import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import {
  BillAlreadySettledError,
  BillNotFoundError,
  OverpaymentError,
  recordPayments,
} from '@/server/services/payment.service'
import { printBill } from '@/server/services/receipt.service'
import { kickForCashPayment } from '@/server/services/cash-drawer.service'
import { wakePrintQueue } from '@/server/print/wake'
import { announcePayment } from '@/server/services/payment-announce'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'

const billIdSchema = z.string().uuid()

/**
 * One or two tenders: cash, card, or one of each for a split payment.
 *
 * Integer paisa, strictly positive. `safeParse`, never `.catch()` — a silently
 * defaulted amount is the worst possible field to default.
 */
const bodySchema = z.object({
  tenders: z
    .array(
      z.object({
        method: z.enum(['cash', 'card']),
        amountPaisa: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(2)
    // Two tenders of the same method is one tender typed twice — almost
    // certainly a double-tap, and never a real split.
    .refine((tenders) => new Set(tenders.map((tender) => tender.method)).size === tenders.length, {
      message: 'A split payment is one cash and one card tender',
    }),
  /**
   * The cash the guest handed over (Story 6.6) — for the receipt's change,
   * never revenue. Only with a cash tender, and never less than it.
   */
  // Capped below int4: the column is `integer`, so a bigger number would pass
  // validation and then fail the whole payment as a 500. The pad stops at
  // LKR 9,999,999 (999,999,900 paisa).
  cashReceivedPaisa: z.number().int().positive().max(2_000_000_000).optional(),
}).refine(
  (body) => {
    if (body.cashReceivedPaisa === undefined) return true
    const cash = body.tenders.find((tender) => tender.method === 'cash')
    return cash !== undefined && body.cashReceivedPaisa >= cash.amountPaisa
  },
  { message: 'Cash received must be at least the cash paid' },
)

function fail(code: string, message: string, status: number, extra?: object) {
  return NextResponse.json({ success: false, error: { code, message, ...extra } }, { status })
}

/**
 * Records a payment against a bill (Story 6.5). It never closes the table —
 * the waiter does, from the bill screen, once `allPaid` is true.
 *
 * RBAC is inherited from the `/api/bills` prefix (owner + waiter) in
 * `permissions.ts`, enforced by `proxy.ts`. Any waiter may take payment
 * (FR31) — no manager step.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ billId: string }> },
) {
  const { billId: rawBillId } = await params

  const parsedBillId = billIdSchema.safeParse(rawBillId)
  if (!parsedBillId.success) {
    return fail('INVALID_BILL_ID', 'Bill id must be a UUID', 400)
  }

  const staffId = request.headers.get('x-staff-id')
  if (!staffId) return fail('UNAUTHENTICATED', 'Sign in required', 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }

  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success) {
    return fail('INVALID_BODY', 'Payment must be one cash and/or one card amount, in paisa', 400)
  }

  try {
    const result = await db.transaction(async (tx) => {
      const paid = await recordPayments(tx, {
        billId: parsedBillId.data,
        staffId,
        tenders: parsedBody.data.tenders,
        cashReceivedPaisa: parsedBody.data.cashReceivedPaisa ?? null,
      })

      // ── Cash opens the drawer (Story 6.7) ──────────────────────────────────
      // Queued BEFORE the receipt: both go to the `cashier` printer, whose
      // queue keeps order, so the drawer opens while the receipt prints. In
      // its own savepoint for the same reason as the receipt: the drawer must
      // never cost the payment. If the printer was off, the kick waits and
      // retries like any job — the drawer may open up to a minute late.
      let drawerJobId: string | null = null
      if (paid.cashRecordId) {
        const paymentRecordId = paid.cashRecordId
        drawerJobId = await tx
          .transaction((savepoint) => kickForCashPayment(savepoint, { paymentRecordId, staffId }))
          .then((job) => job.jobId)
          .catch((error: unknown) => {
            console.error('[api/bills/:billId/payments] Paid in cash, but the drawer kick was not queued:', error)
            return null
          })
      }

      // ── The receipt prints by itself once the bill is paid (Teran, 2026-11-10)
      // In the same transaction, so a recorded payment and its queued receipt
      // commit together — on whichever tablet took the money, even if the
      // screen is closed straight after. A part payment prints nothing: the
      // guest is not finished paying.
      //
      // Inside a SAVEPOINT: queuing a receipt must never cost the payment. If
      // it fails, the money stays recorded and Print receipt on the bill
      // screen is the way to get one.
      let receiptJobId: string | null = null
      if (paid.settled) {
        receiptJobId = await tx
          .transaction((savepoint) => printBill(savepoint, { billId: parsedBillId.data, staffId }))
          .then((job) => job.jobId)
          .catch((error: unknown) => {
            console.error('[api/bills/:billId/payments] Paid, but the receipt was not queued:', error)
            return null
          })
      }
      return { ...paid, drawerJobId, receiptJobId }
    })

    // The drawer should open now, not on the queue's next 3-second tick.
    if (result.drawerJobId || result.receiptJobId) wakePrintQueue()
    await announcePayment(result.sessionId)
    return NextResponse.json({ success: true, data: result }, { status: 201 })
  } catch (error) {
    if (error instanceof BillNotFoundError) return fail('BILL_NOT_FOUND', 'No such bill', 404)
    if (error instanceof BillAlreadySettledError) {
      return fail('BILL_ALREADY_SETTLED', 'This bill is already paid', 409)
    }
    if (error instanceof OverpaymentError) {
      return fail('OVERPAYMENT', 'That is more than is owed on this bill', 409, {
        outstandingPaisa: error.outstandingPaisa,
      })
    }
    if (error instanceof SessionAlreadyClosedError) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is already closed', 409)
    }
    console.error('[api/bills/:billId/payments] Failed to record payment:', error)
    return fail('INTERNAL_ERROR', 'Could not record the payment', 500)
  }
}
