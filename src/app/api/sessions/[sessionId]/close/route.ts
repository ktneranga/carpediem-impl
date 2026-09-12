import { NextResponse } from 'next/server'
import { and, count, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderEvents, orderSessions } from '@/server/db/schema'
import {
  closeSession,
  SessionAlreadyClosedError,
  CLIENT_CLOSE_REASONS,
} from '@/server/services/table-session.service'
import { emitCounterSalesChanged, emitTableStatusChanged } from '@/server/socket/events'

const sessionIdSchema = z.string().uuid()

/** `settled` stays excluded — see the table-addressed close route. */
const closeBodySchema = z.object({
  reason: z.enum(CLIENT_CLOSE_REASONS),
})

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Closes a session by SESSION id, without payment.
 *
 * ── Why a second close route ─────────────────────────────────────────────────
 * `POST /api/tables/:tableId/sessions/close` finds the session by walking from a
 * table. A counter sale has no table to walk from, so that route can never reach
 * one. This is the general form; the table-addressed route stays because the
 * grid and the order screen already link to it and because closing "this table"
 * is the phrasing a waiter is acting on.
 *
 * Both are thin over the SAME `closeSession` service — a settled close, an
 * unpaid close and a counter close must produce identical session and audit
 * records, differing only in reason. Story 3.6 established that and it is not
 * re-litigated here.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId: rawSessionId } = await params

  const parsedSessionId = sessionIdSchema.safeParse(rawSessionId)
  if (!parsedSessionId.success) {
    return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  }
  const sessionId = parsedSessionId.data

  const staffId = request.headers.get('x-staff-id')
  if (!staffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }

  const parsedBody = closeBodySchema.safeParse(body)
  if (!parsedBody.success) {
    return fail('INVALID_BODY', 'reason must be "abandoned" or "walkout"', 400)
  }
  const { reason } = parsedBody.data

  try {
    const [session] = await db
      .select({ id: orderSessions.id, kind: orderSessions.kind })
      .from(orderSessions)
      .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))
      .limit(1)

    if (!session) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    }

    // Same rule as the table-addressed route: "abandoned" must always mean
    // nothing was ever ordered, or the audit trail stops meaning anything.
    const [items] = await db
      .select({ total: count() })
      .from(orderEvents)
      .where(and(eq(orderEvents.sessionId, session.id), eq(orderEvents.eventType, 'ITEM_ADDED')))

    if (reason === 'abandoned' && Number(items?.total ?? 0) > 0) {
      return fail(
        'SESSION_HAS_ITEMS',
        'This order has items on it. Close it as a walkout, or settle the bill.',
        409,
      )
    }

    let closedAt: Date
    let releasedTableIds: string[]
    try {
      const result = await db.transaction((tx) =>
        closeSession(tx, { sessionId: session.id, staffId, reason }),
      )
      closedAt = result.closedAt
      releasedTableIds = result.releasedTableIds
    } catch (error) {
      if (error instanceof SessionAlreadyClosedError) {
        return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
      }
      throw error
    }

    // One event per RELEASED table — which for a counter sale is none at all.
    // The loop naturally emits nothing, which is what AC-4 asks for: there is no
    // table whose status changed, so there is nothing for the grid to patch.
    // Straight over the ids the service returned. There was a SELECT here that
    // re-read those same ids from `tables` — FK-constrained rows that cannot be
    // absent — and then looped its result, so the only thing it could achieve was
    // silently dropping an event if a row somehow vanished.
    if (releasedTableIds.length > 0) {
      for (const releasedTableId of releasedTableIds) {
        emitTableStatusChanged({
          tableId: releasedTableId,
          status: 'open',
          sessionId: null,
          openedAt: null,
          itemCount: 0,
          unavailableReason: null,
          groupTableLabels: [],
        })
      }
    }

    // The counter list shrank — or, for a table session, did not change and this
    // is a cheap no-op on every client. Either way the list must not keep showing
    // an order that is closed.
    emitCounterSalesChanged()

    return NextResponse.json(
      {
        success: true,
        data: {
          sessionId: session.id,
          kind: session.kind,
          closedAt: closedAt.toISOString(),
          reason,
          releasedTableIds,
        },
      },
      { status: 200 },
    )
  } catch (error) {
    console.error('[api/sessions/:sessionId/close] Failed to close session:', error)
    return fail('INTERNAL_ERROR', 'Could not close the order', 500)
  }
}
