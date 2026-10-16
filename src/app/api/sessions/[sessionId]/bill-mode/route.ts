import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { setBillMode, SessionAlreadyClosedError } from '@/server/services/table-session.service'

const sessionIdSchema = z.string().uuid()

/** `safeParse`, never `.catch()` — Story 4.3's review found a silently defaulted field. */
const bodySchema = z.object({
  mode: z.enum(['one', 'separate']),
})

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Switches an order between One bill and Separate bills (Teran, 2026-10-16).
 *
 * ── Why its own route ───────────────────────────────────────────────────────
 * It is not a seat operation and it is not a close. It rewrites every
 * `order_events.seat_slot_id` on the session when collapsing, which is a
 * heavier thing than anything under `/seats`, and it deserves a name a reader
 * can find.
 *
 * RBAC is INHERITED from the `/api/sessions` prefix (owner + waiter) in
 * `permissions.ts`, enforced by `proxy.ts` before this handler runs. No role
 * check here — the sibling routes say the same.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId: rawSessionId } = await params

  const parsedSessionId = sessionIdSchema.safeParse(rawSessionId)
  if (!parsedSessionId.success) {
    return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  }

  if (!request.headers.get('x-staff-id')) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }

  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success) {
    return fail('INVALID_BODY', 'mode must be "one" or "separate"', 400)
  }

  try {
    const result = await db.transaction((tx) =>
      setBillMode(tx, { sessionId: parsedSessionId.data, mode: parsedBody.data.mode }),
    )
    return NextResponse.json(
      { success: true, data: { mode: parsedBody.data.mode, ...result } },
      { status: 200 },
    )
  } catch (error) {
    if (error instanceof SessionAlreadyClosedError) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    }
    console.error('[api/sessions/:sessionId/bill-mode] Failed to switch bill mode:', error)
    return fail('INTERNAL_ERROR', 'Could not change how this order is billed', 500)
  }
}
