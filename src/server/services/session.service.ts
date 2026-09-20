import { eq, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { staffSessions, tenantConfig, type staffRoleEnum } from '@/server/db/schema'
import { signSessionId, verifySessionCookie } from '@/server/auth/session-cookie'

// NOTE: no `import 'server-only'` here.
// src/proxy.ts imports this module, and the proxy is neither a Server Component
// nor a Route Handler — the server-only marker throws in that context. Every
// export below is still server-side by construction: they all touch `db`, which
// carries its own server-only guard.

// The cookie name, the signing and the verification moved to
// `src/server/auth/session-cookie.ts` in Story 4.5, so the socket authenticator
// in `server.ts` — where `db` cannot be imported — shares them rather than
// carrying a copy. Re-exported so existing importers keep working.
export {
  MIN_SESSION_SECRET_LENGTH,
  SESSION_COOKIE_NAME,
  signSessionId,
  verifySessionCookie,
} from '@/server/auth/session-cookie'

export type StaffRole = (typeof staffRoleEnum.enumValues)[number]

/** Idle timeout in minutes for a tenant, from tenant_config. Falls back to 5. */
export async function getSessionTimeoutMinutes(tenantId: string): Promise<number> {
  const [config] = await db
    .select({ minutes: tenantConfig.sessionTimeoutMinutes })
    .from(tenantConfig)
    .where(eq(tenantConfig.tenantId, tenantId))
    .limit(1)

  return config?.minutes ?? 5
}

export type CreatedSession = {
  sessionId: string
  cookieValue: string
  expiresAt: Date
  timeoutMinutes: number
}

export async function createSession(params: {
  tenantId: string
  staffId: string
  role: StaffRole
}): Promise<CreatedSession> {
  const timeoutMinutes = await getSessionTimeoutMinutes(params.tenantId)

  // expires_at is computed by PostgreSQL, not by Node. See the CLOCK note below
  // — last_active_at defaults to the database's now(), so anything compared
  // against it must come from the same clock.
  const [row] = await db
    .insert(staffSessions)
    .values({
      tenantId: params.tenantId,
      staffId: params.staffId,
      role: params.role,
      expiresAt: sql`now() + make_interval(mins => ${timeoutMinutes})`,
    })
    .returning({ id: staffSessions.id, expiresAt: staffSessions.expiresAt })

  return {
    sessionId: row.id,
    cookieValue: signSessionId(row.id),
    expiresAt: row.expiresAt,
    timeoutMinutes,
  }
}

/** Deletes a session. Safe to call with an id that no longer exists. */
export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(staffSessions).where(eq(staffSessions.id, sessionId))
}

/**
 * ── CLOCK AUTHORITY: PostgreSQL, always ──────────────────────────────────────
 *
 * Every timestamp in `staff_sessions` is written by the database (`defaultNow()`
 * or an explicit `now()`), and every comparison against those timestamps happens
 * in SQL. Node's `Date.now()` is never used for session expiry.
 *
 * This is not stylistic. During development the Docker container's clock was
 * measured 120 seconds ahead of the host — routine drift for a VM-backed Docker
 * Desktop, and worse after a host sleep/resume. Mixing the two clocks made a
 * session backdated two minutes look 2.5 seconds old, so idle expiry silently
 * failed to fire. In production the same skew would log staff out early or keep
 * dead sessions alive.
 *
 * One clock, and it is the shared one.
 */
export type ValidatedSession = {
  sessionId: string
  staffId: string
  tenantId: string
  role: StaffRole
  /** Seconds since last activity, measured by PostgreSQL. */
  idleSeconds: number
  timeoutMinutes: number
}

/**
 * Full validation for the request path: signature, existence, and idle expiry.
 *
 * Returns null for every failure mode — bad signature, unknown id, expired —
 * deliberately without distinguishing them. Telling a caller that a session id
 * "existed but expired" confirms the id was real.
 */
export async function validateSession(
  cookieValue: string | undefined | null,
): Promise<ValidatedSession | null> {
  // Signature first. A forged cookie must cost zero database queries.
  const sessionId = verifySessionCookie(cookieValue)
  if (!sessionId) return null

  const [row] = await db
    .select({
      id: staffSessions.id,
      staffId: staffSessions.staffId,
      tenantId: staffSessions.tenantId,
      role: staffSessions.role,
      // Idle age computed by PostgreSQL against its own clock — never derived
      // from Date.now(). See the CLOCK AUTHORITY note above.
      idleSeconds: sql<number>`extract(epoch from (now() - ${staffSessions.lastActiveAt}))`,
    })
    .from(staffSessions)
    .where(eq(staffSessions.id, sessionId))
    .limit(1)

  if (!row) return null

  const timeoutMinutes = await getSessionTimeoutMinutes(row.tenantId)

  // Idle window measured from last activity, NOT from a fixed expiry stamped at
  // login. `session_short` means "5 minutes idle", not "5 minutes total" —
  // otherwise a waiter mid-shift is logged out while actively taking orders.
  const idleSeconds = Number(row.idleSeconds)

  if (idleSeconds > timeoutMinutes * 60) {
    await destroySession(row.id)
    return null
  }

  return {
    sessionId: row.id,
    staffId: row.staffId,
    tenantId: row.tenantId,
    role: row.role,
    idleSeconds,
    timeoutMinutes,
  }
}

/** Below this idle age (seconds), skip the activity write entirely. */
const TOUCH_THROTTLE_SECONDS = 30

/**
 * Advances the idle window. Throttled: writing on every request would mean a
 * database round trip per page load and per API call, which NFR-P2 would feel.
 * 30 seconds of slack is immaterial against a 5-minute window.
 *
 * Returns true if a write happened, so the caller knows whether to refresh the
 * cookie's Max-Age alongside it.
 */
export async function touchSession(session: ValidatedSession): Promise<boolean> {
  if (session.idleSeconds < TOUCH_THROTTLE_SECONDS) {
    return false
  }

  // Both timestamps written by PostgreSQL. See CLOCK AUTHORITY above.
  await db
    .update(staffSessions)
    .set({
      lastActiveAt: sql`now()`,
      expiresAt: sql`now() + make_interval(mins => ${session.timeoutMinutes})`,
    })
    .where(eq(staffSessions.id, session.sessionId))

  return true
}

/**
 * Reaps sessions nobody came back to.
 *
 * validateSession only deletes rows it actually encounters, so a staff member
 * who closes the tab and never returns leaves a row forever. Called on an
 * interval from server.ts.
 */
export async function deleteExpiredSessions(): Promise<number> {
  // `now()` not `new Date()` — same clock as the column being compared.
  const deleted = await db
    .delete(staffSessions)
    .where(sql`${staffSessions.expiresAt} < now()`)
    .returning({ id: staffSessions.id })

  return deleted.length
}
