import 'server-only'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/server/db'
import { isUniqueViolation } from '@/server/db/errors'
import {
  billComps,
  billLines,
  bills,
  compRecords,
  menuItems,
  orderEvents,
  orderSessionTables,
  orderSessions,
  seatSlots,
  tenantConfig,
} from '@/server/db/schema'
import { lockOpenSession } from '@/server/services/table-session.service'
import type { BillDetail, BillLineDetail, BillTotals } from '@/types/bills'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ── Errors ───────────────────────────────────────────────────────────────────
// Typed, so the route maps each to its status without parsing messages — the
// pattern `order.service.ts` and `table-session.service.ts` use.

/** The session has no `ITEM_ADDED` events. An empty bill has no meaning (AC-11). */
export class NothingToBillError extends Error {}

/** The session already has an unsettled bill (AC-6). Carries it, so the route can name it. */
export class BillAlreadyOpenError extends Error {
  constructor(readonly billId: string) {
    super('Bill already open')
  }
}

/**
 * A comp is already attached to another bill.
 *
 * Separate from `BillAlreadyOpenError` even though both arrive as a 23505.
 * They were one case, and the review caught it: a comp collision was reported
 * to the waiter as "this order already has a bill" — which is the exact defect
 * `errors.ts` describes and Trap 2 warns about, reintroduced for the second
 * index. Two causes, two errors, two messages.
 */
export class CompAlreadyBilledError extends Error {}

/**
 * The tenant has no `tenant_config` row, so no rates and no re-auth setting.
 *
 * This used to fail OPEN at two separate sites — `config?.serviceChargeBp ?? 0`
 * and `if (config?.reauth)` — which meant a missing configuration produced a
 * valid-looking bill charging no service and no tax, with the PIN requirement
 * silently skipped. Worse, the bill then RECORDED `serviceChargeBp: 0`, which
 * by this schema's own definition means "we deliberately charged nothing" and
 * is indistinguishable from a counter sale forever after.
 */
export class MissingTenantConfigError extends Error {}

/**
 * An `ITEM_ADDED` event has no `unit_price_paisa`.
 *
 * The column is nullable and `submitRound` always writes it, so this is a data
 * defect rather than a reachable state today. It used to be coerced with
 * `?? 0`: the line was billed free, the bill looked fine, and because a session
 * gets one bill the correct bill could never be generated afterwards. A price
 * that is missing is not a price of zero.
 */
export class UnpricedItemError extends Error {
  constructor(readonly orderEventId: string) {
    super('Item has no price')
  }
}

/**
 * The comps on this bill exceed what was ordered.
 *
 * Produced a negative subtotal, and therefore a negative service charge, a
 * negative tax and a negative total — written to an append-only table that
 * forbids UPDATE, so a fat-fingered comp became a permanent record of the
 * restaurant owing the guest money. Refused rather than clamped to zero: a
 * comp bigger than the item it reduces is a mistake someone has to fix, and
 * silently charging nothing hides it.
 */
export class CompsExceedOrderError extends Error {}

/**
 * The total does not fit in the column.
 *
 * `subtotal_paisa` and `total_paisa` are PostgreSQL `integer`, so they cap at
 * 2,147,483,647 paisa — about LKR 21.47 million. JavaScript computes the sum
 * in doubles without complaining and PostgreSQL then raises `22003` at the
 * INSERT, which reached the waiter as an undifferentiated 500 they would retry
 * forever. Checked here so the failure names itself.
 */
export class BillTooLargeError extends Error {}

/** The largest value a PostgreSQL `integer` column holds. */
const MAX_INT4 = 2_147_483_647

/**
 * The money, computed in ONE place (AC-2).
 *
 * ── Why a pure function, exported ────────────────────────────────────────────
 * Story 6.4 (per-seat bills) and 6.5 (payments) both need these numbers. If
 * each computed them itself, a seat bill and a consolidated bill for the same
 * table could disagree about the service charge and nothing would catch it.
 * There is one implementation and callers hand it a subtotal.
 *
 * ── Round ONCE, never per line ───────────────────────────────────────────────
 * Rounding each line and summing produces a bill that disagrees with its own
 * arithmetic by a few paisa, which the guest notices before you do. Each of the
 * two roundings below happens on a single whole-bill figure.
 *
 * ── Order matters ────────────────────────────────────────────────────────────
 * Service is on the subtotal; tax is on subtotal + service. Reversing them is a
 * different total.
 *
 * ── `hasTableService`, not `kind` ────────────────────────────────────────────
 * The caller decides this from the session's ATTACHED TABLES. See
 * `collectBillable` for why `order_sessions.kind` is the wrong input (AC-3).
 *
 * Basis points: 1000 = 10.00%. `taxBp` is derived from the integer
 * `tax_rate_percent` by the caller — see `readRates`.
 */
