import { disconnectSocket } from '@/hooks/use-socket'

/**
 * Ends the staff session and returns to the PIN pad.
 *
 * Shared because more than one screen needs it: the table grid's header control
 * and the order screen's. Duplicating it once already produced a screen whose
 * "Switch user" button did nothing (Story 3.3 review).
 *
 * Story 2.4 replaces this with the PIN-switch flow, at which point both callers
 * change together rather than drifting apart.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' })
  } finally {
    // Drop the shared socket explicitly. It is a module singleton that outlives
    // any single component, so without this it would stay connected under the
    // identity of the staff member who just signed out.
    disconnectSocket()
    // Full navigation, not router.push — the root layout derives
    // [data-context] server-side, so the server must re-render.
    window.location.assign('/login')
  }
}
