import 'server-only'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { isCheckViolation, isUniqueViolation } from '@/server/db/errors'
import {
  billComps,
  billLines,
  bills,
  compRecords,
  menuItems,
  orderEvents,
  orderSessions,
  seatSlots,
  tenantConfig,
} from '@/server/db/schema'
import { lockOpenSession } from '@/server/services/table-session.service'
import { billedUnits, hasUnbilledUnits, liveBill, voidedUnits } from '@/server/orders/units'
import { optionText } from '@/lib/options'
import type { BillDetail, BillLineDetail, BillTotals } from '@/types/bills'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ── Errors ───────────────────────────────────────────────────────────────────
// Typed, so the route maps each to its status without parsing messages — the
// pattern `order.service.ts` and `table-session.service.ts` use.

/** The session has no `ITEM_ADDED` events. An empty bill has no meaning (AC-11). */
export class NothingToBillError extends Error {}

/** This seat already has a bill (Story 6.4, AC-6). Carries it, so the route can name it. */
export class SeatBillAlreadyExistsError extends Error {
  constructor(readonly billId: string) {
    super('Seat already billed')
  }
}

/** The seat has no UNBILLED items of its own (Story 6.4, AC-7). */
export class SeatHasNoItemsError extends Error {}

/**
 * The seat belongs to a different session (Story 6.4, AC-8).
 *
 * Named `BillSeatNotOnSessionError`, not `SeatNotOnSessionError`, because
 * `order.service.ts` already exports a class by the latter name. Two exported
 * classes sharing a name in a codebase whose error handling is entirely
 * `instanceof` is a landmine: the wrong one reaching a `catch` fails the check
 * silently and the waiter gets a 500 where a 404 belongs (code review
 * 2026-10-13).
 */
