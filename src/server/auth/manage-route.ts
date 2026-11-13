import 'server-only'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { SESSION_COOKIE_NAME, validateSession, type ValidatedSession } from '@/server/services/session.service'
import {
  createManageSession,
  MANAGE_COOKIE_NAME,
  manageCookieOptions,
} from '@/server/services/manage-session.service'

/**
 * Shared by the Manage auth routes (unlock, password, lock), Story 10.0.
 *
 * They need the POS SESSION ID — the Manage session is tied to it — and the
 * proxy passes only who and which role. So the POS cookie is validated again
 * here; the proxy has already refused anyone without a live owner session.
 */

export function manageFail(code: string, message: string, status: number, extra?: object) {
  return NextResponse.json({ success: false, error: { code, message, ...extra } }, { status })
}

/** The owner's live POS session, or null. */
export async function currentOwnerSession(): Promise<ValidatedSession | null> {
  const cookieStore = await cookies()
  const session = await validateSession(cookieStore.get(SESSION_COOKIE_NAME)?.value)
  return session && session.role === 'owner' ? session : null
}

/** Starts a Manage session for this POS session and sets its cookie. */
export async function startManageSession(staffSessionId: string): Promise<void> {
  const { cookieValue } = await createManageSession(staffSessionId)
  const cookieStore = await cookies()
  cookieStore.set(MANAGE_COOKIE_NAME, cookieValue, manageCookieOptions())
}

/**
 * The password out of a request body, or null. A fixed shape check, never a
 * Zod issue list — that echoes the received value, which here is the password.
 */
export async function readPassword(request: Request): Promise<string | null> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const password = (body as { password?: unknown }).password
  return typeof password === 'string' ? password : null
}
