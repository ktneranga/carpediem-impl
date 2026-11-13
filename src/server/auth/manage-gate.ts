import { isManagePath } from '@/lib/return-to'

/**
 * Which paths need a live Manage session — the proxy's second gate (Story 10.0,
 * FR70). Its own module, not inside `proxy.ts`, so the verify scripts can test
 * it without a request.
 */

/** The endpoints that get you IN (or out) — without those nobody could unlock. */
const MANAGE_GATE_EXEMPT = new Set([
  '/manage/unlock',
  '/api/manage/unlock',
  '/api/manage/password',
  '/api/manage/lock',
])

/**
 * Manage pages that open WITHOUT the Manage password (Story 8.3). Not the way
 * in, so not in `MANAGE_GATE_EXEMPT`: Sold out is a mid-service task for the
 * owner AND waiters (Teran, 2026-11-13), who hear "the fish is finished" from
 * the kitchen. The role gate still applies (`ROUTE_ROLES`: owner + waiter), and
 * its APIs live outside `/api/manage`. Same exact-or-slash test as
 * `findRoutePolicy`, so `/manage/sold-outx` stays gated.
 */
const MANAGE_PASSWORD_FREE = ['/manage/sold-out']

export function needsManageSession(pathname: string): boolean {
  if (MANAGE_GATE_EXEMPT.has(pathname)) return false
  if (MANAGE_PASSWORD_FREE.some((free) => pathname === free || pathname.startsWith(`${free}/`))) return false
  return isManagePath(pathname) || pathname === '/api/manage' || pathname.startsWith('/api/manage/')
}
