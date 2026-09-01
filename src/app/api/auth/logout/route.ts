import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import {
  destroySession,
  verifySessionCookie,
  SESSION_COOKIE_NAME,
} from '@/server/services/session.service'

/**
 * Always returns 200, even with a missing or invalid cookie.
 *
 * Logout is idempotent, and differentiating "session destroyed" from "no such
 * session" would turn this endpoint into a probe for whether a stolen cookie is
 * still live.
 */
export async function POST() {
  try {
    const cookieStore = await cookies()
    const sessionId = verifySessionCookie(cookieStore.get(SESSION_COOKIE_NAME)?.value)

    if (sessionId) {
      await destroySession(sessionId)
    }

    cookieStore.delete(SESSION_COOKIE_NAME)

    return NextResponse.json({ success: true, data: null }, { status: 200 })
  } catch (error) {
    console.error('[auth/logout] Unexpected failure:', error)
    // Still clear the cookie client-side — the device should end up logged out
    // regardless of what went wrong server-side.
    const response = NextResponse.json({ success: true, data: null }, { status: 200 })
    response.cookies.delete(SESSION_COOKIE_NAME)
    return response
  }
}
