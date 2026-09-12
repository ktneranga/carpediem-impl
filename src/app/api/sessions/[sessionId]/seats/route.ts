import { NextResponse } from 'next/server'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderSessions, seatSlots } from '@/server/db/schema'
import { isUniqueViolation } from '@/server/db/errors'
import { createSeat, nextSeatLabel } from '@/server/services/table-session.service'

const sessionIdSchema = z.string().uuid()

/** The index that decides the Add Seat race. Named, so an unrelated 23505 is a 500. */
const SEAT_LABEL_INDEX = 'idx_seat_slots_session_label'

/** A memory aid, not a description. Long enough for "curly hair, blue dress". */
const MAX_SEAT_NOTE = 40

/**
 * Attempts at deriving a free label before giving up.
 *
 * Two. A collision means another device inserted between this request deriving
 * its label and committing it, and the re-derivation sees that insert. On a
 * two-tablet floor a second collision means something other than a race, and
 * looping would hide it.
 */
const MAX_SEAT_ATTEMPTS = 2

const bodySchema = z
  .object({ seatNote: z.string().max(MAX_SEAT_NOTE).optional() })
  // An absent body is the common case — Add Seat is one tap. Only the FIELD is
  // optional-with-catch; a body that is present and malformed still fails,
  // which is the distinction Story 4.2's review had to restore on the open route.
  .catch({ seatNote: undefined })

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Adds a seat to a session (FR10).
 *
 * ── The label is derived server-side, always ─────────────────────────────────
 * A client-supplied label means two tablets both send "Seat 2". Even derived,
 * two devices reading the same count propose the same label — so the unique
 * index `(session_id, seat_label)` is what actually decides it, and a 23505 is
 * retried once with a freshly derived label. The database settles this race, as
 * it settles every other one in this codebase.
 *
 * RBAC is inherited: `{ prefix: '/api/sessions', roles: ['owner','waiter'] }`
 * from Story 3.9 covers everything beneath it. No policy was added here — that
 * was verified, not assumed.
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

  const body = bodySchema.parse(await request.json().catch(() => ({})))

  try {
    const [session] = await db
      .select({ id: orderSessions.id })
      .from(orderSessions)
      .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))
      .limit(1)

    if (!session) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    }

    for (let attempt = 1; attempt <= MAX_SEAT_ATTEMPTS; attempt += 1) {
      try {
        const seat = await db.transaction(async (tx) => {
          const seatLabel = await nextSeatLabel(tx, sessionId)
          return createSeat(tx, { sessionId, seatLabel, seatNote: body.seatNote })
        })

        return NextResponse.json({ success: true, data: seat }, { status: 201 })
      } catch (error) {
        if (!isUniqueViolation(error, SEAT_LABEL_INDEX)) throw error

        // Losing the last attempt is a CONFLICT, not a server fault. The first
        // version of this loop re-threw here and the generic handler turned it
        // into a 500 — a twelve-way burst during Task 5 produced five of them,
        // and the client would have shown "something went wrong" for what is
        // an ordinary, retryable race the waiter can just tap through.
        if (attempt === MAX_SEAT_ATTEMPTS) {
          console.warn(
            `[api/sessions/:sessionId/seats] Label race lost after ${MAX_SEAT_ATTEMPTS} attempts on session ${sessionId}`,
          )
          return fail('SEAT_LABEL_TAKEN', 'Could not add a seat. Try again.', 409)
        }
      }
    }

    // Unreachable: the loop either returns a seat or returns the 409 above.
    return fail('SEAT_LABEL_TAKEN', 'Could not add a seat. Try again.', 409)
  } catch (error) {
    console.error('[api/sessions/:sessionId/seats] Failed to add a seat:', error)
    return fail('INTERNAL_ERROR', 'Could not add a seat', 500)
  }
}

/**
 * The session's seats, oldest first.
 *
 * The order screen gets these from its own server query — this exists for a
 * client that needs to refresh them without a page load, which Story 4.4 will.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId: rawSessionId } = await params

  const parsedSessionId = sessionIdSchema.safeParse(rawSessionId)
  if (!parsedSessionId.success) {
    return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  }

  try {
    const seats = await db
      .select({
        id: seatSlots.id,
        seatLabel: seatSlots.seatLabel,
        seatNote: seatSlots.seatNote,
      })
      .from(seatSlots)
      .where(eq(seatSlots.sessionId, parsedSessionId.data))
      // Creation order, so a seat never moves in the row under a waiter's finger.
      .orderBy(asc(seatSlots.createdAt), asc(seatSlots.id))

    return NextResponse.json({ success: true, data: seats })
  } catch (error) {
    console.error('[api/sessions/:sessionId/seats] Failed to list seats:', error)
    return fail('INTERNAL_ERROR', 'Could not load the seats', 500)
  }
}
