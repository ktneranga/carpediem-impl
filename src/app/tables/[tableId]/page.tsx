import { redirect } from 'next/navigation'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderSessions, orderSessionTables } from '@/server/db/schema'

/**
 * Table-addressed order screen — now a redirect to the canonical session URL.
 *
 * ── Why it still exists ──────────────────────────────────────────────────────
 * Story 3.9 moved order entry to `/orders/[sessionId]`, because a counter sale
 * (FR64) has no table id to put in a URL. This route stays so that bookmarks,
 * the browser's history and any link written before the move keep working
 * instead of dead-ending on a 404.
 *
 * It resolves the table's OPEN session and redirects. The grid does not come
 * through here — it already holds `sessionId` on every row and navigates
 * straight to `/orders/:sessionId`, so this costs a round trip only for the
 * stale-link case it exists to serve.
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
  // exactly this situation (a stale or mistyped bookmark).
  if (!z.string().uuid().safeParse(tableId).success) redirect('/')

  // Two hops: table → attachment → session. A merged group's non-primary tables
  // are reachable only through the join table, so matching on
  // `order_sessions.table_id` alone would fail to find the session from any
  // table but the primary.
  const [row] = await db
    .select({ sessionId: orderSessions.id })
    .from(orderSessionTables)
    .innerJoin(orderSessions, eq(orderSessions.id, orderSessionTables.sessionId))
    .where(
      and(
        eq(orderSessionTables.tableId, tableId),
        isNull(orderSessionTables.releasedAt),
        isNull(orderSessions.closedAt),
      ),
    )
    .limit(1)

  // No open session — the table was closed by another device, or this is a
  // bookmarked URL from a finished sitting. Send the waiter back to the floor
  // rather than to an order screen with nothing behind it.
  if (!row) redirect('/')

  redirect(`/orders/${row.sessionId}`)
}
