import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { billLines, bills, orderEvents, paymentRecords } from '@/server/db/schema'
import { hasUnbilledItems } from '@/server/services/bill.service'
import { lockOpenSession } from '@/server/services/table-session.service'
import type { PaymentState } from '@/types/tables'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** `transfer` = a bank transfer the cashier has seen arrive (Teran, 2026-11-13). */
export type Tender = { method: 'cash' | 'card' | 'transfer'; amountPaisa: number }

export type BillPayments = {
  paidPaisa: number
  tenders: {
    method: 'cash' | 'card' | 'transfer'
    amountPaisa: number
    /** The cash handed over, on a cash tender recorded since Story 6.6. */
    cashReceivedPaisa: number | null
    createdAt: string
  }[]
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class BillNotFoundError extends Error {}
/** The bill's payments already sum to its total. */
export class BillAlreadySettledError extends Error {}
/** The tenders would take the bill past its total. Carries what is still owed. */
export class OverpaymentError extends Error {
  constructor(readonly outstandingPaisa: number) {
    super('Payment exceeds the amount outstanding')
  }
}

/**
 * Every payment on a session, grouped by bill.
 *
 * Read by the bill screen to show what is settled and what is outstanding,
 * and by `recordPayments` to decide whether the table is finished.
 */
export async function loadSessionPayments(
  executor: Tx | typeof db,
  sessionId: string,
): Promise<Map<string, BillPayments>> {
  const rows = await executor
    .select({
      billId: paymentRecords.billId,
      method: paymentRecords.method,
      amountPaisa: paymentRecords.amountPaisa,
      cashReceivedPaisa: paymentRecords.cashReceivedPaisa,
      createdAt: paymentRecords.createdAt,
    })
    .from(paymentRecords)
    .where(eq(paymentRecords.sessionId, sessionId))
    .orderBy(asc(paymentRecords.createdAt))

  const byBill = new Map<string, BillPayments>()
  for (const row of rows) {
    const entry = byBill.get(row.billId) ?? { paidPaisa: 0, tenders: [] }
    entry.paidPaisa += row.amountPaisa
    entry.tenders.push({
      method: row.method,
      amountPaisa: row.amountPaisa,
      cashReceivedPaisa: row.cashReceivedPaisa,
      createdAt: row.createdAt.toISOString(),
    })
    byBill.set(row.billId, entry)
  }
  return byBill
}

/**
 * Records money received against one bill (Story 6.5, FR28-FR31).
 *
 * ── Split payment is just two tenders ────────────────────────────────────────
 * `[{ cash, 2000 }, { card, 2510 }]` writes two rows on the same bill in one
 * transaction. The epic sketched a `{ method: "split", cashAmount, cardAmount }`
 * body; a list of tenders says the same thing and does not need a third
 * "method" that is really two.
 *
 * ── Never past the total ─────────────────────────────────────────────────────
 * The amounts are what was APPLIED to the bill. Change handed back for a large
 * note is the screen's arithmetic, not the restaurant's revenue, so a tender
 * set that sums past what is outstanding is refused rather than recorded.
 *
 * ── Serialised on the session lock (NFR-D3) ──────────────────────────────────
 * Two tablets settling the same bill at the same moment both take
 * `lockOpenSession`; the second waits, re-reads the paid sum the first
 * committed, and is refused as already settled or as an overpayment. The
 * paid-sum read is a read-then-write check, and the lock is what makes it
 * safe — the same arrangement `generateConsolidatedBill` relies on.
 *
 * ── It never closes the table ───────────────────────────────────────────────
 * See the note in the body. It reports `allPaid`; the waiter closes the table.
 */
export async function recordPayments(
  tx: Tx,
  {
    billId,
    staffId,
    tenders,
    cashReceivedPaisa = null,
  }: {
    billId: string
    staffId: string
    tenders: Tender[]
    /**
     * The cash the guest handed over (Story 6.6), kept beside the CASH tender
     * so the receipt can print the change. A note, not revenue: the tender's
     * amount is still what is applied, and still capped below. The route
     * checks it is at least the cash tender; the database checks it again.
     */
    cashReceivedPaisa?: number | null
  },
): Promise<{
  billId: string
  sessionId: string
  paidPaisa: number
  outstandingPaisa: number
  settled: boolean
  /** Every bill on the session paid, and nothing left unbilled. */
  allPaid: boolean
  /** The cash tender's `payment_records` row, or null for card/transfer only. */
  cashRecordId: string | null
}> {
  const [bill] = await tx
    .select({ sessionId: bills.sessionId, totalPaisa: bills.totalPaisa })
    .from(bills)
    .where(eq(bills.id, billId))
    .limit(1)
  if (!bill) throw new BillNotFoundError()

  // Throws SessionAlreadyClosedError for a closed session: a closed table
  // takes no more money, and the error says so rather than recording it.
  await lockOpenSession(tx, bill.sessionId)

  const [{ paid }] = await tx
    .select({ paid: sql<number>`coalesce(sum(${paymentRecords.amountPaisa}), 0)::int` })
    .from(paymentRecords)
    .where(eq(paymentRecords.billId, billId))

  const outstanding = bill.totalPaisa - paid
  if (outstanding <= 0) throw new BillAlreadySettledError()

  const tendered = tenders.reduce((total, tender) => total + tender.amountPaisa, 0)
  if (tendered > outstanding) throw new OverpaymentError(outstanding)

  const inserted = await tx.insert(paymentRecords).values(
    tenders.map((tender) => ({
      sessionId: bill.sessionId,
      billId,
      staffId,
      amountPaisa: tender.amountPaisa,
      method: tender.method,
      cashReceivedPaisa: tender.method === 'cash' ? cashReceivedPaisa : null,
    })),
  ).returning({ id: paymentRecords.id, method: paymentRecords.method })
  // The cash tender, if there was one — it opens the drawer (Story 6.7).
  const cashRecordId = inserted.find((row) => row.method === 'cash')?.id ?? null

  const settled = tendered === outstanding

  // ── It does NOT close the table (code review D1, Teran, 2026-10-31) ──────
  // It used to, the moment every bill was settled and nothing was unbilled.
  // That emptied a table while guests were still at it — a four-top where only
  // seat 1 had ordered, closed by seat 1 paying — and closed a bar tab mid-
  // visit, losing its nickname with the next drink. The waiter now closes it:
  // `allPaid` tells the bill screen to offer "All paid · Close table", and the
  // close route re-checks it with `assertCloseMatchesPayment`.
  const allPaid = settled && (await isFullyPaid(tx, bill.sessionId))

  return {
    billId,
    sessionId: bill.sessionId,
    paidPaisa: paid + tendered,
    outstandingPaisa: outstanding - tendered,
    settled,
    allPaid,
    cashRecordId,
  }
}

/**
 * Is this order fully paid? At least one bill, every bill's payments summing
 * to its total, and no unit of any item left off a bill.
 *
 * A bill of LKR 0 — free items, or comps covering everything — is paid by this
 * rule with no payment at all (code review P1): nothing is owed on it.
 */
export async function isFullyPaid(tx: Tx | typeof db, sessionId: string): Promise<boolean> {
  if (await hasUnbilledItems(tx, sessionId)) return false

  const sessionBills = await tx
    .select({ id: bills.id, totalPaisa: bills.totalPaisa })
    .from(bills)
    .where(eq(bills.sessionId, sessionId))
  if (sessionBills.length === 0) return false

  const paidByBill = new Map(
    (
      await tx
        .select({
          billId: paymentRecords.billId,
          paid: sql<number>`sum(${paymentRecords.amountPaisa})::int`,
        })
        .from(paymentRecords)
        .where(inArray(paymentRecords.billId, sessionBills.map((row) => row.id)))
        .groupBy(paymentRecords.billId)
    ).map((row) => [row.billId, row.paid]),
  )
  return sessionBills.every((row) => (paidByBill.get(row.id) ?? 0) >= row.totalPaisa)
}

/** A `settled` close on an order that is not fully paid. */
export class OrderNotSettledError extends Error {}
/** A walkout or abandoned close on an order that IS fully paid. */
export class OrderAlreadyPaidError extends Error {}

/**
 * The close reason must agree with the money (code review D1/P6).
 *
 * `settled` only when the order is fully paid — the server's word, not the
 * screen's. And never `walkout` or `abandoned` once it is: More → Close table
 * on a paid table would otherwise record a paid party as having run off.
 *
 * Call inside the close transaction, under `lockOpenSession`, so a payment
 * cannot land between this check and the close.
 */
export async function assertCloseMatchesPayment(
  tx: Tx,
  { sessionId, reason }: { sessionId: string; reason: 'abandoned' | 'walkout' | 'settled' },
): Promise<void> {
  await lockOpenSession(tx, sessionId)
  const paid = await isFullyPaid(tx, sessionId)
  if (reason === 'settled' && !paid) throw new OrderNotSettledError()
  if (reason !== 'settled' && paid) throw new OrderAlreadyPaidError()
}

/**
 * Where an open order stands with its money, for the floor (Teran, 2026-11-10).
 *
 * `paid` is exactly `isFullyPaid` — the rule the close route enforces — so a
 * card that says ✓ Paid offers a Close table the server will accept. `part`
 * means a payment exists but something is still owed.
 */
export async function sessionPaymentState(
  executor: Tx | typeof db,
  sessionId: string,
): Promise<PaymentState> {
  if (await isFullyPaid(executor, sessionId)) return 'paid'
  const [payment] = await executor
    .select({ id: paymentRecords.id })
    .from(paymentRecords)
    .where(eq(paymentRecords.sessionId, sessionId))
    .limit(1)
  return payment ? 'part' : 'none'
}

/**
 * The same, for several open orders at once — the floor's list endpoints.
 *
 * Three grouped queries however many orders there are (code review,
 * 2026-11-11): the floor refetches on every socket event, and one query set per
 * open table was ~4N round trips on the hottest endpoint. The rule is
 * `isFullyPaid`'s, restated per session: nothing unbilled, at least one bill,
 * every bill's payments covering its total.
 *
 * Never throws. The badge is decoration: if these reads fail the floor still
 * loads, every order showing no payment state (callers read `?? 'none'`).
 */
export async function sessionPaymentStates(
  executor: Tx | typeof db,
  sessionIds: string[],
): Promise<Map<string, PaymentState>> {
  const ids = [...new Set(sessionIds)]
  const states = new Map<string, PaymentState>()
  if (ids.length === 0) return states

  try {
    const [unbilledRows, billRows, paymentRows] = await Promise.all([
      executor
        .selectDistinct({ sessionId: orderEvents.sessionId })
        .from(orderEvents)
        .where(
          and(
            inArray(orderEvents.sessionId, ids),
            eq(orderEvents.eventType, 'ITEM_ADDED'),
            sql`${orderEvents.quantity} > coalesce((select sum(${billLines.quantity}) from ${billLines} where ${billLines.orderEventId} = ${orderEvents.id}), 0)`,
          ),
        ),
      executor
        .select({ id: bills.id, sessionId: bills.sessionId, totalPaisa: bills.totalPaisa })
        .from(bills)
        .where(inArray(bills.sessionId, ids)),
      executor
        .select({
          sessionId: paymentRecords.sessionId,
          billId: paymentRecords.billId,
          paid: sql<number>`sum(${paymentRecords.amountPaisa})::int`,
        })
        .from(paymentRecords)
        .where(inArray(paymentRecords.sessionId, ids))
        .groupBy(paymentRecords.sessionId, paymentRecords.billId),
    ])

    const unbilled = new Set(unbilledRows.map((row) => row.sessionId))
    const paidByBill = new Map(paymentRows.map((row) => [row.billId, row.paid]))
    const hasPayment = new Set(paymentRows.map((row) => row.sessionId))
    const billsBySession = new Map<string, { id: string; totalPaisa: number }[]>()
    for (const row of billRows) {
      const list = billsBySession.get(row.sessionId)
      if (list) list.push(row)
      else billsBySession.set(row.sessionId, [row])
    }

    for (const id of ids) {
      const sessionBills = billsBySession.get(id) ?? []
      const paid =
        !unbilled.has(id) &&
        sessionBills.length > 0 &&
        sessionBills.every((bill) => (paidByBill.get(bill.id) ?? 0) >= bill.totalPaisa)
      states.set(id, paid ? 'paid' : hasPayment.has(id) ? 'part' : 'none')
    }
  } catch (error) {
    console.error('[payment.service] Could not read payment states for the floor:', error)
    return new Map()
  }
  return states
}
