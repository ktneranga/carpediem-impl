import { NextResponse } from 'next/server'
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderEvents, orderSessions, orderSessionTables, tables } from '@/server/db/schema'
import { isUniqueViolation } from '@/server/db/errors'
import {
  attachTables,
  SessionAlreadyClosedError,
  TableWentUnavailableError,
} from '@/server/services/table-session.service'
import { emitCounterSalesChanged, emitTableStatusChanged } from '@/server/socket/events'

const sessionIdSchema = z.string().uuid()
const OPEN_SESSION_INDEX = 'idx_one_open_session_per_table'

const bodySchema = z.object({
  tableIds: z.array(z.string().uuid()).min(1).max(11),
})

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Seats a counter sale — attaches tables to a session that had none (AC-5).
 *
 * The customer bought at the bar and then took a table. The order, its items and
 * its audit trail are untouched; only what it occupies changes, and `kind` flips
 * from `counter` to `table` inside `attachTables`' transaction. That this works
 * at all is the payoff of Story 3.8's join table: zero, one or many tables per
 * session were already expressible.
 *
 * Addressed by SESSION because a counter sale has no table to address it
 * through — the same reason `/api/tables/:tableId/merge` cannot serve this case
 * even though the write underneath is identical.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId: rawSessionId } = await params

  const parsedSessionId = sessionIdSchema.safeParse(rawSessionId)
  if (!parsedSessionId.success) {
    return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  }
  const sessionId = parsedSessionId.data

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
    return fail('INVALID_BODY', 'tableIds must be an array of 1 to 11 table UUIDs', 400)
  }

  const tableIds = [
    ...new Map(parsedBody.data.tableIds.map((id) => [id.toLowerCase(), id])).values(),
  ]

  try {
    const [session] = await db
      .select({
        id: orderSessions.id,
        openedAt: orderSessions.openedAt,
        kind: orderSessions.kind,
      })
      .from(orderSessions)
      .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))
      .limit(1)

    if (!session) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    }

    // COUNTER-ORIGIN SESSIONS THAT ARE NOT ALREADY SEATED.
    //
    // This route's zone rule compares the incoming tables only among themselves,
    // on the premise that there is no anchor to compare against. That premise
    // holds only for a session occupying nothing — and the route used to accept
    // ANY open session, so pointing it at a table order attached tables from a
    // DIFFERENT zone with no complaint, producing exactly the cross-zone group
    // `/api/tables/:tableId/merge` refuses and skipping that route's
    // `expectedSessionId` staleness guard.
    //
    // Checking attachments rather than `kind` alone also closes the double-seat
    // race: two devices seating the same counter sale both passed before, since
    // `kind` stayed 'counter' and the session stayed open. The second is now
    // refused, and told where to go instead.
    if (session.kind !== 'counter') {
      return fail(
        'NOT_A_COUNTER_SALE',
        'This order started at a table. Use Merge to add another table to it.',
        409,
      )
    }

    const [alreadySeated] = await db
      .select({ tableId: orderSessionTables.tableId })
      .from(orderSessionTables)
      .where(
        and(eq(orderSessionTables.sessionId, session.id), isNull(orderSessionTables.releasedAt)),
      )
      .limit(1)

    if (alreadySeated) {
      return fail(
        'ALREADY_SEATED',
        'This order is already at a table. Use Merge to add another table to it.',
        409,
      )
    }

    const targets = await db
      .select({ id: tables.id, label: tables.label, zoneId: tables.zoneId, status: tables.status })
      .from(tables)
      .where(inArray(tables.id, tableIds))

    if (targets.length !== tableIds.length) {
      return fail('TABLE_NOT_FOUND', 'One of the tables does not exist', 404)
    }

    // The same-zone rule (FR62) applies to the tables being attached, since a
    // session that is about to become a table order must obey the same
    // constraint as one that always was. There is no anchor to compare against,
    // so they must agree among themselves.
    const zoneIds = new Set(targets.map((target) => target.zoneId))
    if (zoneIds.size > 1) {
      return fail('CROSS_ZONE_MERGE', 'Tables can only be merged within one zone', 422)
    }
    if (targets.some((target) => target.status === 'unavailable')) {
      return fail('TABLE_NOT_AVAILABLE', 'One of the tables is not in service', 422)
    }

    // Fast path for a clear message; the unique index still decides a real race.
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
          tableLabels: targets.map((target) => target.label),
        }),
      )
    } catch (error) {
      if (error instanceof SessionAlreadyClosedError) {
        return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
      }
      if (error instanceof TableWentUnavailableError) {
        return fail('TABLE_NOT_AVAILABLE', 'One of the tables is not in service', 422)
      }
      if (isUniqueViolation(error, OPEN_SESSION_INDEX)) {
        return fail('BOTH_TABLES_OCCUPIED', 'That table was taken by another order first.', 409)
      }
      throw error
    }

    // The session now has tables, so it now belongs on the grid — every attached
    // table needs an event carrying the full group, exactly as the merge route
    // does. This is the first moment a counter sale becomes visible on the floor.
    const groupTables = await db
      .select({ id: tables.id, label: tables.label })
      .from(orderSessionTables)
      .innerJoin(tables, eq(tables.id, orderSessionTables.tableId))
      .where(
        and(eq(orderSessionTables.sessionId, session.id), isNull(orderSessionTables.releasedAt)),
      )
      .orderBy(asc(tables.label))

    const groupTableLabels = groupTables.map((groupTable) => groupTable.label)

    const [items] = await db
      .select({ total: count() })
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

    // It has left the counter list and joined the floor.
    emitCounterSalesChanged()

    return NextResponse.json(
      { success: true, data: { sessionId: session.id, attachedTableIds: tableIds } },
      { status: 200 },
    )
  } catch (error) {
    console.error('[api/sessions/:sessionId/tables] Failed to attach tables:', error)
    return fail('INTERNAL_ERROR', 'Could not seat the order', 500)
  }
}
