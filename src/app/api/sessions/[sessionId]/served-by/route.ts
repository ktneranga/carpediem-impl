import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { NotAServerError, SessionAlreadyClosedError, setServedBy } from '@/server/services/table-session.service'

const sessionIdSchema = z.string().uuid()
const bodySchema = z.object({ staffId: z.string().uuid() })

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Who looks after this order (Teran, 2026-11-16). Any owner or waiter may
 * change it — a table handed over at a shift change. RBAC from `/api/sessions`.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId: raw } = await params
  const sessionId = sessionIdSchema.safeParse(raw)
  if (!sessionId.success) return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  if (!request.headers.get('x-staff-id')) return fail('UNAUTHENTICATED', 'Sign in required', 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return fail('INVALID_BODY', 'Choose a staff member', 400)

  try {
    const result = await db.transaction((tx) => setServedBy(tx, { sessionId: sessionId.data, staffId: parsed.data.staffId }))
    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    if (error instanceof SessionAlreadyClosedError) return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    if (error instanceof NotAServerError) return fail('NOT_A_SERVER', 'That person cannot look after a table', 422)
    console.error('[api/sessions/:sessionId/served-by] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not change the waiter', 500)
  }
}
