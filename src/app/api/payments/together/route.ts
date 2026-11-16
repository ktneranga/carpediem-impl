import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import {
  PayTogetherNeedsOwnSettleError,
  PayTogetherNotInFullError,
  PayTogetherNothingOwedError,
  PayTogetherTotalChangedError,
  payTogether,
} from '@/server/services/pay-together.service'
import { printCombinedReceipt } from '@/server/services/receipt.service'
import { kickForCashPayment } from '@/server/services/cash-drawer.service'
import { wakePrintQueue } from '@/server/print/wake'
import { announcePayment } from '@/server/services/payment-announce'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'

const bodySchema = z
  .object({
    sessionIds: z.array(z.string().uuid()).min(2).max(10),
    /** The combined total the cashier's screen showed; a different one is refused. */
    expectedTotalPaisa: z.number().int().positive(),
    tenders: z
      .array(z.object({ method: z.enum(['cash', 'card', 'transfer']), amountPaisa: z.number().int().positive() }))
      .min(1)
      .max(2)
      .refine((tenders) => new Set(tenders.map((tender) => tender.method)).size === tenders.length),
    cashReceivedPaisa: z.number().int().positive().max(2_000_000_000).optional(),
    printReceipt: z.boolean().optional(),
  })
  .refine((body) => {
    if (body.cashReceivedPaisa === undefined) return true
    const cash = body.tenders.find((tender) => tender.method === 'cash')
    return cash !== undefined && body.cashReceivedPaisa >= cash.amountPaisa
  })

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Pay together (Teran, 2026-11-16): several orders paid in one go. Each order
 * is billed and paid on its own record; the drawer opens once; one receipt.
 * Owner and waiters (`/api/payments`).
 */
export async function POST(request: Request) {
  const staffId = request.headers.get('x-staff-id')
  if (!staffId) return fail('UNAUTHENTICATED', 'Sign in required', 401)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return fail('INVALID_BODY', 'Check the orders and the amounts', 400)
  const input = parsed.data

  try {
    const result = await db.transaction(async (tx) => {
      const paid = await payTogether(tx, {
        sessionIds: input.sessionIds,
        staffId,
        tenders: input.tenders,
        cashReceivedPaisa: input.cashReceivedPaisa ?? null,
        expectedTotalPaisa: input.expectedTotalPaisa,
      })
      // Savepoints: a printer problem never undoes money already taken.
      let drawerJobId: string | null = null
      if (paid.cashRecordId) {
        const paymentRecordId = paid.cashRecordId
        drawerJobId = await tx
          .transaction((savepoint) => kickForCashPayment(savepoint, { paymentRecordId, staffId }))
          .then((job) => job.jobId)
          .catch((error: unknown) => {
            console.error('[api/payments/together] Paid in cash, but the drawer kick was not queued:', error)
            return null
          })
      }
      let receiptJobId: string | null = null
      if (input.printReceipt !== false) {
        receiptJobId = await tx
          .transaction((savepoint) => printCombinedReceipt(savepoint, { billIds: paid.billIds, staffId }))
          .then((job) => job.jobId)
          .catch((error: unknown) => {
            console.error('[api/payments/together] Paid, but the receipt was not queued:', error)
            return null
          })
      }
      return { ...paid, drawerJobId, receiptJobId }
    })

    if (result.drawerJobId || result.receiptJobId) wakePrintQueue()
    for (const session of result.sessions) await announcePayment(session.sessionId)
    return NextResponse.json(
      {
        success: true,
        data: {
          allPaid: result.sessions.every((session) => session.allPaid),
          sessions: result.sessions,
          receiptJobId: result.receiptJobId,
        },
      },
      { status: 201 },
    )
  } catch (error) {
    if (error instanceof PayTogetherTotalChangedError) {
      return fail('TOTAL_CHANGED', 'The total changed since it was shown. Check the orders and try again.', 409)
    }
    if (error instanceof PayTogetherNeedsOwnSettleError) {
      return fail('SETTLE_ON_ITS_OWN', `${error.label} has a bill already and new items. Settle it on its own first.`, 409)
    }
    if (error instanceof PayTogetherNothingOwedError) return fail('NOTHING_OWED', 'Nothing is owed on these orders', 409)
    if (error instanceof PayTogetherNotInFullError) return fail('NOT_IN_FULL', 'Paying together pays the whole total', 400)
    if (error instanceof SessionAlreadyClosedError) return fail('SESSION_ALREADY_CLOSED', 'One of these orders is already closed', 409)
    console.error('[api/payments/together] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not record the payment', 500)
  }
}
