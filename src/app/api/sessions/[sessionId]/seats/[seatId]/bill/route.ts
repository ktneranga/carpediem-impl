import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { bills, orderSessions, staff, tenantConfig } from '@/server/db/schema'
import { DUMMY_PIN_HASH } from '@/server/auth/dummy-pin-hash'
import {
  BillTooLargeError,
  CompAlreadyBilledError,
  CompsExceedOrderError,
  generateSeatBill,
  MissingTenantConfigError,
  SeatBillAlreadyExistsError,
  SeatHasNoItemsError,
  SeatNotOnSessionError,
  UnpricedItemError,
} from '@/server/services/bill.service'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'

const uuidSchema = z.string().uuid()

/** Same body as the consolidated route, minus the type — the path says it. */
const seatBillBodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/).optional(),
})

function fail(code: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ success: false, error: { code, message, ...extra } }, { status })
}

/**
 * Bills ONE seat, leaving the rest of the table open (Story 6.4, FR25/FR26).
 *
 * ── Deliberately the same shape as the consolidated route ───────────────────
 * The zod `safeParse` on both params, the `x-staff-id` UUID check, the re-auth
 * seam and the guarded re-read inside the catch are all copied from
 * `../../bills/route.ts` rather than re-derived. Every one of them exists
 * because Story 6.2's review found it missing, and a second billing route that
 * reinvented any of them would reintroduce the same defect in a new file.
 *
 * ── RBAC is INHERITED ───────────────────────────────────────────────────────
 * `permissions.ts` covers the `/api/sessions` prefix (owner + waiter) and
 * `proxy.ts` enforces it before this handler runs. There is no role check here
 * on purpose — the sibling seat and order routes say the same. Note the trap
 * that makes this worth stating: an UNMATCHED prefix defaults to ALLOW, so a
 * route under a path nobody covered would be open to kitchen staff. This one
 * is covered; it is verified as Kumar rather than assumed.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; seatId: string }> },
) {
  const { sessionId: rawSessionId, seatId: rawSeatId } = await params

  const parsedSessionId = uuidSchema.safeParse(rawSessionId)
  if (!parsedSessionId.success) {
    return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  }
  const parsedSeatId = uuidSchema.safeParse(rawSeatId)
  if (!parsedSeatId.success) {
    return fail('INVALID_SEAT_ID', 'Seat id must be a UUID', 400)
  }
  const sessionId = parsedSessionId.data
  const seatId = parsedSeatId.data

  const rawStaffId = request.headers.get('x-staff-id')
  if (!rawStaffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }
  const parsedStaffId = uuidSchema.safeParse(rawStaffId)
  if (!parsedStaffId.success) {
    return fail('INVALID_STAFF_ID', 'Staff id must be a UUID', 400)
  }
  const headerStaffId = parsedStaffId.data

  // An empty body is fine here — unlike the consolidated route there is no
  // `type` to carry, and the PIN is only needed when re-auth is on.
  const raw = await request.text()
  let body: unknown = {}
  if (raw.trim() !== '') {
    try {
      body = JSON.parse(raw)
    } catch {
      return fail('INVALID_BODY', 'Request body must be JSON', 400)
    }
  }

  const parsedBody = seatBillBodySchema.safeParse(body)
  if (!parsedBody.success) {
    return fail('INVALID_BODY', 'PIN must be four digits', 400)
  }
  const { pin } = parsedBody.data

  try {
    const [session] = await db
      .select({ id: orderSessions.id, tenantId: orderSessions.tenantId })
      .from(orderSessions)
      .where(eq(orderSessions.id, sessionId))
      .limit(1)

    if (!session) {
      return fail('SESSION_NOT_FOUND', 'No such order', 404)
    }

    const [config] = await db
      .select({ reauth: tenantConfig.financialActionReauth })
      .from(tenantConfig)
      .where(eq(tenantConfig.tenantId, session.tenantId))
      .limit(1)

    // Fails CLOSED on a missing config row, like the consolidated route. A
    // misconfiguration must not silently skip the PIN requirement.
    if (!config) {
      console.error(
        '[api/sessions/:sessionId/seats/:seatId/bill] No tenant_config for tenant',
        session.tenantId,
      )
      return fail('INTERNAL_ERROR', 'Could not generate the bill', 500)
    }

    let billingStaffId = headerStaffId
    if (config.reauth) {
      if (!pin) {
        return fail('REAUTH_REQUIRED', 'Enter your PIN to bill this seat', 401)
      }
      const [person] = await db
        .select({ id: staff.id, pinHash: staff.pinHash })
        .from(staff)
        .where(and(eq(staff.id, headerStaffId), eq(staff.isActive, true)))
        .limit(1)

      // The shared constant — a VALID 60-character hash, so an unknown id
      // costs the same as a wrong PIN. Story 6.2 hand-typed a 59-character one
      // here and opened a 0ms-vs-336ms enumeration oracle under a comment
      // claiming it had closed exactly that.
      const isMatch = await bcrypt.compare(pin, person?.pinHash ?? DUMMY_PIN_HASH)
      if (!person || !isMatch) {
        return fail('REAUTH_FAILED', 'That PIN was not recognised', 401)
      }
      billingStaffId = person.id
    }

    const bill = await db.transaction((tx) =>
      generateSeatBill(tx, { sessionId: session.id, seatId, staffId: billingStaffId }),
    )

    return NextResponse.json({ success: true, data: bill }, { status: 201 })
  } catch (error) {
    if (error instanceof SeatNotOnSessionError) {
      return fail('SEAT_NOT_ON_SESSION', 'That seat is not on this order', 404)
    }
    if (error instanceof SeatHasNoItemsError) {
      return fail('SEAT_HAS_NO_ITEMS', 'This seat has nothing left to bill', 422)
    }
    if (error instanceof SeatBillAlreadyExistsError) {
      let billId = error.billId
      if (!billId) {
        // GUARDED. An unguarded throw here escapes the handler and the route
        // returns Next's error page instead of the envelope every client
        // parses — the lesson the orders route documents and the consolidated
        // bills route now follows.
        try {
          const [winner] = await db
            .select({ id: bills.id })
            .from(bills)
            .where(and(eq(bills.sessionId, sessionId), eq(bills.seatSlotId, seatId)))
            .limit(1)
          billId = winner?.id ?? ''
        } catch (reReadError) {
          console.error(
            '[api/sessions/:sessionId/seats/:seatId/bill] Could not re-read the winner:',
            reReadError,
          )
        }
      }
      return fail('SEAT_ALREADY_BILLED', 'This seat already has a bill', 409, { billId, seatId })
    }
    if (error instanceof SessionAlreadyClosedError) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    }
    if (error instanceof CompAlreadyBilledError) {
      return fail(
        'COMP_ALREADY_BILLED',
        'A discount on this seat is already on another bill',
        409,
      )
    }
    if (error instanceof UnpricedItemError) {
      console.error(
        '[api/sessions/:sessionId/seats/:seatId/bill] Order event has no price:',
        error.orderEventId,
      )
      return fail('ITEM_NOT_PRICED', 'An item on this seat has no price recorded', 422)
    }
    if (error instanceof CompsExceedOrderError) {
      return fail(
        'COMPS_EXCEED_ORDER',
        'The discounts on this seat are larger than what it ordered',
        422,
      )
    }
    if (error instanceof BillTooLargeError) {
      return fail('BILL_TOO_LARGE', 'This total is too large to record', 422)
    }
    if (error instanceof MissingTenantConfigError) {
      console.error('[api/sessions/:sessionId/seats/:seatId/bill] No tenant_config row')
      return fail('INTERNAL_ERROR', 'Could not generate the bill', 500)
    }
    console.error('[api/sessions/:sessionId/seats/:seatId/bill] Failed to bill seat:', error)
    return fail('INTERNAL_ERROR', 'Could not bill this seat', 500)
  }
}
