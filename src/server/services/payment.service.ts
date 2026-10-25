import 'server-only'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { bills, paymentRecords } from '@/server/db/schema'
import { hasUnbilledItems } from '@/server/services/bill.service'
import { closeSession, lockOpenSession } from '@/server/services/table-session.service'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type Tender = { method: 'cash' | 'card'; amountPaisa: number }

export type BillPayments = {
  paidPaisa: number
  tenders: { method: 'cash' | 'card' | 'transfer'; amountPaisa: number; createdAt: string }[]
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
      createdAt: row.createdAt.toISOString(),
    })
    byBill.set(row.billId, entry)
  }
  return byBill
}

/**
 * Records money received against one bill, and closes the table when that was
 * the last of it (Story 6.5, FR28-FR31).
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
 * ── When the table closes ────────────────────────────────────────────────────
 * Not when "the last open bill is settled", which is how the epic words it and
 * which Story 6.4 made wrong: seats 1 and 2 can be billed and paid while seats
 * 3 and 4 are still eating. The predicate is EVERY bill settled AND nothing
 * left unbilled — `hasUnbilledItems` exists for exactly this question. Then
 * the shared `closeSession` runs with reason `settled`, which releases every
 * attached table (none, for a counter sale) and writes the audit event; it is
 * not reimplemented here.
 */
export async function recordPayments(
  tx: Tx,
  { billId, staffId, tenders }: { billId: string; staffId: string; tenders: Tender[] },
): Promise<{
  billId: string
  paidPaisa: number
  outstandingPaisa: number
  settled: boolean
  sessionClosed: boolean
  releasedTableIds: string[]
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

  await tx.insert(paymentRecords).values(
    tenders.map((tender) => ({
      sessionId: bill.sessionId,
      billId,
      staffId,
      amountPaisa: tender.amountPaisa,
      method: tender.method,
    })),
  )

  const settled = tendered === outstanding
  let sessionClosed = false
  let releasedTableIds: string[] = []

  if (settled && !(await hasUnbilledItems(tx, bill.sessionId))) {
    // Every OTHER bill on the session must be paid as well — a seat bill
    // generated an hour ago and never settled keeps the table open.
    const sessionBills = await tx
      .select({ id: bills.id, totalPaisa: bills.totalPaisa })
      .from(bills)
      .where(eq(bills.sessionId, bill.sessionId))
    const paidByBill = new Map(
      (
        await tx
          .select({
            billId: paymentRecords.billId,
            paid: sql<number>`sum(${paymentRecords.amountPaisa})::int`,
          })
          .from(paymentRecords)
          .where(
            inArray(
              paymentRecords.billId,
              sessionBills.map((row) => row.id),
            ),
          )
          .groupBy(paymentRecords.billId)
      ).map((row) => [row.billId, row.paid]),
    )
    const everyBillSettled = sessionBills.every(
      (row) => (paidByBill.get(row.id) ?? 0) >= row.totalPaisa,
    )

    if (everyBillSettled) {
      const closed = await closeSession(tx, {
        sessionId: bill.sessionId,
        staffId,
        reason: 'settled',
      })
      sessionClosed = true
      releasedTableIds = closed.releasedTableIds
    }
  }

  return {
    billId,
    paidPaisa: paid + tendered,
    outstandingPaisa: outstanding - tendered,
    settled,
    sessionClosed,
    releasedTableIds,
  }
}
