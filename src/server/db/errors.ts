import 'server-only'

/** PostgreSQL unique-violation SQLSTATE. */
export const PG_UNIQUE_VIOLATION = '23505'

/**
 * Detects a unique violation for a NAMED index, through Drizzle's error wrapping.
 *
 * ── Why the name matters ─────────────────────────────────────────────────────
 * Matching on `23505` alone answers "some unique constraint was violated", not
 * "the one I am handling". The day a table gains a second unique index, a
 * collision on THAT would be reported to the waiter as "this table is already
 * occupied" while the real cause never reached a log — the 409 branches do not
 * log. Naming the index keeps an unexpected collision on the 500 path, where it
 * is visible. The merge route originally copied this check WITHOUT the name and
 * reintroduced exactly that defect, in the same changeset as the argument
 * against it; hence one shared helper rather than two hand-copied loops.
 *
 * ── Why `constraint === undefined` still counts ──────────────────────────────
 * `constraint` sits on the same driver error object as `code`. If a future
 * driver stops populating it, fall back to treating any unique violation on
 * this path as the expected one — the behaviour before names were checked.
 *
 * ── Why the cause chain ──────────────────────────────────────────────────────
 * Drizzle wraps driver errors, so `code` and `constraint` appear on `cause`
 * rather than at the top level. A bounded walk finds it wherever the wrapping
 * puts it without risking a cycle.
 */
export function isUniqueViolation(error: unknown, indexName: string): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const candidate = current as { code?: unknown; constraint?: unknown }
      if (candidate.code === PG_UNIQUE_VIOLATION) {
        return candidate.constraint === undefined || candidate.constraint === indexName
      }
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}
