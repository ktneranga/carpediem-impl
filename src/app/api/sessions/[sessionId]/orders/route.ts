import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderSessions } from '@/server/db/schema'
import { loadSubmittedRounds } from '@/server/orders/submitted-rounds'

export type { SubmittedItemRow, SubmittedRoundRow } from '@/server/orders/submitted-rounds'

const sessionIdSchema = z.string().uuid()

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * The session's already-submitted items, grouped by round (Story 4.4, AC-6).
 *
 * ── Read-only, and that is the whole point ───────────────────────────────────
 * These rows are in `order_events`, which is APPEND-ONLY by database trigger.
 * There is no PATCH and no DELETE on this path: correcting a submitted item is a
 * new event, and Epic 7 owns that flow.
 *
 * ── POST is Story 4.5 ────────────────────────────────────────────────────────
 * `epics.md:1395` puts submission on this exact path. Story 4.4 stages on the
 * client and writes nothing.
 *
 * The query and the grouping live in `loadSubmittedRounds`, shared with the
 * order page's first paint. RBAC is inherited from
 * `{ prefix: '/api/sessions', roles: ['owner','waiter'] }` — verified as Kumar
 * (4321, kitchen), not assumed.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId: rawSessionId } = await params

  const parsedSessionId = sessionIdSchema.safeParse(rawSessionId)
  if (!parsedSessionId.success) {
    return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  }

  // Defence in depth — the proxy refuses an unauthenticated request first — but
  // every handler in this namespace checks it, and one quietly missing it reads
  // as a bug.
  if (!request.headers.get('x-staff-id')) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  try {
    // A session that does not exist is a 404, not `200 []`. The empty list
    // meant both "no items yet" and "no such order", and the client could not
    // tell them apart. A CLOSED session still answers — its history is real.
    const [session] = await db
      .select({ id: orderSessions.id })
      .from(orderSessions)
      .where(eq(orderSessions.id, parsedSessionId.data))
      .limit(1)

    if (!session) {
      return fail('SESSION_NOT_FOUND', 'No such order', 404)
    }

    const rounds = await loadSubmittedRounds(parsedSessionId.data)
    return NextResponse.json({ success: true, data: rounds })
  } catch (error) {
    console.error('[api/sessions/:sessionId/orders] Failed to load rounds:', error)
    return fail('INTERNAL_ERROR', 'Could not load the order history', 500)
  }
}
