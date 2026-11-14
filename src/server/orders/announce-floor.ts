import 'server-only'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@/server/db'
import { orderEvents, orderSessions, orderSessionTables, tables } from '@/server/db/schema'
import { dishCount, dishTotalPaisa } from '@/server/orders/item-count'
import { emitCounterSalesChanged, emitTableStatusChanged } from '@/server/socket/events'

/**
 * Tells every floor what an open order now stands at, after something changed
 * its money but not its tables — a void or a cancelled bill (Story 7.5).
 *
 * Read AFTER commit, like the send route's refresh. The same two-branch rule:
 * a counter-origin order refreshes the counter list, an order with tables
 * refreshes their cards, and a seated counter sale does both (`kind` is where
 * an order started, never what it occupies now). A closed order is skipped —
 * the close already put its tables back.
 *
 * Never throws: the change is committed, and a failed refresh is not a reason
 * to tell the waiter it failed. Cards correct themselves on the next event or
 * refetch.
 */
export async function announceSessionTotals(sessionId: string): Promise<void> {
  try {
    const [session] = await db
      .select({
        kind: orderSessions.kind,
        closedAt: orderSessions.closedAt,
        openedAt: orderSessions.openedAt,
        dailyNumber: orderSessions.dailyNumber,
      })
      .from(orderSessions)
      .where(eq(orderSessions.id, sessionId))
      .limit(1)
    if (!session || session.closedAt) return

    if (session.kind === 'counter') emitCounterSalesChanged()

    const attached = await db
      .select({ id: tables.id, label: tables.label })
      .from(orderSessionTables)
      .innerJoin(tables, eq(tables.id, orderSessionTables.tableId))
      .where(and(eq(orderSessionTables.sessionId, sessionId), isNull(orderSessionTables.releasedAt)))
      .orderBy(asc(tables.label))
    if (attached.length === 0) return

    const [dishes] = await db
      .select({ total: dishCount, totalPaisa: dishTotalPaisa })
      .from(orderEvents)
      .where(and(eq(orderEvents.sessionId, sessionId), eq(orderEvents.eventType, 'ITEM_ADDED')))

    for (const table of attached) {
      emitTableStatusChanged({
        tableId: table.id,
        status: 'occupied',
        sessionId,
        openedAt: session.openedAt.toISOString(),
        dailyNumber: session.dailyNumber,
        itemCount: dishes?.total ?? 0,
        totalPaisa: dishes?.totalPaisa ?? 0,
        unavailableReason: null,
        groupTableLabels: attached.map((row) => row.label),
      })
    }
  } catch (error) {
    console.error('[announceSessionTotals] Failed to refresh the floor:', error)
  }
}
