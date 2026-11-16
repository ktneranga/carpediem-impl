import 'server-only'
import { eq, sql } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { db } from '@/server/db'
import { tenants } from '@/server/db/schema'

/**
 * The Manage area password (Story 10.0, FR70). One per restaurant, on `tenants`.
 *
 * The password is never logged, never put in an error, never returned. Only the
 * bcrypt hash is stored (cost 10, architecture.md).
 *
 * ── The lockout ──────────────────────────────────────────────────────────────
 * 5 wrong in a row → every attempt refused for 5 minutes, even a right one.
 * Counted in the database under a row lock (`SELECT … FOR UPDATE`): an
 * in-memory counter resets on restart, and parallel guesses would each read
 * "4 so far" and all get a try. Per restaurant, not per device — an attacker
 * can change devices. Database clock only.
 */

export const MANAGE_MAX_ATTEMPTS = 5
export const MANAGE_LOCK_MINUTES = 5
const BCRYPT_COST = 10

/** bcrypt ignores bytes past 72, so a longer password would really be its first 72. */
export const MANAGE_PASSWORD_MIN_BYTES = 8
export const MANAGE_PASSWORD_MAX_BYTES = 72

/** Length in UTF-8 BYTES, which is what bcrypt counts. */
export function isValidManagePasswordLength(password: string): boolean {
  const bytes = Buffer.byteLength(password, 'utf8')
  return bytes >= MANAGE_PASSWORD_MIN_BYTES && bytes <= MANAGE_PASSWORD_MAX_BYTES
}

export type ManagePasswordState = {
  isSet: boolean
  /** 0 when not locked. */
  lockedForSeconds: number
}

export async function getManagePasswordState(tenantId: string): Promise<ManagePasswordState> {
  const [row] = await db
    .select({
      isSet: sql<boolean>`${tenants.managePasswordHash} is not null`,
      lockedForSeconds: sql<number>`greatest(0, ceil(extract(epoch from (${tenants.manageLockedUntil} - now()))))`,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)

  return {
    isSet: Boolean(row?.isSet),
    lockedForSeconds: Number(row?.lockedForSeconds ?? 0),
  }
}

export type SetPasswordResult = { kind: 'set' } | { kind: 'already-set' } | { kind: 'invalid-length' }

/** First time only. A password already set is refused — the reset command clears it. */
export async function setManagePassword(
  tenantId: string,
  password: string,
): Promise<SetPasswordResult> {
  if (!isValidManagePasswordLength(password)) return { kind: 'invalid-length' }

  const hash = await bcrypt.hash(password, BCRYPT_COST)

  // `WHERE hash IS NULL` makes two racing first-time setters safe: one wins,
  // the other updates nothing and is told it is already set.
  const updated = await db
    .update(tenants)
    .set({ managePasswordHash: hash, manageFailedAttempts: 0, manageLockedUntil: null })
    .where(sql`${tenants.id} = ${tenantId} and ${tenants.managePasswordHash} is null`)
    .returning({ id: tenants.id })

  return updated.length === 1 ? { kind: 'set' } : { kind: 'already-set' }
}

export type CheckPasswordResult =
  | { kind: 'ok' }
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'locked'; retryAfterSeconds: number }
  | { kind: 'not-set' }

export async function checkManagePassword(
  tenantId: string,
  password: string,
): Promise<CheckPasswordResult> {
  return db.transaction(async (tx) => {
    // The row lock is the race guard: a second attempt waits here until the
    // first has written its count.
    const result = await tx.execute(sql`
      select manage_password_hash as hash,
             manage_failed_attempts as attempts,
             greatest(0, ceil(extract(epoch from (manage_locked_until - now()))))::int as locked_for
        from tenants
       where id = ${tenantId}
       for update`)
    const row = result.rows[0] as
      | { hash: string | null; attempts: number; locked_for: number }
      | undefined

    if (!row || !row.hash) return { kind: 'not-set' as const }

    if (Number(row.locked_for) > 0) {
      return { kind: 'locked' as const, retryAfterSeconds: Number(row.locked_for) }
    }

    const matches = await bcrypt.compare(password, row.hash)

    if (matches) {
      await tx
        .update(tenants)
        .set({ manageFailedAttempts: 0, manageLockedUntil: null })
        .where(eq(tenants.id, tenantId))
      return { kind: 'ok' as const }
    }

    const attempts = Number(row.attempts) + 1
    if (attempts >= MANAGE_MAX_ATTEMPTS) {
      await tx
        .update(tenants)
        .set({
          manageFailedAttempts: 0,
          manageLockedUntil: sql`now() + make_interval(mins => ${MANAGE_LOCK_MINUTES})`,
        })
        .where(eq(tenants.id, tenantId))
      return { kind: 'locked' as const, retryAfterSeconds: MANAGE_LOCK_MINUTES * 60 }
    }

    await tx.update(tenants).set({ manageFailedAttempts: attempts }).where(eq(tenants.id, tenantId))
    return { kind: 'wrong' as const, attemptsLeft: MANAGE_MAX_ATTEMPTS - attempts }
  })
}

export type ChangePasswordResult =
  | { kind: 'changed' }
  | { kind: 'invalid-length' }
  | Exclude<CheckPasswordResult, { kind: 'ok' }>

/**
 * The owner changes the Manage password from inside Manage (Teran,
 * 2026-11-16). The CURRENT password is checked first, through the same
 * lockout as the unlock screen, so an unattended open Manage cannot be used
 * to take it over. Every other device's Manage session ends; this one stays.
 */
export async function changeManagePassword(
  tenantId: string,
  { current, next, keepStaffSessionId }: { current: string; next: string; keepStaffSessionId: string },
): Promise<ChangePasswordResult> {
  if (!isValidManagePasswordLength(next)) return { kind: 'invalid-length' }
  const checked = await checkManagePassword(tenantId, current)
  if (checked.kind !== 'ok') return checked

  const hash = await bcrypt.hash(next, BCRYPT_COST)
  await db.transaction(async (tx) => {
    await tx
      .update(tenants)
      .set({ managePasswordHash: hash, manageFailedAttempts: 0, manageLockedUntil: null })
      .where(eq(tenants.id, tenantId))
    await tx.execute(sql`
      delete from manage_sessions m
       using staff_sessions s
       where s.id = m.staff_session_id
         and s.tenant_id = ${tenantId} and m.staff_session_id <> ${keepStaffSessionId}`)
  })
  return { kind: 'changed' }
}
