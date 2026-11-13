import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE_NAME, touchSession, validateSession } from '@/server/services/session.service'
import { isRoleAllowed } from '@/server/auth/permissions'
import { isManagePath, loginUrl, manageUnlockUrl } from '@/lib/return-to'
import {
  MANAGE_COOKIE_NAME,
  manageCookieOptions,
  touchManageSession,
  validateManageSession,
} from '@/server/services/manage-session.service'

/**
 * Session validation and RBAC for every request.
 *
 * FILENAME: this is `proxy.ts`, not `middleware.ts`. Next.js 16 renamed it and
 * moved it to the Node.js runtime — which is what makes the database query below
 * possible at all. On Edge (Next 15 and earlier) `pg` cannot open a TCP socket,
 * so session lookup here would have been impossible.
 */

/** Reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = new Set(['/login', '/api/health'])

function isPublic(request: NextRequest): boolean {
  const { pathname } = request.nextUrl

  if (PUBLIC_PATHS.has(pathname)) return true

  // Login is the one auth endpoint that cannot require a session.
  // Logout deliberately is NOT public — it needs a session to know what to
  // delete, and it already tolerates an absent one.
  if (pathname === '/api/auth/login' && request.method === 'POST') return true

  return false
}

function unauthenticated(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } },
      { status: 401 },
    )
  }

  // Back to the page they were on once they sign in again — a timeout in the
  // middle of an order must not cost the waiter their place.
  const { pathname, search } = request.nextUrl
  return NextResponse.redirect(new URL(loginUrl(pathname + search), request.url))
}

function forbidden(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'FORBIDDEN', message: 'Your role cannot perform this action' },
      },
      { status: 403 },
    )
  }

  return NextResponse.redirect(new URL('/', request.url))
}

/**
 * Behind the Manage password (Story 10.0, FR70): the area and its API, except
 * the endpoints that get you IN (or out) — without those nobody could unlock.
 */
const MANAGE_GATE_EXEMPT = new Set([
  '/manage/unlock',
  '/api/manage/unlock',
  '/api/manage/password',
  '/api/manage/lock',
])

function needsManageSession(pathname: string): boolean {
  if (MANAGE_GATE_EXEMPT.has(pathname)) return false
  return isManagePath(pathname) || pathname === '/api/manage' || pathname.startsWith('/api/manage/')
}

function manageLocked(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, error: { code: 'MANAGE_LOCKED', message: 'Manage is locked' } },
      { status: 401 },
    )
  }
  const { pathname, search } = request.nextUrl
  return NextResponse.redirect(new URL(manageUnlockUrl(pathname + search), request.url))
}

export async function proxy(request: NextRequest) {
  // Strip identity headers UNCONDITIONALLY, before anything else and regardless
  // of whether this route is public.
  //
  // A client can send any header it likes. Everything downstream treats
  // x-staff-id as the identity of record for the audit trail (NFR-S3), so if a
  // forged header could survive on any path — a public one, or a protected route
  // someone later forgets to cover — an attacker could attribute orders and
  // payments to another staff member. Deleting first and setting only from a
  // validated session makes that structurally impossible.
  const headers = new Headers(request.headers)
  headers.delete('x-staff-id')
  headers.delete('x-staff-role')

  if (isPublic(request)) {
    return NextResponse.next({ request: { headers } })
  }

  let session
  try {
    session = await validateSession(request.cookies.get(SESSION_COOKIE_NAME)?.value)
  } catch (error) {
    // A database outage must not silently authenticate anyone.
    console.error('[proxy] Session validation failed:', error)
    return unauthenticated(request)
  }

  if (!session) {
    return unauthenticated(request)
  }

  if (!isRoleAllowed(request.nextUrl.pathname, session.role, request.method)) {
    return forbidden(request)
  }

  // The Manage gate, AFTER the role check: a waiter is refused as a waiter,
  // never shown the unlock screen. A PIN alone never opens configuration.
  let manageTouched = false
  if (needsManageSession(request.nextUrl.pathname)) {
    try {
      const manage = await validateManageSession(
        request.cookies.get(MANAGE_COOKIE_NAME)?.value,
        session.sessionId,
      )
      if (!manage) return manageLocked(request)
      manageTouched = await touchManageSession(manage)
    } catch (error) {
      // Database down: refuse, never let through.
      console.error('[proxy] Manage session check failed:', error)
      return manageLocked(request)
    }
  }

  // Set from the validated session only — never from anything the client sent.
  headers.set('x-staff-id', session.staffId)
  headers.set('x-staff-role', session.role)

  const response = NextResponse.next({ request: { headers } })

  if (manageTouched) {
    // Refresh Max-Age with the row, as for the POS cookie below.
    response.cookies.set(
      MANAGE_COOKIE_NAME,
      request.cookies.get(MANAGE_COOKIE_NAME)!.value,
      manageCookieOptions(),
    )
  }

  // Slide the idle window. Throttled inside touchSession, so this is a no-op for
  // most requests.
  try {
    const touched = await touchSession(session)
    if (touched) {
      // Refresh Max-Age alongside, or the browser drops a cookie for a session
      // the server still considers live.
      response.cookies.set(SESSION_COOKIE_NAME, request.cookies.get(SESSION_COOKIE_NAME)!.value, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production' && process.env.HTTPS_ENABLED === 'true',
        path: '/',
        maxAge: session.timeoutMinutes * 60,
      })
    }
  } catch (error) {
    // Failing to extend the window is not worth rejecting a valid request over.
    console.error('[proxy] Failed to touch session:', error)
  }

  return response
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
