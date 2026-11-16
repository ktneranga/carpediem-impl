import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { NothingToBillError } from '@/server/services/bill.service'
import { BillTotalChangedError, printTogetherBill } from '@/server/services/receipt.service'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'
import { wakePrintQueue } from '@/server/print/wake'

const bodySchema = z.object({
  sessionIds: z.array(z.string().uuid()).min(2).max(10),
  /** The combined total on the cashier's screen; a different one is refused. */
  expectedTotalPaisa: z.number().int().nonnegative(),
})

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/** Prints the combined BILL before Settle (Teran, 2026-11-16). Owner and waiters (`/api/payments`). */
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
  if (!parsed.success) return fail('INVALID_BODY', 'Choose the orders to print', 400)

  try {
    const job = await db.transaction((tx) => printTogetherBill(tx, { ...parsed.data, staffId }))
    wakePrintQueue()
    return NextResponse.json({ success: true, data: job }, { status: 202 })
  } catch (error) {
    if (error instanceof BillTotalChangedError) {
      return fail('TOTAL_CHANGED', 'The total changed since it was shown. Check the orders and print again.', 409)
    }
    if (error instanceof NothingToBillError) return fail('NOTHING_TO_BILL', 'Nothing to print on these orders', 409)
    if (error instanceof SessionAlreadyClosedError) return fail('SESSION_ALREADY_CLOSED', 'One of these orders is already closed', 409)
    console.error('[api/payments/together/print] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not print the bill', 500)
  }
}
