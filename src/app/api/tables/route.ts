import { NextResponse } from 'next/server'
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/server/db'
import { orderEvents, orderSessions, tables, tenants, zones } from '@/server/db/schema'

export type TableGridRow = {
  id: string
  label: string
  status: 'open' | 'occupied' | 'unavailable'
  zoneId: string
  zoneName: string
  capacity: number | null
  /** Present only while a session is open. */
  sessionId: string | null
  /** ISO timestamp from PostgreSQL. The client derives elapsed time from it. */
  openedAt: string | null
  itemCount: number
}

/**
 * Grid data for the waiter's landing screen.
 *
 * Authentication is NOT checked here — src/proxy.ts rejects unauthenticated
 * requests before any Route Handler runs (Story 2.3). Re-checking would
 * duplicate logic the architecture deliberately centralised.
 */
export async function GET() {
  try {
    // Single-tenant-per-stack (NFR-SC1).
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1)

    if (!tenant) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_PROVISIONED', message: 'No tenant configured' } },
        { status: 503 },
      )
    }

    // One joined query, not N+1.
    //
    // The left join on order_sessions is filtered to `closed_at IS NULL`, and the
    // partial unique index idx_order_sessions_one_open_per_table guarantees at
    // most one such row per table — so this join cannot fan out and duplicate
    // table rows.
    const rows = await db
      .select({
        id: tables.id,
        label: tables.label,
        status: tables.status,
        capacity: tables.capacity,
        zoneId: zones.id,
        zoneName: zones.name,
        sessionId: orderSessions.id,
        openedAt: orderSessions.openedAt,
      })
      .from(tables)
      .innerJoin(zones, eq(zones.id, tables.zoneId))
      .leftJoin(
        orderSessions,
        and(eq(orderSessions.tableId, tables.id), isNull(orderSessions.closedAt)),
      )
      // A deactivated zone must not appear in the grid or the filter bar.
      .where(and(eq(tables.tenantId, tenant.id), eq(zones.isActive, true)))
      // display_order defaults to 0 on both tables, so anything created outside
      // the seed ties. PostgreSQL gives no ordering guarantee for ties, which
      // let the grid reshuffle between refetches and interleaved the tables of
      // two zones sharing an order. zones.id then tables.label break the tie
      // deterministically and keep each zone's tables contiguous.
      .orderBy(
        asc(zones.displayOrder),
        asc(zones.id),
        asc(tables.displayOrder),
        asc(tables.label),
      )

    // Item counts for open sessions only. Separate grouped query rather than
    // folding a COUNT into the join above, which would require grouping every
    // selected table column.
    const openSessionIds = rows.map((r) => r.sessionId).filter((id): id is string => id !== null)

    const itemCounts = new Map<string, number>()
    if (openSessionIds.length > 0) {
      const counts = await db
        .select({ sessionId: orderEvents.sessionId, total: count() })
        .from(orderEvents)
        // The session filter belongs in the WHERE clause, not in a JS pass
        // afterwards. order_events is the append-only audit table and only ever
        // grows, so an unbounded aggregate here meant every landing-screen load
        // scanned every ITEM_ADDED row ever written and discarded almost all of
        // it. idx_order_events_session_id is unusable without this predicate.
        .where(
          and(
            eq(orderEvents.eventType, 'ITEM_ADDED'),
            inArray(orderEvents.sessionId, openSessionIds),
          ),
        )
        .groupBy(orderEvents.sessionId)

      for (const row of counts) {
        itemCounts.set(row.sessionId, Number(row.total))
      }
    }

    const data: TableGridRow[] = rows.map((row) => ({
      id: row.id,
      label: row.label,
      // Occupancy is DERIVED from the session join, never read from
      // tables.status. The column and the join are two sources of truth for one
      // fact: if a writer opens a session without also updating the column, a
      // socket patch sets the card to occupied and the next refetch reverts it
      // to open, discarding elapsed time and item count. Deriving makes that
      // divergence impossible, so Story 3.3 cannot get it wrong. The column
      // still owns `unavailable`, which is a property of the table itself and
      // has no session.
      status: row.status === 'unavailable' ? 'unavailable' : row.sessionId ? 'occupied' : 'open',
      zoneId: row.zoneId,
      zoneName: row.zoneName,
      capacity: row.capacity,
      sessionId: row.sessionId,
      openedAt: row.openedAt ? row.openedAt.toISOString() : null,
      // SIMPLIFICATION: counts ITEM_ADDED only, ignoring ITEM_REMOVED. Removal is
      // not implemented until Epic 4, so there is nothing to subtract yet. Revisit
      // in Story 4.4 when items can be removed.
      itemCount: row.sessionId ? (itemCounts.get(row.sessionId) ?? 0) : 0,
    }))

    return NextResponse.json({ success: true, data }, { status: 200 })
  } catch (error) {
    console.error('[api/tables] Failed to load grid:', error)
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Could not load tables' } },
      { status: 500 },
    )
  }
}
