import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderEvents, orderRounds, orderSessions } from '@/server/db/schema'
import { isUniqueViolation } from '@/server/db/errors'
import { dishCount } from '@/server/orders/item-count'
import { loadSubmittedRounds } from '@/server/orders/submitted-rounds'
import {
  ItemUnavailableError,
  PriceChangedError,
  SeatNotOnSessionError,
  SubmissionIdReusedError,
  submitRound,
} from '@/server/services/order.service'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'
import {
  emitCounterSalesChanged,
  emitOrderConfirmed,
  emitOrderSubmitted,
  emitTableStatusChanged,
} from '@/server/socket/events'
import {
  MAX_LINE_QUANTITY,
  MAX_MODIFIER_TEXT,
  MAX_ROUND_LINES,
  type SubmitRoundResponse,
} from '@/types/orders'

export type { SubmittedItemRow, SubmittedRoundRow } from '@/types/orders'

const sessionIdSchema = z.string().uuid()

function fail(
  code: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json({ success: false, error: { code, message, ...extra } }, { status })
}

/** Index names, caught BY NAME so an unexpected collision stays a visible 500. */
const ROUND_PKEY = 'order_rounds_pkey'
const ROUND_NUMBER_INDEX = 'idx_order_rounds_session_round'

/**
 * One send. A body that is present and malformed is a 400 — no `.catch()`
 * fallback, which is the defect Story 4.3's review found on the seat route.
 */
const submitSchema = z.object({
  submissionId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        seatSlotId: z.string().uuid(),
        quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
        modifierText: z.string().max(MAX_MODIFIER_TEXT),
        quotedPricePaisa: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(MAX_ROUND_LINES),
})

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

