import 'server-only'

/**
 * A VALID bcrypt hash of a PIN nobody has, for burning a compare.
 *
 * ── Why this exists as a shared constant ─────────────────────────────────────
 * Any route that checks a PIN must cost the same whether or not the staff
 * member exists, or the response time itself answers "is this a real account?".
 * The login route got this right and defined the constant privately; Story
 * 6.2's bill route then needed the same thing and retyped it as
 * `'$2a$12$' + 52 zeros`.
 *
 * That literal is 59 characters. A bcrypt hash is exactly 60, and `compare`
 * rejects a malformed one by returning false WITHOUT running a single round —
 * so the "equal cost" the comment promised never happened. Measured with this
 * project's own bcryptjs: the malformed path returned in 0 ms, a real cost-12
 * compare took 336 ms. The oracle the code set out to close was wide open, and
 * it was caught in review rather than by anything executable.
 *
 * One constant, in one place, so there is nothing to retype incorrectly. If you
 * add a third PIN-checking route, import this.
 *
 * ── Why a real hash and not a crafted string ─────────────────────────────────
 * It is a genuine bcrypt output, so it stays valid if bcryptjs tightens its
 * parsing. The plaintext is irrelevant and deliberately not recorded: nothing
 * should ever match it, and a 4-digit PIN check against it fails on the hash
 * comparison after doing the full work.
 */
export const DUMMY_PIN_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
