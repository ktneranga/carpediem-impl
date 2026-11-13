/**
 * Where to go back to after signing in again (Teran, 2026-11-01).
 *
 * An idle timeout used to land every waiter on the floor plan, so a waiter in
 * the middle of an order had to find the table again. Now the page they were
 * on rides along as `/login?next=…` and the PIN pad sends them back to it.
 * Their staged round is in localStorage by session, so it is still there.
 *
 * Used by the proxy (a page load after the timeout) and by the screens (an API
 * call that came back 401). A deliberate "Switch user" does NOT use it: the
 * next person starts from the floor, not on someone else's screen.
 *
 * Only the SAME waiter goes back (Teran, 2026-11-01): the PIN pad remembers
 * who signed in last (`LAST_STAFF_KEY`) and sends anyone else to the floor.
 */

/** localStorage key: the staff id of the last sign-in on this tablet. */
export const LAST_STAFF_KEY = 'cdrms:last-staff'

/** `/login?next=<this page>` — or plain `/login` when there is nothing to return to. */
export function loginUrl(from?: string): string {
  const path =
    from ?? (typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search)
  const safe = safeReturnPath(withoutInternalParams(path))
  return safe === '/' ? '/login' : `/login?next=${encodeURIComponent(safe)}`
}

/**
 * `next`, if it is a path on THIS app; otherwise `/`.
 *
 * It arrives in a URL anyone can craft, so it is checked rather than trusted:
 * `//evil.example` and `/\evil.example` are read by browsers as another
 * host, and an absolute URL is one — any of them would make the PIN pad an
 * open redirect. The login page itself is refused so the pad cannot loop.
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/')) return '/'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  // Control characters (a tab or newline inside "/\t/evil") are stripped by
  // URL parsers, which can turn a harmless-looking path into `//host`.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/'
  // The PATH, normalised — `/login/`, `/LOGIN` and `/login#x` are all the pad.
  const path = (raw.split(/[?#]/)[0] ?? '').toLowerCase().replace(/\/+$/, '')
  if (path === '/login' || path === '/api' || path.startsWith('/api/')) return '/'
  return raw
}

/** True for `/manage` and `/manage/...` — not `/manager-notes`. */
export function isManagePath(pathname: string): boolean {
  return pathname === '/manage' || pathname.startsWith('/manage/')
}

/**
 * `next` for the Manage unlock screen (Story 10.0): the same checks as
 * `safeReturnPath`, and it must be a Manage page other than the unlock screen
 * itself. Anything else lands on `/manage`.
 */
export function safeManagePath(raw: string | null | undefined): string {
  const safe = safeReturnPath(raw)
  const path = (safe.split(/[?#]/)[0] ?? '').toLowerCase().replace(/\/+$/, '')
  if (!isManagePath(path) || path === '/manage/unlock') return '/manage'
  return safe
}

/** `/manage/unlock?next=<this Manage page>`. */
export function manageUnlockUrl(from: string): string {
  const safe = safeManagePath(withoutInternalParams(from))
  return safe === '/manage' ? '/manage/unlock' : `/manage/unlock?next=${encodeURIComponent(safe)}`
}

/**
 * Drops Next's own `_rsc` cache-buster. A prefetch that hit the timeout
 * carries it, and sending the waiter to that URL after sign-in would load an
 * RSC payload rather than the page.
 */
function withoutInternalParams(path: string): string {
  const at = path.indexOf('?')
  if (at === -1) return path
  const params = new URLSearchParams(path.slice(at + 1))
  params.delete('_rsc')
  const query = params.toString()
  return query ? `${path.slice(0, at)}?${query}` : path.slice(0, at)
}
