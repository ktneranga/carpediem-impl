import { redirect } from 'next/navigation'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { menuItems, orderEvents, orderSessions, orderSessionTables, tables } from '@/server/db/schema'
import { loadSessionBills, priceBillable } from '@/server/services/bill.service'
import { loadSessionPayments } from '@/server/services/payment.service'
import { BillScreen, type BillScreenBill, type BillScreenDraft } from '@/components/pos/bill-screen'
import type { ProductionDestination } from '@/types/orders'

/**
 * The bill screen (Story 6.5, Teran's design 2026-10-25).
 *
 * ── Nothing is written by opening it ─────────────────────────────────────────
 * "Bill & split" used to CREATE the bill on tap and lock the order into
 * `settling`. It now only navigates here. What the table owes is shown as a
 * DRAFT — priced by `priceBillable`, the same code that writes bills — and the
 * bill is recorded when the waiter taps Settle. A waiter who opens this to
 * read the total to a guest, then goes back to add a dessert, has changed
 * nothing.
 *
 * ── What a session can hold here ─────────────────────────────────────────────
 * Bills already recorded (a seat billed early, or a bill created and not yet
 * paid), each with its payments; and the draft for whatever no bill covers
 * yet. Each unpaid one is something the waiter can settle.
 */
export default async function BillPage({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const { sessionId } = await params
  if (!z.string().uuid().safeParse(sessionId).success) redirect('/')

  const rows = await db
    .select({
      billMode: orderSessions.billMode,
      tableLabel: tables.label,
    })
    .from(orderSessions)
    .leftJoin(
      orderSessionTables,
      and(
        eq(orderSessionTables.sessionId, orderSessions.id),
        isNull(orderSessionTables.releasedAt),
      ),
    )
    .leftJoin(tables, eq(tables.id, orderSessionTables.tableId))
    .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))

  // A closed order has nothing left to settle; the floor is where the waiter
  // goes next anyway.
  if (rows.length === 0) redirect('/')

  const labels = rows
    .map((row) => row.tableLabel)
    .filter((label): label is string => label !== null)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const tableLabel = labels.length > 0 ? labels.join(' + ') : 'Counter'

  const [recorded, payments, priced] = await Promise.all([
    loadSessionBills(db, sessionId),
    loadSessionPayments(db, sessionId),
    db.transaction((tx) => priceBillable(tx, { sessionId })),
  ])

  // The station chip on a recorded bill's lines. Bills snapshot the name and
  // price but not where it was cooked — a guest is not charged for that — so
  // it is read live, display-only.
  const recordedEventIds = recorded.flatMap((bill) => bill.lines.map((line) => line.orderEventId))
  const stationRows =
    recordedEventIds.length === 0
      ? []
      : await db
          .select({ eventId: orderEvents.id, destination: menuItems.productionDestination })
          .from(orderEvents)
          .innerJoin(menuItems, eq(menuItems.id, orderEvents.menuItemId))
          .where(inArray(orderEvents.id, recordedEventIds))
  const stationByEvent = new Map<string, ProductionDestination>(
    stationRows.map((row) => [row.eventId, row.destination]),
  )

  const bills: BillScreenBill[] = recorded.map((bill) => ({
    billId: bill.billId,
    type: bill.type,
    seatLabel: bill.seatLabel,
    subtotalPaisa: bill.subtotalPaisa,
    serviceChargePaisa: bill.serviceChargePaisa,
    serviceChargeBp: bill.serviceChargeBp,
    taxPaisa: bill.taxPaisa,
    taxBp: bill.taxBp,
    totalPaisa: bill.totalPaisa,
    paidPaisa: payments.get(bill.billId)?.paidPaisa ?? 0,
    lines: bill.lines.map((line) => ({
      orderEventId: line.orderEventId,
      name: line.name,
      quantity: line.quantity,
      amountPaisa: line.amountPaisa,
      modifierText: line.modifierText,
      destination: stationByEvent.get(line.orderEventId) ?? null,
    })),
  }))

  const draft: BillScreenDraft | null =
    priced.events.length === 0
      ? null
      : {
          ...priced.totals,
          lines: priced.events.map((event, index) => ({
            orderEventId: event.eventId,
            name: event.itemName ?? 'Unknown item',
            quantity: event.quantity,
            amountPaisa: priced.lineAmounts[index]!,
            modifierText: event.modifierText,
            destination: event.destination ?? null,
          })),
        }

  return (
    <BillScreen
      key={sessionId}
      sessionId={sessionId}
      tableLabel={tableLabel}
      billMode={rows[0]!.billMode}
      bills={bills}
      draft={draft}
    />
  )
}
