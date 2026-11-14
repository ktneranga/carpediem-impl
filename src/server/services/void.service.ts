import 'server-only'
import bcrypt from 'bcryptjs'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { isCheckViolation } from '@/server/db/errors'
import {
  bills,
  menuItems,
  orderEvents,
  orderRounds,
  orderSessions,
  orderSessionTables,
  printJobs,
  seatSlots,
  staff,
  tables,
  tenants,
  zones,
} from '@/server/db/schema'
import { DUMMY_PIN_HASH } from '@/server/auth/dummy-pin-hash'
import { canApproveVoids, type StaffRole } from '@/server/auth/permissions'
import { billedUnits, voidedUnits } from '@/server/orders/units'
import { buildVoidTicketPayload } from '@/server/print/ticket'
import { lockOpenSession } from '@/server/services/table-session.service'
import { zoneUsesSeats } from '@/lib/zone-seats'
import { optionLabel } from '@/lib/options'
import { reasonText, type VoidResult } from '@/types/voids'

/**
 * Voiding a sent item and cancelling an unpaid bill (Story 7.5).
 *
 * ── A void is an `ITEM_VOIDED` order event ───────────────────────────────────
 * Linked to the `ITEM_ADDED` line by `voids_event_id`; the line is never
 * touched. Voided units are never billable (`server/orders/units.ts`), so the
 * guest's bill simply leaves them out. `order_event_void_within_quantity`
 * (migration 0043) is the guarantee against over-voiding; the check here is for
 * the message.
 *
 * ── A cancel is a one-way stamp on `bills` ───────────────────────────────────
 * Only a bill with no payments. Its lines stay; a cancelled bill counts nowhere,
 * so its units are billable again. `immutable_bills` allows that one update.
 *
 * Ported from the reverted 7.3 build (git stash, 2026-11-06): the approver
 * lookup, the lockout and the VOID ticket. Narrowed to the owner role — there
 * is no manager role and no `comp` permission yet.
 */

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ── Errors ───────────────────────────────────────────────────────────────────
export class VoidEventNotOnSessionError extends Error {}
export class VoidNotEnoughUnitsError extends Error {
  constructor(public readonly unitsLeft: number) {
    super('Not enough units left to void')
  }
}
export class CancelBillNotFoundError extends Error {}
export class BillHasPaymentsError extends Error {}
export class BillAlreadyCancelledError extends Error {}

// ── Wrong-PIN lockout ────────────────────────────────────────────────────────
// A waiter could otherwise try all 10,000 PINs from the void sheet, and the
// owner's approval PIN is also their sign-in. Counted per REQUESTING staff
// member, in this process's memory: the POS runs as one server, and a restart
// clearing the count is acceptable for a lock measured in minutes. A right PIN
// clears the count.
const MAX_WRONG_PINS = 5
const LOCKOUT_MS = 5 * 60 * 1000
const wrongPins = new Map<string, { count: number; lockedUntil: number }>()

function lockedForMs(staffId: string, now: number): number {
  const entry = wrongPins.get(staffId)
  if (!entry || entry.lockedUntil === 0) return 0
  if (entry.lockedUntil > now) return entry.lockedUntil - now
  wrongPins.delete(staffId)
  return 0
}

function noteWrongPin(staffId: string, now: number): void {
  const entry = wrongPins.get(staffId) ?? { count: 0, lockedUntil: 0 }
  entry.count += 1
  if (entry.count >= MAX_WRONG_PINS) entry.lockedUntil = now + LOCKOUT_MS
  wrongPins.set(staffId, entry)
}

/**
 * The staff member who may approve voids whose PIN this is, or null: an active
 * owner, or an active waiter holding `approve_voids` (Story 10.6).
 *
 * A PIN lookup, not a sign-in: nothing else happens, the waiter stays signed
 * in. Every candidate is compared with no early exit, and the dummy hash is
 * burned when there are none, so a wrong PIN, a waiter's PIN and an install
 * with no owners cost the same (the login route's rule).
 */
export async function findApprover(tenantId: string, pin: string): Promise<string | null> {
  const active = await db
    .select({ id: staff.id, role: staff.role, permissions: staff.permissions, pinHash: staff.pinHash })
    .from(staff)
    .where(and(eq(staff.tenantId, tenantId), eq(staff.isActive, true)))
  const owners = active.filter((person) => canApproveVoids(person.role, person.permissions))

  if (owners.length === 0) {
    await bcrypt.compare(pin, DUMMY_PIN_HASH)
    return null
  }
  let approver: string | null = null
  for (const owner of owners) {
    const isMatch = await bcrypt.compare(pin, owner.pinHash)
    if (isMatch && approver === null) approver = owner.id
  }
  return approver
}

export type Approval =
  | { ok: true; staffId: string; approverId: string }
  | { ok: false; code: string; message: string; status: number }

/**
 * Who is asking and who approves. An owner approves their own request (any PIN
 * sent is ignored). Anyone else needs an owner-role PIN. Identity comes from the
 * proxy's headers, never the body.
 */