/**
 * Sends the staged round (Story 4.5, FR12).
 *
 * ── Status codes ─────────────────────────────────────────────────────────────
 * 201 new round · 200 replay of an already-sent round (AC-8) · 400 body ·
 * 401 · 409 SESSION_ALREADY_CLOSED / PRICE_CHANGED / SUBMISSION_ID_REUSED /
 * ROUND_CONFLICT · 422 ITEM_UNAVAILABLE / SEAT_NOT_FOUND · 500.
 *
 * ── Announcements: after the commit, before the response, never on a replay ─
 * Emitting inside the transaction would announce a round that could still roll
 * back (AC-6). Emitting after the response would let the waiter's tablet move
 * on before the kitchen heard. A replay announces nothing: the first request
 * already did, and doing it again is the duplicate ticket AC-8 exists to stop.
 *
 * ── No printing ──────────────────────────────────────────────────────────────
 * `architecture.md:867` calls a synchronous print service here. That step was
 * superseded by the durable print queue (sprint-change-proposal-2026-08-21,
 * Story 5.0), which will enqueue from these same committed rows.
 *
 * RBAC: inherited from `{ prefix: '/api/sessions', roles: ['owner','waiter'] }`.
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

  // Set by the proxy from a validated session, and stripped from anything a
  // client sent. The identity every event row is attributed to (NFR-S3).
  const staffId = request.headers.get('x-staff-id')
  if (!staffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsedBody = submitSchema.safeParse(raw)
  if (!parsedBody.success) {
    return fail('INVALID_BODY', 'The round could not be read. Nothing was sent.', 400)
  }
  const { submissionId, lines } = parsedBody.data

  let result
  try {
    result = await db.transaction((tx) =>
      submitRound(tx, { sessionId, staffId, submissionId, lines }),
    )
  } catch (error) {
    if (error instanceof SessionAlreadyClosedError) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    }
    if (error instanceof ItemUnavailableError) {
      return fail(
        'ITEM_UNAVAILABLE',
        'A dish in this round is no longer available. Take it off and send again.',
        422,
        { itemId: error.itemId },
      )
    }
    if (error instanceof SeatNotOnSessionError) {
      return fail(
        'SEAT_NOT_FOUND',
        'A dish is on a seat that is no longer on this order. Move it and send again.',
        422,
        { seatId: error.seatId },
      )
    }
    if (error instanceof PriceChangedError) {
      return fail('PRICE_CHANGED', 'A price has changed since this round was started.', 409, {
        itemId: error.itemId,
        currentPricePaisa: error.currentPricePaisa,
      })
    }
    if (error instanceof SubmissionIdReusedError) {
      return fail('SUBMISSION_ID_REUSED', 'This send belongs to a different order.', 409)
    }
    // Two sends with the same id from DIFFERENT sessions can race: each holds
    // only its own session's lock, so neither replay check sees the other's
    // uncommitted round. Answer from whatever committed.
    if (isUniqueViolation(error, ROUND_PKEY)) {
      const [existing] = await db
        .select({
          sessionId: orderRounds.sessionId,
          roundNumber: orderRounds.roundNumber,
          itemCount: orderRounds.itemCount,
        })
        .from(orderRounds)
        .where(eq(orderRounds.id, submissionId))
        .limit(1)
      if (existing && existing.sessionId === sessionId) {
        const replay: SubmitRoundResponse = {
          submissionId,
          roundNumber: existing.roundNumber,
          itemCount: existing.itemCount,
          replayed: true,
        }
        return NextResponse.json({ success: true, data: replay }, { status: 200 })
      }
      return fail('SUBMISSION_ID_REUSED', 'This send belongs to a different order.', 409)
    }
    // Should be impossible under the session lock; a conflict, not a fault.
    if (isUniqueViolation(error, ROUND_NUMBER_INDEX)) {
      return fail('ROUND_CONFLICT', 'Another round was sent at the same moment. Send again.', 409)
    }
    console.error('[api/sessions/:sessionId/orders] Failed to send round:', error)
    return fail('INTERNAL_ERROR', 'The round was not sent. Nothing was saved.', 500)
  }

  const response: SubmitRoundResponse = {
    submissionId: result.submissionId,
    roundNumber: result.roundNumber,
    itemCount: result.itemCount,
    replayed: result.replayed,
  }

  if (!result.announcement) {
    return NextResponse.json({ success: true, data: response }, { status: 200 })
  }

  // ── Committed. Announce. ──────────────────────────────────────────────────
  const { announcement } = result
  const timestamp = new Date().toISOString()

  for (const [destination, ticketLines] of announcement.byDestination) {
    emitOrderSubmitted({
      eventId: randomUUID(),
      timestamp,
      staffId,
      sessionId,
      roundNumber: result.roundNumber,
      destination,
      tableLabels: announcement.tableLabels,
      usesSeats: announcement.usesSeats,
      lines: ticketLines,
    })
  }

  emitOrderConfirmed({
    eventId: randomUUID(),
    timestamp,
    staffId,
    sessionId,
    roundNumber: result.roundNumber,
    itemCount: result.itemCount,
  })

  // The floor's item count changed (AC-12). Read after commit, in dishes.
  try {
    const [dishes] = await db
      .select({ total: dishCount })
      .from(orderEvents)
      .where(and(eq(orderEvents.sessionId, sessionId), eq(orderEvents.eventType, 'ITEM_ADDED')))

    if (announcement.tableIds.length === 0) {
      // A counter sale has no card on the floor; its list shows the count.
      emitCounterSalesChanged()
    } else {
      for (const tableId of announcement.tableIds) {
        emitTableStatusChanged({
          tableId,
          status: 'occupied',
          sessionId,
          openedAt: announcement.openedAt.toISOString(),
          itemCount: dishes?.total ?? 0,
          // An occupied table carries no out-of-service reason — migration
          // 0006's CHECK makes that impossible.
          unavailableReason: null,
          groupTableLabels: announcement.tableLabels,
        })
      }
    }
  } catch (error) {
    // The round is committed and the kitchen has been told. A failed count for
    // the floor is not a reason to tell the waiter it failed.
    console.error('[api/sessions/:sessionId/orders] Failed to refresh the floor:', error)
  }

  return NextResponse.json({ success: true, data: response }, { status: 201 })
}
