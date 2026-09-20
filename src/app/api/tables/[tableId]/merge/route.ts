import { NextResponse } from 'next/server'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { dishCount } from '@/server/orders/item-count'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderEvents, orderSessions, orderSessionTables, tables } from '@/server/db/schema'
import { isUniqueViolation } from '@/server/db/errors'
import {
  attachTables,
  SessionAlreadyClosedError,
  TableWentUnavailableError,
} from '@/server/services/table-session.service'
import { emitTableStatusChanged } from '@/server/socket/events'

const tableIdSchema = z.string().uuid()

/** The index that decides a merge race. Named, so an unrelated 23505 is a 500. */
const OPEN_SESSION_INDEX = 'idx_one_open_session_per_table'

const bodySchema = z.object({
  tableIds: z.array(z.string().uuid()).min(1).max(11),
  /**
   * The session the CLIENT believed the anchor had when the merge was staged —
   * `null` when it staged against a free table.
   *
   * Merge mode is built over several taps, and the anchor can be seated by
   * another device in between. The client then silently switched strategy:
   * seeing the anchor now `occupied`, it merged the staged tables into a
   * stranger's session, putting two parties' items on one bill. The server
   * cannot spot that from the request alone — it is a perfectly valid merge —
   * so the client states what it expected and the server refuses if reality
   * moved. Optional so an omitted value keeps the previous (unchecked)
   * behaviour rather than breaking older clients mid-service.
   */
  expectedSessionId: z.string().uuid().nullable().optional(),
})

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Merges further tables into a session that is already open.
 *
 * The party grew, or was seated across more space than first expected. The
 * order, its items and its audit trail are untouched — only the set of tables
 * changes.
 *
 * ── Why two live sessions cannot be combined ─────────────────────────────────
 * Merging a table that already has its own open session would mean deciding
 * whose items are whose, which is retroactive item re-assignment — a Growth-tier
 * feature (`prd.md:113`), not v1. Refused with 409 rather than guessed at.
 *
 * ── Concurrency ──────────────────────────────────────────────────────────────
 * The partial unique index `idx_one_open_session_per_table` decides races. Two
 * devices merging the same free table into different sessions both insert; one
 * commits, the other raises 23505 and gets a 409.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ tableId: string }> },
) {
  const { tableId: rawTableId } = await params

  const parsedTableId = tableIdSchema.safeParse(rawTableId)
  if (!parsedTableId.success) {
    return fail('INVALID_TABLE_ID', 'Table id must be a UUID', 400)
  }
  const anchorId = parsedTableId.data

  const staffId = request.headers.get('x-staff-id')
  if (!staffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }

  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success) {
    return fail('INVALID_BODY', 'tableIds must be a non-empty array of UUIDs', 400)
  }

  const { expectedSessionId } = parsedBody.data
  const tableIds = [...new Set(parsedBody.data.tableIds)].filter((id) => id !== anchorId)
  if (tableIds.length === 0) {
    return fail('INVALID_BODY', 'No tables to merge', 400)
  }

  try {
    // The anchor's open session, found through the join table so any table in an
    // existing group can act as the anchor.
    const [session] = await db
      .select({ id: orderSessions.id, openedAt: orderSessions.openedAt })
      .from(orderSessions)
      .innerJoin(orderSessionTables, eq(orderSessionTables.sessionId, orderSessions.id))
      .where(
        and(
          eq(orderSessionTables.tableId, anchorId),
          isNull(orderSessionTables.releasedAt),
          isNull(orderSessions.closedAt),
        ),
      )
      .limit(1)

    if (!session) {
      return fail('SESSION_ALREADY_CLOSED', 'This table has no open session to merge into', 409)
    }

    // The anchor moved underneath the waiter while they were staging.
    if (expectedSessionId !== undefined && expectedSessionId !== session.id) {
      return fail(
        'ANCHOR_CHANGED',
        'That table was opened by someone else while you were merging. Start the merge again.',
        409,
      )
    }

    const [anchor] = await db
      .select({ zoneId: tables.zoneId })
      .from(tables)
      .where(eq(tables.id, anchorId))
      .limit(1)

    if (!anchor) {
      return fail('TABLE_NOT_FOUND', 'No such table', 404)
    }

    const targets = await db
      .select({ id: tables.id, label: tables.label, zoneId: tables.zoneId, status: tables.status })
      .from(tables)
      .where(inArray(tables.id, tableIds))

    if (targets.length !== tableIds.length) {
      return fail('TABLE_NOT_FOUND', 'One of the tables does not exist', 404)
    }
    if (targets.some((t) => t.zoneId !== anchor.zoneId)) {
      return fail('CROSS_ZONE_MERGE', 'Tables can only be merged within one zone', 422)
    }
    if (targets.some((t) => t.status === 'unavailable')) {
      return fail('TABLE_NOT_AVAILABLE', 'One of the tables is not in service', 422)
    }

    // Fast path for a clear message. The unique index is still what decides a
    // genuine race — see the catch below.
    const [occupied] = await db
      .select({ id: orderSessionTables.tableId })
      .from(orderSessionTables)
      .where(
        and(inArray(orderSessionTables.tableId, tableIds), isNull(orderSessionTables.releasedAt)),
      )
      .limit(1)

    if (occupied) {
      return fail(
        'BOTH_TABLES_OCCUPIED',
        'That table already has its own order. Settle or close it first.',
        409,
      )
    }

    try {
      await db.transaction((tx) =>
        attachTables(tx, {
          sessionId: session.id,
          tableIds,
          staffId,
          tableLabels: targets.map((t) => t.label),
        }),
      )
    } catch (error) {
      if (error instanceof TableWentUnavailableError) {
        return fail('TABLE_NOT_AVAILABLE', 'One of the tables is not in service', 422)
      }
      if (error instanceof SessionAlreadyClosedError) {
        // The session was closed between our read and the write — `attachTables`
        // re-asserts it under a row lock, which is what stops a merge landing on
        // a closed session and stranding the table.
        return fail('SESSION_ALREADY_CLOSED', 'This table has no open session to merge into', 409)
      }
      if (isUniqueViolation(error, OPEN_SESSION_INDEX)) {
        return fail(
          'BOTH_TABLES_OCCUPIED',
          'That table was taken by another order first.',
          409,
        )
      }
      throw error
    }

    // The whole group after the merge, not just the tables that moved.
    //
    // Every member's `groupTableLabels` changed, and the client decides whether
    // to collapse a group SOLELY from that array — so emitting only for the
    // newly attached tables left other devices rendering the party as separate
    // cards. Existing members need an event too.
    const groupTables = await db
      .select({ id: tables.id, label: tables.label })
      .from(orderSessionTables)
      .innerJoin(tables, eq(tables.id, orderSessionTables.tableId))
      .where(
        and(
          eq(orderSessionTables.sessionId, session.id),
          isNull(orderSessionTables.releasedAt),
        ),
      )
      .orderBy(asc(tables.label))

    const groupTableLabels = groupTables.map((groupTable) => groupTable.label)

    // Sums ITEM_ADDED quantities (dishes, not rows) without subtracting ITEM_REMOVED, matching /api/tables,
    // the close route and the order page. All four change together when Epic 4
    // adds removal.
    //
    // NOT hardcoded 0. That was copied from the open route, where zero is true
    // by definition; here it is false, because merging into a LIVE session is
    // the point of AC-4. Remote caches recorded 0 for the merged-in table, and
    // since the group card reads its primary — the first table by label —
    // merging A9 into B2 made a twenty-item order display "No items yet".
    const [items] = await db
      .select({ total: dishCount })
      .from(orderEvents)
      .where(and(eq(orderEvents.sessionId, session.id), eq(orderEvents.eventType, 'ITEM_ADDED')))
    const itemCount = Number(items?.total ?? 0)

    for (const groupTable of groupTables) {
      emitTableStatusChanged({
        tableId: groupTable.id,
        status: 'occupied',
        sessionId: session.id,
        openedAt: session.openedAt.toISOString(),
        itemCount,
        unavailableReason: null,
        groupTableLabels,
      })
    }

    return NextResponse.json(
      { success: true, data: { sessionId: session.id, mergedTableIds: tableIds } },
      { status: 200 },
    )
  } catch (error) {
    console.error('[api/tables/:tableId/merge] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not merge the tables', 500)
  }
}
