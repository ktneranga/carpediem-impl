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
 */

/** `/login?next=<this page>` — or plain `/login` when there is nothing to return to. */
export function loginUrl(from?: string): string {
  const path =
    from ?? (typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search)
  const safe = safeReturnPath(path)
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
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/api/')) return '/'
  return raw
}