export async function resolveApproval({
  staffId,
  role,
  permissions = [],
  tenantId,
  approverPin,
}: {
  staffId: string
  role: StaffRole | null
  /** From `x-staff-permissions` (the proxy, from the database). */
  permissions?: readonly string[]
  tenantId: string
  approverPin: string | undefined
}): Promise<Approval> {
  // Owners, and holders of `approve_voids` (Story 10.6), approve their own.
  if (canApproveVoids(role, permissions)) return { ok: true, staffId, approverId: staffId }

  if (!approverPin) {
    return { ok: false, code: 'APPROVAL_REQUIRED', message: 'Someone allowed to approve voids needs to enter their PIN', status: 403 }
  }

  // Before the compare, so a locked-out loop costs no bcrypt either.
  const now = Date.now()
  const lockedMs = lockedForMs(staffId, now)
  if (lockedMs > 0) {
    const minutes = Math.ceil(lockedMs / 60_000)
    return {
      ok: false,
      code: 'PIN_LOCKED',
      message: `Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      status: 429,
    }
  }

  const approverId = await findApprover(tenantId, approverPin)
  if (!approverId) {
    noteWrongPin(staffId, now)
    return { ok: false, code: 'INVALID_PIN', message: "That PIN can't approve voids", status: 401 }
  }
  wrongPins.delete(staffId)
  return { ok: true, staffId, approverId }
}

/** For the verify script only: forget every wrong-PIN count. */
export function resetWrongPinsForTests(): void {
  wrongPins.clear()
}

/**
 * Voids `quantity` units of one sent item, and queues a VOID ticket to its
 * station in the same transaction, so the kitchen is never told about a void
 * that rolled back.
 *
 * Idempotent on `requestId`: a replay returns the first answer.
 */
export async function voidItem(
  tx: Tx,
  {
    sessionId,
    orderEventId,
    quantity,
    reason,
    note,
    requestId,
    staffId,
    approverId,
  }: {
    sessionId: string
    orderEventId: string
    quantity: number
    reason: string
    note: string | null
    requestId: string
    staffId: string
    approverId: string
  },
): Promise<VoidResult> {
  // Closed or missing → SessionAlreadyClosedError. Also serialises this void
  // with a bill or another void on the same order.
  await lockOpenSession(tx, sessionId)

  const replay = await findVoidByRequest(tx, sessionId, requestId)
  if (replay) return replay

  const [line] = await tx
    .select({
      id: orderEvents.id,
      quantity: orderEvents.quantity,
      billed: billedUnits,
      voided: voidedUnits,
      menuItemId: orderEvents.menuItemId,
      customName: orderEvents.customName,
      unitPricePaisa: orderEvents.unitPricePaisa,
      seatSlotId: orderEvents.seatSlotId,
      roundNumber: orderEvents.roundNumber,
      modifierText: orderEvents.modifierText,
      options: orderEvents.options,
      itemName: menuItems.name,
      destination: menuItems.productionDestination,
      seatLabel: seatSlots.seatLabel,
      seatNote: seatSlots.seatNote,
    })
    .from(orderEvents)
    .leftJoin(menuItems, eq(menuItems.id, orderEvents.menuItemId))
    .leftJoin(seatSlots, eq(seatSlots.id, orderEvents.seatSlotId))
    .where(and(eq(orderEvents.id, orderEventId), eq(orderEvents.sessionId, sessionId), eq(orderEvents.eventType, 'ITEM_ADDED')))
    .limit(1)
  if (!line) throw new VoidEventNotOnSessionError()

  const unitsLeft = line.quantity - Number(line.billed) - Number(line.voided)
  if (quantity > unitsLeft) throw new VoidNotEnoughUnitsError(Math.max(unitsLeft, 0))

  let voided: { id: string; createdAt: Date } | undefined
  try {
    ;[voided] = await tx
      .insert(orderEvents)
      .values({
        sessionId,
        staffId,
        approvedByStaffId: approverId,
        eventType: 'ITEM_VOIDED',
        voidsEventId: line.id,
        menuItemId: line.menuItemId,
        // Copied so the dashboard and history can name it like the line.
        customName: line.customName,
        unitPricePaisa: line.unitPricePaisa,
        seatSlotId: line.seatSlotId,
        roundNumber: line.roundNumber,
        quantity,
        notes: reasonText(reason, note),
        requestId,
      })
      .returning({ id: orderEvents.id, createdAt: orderEvents.createdAt })
  } catch (error) {
    // The trigger found the units gone: a writer that skipped the lock.
    if (isCheckViolation(error, 'order_event_void_within_quantity')) throw new VoidNotEnoughUnitsError(0)
    throw error
  }

  // ── The VOID ticket ───────────────────────────────────────────────────────
  // A custom charge was never made by a kitchen: no ticket, and the sheet must
  // not tell anyone to stop it.
  const ticketNeeded = line.menuItemId !== null
  let ticketQueued = false
  if (ticketNeeded && line.destination !== null) {
    // `print_jobs.round_id` is NOT NULL: the job belongs to the round the dish
    // went out in. Rows from before migration 0014 have no round row; for those
    // the void is still recorded and the sheet says to tell the kitchen.
    const round = await findVoidRound(tx, sessionId, line.roundNumber)
    if (round) {
      const [session] = await tx
        .select({
          tenantId: orderSessions.tenantId,
          timeZone: tenants.timezone,
          dailyNumber: orderSessions.dailyNumber,
          businessDate: orderSessions.businessDate,
        })
        .from(orderSessions)
        .innerJoin(tenants, eq(tenants.id, orderSessions.tenantId))
        .where(eq(orderSessions.id, sessionId))
        .limit(1)

      // Same header as the round's own ticket: every table on the session now.
      const attached = await tx
        .select({ label: tables.label, zoneName: zones.name })
        .from(orderSessionTables)
        .innerJoin(tables, eq(tables.id, orderSessionTables.tableId))
        .innerJoin(zones, eq(zones.id, tables.zoneId))
        .where(and(eq(orderSessionTables.sessionId, sessionId), isNull(orderSessionTables.releasedAt)))
        .orderBy(asc(tables.label))

      const ticket = buildVoidTicketPayload({
        destination: line.destination,
        roundNumber: line.roundNumber!,
        tableLabels: attached.map((table) => table.label),
        usesSeats: zoneUsesSeats(attached[0]?.zoneName ?? null),
        voidedAt: voided!.createdAt,
        timeZone: session!.timeZone,
        dailyNumber: session!.dailyNumber,
        businessDate: session!.businessDate,
        line: {
          eventId: line.id,
          name: line.itemName ?? 'Item',
          quantity,
          options: (line.options ?? []).map(optionLabel),
          modifierText: line.modifierText,
          seatLabel: line.seatLabel ?? '',
          seatNote: line.seatNote,
        },
      })
      await tx.insert(printJobs).values({
        tenantId: session!.tenantId,
        sessionId,
        roundId: round.id,
        destination: ticket.destination,
        ticket,
      })
      ticketQueued = true
    }
  }

  return { voidId: voided!.id, quantity, ticketNeeded, ticketQueued }
}

/** The round row a void's ticket belongs to, if the line has one. */
async function findVoidRound(tx: Tx, sessionId: string, roundNumber: number | null) {
  if (roundNumber === null) return undefined
  const [round] = await tx
    .select({ id: orderRounds.id })
    .from(orderRounds)
    .where(and(eq(orderRounds.sessionId, sessionId), eq(orderRounds.roundNumber, roundNumber)))
    .limit(1)
  return round
}

/**
 * The void a `requestId` already wrote, answered as it was the first time.
 * `ticketQueued` is re-derived by the same rule: the job was written in the
 * same transaction as the void.
 */
async function findVoidByRequest(tx: Tx, sessionId: string, requestId: string): Promise<VoidResult | null> {
  const [row] = await tx
    .select({
      id: orderEvents.id,
      quantity: orderEvents.quantity,
      menuItemId: orderEvents.menuItemId,
      roundNumber: orderEvents.roundNumber,
      destination: menuItems.productionDestination,
    })
    .from(orderEvents)
    .leftJoin(menuItems, eq(menuItems.id, orderEvents.menuItemId))
    .where(and(eq(orderEvents.sessionId, sessionId), eq(orderEvents.requestId, requestId)))
    .limit(1)
  if (!row) return null
  const ticketNeeded = row.menuItemId !== null
  const ticketQueued = ticketNeeded && row.destination !== null && (await findVoidRound(tx, sessionId, row.roundNumber)) !== undefined
  return { voidId: row.id, quantity: row.quantity, ticketNeeded, ticketQueued }
}

/**
 * Cancels an unpaid bill. Its units become billable again; the waiter voids
 * what was wrong and generates a new bill.
 */
export async function cancelBill(
  tx: Tx,
  {
    billId,
    reason,
    note,
    staffId,
    approverId,
  }: { billId: string; reason: string; note: string | null; staffId: string; approverId: string },
): Promise<{ billId: string; sessionId: string }> {
  const [bill] = await tx.select({ sessionId: bills.sessionId }).from(bills).where(eq(bills.id, billId)).limit(1)
  if (!bill) throw new CancelBillNotFoundError()

  // A payment takes the same lock (`recordPayments`), so "no payments" below
  // cannot change before this commits.
  await lockOpenSession(tx, bill.sessionId)

  const [current] = await tx
    .select({
      cancelledAt: bills.cancelledAt,
      // Spelled out: in a single-table select Drizzle would print a bare "id",
      // which binds to payment_records inside the subquery (see units.ts).
      payments: sql<number>`(select count(*) from payment_records p where p.bill_id = "bills"."id")::int`,
    })
    .from(bills)
    .where(eq(bills.id, billId))
    .limit(1)
  if (current!.cancelledAt) throw new BillAlreadyCancelledError()
  if (Number(current!.payments) > 0) throw new BillHasPaymentsError()

  await tx
    .update(bills)
    .set({
      cancelledAt: sql`clock_timestamp()`,
      cancelledByStaffId: staffId,
      cancelApprovedByStaffId: approverId,
      cancelReason: reasonText(reason, note),
    })
    .where(eq(bills.id, billId))

  return { billId, sessionId: bill.sessionId }
}
