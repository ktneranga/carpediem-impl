import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { bills, orderSessions, staff, tenantConfig } from '@/server/db/schema'
import { DUMMY_PIN_HASH } from '@/server/auth/dummy-pin-hash'
import {
  BillAlreadyOpenError,
  BillTooLargeError,
  CompAlreadyBilledError,
  CompsExceedOrderError,
  generateConsolidatedBill,
  loadSessionBill,
  MissingTenantConfigError,
  NothingToBillError,
  UnpricedItemError,
} from '@/server/services/bill.service'
import { SessionAlreadyClosedError } from '@/server/services/table-session.service'

const sessionIdSchema = z.string().uuid()

/**
 * `safeParse`, never `.catch()`.
 *
 * Story 4.3's review found a body schema that silently defaulted a malformed
 * field instead of rejecting it, so a typo in a client became a valid request
 * meaning something else. A bad body here is a 400.
 *
 * `pin` is optional at the schema level and REQUIRED at runtime when the tenant
 * has `financial_action_reauth` on — see below.
 */
const billBodySchema = z.object({
  type: z.literal('consolidated'),
  pin: z.string().regex(/^\d{4}$/).optional(),
})

function fail(code: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { success: false, error: { code, message, ...extra } },
    { status },
  )
}

/**
 * Generates the consolidated bill for a session (FR21, Story 6.2 AC-1).
 *
 * ── The re-auth seam ─────────────────────────────────────────────────────────
 * `architecture.md:218`: when `financial_action_reauth` is true, bill and
 * payment routes "require a fresh PIN in the request body, validated inline
 * regardless of active session state", and the bill records the staff member
 * who gave that PIN. That behaviour is implemented here.
 *
 * Teran set the flag FALSE for the demo (2026-10-02), because Story 2.4 owns
 * the UI that collects a fresh PIN and is deferred post-demo. Leaving it true
 * would have left a configuration promising a protection nothing could satisfy.
 * The server side is honest either way: flip the flag and this route starts
 * demanding a PIN, and 2.4 only has to add the prompt.
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

  const rawStaffId = request.headers.get('x-staff-id')
  if (!rawStaffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  // Shape-checked, not just presence-checked. This value becomes
  // `bills.staff_id` — the person attributed with generating the bill — and it
  // was going straight into a uuid column, so a non-UUID produced a Postgres
  // `22P02` and an opaque 500 where a 400 belongs. The orders route validates
  // it for the same reason. The proxy cannot emit a bad one, but the route
  // should not depend on that being true forever.
  const parsedStaffId = sessionIdSchema.safeParse(rawStaffId)
  if (!parsedStaffId.success) {
    return fail('INVALID_STAFF_ID', 'Staff id must be a UUID', 400)
  }
  const headerStaffId = parsedStaffId.data

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }

  const parsedBody = billBodySchema.safeParse(body)
  if (!parsedBody.success) {
    // Name the field that actually failed. This returned `type must be
    // "consolidated"` for EVERY failure, so a mistyped PIN — the common case
    // once re-auth is on — was reported as a problem with a field the client
    // sent correctly, and `parsedBody.error` was discarded entirely.
    const culprit = parsedBody.error.issues[0]?.path[0]
    return fail(
      'INVALID_BODY',
      culprit === 'pin' ? 'PIN must be four digits' : 'type must be "consolidated"',
      400,
    )
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

    // ── Re-auth, before anything is written ─────────────────────────────────
    const [config] = await db
      .select({ reauth: tenantConfig.financialActionReauth })
      .from(tenantConfig)
      .where(eq(tenantConfig.tenantId, session.tenantId))
      .limit(1)

    // A missing config row used to make `config?.reauth` undefined, so the PIN
    // requirement was skipped silently — a security control failing OPEN on a
    // misconfiguration. It is a broken installation, not a reason to wave the
    // bill through. `readRates` refuses the same case for the same reason.
    if (!config) {
      console.error(
        '[api/sessions/:sessionId/bills] No tenant_config for tenant',
        session.tenantId,
      )
      return fail('INTERNAL_ERROR', 'Could not generate the bill', 500)
    }

    // The staff id on the bill is the one who authorised it. With re-auth off
    // that is the signed-in waiter; with it on it is whoever gave the PIN, and
    // the two are checked to be the same person so a bill cannot be stamped
    // with one waiter's id while another's PIN unlocked it.
    let billingStaffId = headerStaffId
    if (config.reauth) {
      if (!pin) {
        return fail('REAUTH_REQUIRED', 'Enter your PIN to generate this bill', 401)
      }
      const [person] = await db
        .select({ id: staff.id, pinHash: staff.pinHash })
        .from(staff)
        .where(and(eq(staff.id, headerStaffId), eq(staff.isActive, true)))
        .limit(1)

      // Burn a compare for an unknown or deactivated id too, so a wrong id and
      // a wrong PIN cost the same — the login route's rule (AC-3 there).
      //
      // This used `'$2a$12$' + 52 zeros`, which is 59 characters. bcrypt
      // rejects any hash that is not exactly 60 and returns false WITHOUT
      // running a round, so the comment above was false in practice: measured,
      // the unknown-id path returned in 0 ms and a real compare took 336 ms —
      // a clean staff-enumeration oracle. The login route's constant is a
      // valid hash, so it is imported rather than retyped.
      const isMatch = await bcrypt.compare(pin, person?.pinHash ?? DUMMY_PIN_HASH)
      if (!person || !isMatch) {
        return fail('REAUTH_FAILED', 'That PIN was not recognised', 401)
      }
      billingStaffId = person.id
    }

    const bill = await db.transaction((tx) =>
      generateConsolidatedBill(tx, { sessionId: session.id, staffId: billingStaffId }),
    )

    return NextResponse.json({ success: true, data: bill }, { status: 201 })
  } catch (error) {
    if (error instanceof NothingToBillError) {
      return fail('NOTHING_TO_BILL', 'This order has nothing on it yet', 422)
    }
    if (error instanceof BillAlreadyOpenError) {
      // The service's id is empty only on the unique-index path, where its
      // transaction rolled back before it could read the winner. Re-read here,
      // outside that transaction, so the client always gets an id to open.
      let billId = error.billId
      if (!billId) {
        // GUARDED. An unguarded throw here escapes the handler entirely and the
        // route returns Next's error page instead of the error envelope every
        // client parses — the orders route documents this exact trap and this
        // one did not copy it. A failed re-read costs the client the bill id,
        // not the 409.
        try {
          const [winner] = await db
            .select({ id: bills.id })
            .from(bills)
            .where(eq(bills.sessionId, sessionId))
            // Oldest first, matching `findOpenBill`. Without it Postgres
            // returns whichever row it likes, which is harmless at one bill per
            // session and wrong the moment 6.4's per-seat bills land.
            .orderBy(asc(bills.createdAt))
            .limit(1)
          billId = winner?.id ?? ''
        } catch (reReadError) {
          console.error(
            '[api/sessions/:sessionId/bills] Could not re-read the winning bill:',
            reReadError,
          )
        }
      }
      return fail('BILL_ALREADY_OPEN', 'This order already has a bill', 409, { billId })
    }
    if (error instanceof CompAlreadyBilledError) {
      // NOT "already has a bill". A comp claimed by another bill is a different
      // fault with a different fix, and conflating the two is the exact
      // mis-attribution `isUniqueViolation` exists to prevent.
      return fail(
        'COMP_ALREADY_BILLED',
        'A discount on this order is already on another bill',
        409,
      )
    }
    if (error instanceof SessionAlreadyClosedError) {
      return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    }
    if (error instanceof UnpricedItemError) {
      console.error(
        '[api/sessions/:sessionId/bills] Order event has no price:',
        error.orderEventId,
      )
      return fail('ITEM_NOT_PRICED', 'An item on this order has no price recorded', 422)
    }
    if (error instanceof CompsExceedOrderError) {
      return fail(
        'COMPS_EXCEED_ORDER',
        'The discounts on this order are larger than the order itself',
        422,
      )
    }
    if (error instanceof BillTooLargeError) {
      return fail('BILL_TOO_LARGE', 'This total is too large to record', 422)
    }
    if (error instanceof MissingTenantConfigError) {
      console.error('[api/sessions/:sessionId/bills] No tenant_config row')
      return fail('INTERNAL_ERROR', 'Could not generate the bill', 500)
    }
    console.error('[api/sessions/:sessionId/bills] Failed to generate bill:', error)
    return fail('INTERNAL_ERROR', 'Could not generate the bill', 500)
  }
}

/**
 * The bill this session has, or `null` (code review 2026-10-13).
 *
 * ── Why the order screen needs this ─────────────────────────────────────────
 * `settling` used to live in a `useState` set by the generate mutation. It was
 * therefore lost on a page refresh and never existed on a second tablet, so
 * the screen re-offered "Add More Items" on an already-billed order. The
 * server now refuses such a round (`SESSION_ALREADY_BILLED`), but a button
 * that only fails when pressed is not an answer — the screen has to KNOW.
 *
 * Returns the bill itself rather than a boolean, so 6.4's bill view has the
 * document it needs without another round trip.
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
    const bill = await loadSessionBill(db, parsedSessionId.data)
    return NextResponse.json({ success: true, data: { bill } }, { status: 200 })
  } catch (error) {
    console.error('[api/sessions/:sessionId/bills] Failed to read bill:', error)
    return fail('INTERNAL_ERROR', 'Could not load the bill', 500)
  }
}
