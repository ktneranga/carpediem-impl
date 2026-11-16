import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { canCloseOrders, parsePermissionsHeader, type StaffRole } from '@/server/auth/permissions'
import { cancelOrder, OrderHasPaymentsError } from '@/server/services/void.service'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'
import { emitCounterSalesChanged, emitTableStatusChanged } from '@/server/socket/events'
import { wakePrintQueue } from '@/server/print/wake'
import { MAX_VOID_NOTE, ORDER_CANCEL_REASONS } from '@/types/voids'

const sessionIdSchema = z.string().uuid()
const bodySchema = z
  .object({
    reason: z.enum(ORDER_CANCEL_REASONS),
    note: z.string().trim().max(MAX_VOID_NOTE).nullable().optional(),
  })
  .refine((body) => body.reason !== 'Other' || Boolean(body.note), { path: ['note'] })

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Cancels a whole unpaid order (Teran, 2026-11-16): voids what is left, with
 * VOID tickets to the kitchen and bar, and closes it as cancelled. Owners, and
 * staff granted `close_orders`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId: raw } = await params
  const sessionId = sessionIdSchema.safeParse(raw)
  if (!sessionId.success) return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)

  const staffId = request.headers.get('x-staff-id')
  if (!staffId) return fail('UNAUTHENTICATED', 'Sign in required', 401)
  if (
    !canCloseOrders(
      request.headers.get('x-staff-role') as StaffRole | null,
      parsePermissionsHeader(request.headers.get('x-staff-permissions')),
    )
  ) {
    return fail('FORBIDDEN', 'Only the owner can cancel an order', 403)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return fail('INVALID_BODY', 'Choose a reason (Other needs a note)', 400)

  try {
    const result = await db.transaction((tx) =>
      cancelOrder(tx, { sessionId: sessionId.data, staffId, reason: parsed.data.reason, note: parsed.data.note ?? null }),
    )
    if (result.ticketsQueued) wakePrintQueue()
    for (const tableId of result.releasedTableIds) {
      emitTableStatusChanged({
        tableId,
        status: 'open',
        sessionId: null,
        openedAt: null,
        dailyNumber: null,
        itemCount: 0,
        totalPaisa: 0,
        unavailableReason: null,
        groupTableLabels: [],
      })
    }
    emitCounterSalesChanged()
    return NextResponse.json({ success: true, data: { voided: result.voided, ticketsQueued: result.ticketsQueued } })
  } catch (error) {
    if (error instanceof SessionAlreadyClosedError) return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    if (error instanceof OrderHasPaymentsError) {
      return fail('HAS_PAYMENTS', 'Money was already taken on this order. Settle it from the bill screen instead.', 409)
    }
    console.error('[api/sessions/:sessionId/cancel] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not cancel the order', 500)
  }
}