export class BillSeatNotOnSessionError extends Error {}

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
  discountBp = 0,
  serviceChargeWaived = false,
}: {
  subtotalPaisa: number
  serviceChargeBp: number
  taxBp: number
  hasTableService: boolean
  /** The order discount, basis points (Teran, 2026-11-16). Off the subtotal, before service and tax. */
  discountBp?: number
  /** No service charge for this order — a special customer. */
  serviceChargeWaived?: boolean
}): BillTotals {
  const appliedServiceBp = hasTableService ? serviceChargeBp : 0
  // Discount first: service and tax are charged on what the guest pays for.
  const discountPaisa = Math.round((subtotalPaisa * discountBp) / 10_000)
  const netPaisa = subtotalPaisa - discountPaisa
  const wouldBeServicePaisa = Math.round((netPaisa * appliedServiceBp) / 10_000)
  const serviceChargePaisa = serviceChargeWaived ? 0 : wouldBeServicePaisa
  const taxPaisa = Math.round(((netPaisa + serviceChargePaisa) * taxBp) / 10_000)

  return {
    subtotalPaisa,
    discountBp,
    discountPaisa,
    // Only a waiver that gave something up counts as one.
    serviceChargeWaived: serviceChargeWaived && appliedServiceBp > 0,
    serviceWaivedPaisa: serviceChargeWaived ? wouldBeServicePaisa : 0,
    serviceChargePaisa,
    taxPaisa,
    totalPaisa: netPaisa + serviceChargePaisa + taxPaisa,
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
/**
 * The service rate this SESSION is operating under, if any bill exists yet.
 *
 * ── Why a session can only have one rate (Teran, 2026-10-15) ────────────────
 * `hasTableService` is read live from the attached tables, which a session can
 * gain and lose mid-service. A counter-origin party seated at a table had seat
 * 1 billed at 10%; the party went back to the bar, the table was released, and
 * seat 2 was billed at 0% — two guests of one party paying different rates on
 * append-only bills nobody can correct.
 *
 * So the FIRST bill decides. Every later bill on the session reuses the rate
 * that bill stored. Only the first consults the live table attachment.
 */
async function pinnedServiceBp(tx: Tx, sessionId: string): Promise<number | null> {
  const [first] = await tx
    .select({ serviceChargeBp: bills.serviceChargeBp })
    .from(bills)
    .where(eq(bills.sessionId, sessionId))
    .orderBy(asc(bills.createdAt))
    .limit(1)

  return first?.serviceChargeBp ?? null
}

async function readRates(tx: Tx, tenantId: string) {
  const [config] = await tx
    .select({
      serviceChargeBp: tenantConfig.serviceChargeBp,
      taxRatePercent: tenantConfig.taxRatePercent,
      defaultDiscountBp: tenantConfig.defaultDiscountBp,
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
    defaultDiscountBp: config.defaultDiscountBp,
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
async function collectBillable(
  tx: Tx,
  sessionId: string,
  { seatId, eventIds }: { seatId?: string; eventIds?: string[] } = {},
) {
  // Units of this event already TAKEN — on a live bill (migration 0025) or
  // voided (Story 7.5). An event is billable while this is below its quantity.
  // One definition: `server/orders/units.ts`.
  const takenUnits = sql<number>`(${billedUnits} + ${voidedUnits})`

  const rows = await tx
    .select({
      eventId: orderEvents.id,
      quantity: orderEvents.quantity,
      takenQuantity: takenUnits,
      unitPricePaisa: orderEvents.unitPricePaisa,
      modifierText: orderEvents.modifierText,
      // The options as sent (Story 4.8). Display only: the unit price above
      // already includes their deltas, so no money is computed from these.
      options: orderEvents.options,
      roundNumber: orderEvents.roundNumber,
      itemName: menuItems.name,
      // A custom charge's typed name (Story 4.9); null on every dish.
      customName: orderEvents.customName,
      seatLabel: seatSlots.seatLabel,
      // The bill screen pre-splits a Separate-bills order by seat.
      seatSlotId: orderEvents.seatSlotId,
      // For the bill screen's station chip only. Never stored on a bill line:
      // where a dish was cooked is not something a guest is charged for.
      destination: menuItems.productionDestination,
    })
    .from(orderEvents)
    .leftJoin(menuItems, eq(menuItems.id, orderEvents.menuItemId))
    .leftJoin(seatSlots, eq(seatSlots.id, orderEvents.seatSlotId))
    .where(
      and(
        eq(orderEvents.sessionId, sessionId),
        eq(orderEvents.eventType, 'ITEM_ADDED'),
        // ── UNBILLED only (Story 6.4) ─────────────────────────────────────
        // "Already billed" has exactly one definition and this is it: a
        // `bill_lines` row claims the event. There is deliberately no
        // `billed` flag on `order_events` — that would be a second source of
        // truth about the same fact, and the UNIQUE index on
        // `bill_lines.order_event_id` would then be guarding a copy.
        //
        // This is what lets a consolidated bill cover the REMAINDER after
        // some seats have paid, and what stops a seat bill re-claiming an
        // event a consolidated bill already took.
        //
        // UNITS, since migration 0025: an event of 2 with one unit on a
        // person's bill still has one to bill.
        // Voided units (Story 7.5) are never billable, and a cancelled bill
        // claims nothing.
        hasUnbilledUnits,
        // A seat bill covers one seat. A consolidated bill passes no seat and
        // therefore also picks up events with a NULL `seat_slot_id`, which no
        // seat bill could ever reach.
        ...(seatId ? [eq(orderEvents.seatSlotId, seatId)] : []),
        // A person's bill from the split screen (Story 6.3) covers exactly the
        // events the waiter dragged onto them. Still filtered by UNBILLED
        // above, so an event with nothing left drops out here — and the
        // caller compares counts to refuse that case.
        ...(eventIds ? [inArray(orderEvents.id, eventIds)] : []),
      ),
    )
    .orderBy(asc(orderEvents.createdAt))
  // "Extra shot ×2, No ice" — the form a bill line stores and shows.
  const events = rows.map(({ options, ...row }) => ({ ...row, optionText: optionText(options) }))

  // Comps are keyed off the EVENTS being billed, not off the session, so 6.4's
  // per-seat bill gets the same query unchanged: a comp follows the item it
  // reduced. Nothing writes `comp_records` until Epic 7, so this is empty in
  // the demo — which is exactly why it is verified with a hand-inserted row.
  const collectedIds = events.map((event) => event.eventId)
  const comps =
    collectedIds.length === 0
      ? []
      : await tx
          .select({
            compRecordId: compRecords.id,
            orderEventId: compRecords.orderEventId,
            amountPaisa: compRecords.amountPaysa,
            reason: compRecords.reason,
          })
          .from(compRecords)
          .where(inArray(compRecords.orderEventId, collectedIds))

  // Every order pays service, bar tabs included (Teran, 2026-11-21). It used to
  // be tables only, which the order screen never followed: a bar tab showed a
  // service line there that its bill then left off. The order's own waiver
  // (`service_charge_waived`) is how a single order goes without.
  return { events, comps, hasTableService: true }
}

/**
 * The bill a session already has, if any.
 *
 * Exported because `order.service.ts` asks the same question before accepting
 * a round. One implementation, so "is this session billed?" cannot come to
 * two different answers in two places (code review 2026-10-13).
 */
export async function findConsolidatedBill(tx: Tx, sessionId: string) {
  // ── Why "any bill" stopped being the right question ───────────────────────
  // Until Story 6.4 a session could hold one bill, so "does this session have
  // a bill?" answered everything: whether a second could be generated, and
  // whether a round could still be added. Per-seat billing splits that into
  // three different questions, and conflating them is what made the first
  // version of this guard refuse every round on a table where ONE seat had
  // paid — see `SeatAlreadyBilledError` in `order.service.ts`.
  //
  // A bill is append-only and carries no `status` column, so "open" means the
  // payments against it sum to less than its total, which Story 6.5 can ask
  // once `payment_records` gains `bill_id`. Until then there are no payments,
  // so every bill is open and these are the same answer. 6.5 NARROWS these
  // queries; it does not replace them.
  //
  // By TYPE since Story 6.3, not by "has no seat". A person's split bill has
  // no seat either, and reading it as consolidated would refuse every later
  // round and every later bill on a table where one guest had paid.
  const [existing] = await tx
    .select({ id: bills.id })
    .from(bills)
    // A cancelled bill (Story 7.5) is not "the bill" — the session is billed again.
    .where(and(eq(bills.sessionId, sessionId), eq(bills.type, 'consolidated'), liveBill))
    .orderBy(asc(bills.createdAt))
    .limit(1)

  return existing ?? null
}

/** The bill covering one seat, if that seat has been billed. */
export async function findSeatBill(tx: Tx, sessionId: string, seatId: string) {
  const [existing] = await tx
    .select({ id: bills.id })
    .from(bills)
    .where(and(eq(bills.sessionId, sessionId), eq(bills.seatSlotId, seatId), liveBill))
    .limit(1)

  return existing ?? null
}

/**
 * Every seat on this session that already has a bill, with its label.
 *
 * The label travels so a refusal can say "Seat 2 has already been billed"
 * rather than quoting a uuid at a waiter holding a tablet.
 */
export async function billedSeats(
  tx: Tx,
  sessionId: string,
): Promise<Map<string, { billId: string; seatLabel: string }>> {
  const rows = await tx
    .select({ billId: bills.id, seatSlotId: bills.seatSlotId, seatLabel: seatSlots.seatLabel })
    .from(bills)
    .innerJoin(seatSlots, eq(seatSlots.id, bills.seatSlotId))
    .where(and(eq(bills.sessionId, sessionId), isNotNull(bills.seatSlotId), liveBill))

  return new Map(
    rows.map((row) => [row.seatSlotId!, { billId: row.billId, seatLabel: row.seatLabel }]),
  )
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
/**
 * Generates the consolidated bill for a session (FR21, FR27).
 *
 * Since Story 6.4 this covers the REMAINDER: every event not already on some
 * bill. Two guests paying individually and the other four sharing one bill is
 * the ordinary case per-seat billing exists for, so a session that holds seat
 * bills can still be billed consolidated — only another CONSOLIDATED bill
 * blocks it.
 */
export async function generateConsolidatedBill(
  tx: Tx,
  { sessionId, staffId }: { sessionId: string; staffId: string },
): Promise<BillDetail> {
  // Throws SessionAlreadyClosedError for a closed or missing session, and
  // stops a round committing while the bill is computed.
  await lockOpenSession(tx, sessionId)

  const existing = await findConsolidatedBill(tx, sessionId)
  if (existing) throw new BillAlreadyOpenError(existing.id)

  return buildBill(tx, { sessionId, staffId, seatId: null })
}

/**
 * Generates a bill for ONE seat, leaving the rest of the table open
 * (Story 6.4, FR25/FR26).
 *
 * ── What stops this double-billing ───────────────────────────────────────────
 * Three mechanisms, at three different statements, and they are not redundant:
 *
 * 1. `lockOpenSession` serialises two simultaneous taps on the session row, so
 *    the second sees the first's committed bill at the `findSeatBill` check.
 * 2. `idx_bills_seat_slot` (partial unique) rejects a second bill for the same
 *    seat at the `bills` INSERT. This is the guarantee that does not depend on
 *    a future caller remembering the lock.
 * 3. `idx_bill_lines_order_event` rejects any attempt to claim an event twice,
 *    whatever the bill type — the invariant Story 6.2 built for this story.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────
 * It does not close the seat, the session or the table. A bill is not a
 * payment; Story 6.5 owns settlement, and "this table is finished" is
 * `everyBillSettled AND nothing left to bill` — see `deferred-work.md`.
 */
export async function generateSeatBill(
  tx: Tx,
  { sessionId, seatId, staffId }: { sessionId: string; seatId: string; staffId: string },
): Promise<BillDetail> {
  await lockOpenSession(tx, sessionId)

  // AC-8. A seat id from another session is a 404, not a 500 and not a bill
  // against the wrong table.
  const [seat] = await tx
    .select({ id: seatSlots.id })
    .from(seatSlots)
    .where(and(eq(seatSlots.id, seatId), eq(seatSlots.sessionId, sessionId)))
    .limit(1)
  if (!seat) throw new BillSeatNotOnSessionError()

  const existing = await findSeatBill(tx, sessionId, seatId)
  if (existing) throw new SeatBillAlreadyExistsError(existing.id)

  // No check for a CONSOLIDATED bill here, deliberately. One would have swept
  // every unbilled event including this seat's, so `collectBillable` comes
  // back empty and `SeatHasNoItemsError` is raised below — which is the true
  // statement ("this seat has nothing left to bill") rather than a 409
  // claiming the seat has its own bill when it does not.

  return buildBill(tx, { sessionId, staffId, seatId })
}

/**
 * Some of a split's items are already billed, more units were asked for than
 * are left, or an event is not on this session.
 */
export class ItemsNotBillableError extends Error {}

/**
 * Prices what a bill WOULD hold, without writing anything.
 *
 * ── One implementation for the preview and the bill ──────────────────────────
 * The bill screen shows the table's unbilled items and their total before
 * anything is recorded (Story 6.5: the bill is written at Settle, not at
 * "Bill & split"). If the screen did its own arithmetic, the figure a waiter
 * reads to a guest and the figure that gets stored could drift — so both go
 * through here, and `buildBill` only adds the INSERTs.
 *
 * Must run under `lockOpenSession` when its result is about to be written;
 * the preview reads it without the lock, which is fine for a number that is
 * re-derived under the lock at Settle.
 */
export async function priceBillable(
  tx: Tx,
  {
    sessionId,
    seatId = null,
    items,
  }: {
    sessionId: string
    seatId?: string | null
    /**
     * A person's share (Story 6.3): these events, and how many units of
     * each. Absent means every unbilled unit — the whole table, or one seat.
     */
    items?: { eventId: string; quantity: number }[]
  },
) {
  const [session] = await tx
    .select({
      tenantId: orderSessions.tenantId,
      // This order's own discount and waiver (Teran, 2026-11-16).
      discountBp: orderSessions.discountBp,
      serviceChargeWaived: orderSessions.serviceChargeWaived,
    })
    .from(orderSessions)
    .where(eq(orderSessions.id, sessionId))
    .limit(1)

  // 3 — UNBILLED events only, and for one seat when this is a seat bill.
  const requested = items ? new Map(items.map((item) => [item.eventId, item.quantity])) : null
  const { events, comps: allComps, hasTableService } = await collectBillable(tx, sessionId, {
    seatId: seatId ?? undefined,
    eventIds: requested ? [...requested.keys()] : undefined,
  })

  // How many units each line bills: what was asked for, or all that is left.
  // Asking for more than is left is refused whole, never trimmed — a guest
  // must not be billed for fewer cashews than the screen showed them.
  const lineQuantities = events.map((event) => {
    const left = event.quantity - event.takenQuantity
    const want = requested?.get(event.eventId) ?? left
    if (want < 1 || want > left) throw new ItemsNotBillableError()
    return want
  })

  // A comp follows its item onto the bill that takes the item's LAST unit. An
  // event split across two bills would otherwise try to attach the same comp
  // twice, and `idx_bill_comps_comp_record` allows it once. Nothing writes
  // comps until Epic 7; this keeps the rule honest for when something does.
  const finishing = new Set(
    events
      .filter((event, index) => lineQuantities[index] === event.quantity - event.takenQuantity)
      .map((event) => event.eventId),
  )
  const comps = allComps.filter((comp) => finishing.has(comp.orderEventId))
  const { serviceChargeBp, taxBp, defaultDiscountBp } = await readRates(tx, session!.tenantId)

  // One party, one rate. `null` means this is the session's first bill, so the
  // live table attachment decides and this bill sets the precedent.
  const pinned = await pinnedServiceBp(tx, sessionId)

  // Priced from the EVENT row, never from the menu: `unit_price_paisa` is what
  // was quoted when the dish was sent, and a mid-service re-price must not
  // change what a seated guest is charged (AC-10).
  //
  // A null price throws rather than coercing to 0 — see `UnpricedItemError`.
  const unpriced = events.find((event) => event.unitPricePaisa === null)
  if (unpriced) throw new UnpricedItemError(unpriced.eventId)

  const lineAmounts = events.map((event, index) => lineQuantities[index]! * event.unitPricePaisa!)
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
    // A pinned rate of 0 is as binding as a pinned 1000: it records that this
    // party's first bill carried no service charge, and the rest must match.
    serviceChargeBp: pinned ?? serviceChargeBp,
    taxBp,
    hasTableService: pinned === null ? hasTableService : pinned > 0,
    // Null on the order means the restaurant's default.
    discountBp: session!.discountBp ?? defaultDiscountBp,
    serviceChargeWaived: session!.serviceChargeWaived,
  })

  return {
    tenantId: session!.tenantId,
    events,
    comps,
    lineQuantities,
    lineAmounts,
    compAmounts,
    totals,
  }
}

/**
 * One person's bill from the bill screen's split (Story 6.3, FR24).
 *
 * Covers EXACTLY the units the waiter moved onto that person — one of a
 * "2× Devilled Cashew" is fine since migration 0025. The unbilled
 * filter in `collectBillable` drops any that another bill already claimed (or
 * that belong to a different session), so a count mismatch means the screen
 * was out of date — refused whole rather than billing a guest for part of
 * what they were shown.
 *
 * The same guards as every bill: the session lock, the
 * `bill_lines_within_event_quantity` trigger, and the pinned service rate, so
 * the first person to pay sets the rate the rest of the party pays.
 */
export async function generateSplitBill(
  tx: Tx,
  {
    sessionId,
    staffId,
    items,
    personLabel,
  }: {
    sessionId: string
    staffId: string
    items: { eventId: string; quantity: number }[]
    personLabel: string
  },
): Promise<BillDetail> {
  await lockOpenSession(tx, sessionId)

  // A whole-table bill already took everything (code review P4). Say so, with
  // its id — "refresh and try again" sent a stale tablet round in circles.
  const consolidated = await findConsolidatedBill(tx, sessionId)
  if (consolidated) throw new BillAlreadyOpenError(consolidated.id)

  // One entry per event; the screen never sends two, and two would be ambiguous.
  if (new Set(items.map((item) => item.eventId)).size !== items.length) {
    throw new ItemsNotBillableError()
  }
  const { events } = await priceBillable(tx, { sessionId, items })
  if (events.length !== items.length) throw new ItemsNotBillableError()

  return buildBill(tx, { sessionId, staffId, seatId: null, items, personLabel })
}

async function buildBill(
  tx: Tx,
  {
    sessionId,
    staffId,
    seatId,
    items,
    personLabel = null,
  }: {
    sessionId: string
    staffId: string
    seatId: string | null
    items?: { eventId: string; quantity: number }[]
    /** Set for a person's split bill (Story 6.3). */
    personLabel?: string | null
  },
): Promise<BillDetail> {
  const type: BillDetail['type'] = seatId ? 'seat' : items ? 'split' : 'consolidated'
  const { tenantId, events, comps, lineQuantities, lineAmounts, compAmounts, totals } =
    await priceBillable(tx, { sessionId, seatId, items })

  // 4 — for a seat, "nothing left" is SeatHasNoItemsError; for the session it
  // is NothingToBillError, which since 6.4 also means "everything is already
  // billed" — the right answer for a fully-settled table.
  if (events.length === 0) {
    throw seatId ? new SeatHasNoItemsError() : new NothingToBillError()
  }

  // Before the insert, so `22003` cannot surface as an opaque 500.
  if (totals.totalPaisa > MAX_INT4 || totals.subtotalPaisa > MAX_INT4) {
    throw new BillTooLargeError()
  }

  // 5 — the bills INSERT is INSIDE a try of its own.
  //
  // `idx_bills_seat_slot` is an index on `bills`, so a second bill for the
  // same seat raises its 23505 HERE, not on the `bill_lines` insert below.
  // This statement sat outside any catch until Story 6.4, which was correct
  // while `bills` carried no unique index — and would have turned AC-6 and
  // AC-9 into undifferentiated 500s the moment one was added.
  let bill: { id: string; createdAt: Date } | undefined
  try {
    ;[bill] = await tx
      .insert(bills)
      .values({
        tenantId,
        sessionId,
        staffId,
        seatSlotId: seatId,
        type,
        personLabel,
        ...totals,
      })
      .returning({ id: bills.id, createdAt: bills.createdAt })
  } catch (error) {
    // `seatId !== null` guard: `isUniqueViolation` deliberately treats an
    // ABSENT constraint name as a match, so without this any 23505 raised on
    // the consolidated path became a seat collision — an error `/bills/route`
    // has no branch for, which then fell through to a 500 naming a collision
    // that cannot happen (code review 2026-10-13).
    if (seatId !== null && isUniqueViolation(error, 'idx_bills_seat_slot')) {
      // The id is not in hand — this transaction is rolling back and cannot
      // read the winner — so the route re-reads outside it.
      throw new SeatBillAlreadyExistsError('')
    }
    throw error
  }

  try {
    await tx.insert(billLines).values(
      events.map((event, index) => ({
        billId: bill!.id,
        orderEventId: event.eventId,
        quantity: lineQuantities[index]!,
        amountPaisa: lineAmounts[index]!,
        // Snapshotted, not joined at render time (migration 0019). The name a
        // guest was charged under must not change when the owner edits a menu.
        name: event.customName ?? event.itemName ?? 'Unknown item',
        seatLabel: event.seatLabel,
        modifierText: event.modifierText,
        // Snapshotted like the name (Story 4.8): the options a guest was
        // charged for must read the same after the owner renames one.
        optionText: event.optionText,
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
    if (isCheckViolation(error, 'bill_lines_within_event_quantity')) {
      // Another bill took these units first — the database's own guard, which
      // replaced `UNIQUE (order_event_id)` in migration 0025. For a person's
      // share that is "these items are no longer free"; for the table's bill
      // it is the old meaning, another bill got there first, and the route
      // re-reads its id outside this aborted transaction.
      if (type === 'split') throw new ItemsNotBillableError()
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
    type,
    seatSlotId: seatId,
    personLabel,
    // A new bill has no short: only a payment can write one off.
    shortPaisa: 0,
    shortNote: null,
    // Gated on `seatId`. Unconditional, this returned the first collected
    // event's seat on a CONSOLIDATED bill, so POST said `seatLabel: 'S1'` while
    // a GET of the same bill said null — and the POST value came from the live
    // `seat_slots` join that migration 0019 removed (code review 2026-10-13).
    seatLabel: seatId ? (events[0]?.seatLabel ?? null) : null,
    createdAt: bill!.createdAt.toISOString(),
    cancelledAt: null,
    ...totals,
    lines: events.map((event, index) => ({
      orderEventId: event.eventId,
      name: event.customName ?? event.itemName ?? 'Unknown item',
      quantity: lineQuantities[index]!,
      unitPricePaisa: event.unitPricePaisa ?? 0,
      amountPaisa: lineAmounts[index]!,
      seatLabel: event.seatLabel,
      modifierText: event.modifierText,
      optionText: event.optionText,
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
      discountBp: bills.discountBp,
      discountPaisa: bills.discountPaisa,
      serviceChargeWaived: bills.serviceChargeWaived,
      serviceWaivedPaisa: bills.serviceWaivedPaisa,
      seatSlotId: bills.seatSlotId,
      personLabel: bills.personLabel,
      createdAt: bills.createdAt,
      cancelledAt: bills.cancelledAt,
      shortPaisa: bills.shortPaisa,
      shortNote: bills.shortNote,
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
        optionText: billLines.optionText,
        // The units THIS bill took, not the event's — a split cashew bills 1
        // of 2 (migration 0025).
        quantity: billLines.quantity,
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
    optionText: line.optionText,
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
    seatSlotId: bill.seatSlotId,
    // From the SNAPSHOT on `bill_lines`, not a `seat_slots` join — migration
    // 0019 removed that join and re-adding it here would undo it. A seat
    // bill's lines all carry the same label.
    seatLabel: bill.seatSlotId ? (lines[0]?.seatLabel ?? null) : null,
    personLabel: bill.personLabel,
    createdAt: bill.createdAt.toISOString(),
    cancelledAt: bill.cancelledAt ? bill.cancelledAt.toISOString() : null,
    subtotalPaisa: bill.subtotalPaisa,
    serviceChargePaisa: bill.serviceChargePaisa,
    taxPaisa: bill.taxPaisa,
    totalPaisa: bill.totalPaisa,
    serviceChargeBp: bill.serviceChargeBp,
    taxBp: bill.taxBp,
    discountBp: bill.discountBp,
    discountPaisa: bill.discountPaisa,
    serviceChargeWaived: bill.serviceChargeWaived,
    serviceWaivedPaisa: bill.serviceWaivedPaisa,
    shortPaisa: bill.shortPaisa,
    shortNote: bill.shortNote,
    lines,
    comps,
  }
}

/**
 * Every bill on a session, fully rendered, oldest first.
 *
 * ── Plural since Story 6.4 ───────────────────────────────────────────────────
 * It returned a single bill while a session could only have one. Per-seat
 * billing makes "the session's bill" a question with no answer, and the
 * singular form would have quietly reported the oldest — usually a seat bill —
 * as though it were the whole table's.
 *
 * The order screen reads this so `settling` survives a reload and is the same
 * on every tablet. Story 6.5 reads it to ask whether everything is settled.
 */
export async function loadSessionBills(
  executor: Tx | typeof db,
  sessionId: string,
): Promise<BillDetail[]> {
  const rows = await executor
    .select({ id: bills.id })
    .from(bills)
    // Cancelled bills (Story 7.5) are not the session's bills any more.
    .where(and(eq(bills.sessionId, sessionId), liveBill))
    .orderBy(asc(bills.createdAt))

  const loaded = await Promise.all(rows.map((row) => getBill(executor, row.id)))

  // A null here means a row `bills` has and `getBill` could not render. It used
  // to be filtered away in silence, so the screen showed fewer bills than exist
  // — a billed seat's chip un-struck, "Bill This Seat" offered again — while
  // `hasUnbilledItems`, computed separately, disagreed with nothing to flag it.
  const missing = rows.filter((row, i) => loaded[i] === null).map((row) => row.id)
  if (missing.length > 0) {
    console.error('[bill.service] loadSessionBills could not render bills:', missing)
  }

  return loaded.filter((bill): bill is BillDetail => bill !== null)
}

/**
 * Is there anything on this session that no bill covers?
 *
 * ── Defined ONCE, on purpose ─────────────────────────────────────────────────
 * Two callers need exactly this question and would otherwise each invent it:
 * the order screen, to decide whether the action strip is `settling`, and
 * Story 6.5, to decide whether a table may auto-close.
 *
 * 6.5's criterion as the epic words it — "the last open bill in a session is
 * marked settled" — is WRONG on its own after this story. A session can have
 * every bill settled and still have unbilled items: seats 1 and 2 paid and
 * left, seats 3 and 4 still eating. Closing then would release an occupied
 * table onto the floor plan mid-service. The correct predicate is
 * `everyBillSettled AND NOT hasUnbilledItems`, and this is its second half.
 */
export async function hasUnbilledItems(
  executor: Tx | typeof db,
  sessionId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ eventId: orderEvents.id })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.sessionId, sessionId),
        eq(orderEvents.eventType, 'ITEM_ADDED'),
        // Units, since migration 0025: one cashew of two on a person's bill
        // leaves the other unbilled, and the table must not close over it.
        // Voided units and cancelled bills (Story 7.5): `server/orders/units.ts`.
        hasUnbilledUnits,
      ),
    )
    .limit(1)

  return row !== undefined
}
