import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { verifySessionCookie } from '@/server/auth/session-cookie'
import { destroyManageSession, MANAGE_COOKIE_NAME } from '@/server/services/manage-session.service'

/**
 * Ends the Manage session at once (Story 10.0, AC 5 "Lock"). Always 200, safe
 * with none — the same reasoning as logout: it must not probe whether a cookie
 * is live. The POS session is untouched.
 */
export async function POST() {
  const cookieStore = await cookies()
  try {
    const manageSessionId = verifySessionCookie(cookieStore.get(MANAGE_COOKIE_NAME)?.value)
    if (manageSessionId) await destroyManageSession(manageSessionId)
  } catch (error) {
    console.error('[manage/lock] Unexpected failure:', error)
  }
  cookieStore.delete(MANAGE_COOKIE_NAME)
  return NextResponse.json({ success: true, data: null }, { status: 200 })
}
