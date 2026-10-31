import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import {
  BillAlreadySettledError,
  BillNotFoundError,
  OverpaymentError,
  recordPayments,
} from '@/server/services/payment.service'
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
})

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
    const result = await db.transaction((tx) =>
      recordPayments(tx, {
        billId: parsedBillId.data,
        staffId,
        tenders: parsedBody.data.tenders,
      }),
    )

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
