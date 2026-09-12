import { NextResponse } from 'next/server'
import { and, asc, count, eq, gte, inArray, isNull, or } from 'drizzle-orm'
import { db } from '@/server/db'
import {
  orderEvents,
  orderSessions,
  orderSessionTables,
  staff,
  tenants,
} from '@/server/db/schema'
import { startOfDayInZone } from '@/server/time'
import { openCounterSession } from '@/server/services/table-session.service'
import { emitCounterSalesChanged } from '@/server/socket/events'

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Opens a COUNTER SALE — an order attached to no table (FR64, Story 3.9).
 *
 * ── Why this route exists at all ─────────────────────────────────────────────
 * Every other way into an order goes through a table: `POST
 * /api/tables/:tableId/sessions`, and a card on the floor grid. A customer who
 * walks to the bar, buys a beer and leaves occupies no table, so before this
 * route that sale could not be recorded at all — `order_sessions.table_id` was
 * `notNull` and there was no entry point that did not seat somebody.
 *
 * ── Why there is no conflict path ────────────────────────────────────────────
 * No 409, no unique index, no fast-path check. `idx_one_open_session_per_table`
 * constrains TABLES; a counter session has none. Three customers at the bar at
 * once are three open counter sessions, and nothing should serialise them.
 *
 * RBAC comes from `{ prefix: '/api/sessions', roles: ['owner','waiter'] }`,
 * added in Story 3.9 Task 3 BEFORE this file existed — the prefix matched no
 * policy until then, and default-allow would have made this reachable by
 * kitchen staff with nothing erroring.
 */
export async function POST(request: Request) {
  const staffId = request.headers.get('x-staff-id')
  if (!staffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  try {
    // Single-tenant-per-stack (NFR-SC1), same as /api/tables.
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1)
    if (!tenant) {
      return fail('NOT_PROVISIONED', 'No restaurant is configured', 503)
    }

    const session = await db.transaction((tx) =>
      openCounterSession(tx, { tenantId: tenant.id, staffId }),
    )

    // No `table:status_changed` — a counter sale changes no table's status, and
    // the grid is a view of tables, so patching a row that does not exist is
    // meaningless (AC-2). But the COUNTER LIST changed, and that needs saying, or
    // a sale started at the bar never appears on any other tablet.
    emitCounterSalesChanged()
    return NextResponse.json(
      {
        success: true,
        data: {
          sessionId: session.id,
          openedAt: session.openedAt.toISOString(),
          kind: 'counter' as const,
        },
      },
      { status: 201 },
    )
  } catch (error) {
    console.error('[api/sessions] Failed to open counter session:', error)
    return fail('INTERNAL_ERROR', 'Could not start the counter sale', 500)
  }
}

/**
 * Lists OPEN counter sessions (AC-7).
 *
 * ── Why closed sales are NOT listed ──────────────────────────────────────────
 * Same rule as tables: a settled table leaves the floor, and a settled counter
 * sale leaves with it. This screen is a live view of what still needs attention.
 * Completed sales belong to the owner dashboard (Epic 9), where they can be
 * totalled by day, and the audit trail (Epic 7), where they can be filtered —
 * neither of which a floor screen should try to be.
 *
 * ── Why this is not optional ─────────────────────────────────────────────────
 * A counter order appears on no card, and any number can be open at once. A
 * waiter who starts one and navigates away would otherwise have produced a
 * session that is invisible on every screen, unreachable by any URL they know,
 * impossible to close through the UI — and still counted in every revenue and
 * audit query. That is the orphaned-session state Story 3.6 exists to
 * eliminate, arrived at from a third direction. This list is what stops Story
 * 3.9 re-opening the hole Story 3.6 closed.
 */