export function computeBillTotals({
  subtotalPaisa,
  serviceChargeBp,
  taxBp,
  hasTableService,
}: {
  subtotalPaisa: number
  serviceChargeBp: number
  taxBp: number
  hasTableService: boolean
}): BillTotals {
  const appliedServiceBp = hasTableService ? serviceChargeBp : 0
  const serviceChargePaisa = Math.round((subtotalPaisa * appliedServiceBp) / 10_000)
  const taxPaisa = Math.round(((subtotalPaisa + serviceChargePaisa) * taxBp) / 10_000)

  return {
    subtotalPaisa,
    serviceChargePaisa,
    taxPaisa,
    totalPaisa: subtotalPaisa + serviceChargePaisa + taxPaisa,
    // The rates APPLIED, not the rates configured. A counter sale stores 0, so
    // the bill explains why it has no service line without anyone having to
    // know what the tenant's rate was that evening.
    serviceChargeBp: appliedServiceBp,
    taxBp,
  }
}

/**
 * The tenant's two rates, both as basis points.
 *
 * `tax_rate_percent` is an integer percent and `service_charge_bp` is basis
 * points — a difference Story 6.2's Decision 1 made deliberately, because the
 * integer column cannot express SSCL's 2.5% and that limitation was not worth
 * shipping twice. Converting `tax_rate_percent` → `tax_bp` was offered as a
 * cheap extra in this story and NOT taken: it is read in the order summary and
 * the menu admin as a percent, and changing it there belongs in the story that
 * owns those screens. The × 100 here is the whole cost of leaving it.
 */
async function readRates(tx: Tx, tenantId: string) {
  const [config] = await tx
    .select({
      serviceChargeBp: tenantConfig.serviceChargeBp,
      taxRatePercent: tenantConfig.taxRatePercent,
    })
    .from(tenantConfig)
    .where(eq(tenantConfig.tenantId, tenantId))
    .limit(1)

  // No `?? 0`. A missing config row is a broken installation, not a free meal
  // — see `MissingTenantConfigError`.
  if (!config) throw new MissingTenantConfigError()

  return {
    serviceChargeBp: config.serviceChargeBp,
    taxBp: config.taxRatePercent * 100,
  }
}

/**
 * Everything a bill is made of, read under the session lock.
 *
 * ── `hasTableService` comes from the attached tables ─────────────────────────
 * NOT from `order_sessions.kind`. `kind` records where an order STARTED and is
 * never updated: a counter sale later seated at a table keeps `kind =
 * 'counter'` for the rest of its life, and billing off it would mean a guest
 * who buys at the bar, takes a table and orders three more rounds pays no
 * service charge (AC-3). This is the same column that stopped a seated counter
 * sale's floor card refreshing in Story 5.0's review — the second time it has
 * invited the mistake.
 *
 * Released tables do not count: `released_at IS NULL`, the same filter the
 * floor card and the send announcement use.
 */
