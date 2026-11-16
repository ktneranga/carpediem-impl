import { headers } from 'next/headers'
import { canApproveVoids, parsePermissionsHeader, type StaffRole } from '@/server/auth/permissions'
import { redirect } from 'next/navigation'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { dailyOrderLabel } from '@/lib/order-number'
import { db } from '@/server/db'
import {
  menuItems,
  orderEvents,
  orderSessions,
  orderSessionTables,
  seatSlots,
  tables,
  tenantConfig,
} from '@/server/db/schema'
import {
  CompsExceedOrderError,
  loadSessionBills,
  priceBillable,
  UnpricedItemError,
} from '@/server/services/bill.service'
import { loadSessionPayments } from '@/server/services/payment.service'
import { tabName, tabSequence } from '@/server/orders/tab-sequence'
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
      tabLabel: orderSessions.tabLabel,
      kind: orderSessions.kind,
      dailyNumber: orderSessions.dailyNumber,
      discountBp: orderSessions.discountBp,
      serviceChargeWaived: orderSessions.serviceChargeWaived,
      tenantId: orderSessions.tenantId,
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
  // A bar tab by its number and nickname — this screen is staff-facing, so the
  // nickname is fine here; it is the PRINTED bill it must never reach.
  const isBarTab = rows[0]!.kind === 'counter' && labels.length === 0
  const tableLabel =
    labels.length > 0
      ? labels.join(' + ')
      : tabName(await tabSequence(sessionId), rows[0]!.tabLabel)

  const [recorded, payments, pricing, seatRows] = await Promise.all([
    loadSessionBills(db, sessionId),
    loadSessionPayments(db, sessionId),
    // The draft can fail to price — an item with no price recorded, comps
    // larger than what is left, no tenant config. That must not take the
    // recorded bills down with it (code review P2): they can still be settled,
    // and the screen says what is wrong with the rest.
    db
      .transaction((tx) => priceBillable(tx, { sessionId }))
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error })),
    db
      .select({ id: seatSlots.id, seatLabel: seatSlots.seatLabel, seatNote: seatSlots.seatNote })
      .from(seatSlots)
      .where(eq(seatSlots.sessionId, sessionId))
      .orderBy(asc(seatSlots.createdAt), asc(seatSlots.id)),
  ])
  // What the waiter called each person on the order screen — the note when
  // there is one. A Separate-bills order opens the split with these names.
  const seats = seatRows.map((seat) => ({ id: seat.id, name: seat.seatNote ?? seat.seatLabel }))

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
    // The name the bill is FOR: the person on a split bill, the seat on a
    // seat bill, nobody in particular on the table's.
    label: bill.personLabel ?? bill.seatLabel ?? 'Whole table',
    subtotalPaisa: bill.subtotalPaisa,
    serviceChargePaisa: bill.serviceChargePaisa,
    serviceChargeBp: bill.serviceChargeBp,
    taxPaisa: bill.taxPaisa,
    taxBp: bill.taxBp,
    totalPaisa: bill.totalPaisa,
    discountBp: bill.discountBp,
    discountPaisa: bill.discountPaisa,
    serviceChargeWaived: bill.serviceChargeWaived,
    serviceWaivedPaisa: bill.serviceWaivedPaisa,
    paidPaisa: payments.get(bill.billId)?.paidPaisa ?? 0,
    lines: bill.lines.map((line) => ({
      orderEventId: line.orderEventId,
      name: line.name,
      quantity: line.quantity,
      unitPricePaisa: line.unitPricePaisa,
      amountPaisa: line.amountPaisa,
      modifierText: line.modifierText,
      optionText: line.optionText,
      destination: stationByEvent.get(line.orderEventId) ?? null,
    })),
  }))

  const priced = pricing.ok ? pricing.value : null
  const draftError = pricing.ok
    ? null
    : pricing.error instanceof UnpricedItemError
      ? 'An item on this order has no price recorded, so the rest of the table cannot be billed yet.'
      : pricing.error instanceof CompsExceedOrderError
        ? 'The discounts on this order are larger than what is left to bill.'
        : 'The rest of this order could not be priced. Bills already recorded can still be settled.'
  if (!pricing.ok) console.error('[orders/:id/bill] draft could not be priced:', pricing.error)

  const draft: BillScreenDraft | null =
    !priced || priced.events.length === 0
      ? null
      : {
          ...priced.totals,
          lines: priced.events.map((event, index) => ({
            orderEventId: event.eventId,
            name: event.customName ?? event.itemName ?? 'Unknown item',
            // What is still UNBILLED of it — one of a "2×" once the other is
            // on someone's bill (migration 0025).
            quantity: priced.lineQuantities[index]!,
            unitPricePaisa: event.unitPricePaisa ?? 0,
            amountPaisa: priced.lineAmounts[index]!,
            modifierText: event.modifierText,
            optionText: event.optionText,
            destination: event.destination ?? null,
            seatSlotId: event.seatSlotId,
          })),
        }

  const [rates] = await db
    .select({ defaultDiscountBp: tenantConfig.defaultDiscountBp, serviceChargeBp: tenantConfig.serviceChargeBp })
    .from(tenantConfig)
    .where(eq(tenantConfig.tenantId, rows[0]!.tenantId))
    .limit(1)
  const headerList = await headers()
  const role = headerList.get('x-staff-role') as StaffRole | null
  const permissions = parsePermissionsHeader(headerList.get('x-staff-permissions'))

  return (
    <BillScreen
      key={sessionId}
      sessionId={sessionId}
      tableLabel={tableLabel}
      orderLabel={dailyOrderLabel(rows[0]!.dailyNumber)}
      // A bar tab is always one bill, whatever its stored mode (code review
      // UI-P9) — the order screen already ignores it; this screen must agree.
      billMode={isBarTab ? 'one' : rows[0]!.billMode}
      bills={bills}
      draft={draft}
      draftError={draftError}
      seats={seats}
      // Cancel bill (Story 7.5): an owner approves their own; others need an owner's PIN.
      canApprove={canApproveVoids(role, permissions)}
      // Discount and service waiver (Teran, 2026-11-16).
      pricing={{
        discountBp: rows[0]!.discountBp,
        defaultDiscountBp: rates?.defaultDiscountBp ?? 0,
        serviceChargeWaived: rows[0]!.serviceChargeWaived,
        serviceChargeBp: rates?.serviceChargeBp ?? 0,
      }}
    />
  )
}
