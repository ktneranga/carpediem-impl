import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { printBill, ReceiptBillNotFoundError } from '@/server/services/receipt.service'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'

const billIdSchema = z.string().uuid()

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Prints a recorded bill on the receipt printer (Story 6.6, FR69).
 *
 * Queues the job and returns — never waits on the printer (NFR-I2). 202, not
 * 201: what was created is a request to print, not the print. RBAC is the
 * `/api/bills` prefix (owner + waiter) in `permissions.ts`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ billId: string }> },
) {
  const { billId: rawBillId } = await params
  const parsed = billIdSchema.safeParse(rawBillId)
  if (!parsed.success) return fail('INVALID_BILL_ID', 'Bill id must be a UUID', 400)

  if (!request.headers.get('x-staff-id')) return fail('UNAUTHENTICATED', 'Sign in required', 401)

  try {
    const result = await db.transaction((tx) => printBill(tx, { billId: parsed.data }))
    return NextResponse.json({ success: true, data: result }, { status: 202 })
  } catch (error) {
    if (error instanceof ReceiptBillNotFoundError) return fail('BILL_NOT_FOUND', 'No such bill', 404)
    if (error instanceof SessionAlreadyClosedError) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is already closed', 409)
    }
    console.error('[api/bills/:billId/print] Failed to queue the bill:', error)
    return fail('INTERNAL_ERROR', 'Could not send the bill to the printer', 500)
  }
}