async function collectBillable(tx: Tx, sessionId: string) {
  const events = await tx
    .select({
      eventId: orderEvents.id,
      quantity: orderEvents.quantity,
      unitPricePaisa: orderEvents.unitPricePaisa,
      modifierText: orderEvents.modifierText,
      roundNumber: orderEvents.roundNumber,
      itemName: menuItems.name,
      seatLabel: seatSlots.seatLabel,
    })
    .from(orderEvents)
    .leftJoin(menuItems, eq(menuItems.id, orderEvents.menuItemId))
    .leftJoin(seatSlots, eq(seatSlots.id, orderEvents.seatSlotId))
    .where(and(eq(orderEvents.sessionId, sessionId), eq(orderEvents.eventType, 'ITEM_ADDED')))
    .orderBy(asc(orderEvents.createdAt))

  const [attachedTable] = await tx
    .select({ tableId: orderSessionTables.tableId })
    .from(orderSessionTables)
    .where(
      and(eq(orderSessionTables.sessionId, sessionId), isNull(orderSessionTables.releasedAt)),
    )
    .limit(1)

  // Comps are keyed off the EVENTS being billed, not off the session, so 6.4's
  // per-seat bill gets the same query unchanged: a comp follows the item it
  // reduced. Nothing writes `comp_records` until Epic 7, so this is empty in
  // the demo — which is exactly why it is verified with a hand-inserted row.
  const eventIds = events.map((event) => event.eventId)
  const comps =
    eventIds.length === 0
      ? []
      : await tx
          .select({
            compRecordId: compRecords.id,
            orderEventId: compRecords.orderEventId,
            amountPaisa: compRecords.amountPaysa,
            reason: compRecords.reason,
          })
          .from(compRecords)
          .where(inArray(compRecords.orderEventId, eventIds))

  return { events, comps, hasTableService: attachedTable !== undefined }
}

/**
 * The bill a session already has, if any.
 *
 * Exported because `order.service.ts` asks the same question before accepting
 * a round. One implementation, so "is this session billed?" cannot come to
 * two different answers in two places (code review 2026-10-13).
 */
export async function findOpenBill(tx: Tx, sessionId: string) {
  // ── Why "any bill" is the right question TODAY ─────────────────────────────
  // A bill is append-only and carries no `status` column, so "open" means
  // payments recorded against it sum to less than its total — which Story 6.5
  // can ask once `payment_records` gains `bill_id`. Until then there are no
  // payments, so every bill is open and this is the same answer. 6.5 NARROWS
  // this query; it does not replace it.
  const [existing] = await tx
    .select({ id: bills.id })
    .from(bills)
    .where(eq(bills.sessionId, sessionId))
    .orderBy(asc(bills.createdAt))
    .limit(1)

  return existing ?? null
}

/**
 * Generates the one consolidated bill for a session (FR21, FR27).
 *
 * Takes `tx` from the caller, the shape `order.service.ts` established, so a
 * future caller runs the same locking and the same arithmetic as the tablet.
 *
 * ── Order of operations ──────────────────────────────────────────────────────
 * 1. Lock the session and refuse a closed one (`lockOpenSession`). This also
 *    stops a round committing while the bill is being computed — without it a
 *    send that lands between the read and the insert is billed by nobody.
 * 2. Refuse a session that already has a bill (AC-6).
 * 3. Read the events, the attached tables and the rates — all inside the lock.
 * 4. Refuse a session with nothing on it (AC-11).
 * 5. Insert the bill, then its lines, then its comps.
 *
 * ── Two guards against double-billing, and they are not redundant ────────────
 * Step 2 is a read-then-write check, which on its own has a window. It does not
 * have one HERE because step 1 holds the session row `FOR UPDATE`, so two
 * simultaneous taps serialise and the second sees the first's committed bill.
 *
 * `UNIQUE (order_event_id)` on `bill_lines` is the guarantee that does not
 * depend on every future caller remembering to take that lock, and it is the
 * invariant 6.4's per-seat bills actually need: no event may be on two bills,
 * whatever the bill type. If it fires, the insert takes a 23505 and this
 * reports the 409 — caught BY INDEX NAME, because matching bare `23505` would
 * report a future unrelated collision to a waiter as "bill already open".
 */
