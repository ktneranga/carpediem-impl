import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { cashDrawerOpenings, orderSessions, paymentRecords, printJobs, staff } from '@/server/db/schema'
import type { DrawerKickPayload } from '@/types/tickets'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type NoSaleReason = 'change' | 'float' | 'other'

/** The payment row does not exist, or is not cash. */
export class NotACashPaymentError extends Error {}

/**
 * The cash drawer (Story 6.7, FR72).
 *
 * The drawer hangs off the receipt printer, so opening it is a print job — a
 * `cashier` kick — and every request to open it writes one append-only row in
 * `cash_drawer_openings`, in the SAME transaction as the job. A row exists if
 * and only if the kick was queued.
 *
 * The row records the REQUEST. The queue may deliver the kick late (a printer
 * that was off opens the drawer a minute after the payment) or twice (a stale
 * claim it cannot prove was delivered is retried). Neither changes the audit:
 * someone asked for the drawer, for this reason, at this time.
 */

async function queueKick(
  tx: Tx,
  { tenantId, sessionId, opening }: { tenantId: string; sessionId: string | null; opening: DrawerKickPayload['opening'] },
): Promise<string> {
  const payload: DrawerKickPayload = { kind: 'drawer', destination: 'cashier', tableLabels: ['Cash drawer'], opening }
  const [job] = await tx
    .insert(printJobs)
    .values({ tenantId, sessionId, roundId: null, destination: 'cashier', billId: null, ticket: payload })
    .returning({ id: printJobs.id })
  return job!.id
}

/**
 * A cash tender was taken: open the drawer for it. The tenant and order are
 * read from the payment row itself, never trusted from the caller.
 */
export async function kickForCashPayment(
  tx: Tx,
  { paymentRecordId, staffId }: { paymentRecordId: string; staffId: string },
): Promise<{ jobId: string }> {
  const [payment] = await tx
    .select({ sessionId: paymentRecords.sessionId, method: paymentRecords.method, tenantId: orderSessions.tenantId })
    .from(paymentRecords)
    .innerJoin(orderSessions, eq(orderSessions.id, paymentRecords.sessionId))
    .where(eq(paymentRecords.id, paymentRecordId))
    .limit(1)
  if (!payment || payment.method !== 'cash') throw new NotACashPaymentError()

  const jobId = await queueKick(tx, { tenantId: payment.tenantId, sessionId: payment.sessionId, opening: 'sale' })
  await tx.insert(cashDrawerOpenings).values({
    tenantId: payment.tenantId,
    kind: 'sale',
    paymentRecordId,
    printJobId: jobId,
    staffId,
  })
  return { jobId }
}

/**
 * Open the drawer with no sale — change for the float, the float itself, or
 * another reason someone typed. Belongs to no order (`session_id` null).
 * The route checks the role and the note; the database checks the note again.
 */
export async function openWithoutSale(
  tx: Tx,
  { tenantId, staffId, reason, note }: { tenantId: string; staffId: string; reason: NoSaleReason; note: string | null },
): Promise<{ jobId: string }> {
  const jobId = await queueKick(tx, { tenantId, sessionId: null, opening: 'no_sale' })
  await tx.insert(cashDrawerOpenings).values({
    tenantId,
    kind: 'no_sale',
    reason,
    note,
    printJobId: jobId,
    staffId,
  })
  return { jobId }
}

export type NoSaleOpening = {
  id: string
  staffName: string
  reason: NoSaleReason
  note: string | null
  /** ISO. */
  openedAt: string
}

/**
 * The no-sale openings of one business day, oldest first — for the end-of-day
 * screen (Story 9.5). "Which day" is `business_date_at()`, the one definition
 * the order numbers use too (migration 0036).
 */
export async function listNoSaleOpenings(
  executor: Tx | typeof db,
  { tenantId, businessDate }: { tenantId: string; businessDate: string },
): Promise<NoSaleOpening[]> {
  const rows = await executor
    .select({
      id: cashDrawerOpenings.id,
      staffName: staff.name,
      reason: cashDrawerOpenings.reason,
      note: cashDrawerOpenings.note,
      openedAt: cashDrawerOpenings.createdAt,
    })
    .from(cashDrawerOpenings)
    .innerJoin(staff, eq(staff.id, cashDrawerOpenings.staffId))
    .where(
      and(
        eq(cashDrawerOpenings.tenantId, tenantId),
        eq(cashDrawerOpenings.kind, 'no_sale'),
        sql`business_date_at(${cashDrawerOpenings.tenantId}, ${cashDrawerOpenings.createdAt}) = ${businessDate}::date`,
      ),
    )
    .orderBy(asc(cashDrawerOpenings.createdAt), asc(cashDrawerOpenings.id))
  return rows.map((row) => ({
    id: row.id,
    staffName: row.staffName,
    reason: row.reason!,
    note: row.note,
    openedAt: row.openedAt.toISOString(),
  }))
}
