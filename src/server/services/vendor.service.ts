import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { tenants, vendorAccessEvents } from '@/server/db/schema'
import { signSessionId, verifySessionCookie } from '@/server/auth/session-cookie'

/**
 * Vendor access (spec-11-1-vendor-access-export, Teran 2026-11-14): the
 * developer signs in at `/vendor` with `VENDOR_SECRET` and can only download a
 * database export. Not a staff role, not a PIN, not in the staff list.
 *
 * ── The session is the audit row ─────────────────────────────────────────────
 * Signing in writes a `sign_in` row; its id, signed with the POS cookie's HMAC,
 * is the cookie. Valid for 30 minutes from the row's `created_at`, measured by
 * PostgreSQL. No sessions table: the record and the session are one fact.
 */

export const VENDOR_COOKIE_NAME = '__cdrms_vendor'
export const VENDOR_SESSION_MINUTES = 30
const MIN_SECRET_LENGTH = 16
/** The login body's limit too: a longer secret could never be typed in. */
export const MAX_SECRET_LENGTH = 1024

// ── Wrong-password lockout ───────────────────────────────────────────────────
// Process-wide (one POS server): 5 wrong in a row lock vendor sign-in for 15
// minutes. A restart clears it, as with the void PIN lockout. Locking everyone
// out of /vendor is the cost; nobody but the developer uses it.
const MAX_WRONG = 5
const LOCK_MS = 15 * 60 * 1000
let wrong = 0
let lastWrongAt = 0
let lockedUntil = 0

/** The configured secret, or null when vendor access is off. */
function secret(): string | null {
  const value = process.env.VENDOR_SECRET?.trim() ?? ''
  return value.length >= MIN_SECRET_LENGTH && value.length <= MAX_SECRET_LENGTH ? value : null
}

export function vendorConfigured(): boolean {
  return secret() !== null
}

export type PasswordCheck = { ok: true } | { ok: false; code: 'VENDOR_DISABLED' | 'LOCKED' | 'INVALID_PASSWORD'; minutes?: number }

/** Constant-time compare of SHA-256 digests (equal length whatever was typed). */
export function checkVendorPassword(password: string, now = Date.now()): PasswordCheck {
  const expected = secret()
  if (!expected) return { ok: false, code: 'VENDOR_DISABLED' }
  if (lockedUntil > now) return { ok: false, code: 'LOCKED', minutes: Math.ceil((lockedUntil - now) / 60_000) }

  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  if (timingSafeEqual(digest(password), digest(expected))) {
    wrong = 0
    lockedUntil = 0
    return { ok: true }
  }
  // "In a row" means within the lock window: five typos spread over a month
  // are not an attack.
  if (now - lastWrongAt > LOCK_MS) wrong = 0
  lastWrongAt = now
  wrong += 1
  if (wrong >= MAX_WRONG) {
    wrong = 0
    lockedUntil = now + LOCK_MS
  }
  return { ok: false, code: 'INVALID_PASSWORD' }
}

/** For the verify script only. */
export function resetVendorLockoutForTests(): void {
  wrong = 0
  lastWrongAt = 0
  lockedUntil = 0
}

/** The installation's tenant (single tenant per stack, NFR-SC1), as the login route reads it. */
export async function installationTenant(): Promise<{ id: string; timeZone: string } | null> {
  // Ordered, so the sign-in row and the owner's Manage line always read the same tenant.
  const [tenant] = await db
    .select({ id: tenants.id, timeZone: tenants.timezone })
    .from(tenants)
    .orderBy(asc(tenants.createdAt), asc(tenants.id))
    .limit(1)
  return tenant ?? null
}

/** Records the sign-in and returns the cookie value for it. */
export async function startVendorSession(tenantId: string): Promise<string> {
  const [row] = await db.insert(vendorAccessEvents).values({ tenantId, kind: 'sign_in' }).returning({ id: vendorAccessEvents.id })
  return signSessionId(row!.id)
}

/** The live vendor session a cookie names, or null (missing, forged, not a sign-in, or older than 30 minutes). */
export async function validateVendorSession(cookie: string | undefined | null): Promise<{ tenantId: string } | null> {
  const id = verifySessionCookie(cookie)
  if (!id || !z.string().uuid().safeParse(id).success) return null
  const [row] = await db
    .select({ tenantId: vendorAccessEvents.tenantId })
    .from(vendorAccessEvents)
    .where(
      and(
        eq(vendorAccessEvents.id, id),
        eq(vendorAccessEvents.kind, 'sign_in'),
        sql`${vendorAccessEvents.createdAt} > clock_timestamp() - make_interval(mins => ${VENDOR_SESSION_MINUTES})`,
      ),
    )
    .limit(1)
  return row ?? null
}

export async function recordExport(tenantId: string): Promise<void> {
  await db.insert(vendorAccessEvents).values({ tenantId, kind: 'export' })
}

/**
 * For the owner's Manage nav: the latest vendor sign-in and the latest export,
 * each on its own, so a later sign-in never hides that a copy was taken.
 */
export async function lastVendorAccess(tenantId: string): Promise<{ signIn: Date | null; export: Date | null }> {
  const latest = async (kind: 'sign_in' | 'export') =>
    (
      await db
        .select({ at: vendorAccessEvents.createdAt })
        .from(vendorAccessEvents)
        .where(and(eq(vendorAccessEvents.tenantId, tenantId), eq(vendorAccessEvents.kind, kind)))
        .orderBy(desc(vendorAccessEvents.createdAt))
        .limit(1)
    )[0]?.at ?? null
  const [signIn, exported] = await Promise.all([latest('sign_in'), latest('export')])
  return { signIn, export: exported }
}

/** "14 Nov, 21:30" in the restaurant's zone (a bad zone falls back to UTC). */
export function vendorWhen(at: Date, timeZone: string): string {
  const format = (zone: string) =>
    `${at.toLocaleDateString('en-GB', { timeZone: zone, day: 'numeric', month: 'short' })}, ${at.toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
  try {
    return format(timeZone)
  } catch {
    return format('UTC')
  }
}

/** `carpe-diem_2026-11-14_2130.dump`, in the restaurant's time zone. */
export function dumpFilename(now: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  )
  return `carpe-diem_${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}.dump`
}

export function vendorCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS_ENABLED === 'true',
    path: '/',
    maxAge: VENDOR_SESSION_MINUTES * 60,
  }
}