export async function generateConsolidatedBill(
  tx: Tx,
  { sessionId, staffId }: { sessionId: string; staffId: string },
): Promise<BillDetail> {
  // 1 — throws SessionAlreadyClosedError for a closed or missing session.
  await lockOpenSession(tx, sessionId)

  // 2
  const existing = await findOpenBill(tx, sessionId)
  if (existing) throw new BillAlreadyOpenError(existing.id)

  const [session] = await tx
    .select({ tenantId: orderSessions.tenantId })
    .from(orderSessions)
    .where(eq(orderSessions.id, sessionId))
    .limit(1)

  // 3
  const { events, comps, hasTableService } = await collectBillable(tx, sessionId)
  const { serviceChargeBp, taxBp } = await readRates(tx, session!.tenantId)

  // 4
  if (events.length === 0) throw new NothingToBillError()

  // Priced from the EVENT row, never from the menu: `unit_price_paisa` is what
  // was quoted when the dish was sent, and a mid-service re-price must not
  // change what a seated guest is charged (AC-10).
  //
  // A null price throws rather than coercing to 0 — see `UnpricedItemError`.
  const unpriced = events.find((event) => event.unitPricePaisa === null)
  if (unpriced) throw new UnpricedItemError(unpriced.eventId)

  const lineAmounts = events.map((event) => event.quantity * event.unitPricePaisa!)
  const grossPaisa = lineAmounts.reduce((total, amount) => total + amount, 0)

  // A comp REDUCES the subtotal, so it is stored negative and added. Storing it
  // negative rather than subtracting means a bill's lines and comps sum to its
  // subtotal with one `+`, which is what a dispute reader will try.
  const compAmounts = comps.map((comp) => -Math.abs(comp.amountPaisa))
  const compTotalPaisa = compAmounts.reduce((total, amount) => total + amount, 0)

  const subtotalPaisa = grossPaisa + compTotalPaisa
  // A bill the restaurant owes the guest is never right, and this table cannot
  // be corrected by UPDATE once written.
  if (subtotalPaisa < 0) throw new CompsExceedOrderError()

  const totals = computeBillTotals({
    subtotalPaisa,
    serviceChargeBp,
    taxBp,
    hasTableService,
  })

  // Before the insert, so `22003` cannot surface as an opaque 500.
  if (totals.totalPaisa > MAX_INT4 || totals.subtotalPaisa > MAX_INT4) {
    throw new BillTooLargeError()
  }

  // 5
  const [bill] = await tx
    .insert(bills)
    .values({
      tenantId: session!.tenantId,
      sessionId,
      staffId,
      type: 'consolidated',
      ...totals,
    })
    .returning({ id: bills.id, createdAt: bills.createdAt })

  try {
    await tx.insert(billLines).values(
      events.map((event, index) => ({
        billId: bill!.id,
        orderEventId: event.eventId,
        amountPaisa: lineAmounts[index]!,
        // Snapshotted, not joined at render time (migration 0019). The name a
        // guest was charged under must not change when the owner edits a menu.
        name: event.itemName ?? 'Unknown item',
        seatLabel: event.seatLabel,
        modifierText: event.modifierText,
      })),
    )
    if (comps.length > 0) {
      await tx.insert(billComps).values(
        comps.map((comp, index) => ({
          billId: bill!.id,
          compRecordId: comp.compRecordId,
          amountPaisa: compAmounts[index]!,
        })),
      )
    }
  } catch (error) {
    // Two indexes, two meanings. Collapsing them meant a comp already attached
    // to another bill was reported as "this order already has a bill", which is
    // precisely the mis-attribution `isUniqueViolation` exists to prevent.
    if (isUniqueViolation(error, 'idx_bill_lines_order_event')) {
      // Another bill got these events first. Its id is not in hand — this
      // transaction is about to roll back and cannot read it — so the route
      // re-reads outside the aborted transaction. Step 2 catches this case
      // normally; reaching here means the lock was bypassed.
      throw new BillAlreadyOpenError('')
    }
    if (isUniqueViolation(error, 'idx_bill_comps_comp_record')) {
      throw new CompAlreadyBilledError()
    }
    throw error
  }

  return {
    billId: bill!.id,
    sessionId,
    type: 'consolidated',
    createdAt: bill!.createdAt.toISOString(),
    ...totals,
    lines: events.map((event, index) => ({
      orderEventId: event.eventId,
      name: event.itemName ?? 'Unknown item',
      quantity: event.quantity,
      unitPricePaisa: event.unitPricePaisa ?? 0,
      amountPaisa: lineAmounts[index]!,
      seatLabel: event.seatLabel,
      modifierText: event.modifierText,
      roundNumber: event.roundNumber,
    })),
    comps: comps.map((comp, index) => ({
      compRecordId: comp.compRecordId,
      amountPaisa: compAmounts[index]!,
      reason: comp.reason,
    })),
  }
}