export async function GET() {
  try {
    // The day boundary comes from the RESTAURANT's timezone, not the process's.
    //
    // `new Date().setHours(0,0,0,0)` used to sit here and gave midnight wherever
    // Node happened to be running — which in the container is UTC, so "today"
    // began at 05:30 local and every Counter number renumbered mid-service. It
    // looked correct in development only because a developer's machine is
    // already in the restaurant's timezone. See src/server/time.ts.
    const [tenant] = await db
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .limit(1)

    const startOfDay = startOfDayInZone(tenant?.timezone ?? 'Asia/Colombo')

    // EVERY counter sale from today, closed ones included — PLUS any still open
    // from before it.
    //
    // The closed rows are read solely to number the open ones: a counter sale is
    // identified by its sequence within the day, and that number has to be
    // STABLE, so numbering only the open sales would rename the rest each time
    // an earlier one closed.
    //
    // The `isNull(closedAt)` half is not an optimisation — it is the fix for an
    // orphan. The filter was day-only, so a sale opened at 23:50 and still open
    // at 00:05 was excluded from the query entirely: no card, no list, no URL
    // anyone knew, un-closable, and still counted in revenue and audit. That is
    // verbatim the state this endpoint exists to prevent, and a bar trading past
    // midnight hit it every night. An open sale is ALWAYS listed, whenever it
    // started; the day window only decides numbering.
    const allToday = await db
      .select({
        sessionId: orderSessions.id,
        openedAt: orderSessions.openedAt,
        closedAt: orderSessions.closedAt,
        openedByName: staff.name,
      })
      .from(orderSessions)
      .leftJoin(staff, eq(staff.id, orderSessions.openedByStaffId))
      .where(
        and(
          eq(orderSessions.kind, 'counter'),
          or(gte(orderSessions.openedAt, startOfDay), isNull(orderSessions.closedAt)),
        ),
      )
      // Oldest first — the sale waiting longest needs attention first, and a
      // list can express that ordering where a grid cannot.
      //
      // `id` breaks ties. Ordering by `openedAt` alone meant two sales committing
      // in the same tick could come back either way round on successive
      // requests, renaming both — and a number that moves is the whole thing
      // this sequence exists to avoid.
      .orderBy(asc(orderSessions.openedAt), asc(orderSessions.id))

    // Numbered across the whole day's counter-origin sessions, then narrowed to
    // the ones that are open AND currently sitting at no table.
    //
    // A counter sale whose guest sat down keeps `kind = 'counter'` — the column
    // is origin, not current state — but it is now a card on the floor, so
    // listing it here as well would show one order in two places. Un-seat it and
    // it comes back.
    const seatedIds = new Set(
      (
        await db
          .select({ sessionId: orderSessionTables.sessionId })
          .from(orderSessionTables)
          .where(
            and(
              inArray(
                orderSessionTables.sessionId,
                allToday.map((row) => row.sessionId),
              ),
              isNull(orderSessionTables.releasedAt),
            ),
          )
      ).map((row) => row.sessionId),
    )

    const rows = allToday
      .map((row, index) => ({ ...row, sequence: index + 1 }))
      .filter((row) => row.closedAt === null && !seatedIds.has(row.sessionId))

    // Item counts in one grouped pass rather than a query per session.
    //
    // Counts ITEM_ADDED without subtracting ITEM_REMOVED, matching /api/tables,
    // the close routes and the order page. All of them change together when
    // Epic 4 adds removal.
    const counts = new Map<string, number>()
    if (rows.length > 0) {
      // BOUNDED by the sessions actually being listed.
      //
      // This was an unfiltered aggregate — every ITEM_ADDED row ever written,
      // grouped and then discarded for all but a handful of open bar tabs, on
      // every waiter tablet's landing screen. `/api/tables` fixed exactly this
      // and documents why: order_events is append-only and only grows, and
      // `idx_order_events_session_id` is unusable without the predicate.
      const grouped = await db
        .select({ sessionId: orderEvents.sessionId, total: count() })
        .from(orderEvents)
        .where(
          and(
            eq(orderEvents.eventType, 'ITEM_ADDED'),
            inArray(
              orderEvents.sessionId,
              rows.map((row) => row.sessionId),
            ),
          ),
        )
        .groupBy(orderEvents.sessionId)

      for (const row of grouped) counts.set(row.sessionId, Number(row.total))
    }

    return NextResponse.json({
      success: true,
      data: rows.map((row) => ({
        sessionId: row.sessionId,
        openedAt: row.openedAt.toISOString(),
        itemCount: counts.get(row.sessionId) ?? 0,
        // Who started it. On a shared tablet this is the difference between
        // "whose sale is this?" and having to ask across the bar.
        openedByName: row.openedByName ?? 'Unknown',
        /** Position within TODAY's counter sales. Fixed at creation; never moves. */
        sequence: row.sequence,
      })),
    })
  } catch (error) {
    console.error('[api/sessions] Failed to list counter sessions:', error)
    return fail('INTERNAL_ERROR', 'Could not load counter orders', 500)
  }
}
