import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { canGiveDiscount, parsePermissionsHeader, type StaffRole } from '@/server/auth/permissions'
import { SessionAlreadyClosedError, setOrderPricing } from '@/server/services/table-session.service'

const sessionIdSchema = z.string().uuid()

/**
 * Either or both: the discount and the service charge are separate controls
 * (Teran, 2026-11-16). `discountBp` null = the restaurant's default.
 */
const bodySchema = z
  .object({
    discountBp: z.number().int().min(0).max(10_000).nullable().optional(),
    serviceChargeWaived: z.boolean().optional(),
  })
  .refine((body) => body.discountBp !== undefined || body.serviceChargeWaived !== undefined)

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Sets an order's discount and service-charge waiver from the bill screen
 * (Teran, 2026-11-16). Owners, and staff granted `give_discount`.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId: raw } = await params
  const sessionId = sessionIdSchema.safeParse(raw)
  if (!sessionId.success) return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)

  const staffId = request.headers.get('x-staff-id')
  if (!staffId) return fail('UNAUTHENTICATED', 'Sign in required', 401)
  if (
    !canGiveDiscount(
      request.headers.get('x-staff-role') as StaffRole | null,
      parsePermissionsHeader(request.headers.get('x-staff-permissions')),
    )
  ) {
    return fail('FORBIDDEN', 'Only the owner can change the discount or service charge', 403)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return fail('INVALID_BODY', 'Discount is 0% to 100%', 400)

  try {
    await db.transaction((tx) => setOrderPricing(tx, { sessionId: sessionId.data, staffId, ...parsed.data }))
    return NextResponse.json({ success: true, data: parsed.data })
  } catch (error) {
    if (error instanceof SessionAlreadyClosedError) return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    console.error('[api/sessions/:sessionId/pricing] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not change the discount', 500)
  }
}
