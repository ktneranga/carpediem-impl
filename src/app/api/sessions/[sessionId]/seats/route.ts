import { NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { seatSlots } from '@/server/db/schema'
import { isUniqueViolation } from '@/server/db/errors'
import {
  createSeat,
  lockOpenSession,
  nextSeatLabel,
  SessionAlreadyClosedError,
} from '@/server/services/table-session.service'

const sessionIdSchema = z.string().uuid()

/**
 * The index that decides the Add Seat race. Named, so an unrelated 23505 is a 500.
 *
 * ⚠️ This string is coupled to `idx_seat_slots_session_label` in `schema.ts` and
 * nothing checks the pair. Renaming it there without updating it here turns
 * every concurrent tap into a 409 that never resolves — the same warning the
 * tables index carries, which this constant was missing until the 4.3 review.
 */
const SEAT_LABEL_INDEX = 'idx_seat_slots_session_label'

/**
 * A memory aid, not a description. Long enough for "curly hair, blue dress".
 *
 * Declared here, in the `[seatId]` route and in `order-screen.tsx`. Three copies
 * of one number, and nothing checks that they agree — the database deliberately
 * has no CHECK, because a waiter's typo must never be a 500. Keep them in step
 * by hand until there is a shared constants module worth adding.
 */
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

/**
 * An absent body is the common case — Add Seat is one tap — but a body that is
 * PRESENT and malformed must fail.
 *
 * This schema used to carry `.catch({ seatNote: undefined })`, and `.catch()`
 * chained to an object swallows every parse failure of the whole object, not
 * just a missing field. A 60-character note and `{"seatNote": 12345}` both
 * returned **201 with the note silently dropped**, while `PATCH` returned 400
 * for the identical input. The comment sitting here claimed the opposite. Found
 * in the 4.3 review and reproduced against the running server.
 *
 * The "absent body" case is now handled where the body is read, not by making
 * the schema permissive.
 */
const bodySchema = z.object({ seatNote: z.string().max(MAX_SEAT_NOTE).optional() })

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

  // No body at all is Add Seat's one-tap path, so an unparseable request becomes
  // an empty object. A body that IS present still has to satisfy the schema.
  const raw = await request.json().catch(() => ({}))
  const parsedBody = bodySchema.safeParse(raw ?? {})

  if (!parsedBody.success) {
    return fail(
      'INVALID_BODY',
      `seatNote must be text of at most ${MAX_SEAT_NOTE} characters`,
      400,
    )
  }

  try {
    for (let attempt = 1; attempt <= MAX_SEAT_ATTEMPTS; attempt += 1) {
      try {
        const seat = await db.transaction(async (tx) => {
          // INSIDE the transaction, under the row lock. The open-check used to
          // run in its own statement that closed before this transaction began,
          // so a session closed in the gap still gained a seat — the exact
          // read-then-write shape Trap 2 forbids and `deleteSeat` avoids.
          await lockOpenSession(tx, sessionId)

          const seatLabel = await nextSeatLabel(tx, sessionId)
          return createSeat(tx, { sessionId, seatLabel, seatNote: parsedBody.data.seatNote })
        })

        return NextResponse.json({ success: true, data: seat }, { status: 201 })
      } catch (error) {
        if (error instanceof SessionAlreadyClosedError) {
          return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
        }
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
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId: rawSessionId } = await params

  const parsedSessionId = sessionIdSchema.safeParse(rawSessionId)
  if (!parsedSessionId.success) {
    return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  }

  // The proxy already refuses an unauthenticated request before this handler
  // runs — verified — so this is defence in depth, not the gate. It is here
  // because the other three handlers in this namespace have it, and one
  // handler quietly missing the check reads as either a bug or proof that the
  // check is decorative. Prefix RBAC in this codebase defaults to ALLOW on an
  // unmatched prefix, so neither reading is one to leave lying around.
  if (!request.headers.get('x-staff-id')) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
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
      // STABLE order, so a seat never moves in the row under a waiter's finger.
      // Not strictly creation order: `created_at` defaults to `now()`, which is
      // transaction time, so seats written in one transaction all tie and fall
      // back to uuid order. Stable is the property that matters here; if 4.4
      // ever batch-creates seats, give them an explicit sequence instead.
      .orderBy(asc(seatSlots.createdAt), asc(seatSlots.id))

    return NextResponse.json({ success: true, data: seats })
  } catch (error) {
    console.error('[api/sessions/:sessionId/seats] Failed to list seats:', error)
    return fail('INTERNAL_ERROR', 'Could not load the seats', 500)
  }
}
