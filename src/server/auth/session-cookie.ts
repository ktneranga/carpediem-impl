import { createHmac, timingSafeEqual } from 'node:crypto'

// ── Dependency-free on purpose ───────────────────────────────────────────────
// No `server-only`, no `@/server/db`, no path aliases. This module is imported
// by the session service (inside Next) AND by the socket authenticator, which
// runs in `server.ts` — a plain Node process where `server-only` throws. Story
// 4.5 moved the signature code here so the two paths share one implementation
// rather than a copy that could drift.

export const SESSION_COOKIE_NAME = '__cdrms_session'

/** Minimum acceptable SESSION_SECRET length. Enforced at startup by server.ts. */
export const MIN_SESSION_SECRET_LENGTH = 32

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) {
    // server.ts validates this at boot, so reaching here means the process was
    // started by some path that skipped the check. Fail rather than sign weakly.
    throw new Error(
      `[session] SESSION_SECRET missing or shorter than ${MIN_SESSION_SECRET_LENGTH} characters`,
    )
  }
  return secret
}

function computeSignature(sessionId: string): string {
  return createHmac('sha256', getSessionSecret()).update(sessionId).digest('hex')
}

/**
 * Cookie value is `<sessionId>.<hmac>`.
 *
 * The session id alone would be sufficient for lookup — it is 128 bits of
 * randomness. The signature lets us reject forged or tampered cookies without a
 * database round trip, and gives SESSION_SECRET an actual job.
 */
export function signSessionId(sessionId: string): string {
  return `${sessionId}.${computeSignature(sessionId)}`
}

/**
 * Returns the session id if the signature is valid, otherwise null.
 * Never throws on malformed input — a garbage cookie is just an invalid one.
 */
export function verifySessionCookie(cookieValue: string | undefined | null): string | null {
  if (!cookieValue) return null

  const separatorIndex = cookieValue.lastIndexOf('.')
  if (separatorIndex <= 0) return null

  const sessionId = cookieValue.slice(0, separatorIndex)
  const providedSignature = cookieValue.slice(separatorIndex + 1)

  let expectedSignature: string
  try {
    expectedSignature = computeSignature(sessionId)
  } catch {
    return null
  }

  const provided = Buffer.from(providedSignature, 'utf8')
  const expected = Buffer.from(expectedSignature, 'utf8')

  // timingSafeEqual throws on length mismatch, and a plain `===` would
  // short-circuit on the first differing byte — leaking signature bytes.
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null

  return sessionId
}

/** Reads one cookie out of a raw `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}
