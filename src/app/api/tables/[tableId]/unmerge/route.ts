import { NextResponse } from 'next/server'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { dishCount } from '@/server/orders/item-count'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderEvents, orderSessions, orderSessionTables, tables } from '@/server/db/schema'
import {
  attachedTableIds,
  releaseTable,
  SessionNeedsATableError,
  TableNotAttachedError,
} from '@/server/services/table-session.service'
import { emitCounterSalesChanged, emitTableStatusChanged } from '@/server/socket/events'

const tableIdSchema = z.string().uuid()

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Releases one table from a merged group, leaving the session running.
 *
 * The party shrank, or a table was merged by mistake. `released_at` on the join
 * row is the whole mechanism: it frees the table's slot in the partial unique
 * index and returns it to the floor, while the order continues on the rest.
 *
 * ── Why the last table cannot be released ────────────────────────────────────
 * It would leave an open session attached to nothing — invisible on the floor
 * plan, unreachable from any card, and impossible to close through the UI. That
 * is the orphaned-session state Story 3.6 was written to eliminate, arrived at
 * from the other direction. Close the session instead.
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
  const tableId = parsedTableId.data

  const staffId = request.headers.get('x-staff-id')
  if (!staffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  try {
    const [row] = await db
      .select({
        sessionId: orderSessions.id,
        openedAt: orderSessions.openedAt,
        label: tables.label,
      })
      .from(orderSessionTables)
      .innerJoin(orderSessions, eq(orderSessions.id, orderSessionTables.sessionId))
      .innerJoin(tables, eq(tables.id, orderSessionTables.tableId))
      .where(
        and(
          eq(orderSessionTables.tableId, tableId),
          isNull(orderSessionTables.releasedAt),
          isNull(orderSessions.closedAt),
        ),
      )
      .limit(1)

    if (!row) {
      return fail('SESSION_ALREADY_CLOSED', 'This table is not part of an open order', 409)
    }

    // The last-table guard lives INSIDE releaseTable, under a FOR UPDATE lock on
    // the session row.
    //
    // It used to be a count here, in its own transaction that closed before the
    // release began — so two devices un-merging the two tables of a pair both
    // read 2, both passed, and both committed, leaving an open session attached
    // to nothing. Wrapping that read in `db.transaction` made it LOOK atomic
    // while buying nothing. The database decides this race now, like every
    // other race in this story.
    let remainingTableIds: string[] = []
    try {
      remainingTableIds = await db.transaction(async (tx) => {
        await releaseTable(tx, {
          sessionId: row.sessionId,
          tableId,
          staffId,
          tableLabel: row.label,
        })
        // Read inside the same transaction so the group labels broadcast below
        // are the ones this release actually produced.
        return attachedTableIds(tx, row.sessionId)
      })
    } catch (error) {
      if (error instanceof SessionNeedsATableError) {
        return fail(
          'SESSION_NEEDS_A_TABLE',
          'This is the only table on the order. Close the table instead of un-merging it.',
          409,
        )
      }
      if (error instanceof TableNotAttachedError) {
        // Another device released it between our read and the UPDATE.
        return fail('SESSION_ALREADY_CLOSED', 'This table is not part of an open order', 409)
      }
      throw error
    }

    // The SURVIVORS changed too — their group shrank.
    //
    // Emitting only for the released table left every other device rendering
    // the old membership: a group card still titled "B2 + B3" while B3 sat
    // beside it as a free green card. Same table, two contradictory states, on
    // screen at once.
    // Releasing the last table returns the session to a counter sale, so the
    // counter list gained a row. Harmless when it did not.
    if (remainingTableIds.length === 0) emitCounterSalesChanged()

    const survivors = remainingTableIds.length
      ? await db
          .select({ id: tables.id, label: tables.label })
          .from(tables)
          .where(inArray(tables.id, remainingTableIds))
          .orderBy(asc(tables.label))
      : []
    const survivorLabels = survivors.map((survivor) => survivor.label)

    // Sums ITEM_ADDED quantities (dishes, not rows) without subtracting ITEM_REMOVED, matching /api/tables,
    // the close route and the order page. All four change together when Epic 4
    // adds removal.
    const [items] = await db
      .select({ total: dishCount })
      .from(orderEvents)
      .where(and(eq(orderEvents.sessionId, row.sessionId), eq(orderEvents.eventType, 'ITEM_ADDED')))
    const itemCount = Number(items?.total ?? 0)

    emitTableStatusChanged({
      tableId,
      status: 'open',
      sessionId: null,
      openedAt: null,
      itemCount: 0,
      unavailableReason: null,
      groupTableLabels: [],
    })

    for (const survivor of survivors) {
      emitTableStatusChanged({
        tableId: survivor.id,
        status: 'occupied',
        sessionId: row.sessionId,
        openedAt: row.openedAt.toISOString(),
        itemCount: itemCount,
        unavailableReason: null,
        groupTableLabels: survivorLabels,
      })
    }

    return NextResponse.json(
      { success: true, data: { tableId, sessionId: row.sessionId } },
      { status: 200 },
    )
  } catch (error) {
    console.error('[api/tables/:tableId/unmerge] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not un-merge the table', 500)
  }
}
