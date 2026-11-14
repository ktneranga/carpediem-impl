import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderSessions } from '@/server/db/schema'
import { parsePermissionsHeader, type StaffRole } from '@/server/auth/permissions'
import { announceSessionTotals } from '@/server/orders/announce-floor'
import { wakePrintQueue } from '@/server/print/wake'
import { announcePayment } from '@/server/services/payment-announce'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'
import {
  resolveApproval,
  VoidEventNotOnSessionError,
  VoidNotEnoughUnitsError,
  voidItem,
} from '@/server/services/void.service'
import { MAX_VOID_NOTE, VOID_REASONS } from '@/types/voids'

/**
 * Voids units of one sent item (Story 7.5). Behind `/api/sessions` (owner and
 * waiter). A waiter needs an owner-role PIN in `approverPin`; an owner approves
 * their own. The PIN is never echoed: zod's issue list would print it, so a
 * bad body names the field only.
 */
const bodySchema = z
  .object({
    orderEventId: z.string().uuid(),
    quantity: z.number().int().min(1).max(99),
    reason: z.enum(VOID_REASONS),
    note: z.string().trim().max(MAX_VOID_NOTE).optional(),
    approverPin: z.string().regex(/^\d{4}$/).optional(),
    requestId: z.string().uuid(),
  })
  .refine((body) => body.reason !== 'Other' || (body.note ?? '').length > 0, { path: ['note'] })

function fail(code: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ success: false, error: { code, message, ...extra } }, { status })
}

const FIELD_MESSAGES: Record<string, string> = {
  note: 'Say why in the note',
  approverPin: 'PIN must be four digits',
  quantity: 'Choose how many to void',
  reason: 'Choose a reason',
}

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const parsedSession = z.string().uuid().safeParse((await params).sessionId)
  if (!parsedSession.success) return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  const sessionId = parsedSession.data

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
    return fail('INVALID_BODY', FIELD_MESSAGES[field] ?? 'Check the void details', 400)
  }
  const body = parsed.data

  try {
    const [session] = await db
      .select({ tenantId: orderSessions.tenantId, closedAt: orderSessions.closedAt })
      .from(orderSessions)
      .where(eq(orderSessions.id, sessionId))
      .limit(1)
    if (!session) return fail('SESSION_NOT_FOUND', 'No such order', 404)
    if (session.closedAt) return fail('SESSION_CLOSED', 'This order is closed.', 409)

    const approval = await resolveApproval({
      staffId: parsedStaff.data,
      role,
      permissions: parsePermissionsHeader(request.headers.get('x-staff-permissions')),
      tenantId: session.tenantId,
      approverPin: body.approverPin,
    })
    if (!approval.ok) return fail(approval.code, approval.message, approval.status)

    const result = await db.transaction((tx) =>
      voidItem(tx, {
        sessionId,
        orderEventId: body.orderEventId,
        quantity: body.quantity,
        reason: body.reason,
        note: body.note ?? null,
        requestId: body.requestId,
        staffId: approval.staffId,
        approverId: approval.approverId,
      }),
    )

    // After commit: the kitchen, then every floor.
    if (result.ticketQueued) wakePrintQueue()
    await announceSessionTotals(sessionId)
    await announcePayment(sessionId)
    return NextResponse.json({ success: true, data: result }, { status: 201 })
  } catch (error) {
    if (error instanceof SessionAlreadyClosedError) return fail('SESSION_CLOSED', 'This order is closed.', 409)
    if (error instanceof VoidEventNotOnSessionError) return fail('ITEM_NOT_FOUND', 'That item is not on this order', 404)
    if (error instanceof VoidNotEnoughUnitsError) {
      const left = error.unitsLeft
      return fail(
        'NOT_ENOUGH_UNITS',
        left === 0 ? 'Nothing left to void on that line (billed or already voided)' : `Only ${left} left to void`,
        409,
        { unitsLeft: left },
      )
    }
    console.error('[api/sessions/:sessionId/voids] Void failed:', error)
    return fail('INTERNAL_ERROR', 'Could not void the item', 500)
  }
}
