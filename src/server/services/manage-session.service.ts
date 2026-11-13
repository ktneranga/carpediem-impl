import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { manageSessions } from '@/server/db/schema'
import { signSessionId, verifySessionCookie } from '@/server/auth/session-cookie'

// NOTE: no `import 'server-only'` here — src/proxy.ts imports this module, for
// the same reason as session.service.ts. `db` carries its own guard.

/**
 * The Manage area's own session (Story 10.0, FR70, NFR-S7).
 *
 * A PIN opens the floor; a Manage session is the extra proof — the password —
 * that opens configuration. It belongs to ONE POS session (`staff_session_id`,
 * ON DELETE CASCADE), so signing out, switching user or the POS idle timeout
 * ends it with no code here, and another tablet signed in as the same owner
 * has to unlock on its own.
 *
 * The cookie is signed with the POS cookie's HMAC (`signSessionId` signs any
 * id). One secret, one scheme: two signers are how they drift.
 *
 * Clock: PostgreSQL only, as in session.service.ts (CLOCK AUTHORITY).
 */

export const MANAGE_COOKIE_NAME = '__cdrms_manage'

/** NFR-S7. A constant, not a tenant setting yet. */
export const MANAGE_IDLE_MINUTES = 15

/** Same throttle as `touchSession`: no write per request. */
const TOUCH_THROTTLE_SECONDS = 30

/** Cookie options, exactly as the POS cookie's, with the Manage idle window. */
export function manageCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS_ENABLED === 'true',
    path: '/',
    maxAge: MANAGE_IDLE_MINUTES * 60,
  }
}

export type ValidatedManageSession = {
  manageSessionId: string
  /** Seconds since last Manage activity, measured by PostgreSQL. */
  idleSeconds: number
}

export async function createManageSession(
  staffSessionId: string,
): Promise<{ manageSessionId: string; cookieValue: string }> {
  const [row] = await db
    .insert(manageSessions)
    .values({ staffSessionId })
    .returning({ id: manageSessions.id })

  return { manageSessionId: row.id, cookieValue: signSessionId(row.id) }
}

/** Safe with an id that no longer exists. */
export async function destroyManageSession(manageSessionId: string): Promise<void> {
  await db.delete(manageSessions).where(eq(manageSessions.id, manageSessionId))
}

/**
 * Null unless the signature is good, the row exists, it belongs to THIS POS
 * session, and it has been idle at most 15 minutes. Like `validateSession`, it
 * does not say which of those failed.
 */
export async function validateManageSession(
  cookieValue: string | undefined | null,
  staffSessionId: string,
): Promise<ValidatedManageSession | null> {
  // Signature first: a forged cookie costs no query.
  const manageSessionId = verifySessionCookie(cookieValue)
  if (!manageSessionId) return null

  const [row] = await db
    .select({
      id: manageSessions.id,
      idleSeconds: sql<number>`extract(epoch from (now() - ${manageSessions.lastActiveAt}))`,
    })
    .from(manageSessions)
    // Both in the WHERE: session A's Manage cookie with session B's POS cookie
    // finds nothing, the same as no cookie at all.
    .where(
      and(eq(manageSessions.id, manageSessionId), eq(manageSessions.staffSessionId, staffSessionId)),
    )
    .limit(1)

  if (!row) return null

  const idleSeconds = Number(row.idleSeconds)
  if (idleSeconds > MANAGE_IDLE_MINUTES * 60) {
    await destroyManageSession(row.id)
    return null
  }

  return { manageSessionId: row.id, idleSeconds }
}

/** Slides the idle window. True when it wrote, so the caller refreshes the cookie. */
export async function touchManageSession(session: ValidatedManageSession): Promise<boolean> {
  if (session.idleSeconds < TOUCH_THROTTLE_SECONDS) return false

  await db
    .update(manageSessions)
    .set({ lastActiveAt: sql`now()` })
    .where(eq(manageSessions.id, session.manageSessionId))

  return true
}