/**
 * One bill, with everything FR27 says it must itemise (AC-4).
 *
 * Read from `bill_lines`, NOT recomputed from the session: a bill is a snapshot
 * and must render the same a week later, after prices and rates have moved. The
 * unit price shown is the one stored on the event, and the rates shown are the
 * ones stored on the bill.
 */
export async function getBill(
  executor: Tx | typeof db,
  billId: string,
): Promise<BillDetail | null> {
  const [bill] = await executor
    .select({
      id: bills.id,
      sessionId: bills.sessionId,
      type: bills.type,
      subtotalPaisa: bills.subtotalPaisa,
      serviceChargePaisa: bills.serviceChargePaisa,
      taxPaisa: bills.taxPaisa,
      totalPaisa: bills.totalPaisa,
      serviceChargeBp: bills.serviceChargeBp,
      taxBp: bills.taxBp,
      createdAt: bills.createdAt,
    })
    .from(bills)
    .where(eq(bills.id, billId))
    .limit(1)

  if (!bill) return null

  // ── Only ONE join, and it is to an append-only table ──────────────────────
  // `name`, `seat_label` and `modifier_text` now come from `bill_lines` itself
  // (migration 0019). They used to be joined from `menu_items` and `seat_slots`
  // at render time, which meant renaming a dish rewrote every historical bill
  // and deleting one rendered a real charge as "Unknown item" — on the exact
  // document Epic 7 puts in front of a customer during a dispute.
  //
  // `order_events` is still joined, for `quantity` and `unit_price_paisa`. That
  // one is safe: the table is append-only and its price column is the original
  // quote, which is the same reason the money was already immutable. The
  // ordering is taken from it too.
  const lines: BillLineDetail[] = (
    await executor
      .select({
        orderEventId: billLines.orderEventId,
        amountPaisa: billLines.amountPaisa,
        name: billLines.name,
        seatLabel: billLines.seatLabel,
        modifierText: billLines.modifierText,
        quantity: orderEvents.quantity,
        unitPricePaisa: orderEvents.unitPricePaisa,
        roundNumber: orderEvents.roundNumber,
      })
      .from(billLines)
      .innerJoin(orderEvents, eq(orderEvents.id, billLines.orderEventId))
      .where(eq(billLines.billId, billId))
      .orderBy(asc(orderEvents.createdAt))
  ).map((line) => ({
    orderEventId: line.orderEventId,
    name: line.name,
    quantity: line.quantity,
    unitPricePaisa: line.unitPricePaisa ?? 0,
    amountPaisa: line.amountPaisa,
    seatLabel: line.seatLabel,
    modifierText: line.modifierText,
    roundNumber: line.roundNumber,
  }))

  const comps = await executor
    .select({
      compRecordId: billComps.compRecordId,
      amountPaisa: billComps.amountPaisa,
      reason: compRecords.reason,
    })
    .from(billComps)
    .innerJoin(compRecords, eq(compRecords.id, billComps.compRecordId))
    .where(eq(billComps.billId, billId))

  return {
    billId: bill.id,
    sessionId: bill.sessionId,
    type: bill.type,
    createdAt: bill.createdAt.toISOString(),
    subtotalPaisa: bill.subtotalPaisa,
    serviceChargePaisa: bill.serviceChargePaisa,
    taxPaisa: bill.taxPaisa,
    totalPaisa: bill.totalPaisa,
    serviceChargeBp: bill.serviceChargeBp,
    taxBp: bill.taxBp,
    lines,
    comps,
  }
}

/**
 * The bill a session has, fully rendered, or `null` (code review 2026-10-13).
 *
 * The order screen reads this on load so `settling` survives a refresh and is
 * the same on every tablet — the hole that let a billed session be served
 * again. `findOpenBill` answers the cheap yes/no for the services; this
 * returns the document.
 */
export async function loadSessionBill(
  executor: Tx | typeof db,
  sessionId: string,
): Promise<BillDetail | null> {
  const [existing] = await executor
    .select({ id: bills.id })
    .from(bills)
    .where(eq(bills.sessionId, sessionId))
    .orderBy(asc(bills.createdAt))
    .limit(1)

  return existing ? getBill(executor, existing.id) : null
}
