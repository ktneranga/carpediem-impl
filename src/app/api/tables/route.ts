import { NextResponse } from 'next/server'
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/server/db'
import {
  orderEvents,
  orderSessions,
  orderSessionTables,
  tables,
  tenants,
  zones,
} from '@/server/db/schema'

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
  /**
   * Labels of every table this session occupies, e.g. `["B1","B3"]`.
   *
   * One entry when unmerged. Two or more means a merged group — the card shows
   * it so a second occupied table is never unexplained. Empty when no session.
   */
  groupTableLabels: string[]
  /** Why the table is out of service. Null unless status is `unavailable`. */
  unavailableReason: string | null
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
    // Joins are filtered to open attachments and open sessions, and
    // idx_one_open_session_per_table guarantees at most one un-released
    // attachment per table — so this cannot fan out and duplicate table rows.
    const rows = await db
      .select({
        id: tables.id,
        label: tables.label,
        status: tables.status,
        capacity: tables.capacity,
        unavailableReason: tables.unavailableReason,
        zoneId: zones.id,
        zoneName: zones.name,
        sessionId: orderSessions.id,
        openedAt: orderSessions.openedAt,
      })
      .from(tables)
      .innerJoin(zones, eq(zones.id, tables.zoneId))
      // Two hops now, not one: table → attachment → session.
      //
      // A session can span several tables (Story 3.8), so joining on
      // orderSessions.tableId would only ever have found each session's PRIMARY
      // table and left every other table in a merged group looking free.
      //
      // Still cannot fan out: idx_one_open_session_per_table guarantees at most
      // one un-released attachment per table, so each table matches at most one
      // session and the row count is unchanged.
      .leftJoin(
        orderSessionTables,
        and(
          eq(orderSessionTables.tableId, tables.id),
          isNull(orderSessionTables.releasedAt),
        ),
      )
      .leftJoin(
        orderSessions,
        and(
          eq(orderSessions.id, orderSessionTables.sessionId),
          isNull(orderSessions.closedAt),
        ),
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

    // Every table each open session occupies, so a merged card can say so.
    //
    // Without this, the second table in a group renders as an occupied table
    // with no explanation — a waiter glancing at it has no way to know it
    // belongs to the party at the first one.
    const groupLabels = new Map<string, string[]>()
    if (openSessionIds.length > 0) {
      const members = await db
        .select({ sessionId: orderSessionTables.sessionId, label: tables.label })
        .from(orderSessionTables)
        .innerJoin(tables, eq(tables.id, orderSessionTables.tableId))
        // The SAME zone filter the grid query uses.
        //
        // Without it this query counted members the grid never sends, so a group
        // with a table in a deactivated zone reported two labels while only one
        // row reached the client. `buildUnit` then set `isGroup` from the server
        // count (true) while the card recomputed `isMerged` from the assembled
        // labels (false) — rendering an ordinary single table that spanned two
        // grid columns. Two sources of truth for one fact, disagreeing.
        .innerJoin(zones, eq(zones.id, tables.zoneId))
        .where(
          and(
            inArray(orderSessionTables.sessionId, openSessionIds),
            isNull(orderSessionTables.releasedAt),
            eq(zones.isActive, true),
          ),
        )
        .orderBy(asc(tables.label))

      for (const row of members) {
        const existing = groupLabels.get(row.sessionId)
        if (existing) existing.push(row.label)
        else groupLabels.set(row.sessionId, [row.label])
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
      unavailableReason: row.unavailableReason,
      sessionId: row.sessionId,
      openedAt: row.openedAt ? row.openedAt.toISOString() : null,
      // SIMPLIFICATION: counts ITEM_ADDED only, ignoring ITEM_REMOVED. Removal is
      // not implemented until Epic 4, so there is nothing to subtract yet. Revisit
      // in Story 4.4 when items can be removed.
      itemCount: row.sessionId ? (itemCounts.get(row.sessionId) ?? 0) : 0,
      groupTableLabels: row.sessionId ? (groupLabels.get(row.sessionId) ?? []) : [],
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
