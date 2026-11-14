import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { bills } from '@/server/db/schema'
import type { StaffRole } from '@/server/auth/permissions'
import { announceSessionTotals } from '@/server/orders/announce-floor'
import { announcePayment } from '@/server/services/payment-announce'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'
import {
  BillAlreadyCancelledError,
  BillHasPaymentsError,
  CancelBillNotFoundError,
  cancelBill,
  resolveApproval,
} from '@/server/services/void.service'
import { BILL_CANCEL_REASONS, MAX_VOID_NOTE } from '@/types/voids'

/**
 * Cancels an unpaid bill (Story 7.5) so its items can be corrected and billed
 * again. Behind `/api/bills` (owner and waiter); same approval as a void.
 */
const bodySchema = z
  .object({
    reason: z.enum(BILL_CANCEL_REASONS),
    note: z.string().trim().max(MAX_VOID_NOTE).optional(),
    approverPin: z.string().regex(/^\d{4}$/).optional(),
  })
  .refine((body) => body.reason !== 'Other' || (body.note ?? '').length > 0, { path: ['note'] })

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

const FIELD_MESSAGES: Record<string, string> = {
  note: 'Say why in the note',
  approverPin: 'PIN must be four digits',
  reason: 'Choose a reason',
}

export async function POST(request: Request, { params }: { params: Promise<{ billId: string }> }) {
  const parsedBill = z.string().uuid().safeParse((await params).billId)
  if (!parsedBill.success) return fail('INVALID_BILL_ID', 'Bill id must be a UUID', 400)
  const billId = parsedBill.data

  const parsedStaff = z.string().uuid().safeParse(request.headers.get('x-staff-id'))
  if (!parsedStaff.success) return fail('UNAUTHENTICATED', 'Sign in required', 401)
  const role = (request.headers.get('x-staff-role') as StaffRole | null) ?? null

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '')
    return fail('INVALID_BODY', FIELD_MESSAGES[field] ?? 'Check the details', 400)
  }
  const body = parsed.data

  try {
    const [bill] = await db
      .select({ tenantId: bills.tenantId })
      .from(bills)
      .where(eq(bills.id, billId))
      .limit(1)
    if (!bill) return fail('BILL_NOT_FOUND', 'No such bill', 404)

    const approval = await resolveApproval({
      staffId: parsedStaff.data,
      role,
      tenantId: bill.tenantId,
      approverPin: body.approverPin,
    })
    if (!approval.ok) return fail(approval.code, approval.message, approval.status)

    const result = await db.transaction((tx) =>
      cancelBill(tx, {
        billId,
        reason: body.reason,
        note: body.note ?? null,
        staffId: approval.staffId,
        approverId: approval.approverId,
      }),
    )

    await announceSessionTotals(result.sessionId)
    await announcePayment(result.sessionId)
    return NextResponse.json({ success: true, data: result }, { status: 200 })
  } catch (error) {
    if (error instanceof CancelBillNotFoundError) return fail('BILL_NOT_FOUND', 'No such bill', 404)
    if (error instanceof SessionAlreadyClosedError) return fail('SESSION_CLOSED', 'This order is closed.', 409)
    if (error instanceof BillHasPaymentsError) {
      return fail('BILL_HAS_PAYMENTS', "This bill has payments — it can't be cancelled.", 409)
    }
    if (error instanceof BillAlreadyCancelledError) return fail('BILL_CANCELLED', 'This bill is already cancelled.', 409)
    console.error('[api/bills/:billId/cancel] Cancel failed:', error)
    return fail('INTERNAL_ERROR', 'Could not cancel the bill', 500)
  }
}
