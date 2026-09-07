import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { and, count, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderEvents, orderSessions, staff, tables, tenantConfig, zones } from '@/server/db/schema'
import { OrderScreen } from '@/components/pos/order-screen'

/**
 * Order entry screen for one table.
 *
 * ── Structure divergence ─────────────────────────────────────────────────────
 * architecture.md:713 places this at `(waiter)/tables/[tableId]/page.tsx`, inside
 * a route group. No route groups exist yet — src/app is flat — so introducing
 * `(waiter)` here would mean moving page.tsx and login/ as well, which is its own
 * refactor. Built at the plain path for now; whoever adds the groups moves this.
 *
 * Epic 4 builds the actual order entry. This story only needs the navigation
 * target to be real, so the session it opened has somewhere to land.
 */
export default async function TablePage({
  params,
}: {
  params: Promise<{ tableId: string }>
}) {
  const { tableId } = await params

  // Validate the shape before it reaches PostgreSQL.
  //
  // `tables.id` is a uuid column, so a malformed segment raises 22P02 mid-query
  // — and with no error.tsx anywhere under src/app, that throw becomes a
  // full-page server error rather than the redirect this route already has for
  // exactly this situation (a stale or mistyped bookmark). The sibling Route
  // Handler guards the same case deliberately; this page had missed it.
  if (!z.string().uuid().safeParse(tableId).success) redirect('/')

  const headersList = await headers()
  const staffId = headersList.get('x-staff-id')

  // One joined query. The open session is an inner join, not a left join:
  // without an open session there is no order screen to render (see below).
  const [row] = await db
    .select({
      tableId: tables.id,
      tableLabel: tables.label,
      capacity: tables.capacity,
      zoneName: zones.name,
      sessionId: orderSessions.id,
      openedAt: orderSessions.openedAt,
      coverCount: orderSessions.coverCount,
    })
    .from(tables)
    .innerJoin(zones, eq(zones.id, tables.zoneId))
    .innerJoin(
      orderSessions,
      and(eq(orderSessions.tableId, tables.id), isNull(orderSessions.closedAt)),
    )
    .where(eq(tables.id, tableId))
    .limit(1)

  // No open session — the table was closed by another device, or this is a
  // bookmarked URL from a finished sitting. Send the waiter back to the floor
  // rather than rendering an order screen with nothing behind it.
  if (!row) redirect('/')

  const [staffRow] = staffId
    ? await db.select({ name: staff.name }).from(staff).where(eq(staff.id, staffId)).limit(1)
    : []

  const [config] = await db
    .select({ restaurantName: tenantConfig.restaurantName })
    .from(tenantConfig)
    .limit(1)

  // Drives which close reasons the screen offers. Counts ITEM_ADDED without
  // subtracting ITEM_REMOVED, matching /api/tables and the close route — all
  // three change together when Epic 4 adds removal.
  const [items] = await db
    .select({ total: count() })
    .from(orderEvents)
    .where(and(eq(orderEvents.sessionId, row.sessionId), eq(orderEvents.eventType, 'ITEM_ADDED')))

  return (
    <OrderScreen
      tableId={row.tableId}
      restaurantName={config?.restaurantName ?? 'Restaurant'}
      staffName={staffRow?.name ?? 'Unknown'}
      zoneName={row.zoneName}
      tableLabel={row.tableLabel}
      capacity={row.capacity}
      coverCount={row.coverCount}
      openedAt={row.openedAt.toISOString()}
      itemCount={Number(items?.total ?? 0)}
    />
  )
}
