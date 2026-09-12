import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderSessions, seatSlots } from '@/server/db/schema'
import {
  deleteSeat,
  SeatHasItemsError,
  SessionNeedsASeatError,
} from '@/server/services/table-session.service'

const uuidSchema = z.string().uuid()
const MAX_SEAT_NOTE = 40

const patchSchema = z.object({
  /** Empty string clears the note. `null` would too, but a form sends ''. */
  seatNote: z.string().max(MAX_SEAT_NOTE),
})

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Renames the person on a seat.
 *
 * The note is how a waiter recognises a guest they could not ask the name of —
 * "red shirt", "curly hair". It is editable after the fact because the useful
 * detail is usually noticed once the order is underway, not when the seat is
 * created.
 *
 * It never reaches a guest-facing bill; see the note on `seatSlots` in the
 * schema, and the requirement logged against Epic 6.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; seatId: string }> },
) {
  const { sessionId: rawSessionId, seatId: rawSeatId } = await params

  const parsedSessionId = uuidSchema.safeParse(rawSessionId)
  const parsedSeatId = uuidSchema.safeParse(rawSeatId)
  if (!parsedSessionId.success || !parsedSeatId.success) {
    return fail('INVALID_ID', 'Session and seat ids must be UUIDs', 400)
  }

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

  const parsedBody = patchSchema.safeParse(body)
  if (!parsedBody.success) {
    return fail('INVALID_BODY', `seatNote must be at most ${MAX_SEAT_NOTE} characters`, 400)
  }

  try {
    const trimmed = parsedBody.data.seatNote.trim()

    const [updated] = await db
      .update(seatSlots)
      // Empty becomes NULL, so a cleared note reverts the chip to its label
      // rather than rendering a blank pill.
      .set({ seatNote: trimmed ? trimmed : null })
      .where(and(eq(seatSlots.id, parsedSeatId.data), eq(seatSlots.sessionId, parsedSessionId.data)))
      .returning({
        id: seatSlots.id,
        seatLabel: seatSlots.seatLabel,
        seatNote: seatSlots.seatNote,
      })

    // Scoped by BOTH ids, so a seat id from another session updates nothing and
    // is reported as missing rather than silently edited.
    if (!updated) {
      return fail('SEAT_NOT_FOUND', 'No such seat on this order', 404)
    }

    return NextResponse.json({ success: true, data: updated })
  } catch (error) {
    console.error('[api/sessions/:sessionId/seats/:seatId] Failed to update:', error)
    return fail('INTERNAL_ERROR', 'Could not update the seat', 500)
  }
}

/**
 * Removes a seat.
 *
 * ── Two refusals, both held under the session row lock ───────────────────────
 * The last seat cannot go: an active session always has somewhere to put an
 * item. And a seat with items cannot go: `order_events` is append-only, so rows
 * pointing at a deleted seat could never be repaired — the trigger refuses
 * updates, and restoring the seat is impossible because it would be a new row
 * with a new id.
 *
 * Both checks run INSIDE `deleteSeat`'s transaction, after a `FOR UPDATE` on the
 * session. Story 3.9's review found the last-TABLE guard counting in a
 * transaction that closed before the write began, so two devices both passed and
 * orphaned a session. That defect was one story old when this was written.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; seatId: string }> },
) {
  const { sessionId: rawSessionId, seatId: rawSeatId } = await params

  const parsedSessionId = uuidSchema.safeParse(rawSessionId)
  const parsedSeatId = uuidSchema.safeParse(rawSeatId)
  if (!parsedSessionId.success || !parsedSeatId.success) {
    return fail('INVALID_ID', 'Session and seat ids must be UUIDs', 400)
  }

  const staffId = request.headers.get('x-staff-id')
  if (!staffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  try {
    const [session] = await db
      .select({ id: orderSessions.id })
      .from(orderSessions)
      .where(
        and(eq(orderSessions.id, parsedSessionId.data), isNull(orderSessions.closedAt)),
      )
      .limit(1)

    if (!session) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    }

    try {
      await db.transaction((tx) =>
        deleteSeat(tx, { sessionId: parsedSessionId.data, seatId: parsedSeatId.data }),
      )
    } catch (error) {
      if (error instanceof SessionNeedsASeatError) {
        return fail(
          'SESSION_NEEDS_A_SEAT',
          'This is the only seat on the order. Add another before removing it.',
          409,
        )
      }
      if (error instanceof SeatHasItemsError) {
        return fail(
          'SEAT_HAS_ITEMS',
          `This seat has ${error.itemCount} item${error.itemCount === 1 ? '' : 's'} on it. Move or void them first.`,
          409,
        )
      }
      throw error
    }

    return NextResponse.json({ success: true, data: { seatId: parsedSeatId.data } })
  } catch (error) {
    console.error('[api/sessions/:sessionId/seats/:seatId] Failed to delete:', error)
    return fail('INTERNAL_ERROR', 'Could not remove the seat', 500)
  }
}
