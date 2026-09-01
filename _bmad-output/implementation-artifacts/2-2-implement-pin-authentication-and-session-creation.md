# Story 2.2: Implement PIN Authentication & Session Creation

Status: review

- **Epic:** 2 — Staff Authentication & Session Management
- **Story ID:** 2.2
- **Story Key:** 2-2-implement-pin-authentication-and-session-creation
- **Created:** 2026-08-21

---

## ⚠️ READ FIRST — four blockers the epic does not mention

epics.md assumes infrastructure that does not exist. Each of these stops implementation dead if you discover it mid-flow.

| # | Blocker | Reality |
|---|---|---|
| 1 | **There is no `sessions` table** | AC-2 says "a new row is inserted into the `sessions` table". `schema.ts` has 14 tables and none of them is it. `orderSessions` (`order_sessions`) is a *table-occupancy* record — a completely different concept. You must create the auth sessions table in this story. |
| 2 | **`tenant_config` has no auth columns** | AC-5 says to seed `auth_mode`, `session_timeout_minutes`, `financial_action_reauth`. `tenant_config` currently holds only `restaurantName`, `brandColor`, `currencyCode`, `taxRatePercent`, `updatedAt`. Three columns must be added. |
| 3 | **`Secure` cookie flag will break login on the LAN** | `architecture.md:213` specifies `httpOnly; SameSite=Strict; Secure`. The restaurant runs plain **HTTP** on `http://<lan-ip>:3000` — browsers never send a `Secure` cookie over HTTP, so every request would arrive unauthenticated and login would appear to silently fail. Set `Secure` conditionally (see Task 6). |
| 4 | **Two dependencies are missing** | `bcryptjs` and `zod` are not in `package.json`. Both are **pre-approved for this story** — do not HALT to ask. Rationale below. |

---

## Story

As a staff member,
I want to authenticate with my PIN and have a session established on the device,
So that I can access the system and all my actions are attributed to my verified identity.

---

## Acceptance Criteria

**AC-1: PIN comparison never queries by plaintext**
**Given** a staff member submits their PIN via the PINPad
**When** `POST /api/auth/login` is called with `{ pin: string }`
**Then** the server iterates active staff accounts for the tenant and compares the submitted PIN against each stored bcrypt hash using `bcrypt.compare`; the database is never queried by plaintext PIN value

**AC-2: Successful login creates a session**
**Given** the PIN matches an active staff account
**When** the Route Handler completes
**Then** a new row is inserted into the `staff_sessions` table with `staff_id`, `role`, `expires_at`, `created_at`, and `last_active_at`; an `httpOnly` `__cdrms_session` cookie is set on the response; HTTP 200 is returned with `{ success: true, data: { role: string, staffName: string } }`

**AC-3: Failed login, no timing oracle**
**Given** the PIN does not match any active staff account
**When** the Route Handler completes
**Then** HTTP 401 is returned with `{ success: false, error: { code: "INVALID_PIN", message: string } }`; no session row is created; **the handler compares against every active hash regardless of an early match**, so a successful attempt takes no less time than a failed one

**AC-4: Hash storage**
**Given** any staff record in the database
**When** the `pin_hash` column is inspected
**Then** it contains a bcrypt hash at cost factor 10; plaintext PIN is absent from every column, log entry, and HTTP response body at all times

**AC-5: Tenant auth defaults**
**Given** a new tenant is provisioned (initial seed or first run)
**When** the `tenant_config` row is created
**Then** it is seeded with `auth_mode: "session_short"`, `session_timeout_minutes: 5`, `financial_action_reauth: true`

**AC-6: Logout**
**Given** `POST /api/auth/logout` is called with a valid session cookie
**When** the Route Handler processes the request
**Then** the corresponding session row is deleted from `staff_sessions`; the `__cdrms_session` cookie is cleared from the response; HTTP 200 is returned

**AC-7: Cookie integrity**
**Given** a session cookie is issued
**When** it is inspected
**Then** its value is the session id plus an HMAC signature derived from `SESSION_SECRET`; a cookie with a missing, malformed, or invalid signature is rejected without a database query

**AC-8: Startup secret validation**
**Given** the application starts
**When** `SESSION_SECRET` is missing or shorter than 32 characters
**Then** startup fails with an explicit error naming the variable; the server does not begin accepting requests with a weak or absent secret

**AC-9: Login screen wired to the PINPad**
**Given** a staff member opens the application unauthenticated
**When** the login screen renders
**Then** the existing `PINPad` component is used unchanged; a submitted PIN calls `POST /api/auth/login`; the pad is `disabled` while the request is in flight and receives `error="Incorrect PIN"` on 401

**AC-10: Seed data for verification**
**Given** a developer runs the seed script against an empty database
**When** it completes
**Then** one tenant, one `tenant_config` row with the AC-5 defaults, and at least three staff (one per role) exist with bcrypt-hashed PINs; the plaintext PINs are printed to the console **by the seed script only**, never by application code

---

## Tasks / Subtasks

- [x] **Task 1 — Install dependencies** (AC: 1, 4)
  - `pnpm add bcryptjs zod`
  - **Use `bcryptjs`, NOT `bcrypt`.** Native `bcrypt` requires node-gyp, Python, and a C++ toolchain at install time. The production image is `node:22-alpine`, which has none of them — `pnpm install --frozen-lockfile` in the Docker builder stage would fail outright. `bcryptjs` is pure JS with zero native dependencies. Confirmed current: bcryptjs 3.x.
  - bcryptjs 3.x ships its own TypeScript types. **Verify before adding `@types/bcryptjs`** — installing it alongside a self-typed package causes duplicate-declaration errors.
  - `zod` is required by the architecture's validation standard and has no runtime alternative in the repo today.

- [x] **Task 2 — Add the `staff_sessions` table to the schema** (AC: 2)
  - **Name it `staff_sessions`, not `sessions`.** `order_sessions` already exists and means something entirely different; two similarly-named session concepts in one schema is a defect waiting to happen. Architecture calls it `sessions`; this is a deliberate, documented deviation.
  - ```ts
    export const staffSessions = pgTable('staff_sessions', {
      id:           uuid('id').primaryKey().defaultRandom(),
      tenantId:     uuid('tenant_id').notNull().references(() => tenants.id),
      staffId:      uuid('staff_id').notNull().references(() => staff.id),
      role:         staffRoleEnum('role').notNull(),
      createdAt:    timestamp('created_at',      { withTimezone: true }).notNull().defaultNow(),
      lastActiveAt: timestamp('last_active_at',  { withTimezone: true }).notNull().defaultNow(),
      expiresAt:    timestamp('expires_at',      { withTimezone: true }).notNull(),
    }, (t) => [
      index('idx_staff_sessions_staff_id').on(t.staffId),
      index('idx_staff_sessions_expires_at').on(t.expiresAt),
    ])
    ```
  - `role` is denormalised onto the session deliberately — Story 2.3's middleware runs on every request and must not join to `staff` each time.
  - **This table is mutable and must NOT get the append-only RULE.** `last_active_at` is updated on every request and rows are deleted on logout. Check `0001_append_only_rules.sql` to confirm you are not extending it here.

- [x] **Task 3 — Add auth columns to `tenant_config`** (AC: 5)
  - New enum: `authModeEnum = pgEnum('auth_mode', ['session_short', 'session_persistent', 'per_transaction', 'per_action'])`
  - Columns: `authMode` (default `'session_short'`), `sessionTimeoutMinutes` (integer, default `5`), `financialActionReauth` (boolean, default `true`).
  - Defaults match `prd.md:304-310`. **Note the PRD contradicts itself**: NFR-S6 states a 30-minute idle timeout while the flag table says 5. Use **5** — the flag table is what tenant provisioning reads, and Carpe Diem's row is explicitly `5`. Flag the NFR-S6 mismatch in Completion Notes.

- [x] **Task 4 — Generate and verify the migration** (AC: 2, 5)
  - `pnpm db:generate` → produces `0003_*.sql`. Read the generated SQL before trusting it.
  - `DATABASE_URL` must be set for `db:generate` — `drizzle.config.ts` throws without it (added in Story 1.5).
  - Confirm the migration only ADDs. It must not touch existing tables beyond the three new `tenant_config` columns.

- [x] **Task 5 — Session service** (`src/server/services/session.service.ts`) (AC: 2, 6, 7)
  - `createSession(staffId, role, tenantId)` → inserts a row with `expiresAt = now + sessionTimeoutMinutes`, returns the signed cookie value.
  - `signSessionId(id)` → `` `${id}.${hmacSha256(id, SESSION_SECRET)}` `` using Node's built-in `crypto`. No new dependency.
  - `verifySessionCookie(value)` → splits, recomputes the HMAC, compares with `crypto.timingSafeEqual`. Returns the id or `null`. **Never** compare signatures with `===`.
  - `destroySession(id)` → deletes the row.
  - Mark the file `import 'server-only'`.

- [x] **Task 6 — `POST /api/auth/login`** (`src/app/api/auth/login/route.ts`) (AC: 1, 2, 3)
  - Zod: `loginSchema = z.object({ pin: z.string().regex(/^\d{4,6}$/) })`. Reject anything else with 400 before touching bcrypt.
  - Load all active staff for the tenant, then:
    ```ts
    let matched: typeof rows[number] | null = null
    for (const row of rows) {
      // Do NOT break on match — an early return makes success measurably
      // faster than failure and leaks whether a PIN was valid (AC-3).
      const ok = await bcrypt.compare(pin, row.pinHash)
      if (ok && !matched) matched = row
    }
    ```
  - If `rows` is empty, still run one compare against a fixed dummy hash so an empty-tenant response is not instantly distinguishable.
  - On success: create a session, set the cookie, return 200. On failure: 401 with `INVALID_PIN`.
  - **Cookie attributes:**
    ```ts
    cookies().set('__cdrms_session', signed, {
      httpOnly: true,
      sameSite: 'strict',
      // Secure is CONDITIONAL. The restaurant LAN serves plain HTTP on :3000 and a
      // Secure cookie is never sent over HTTP — login would silently never persist.
      // NFR-S5 keeps the LAN closed to the public internet, which is what makes this
      // acceptable. Revisit if the app is ever served over HTTPS.
      secure: process.env.NODE_ENV === 'production' && process.env.HTTPS_ENABLED === 'true',
      path: '/',
      maxAge: sessionTimeoutMinutes * 60,
    })
    ```
  - **Never log the PIN.** Not the value, not its length, not a hash of it. Not in an error path either.

- [x] **Task 7 — `POST /api/auth/logout`** (`src/app/api/auth/logout/route.ts`) (AC: 6)
  - Verify the cookie signature, delete the row, clear the cookie, return 200.
  - Return 200 even when the cookie is absent or invalid — logout is idempotent and must not become a probe for session validity.

- [x] **Task 8 — Enforce `SESSION_SECRET` at startup** (AC: 8)
  - Closes a deferred item from Story 1.1's review, explicitly assigned here.
  - Validate in `server.ts` **before** `httpServer.listen()`: present and ≥32 characters, else throw with a message naming the variable and how to generate one (`openssl rand -hex 32`).
  - Do not validate lazily inside the login handler — a misconfigured server must fail at boot, not at the first login attempt during service.

- [x] **Task 9 — Login screen** (`src/app/login/page.tsx`) (AC: 9)
  - Client component. Renders the existing `PINPad` from `@/components/pos/pin-pad` **unchanged** — it is complete and reviewed. Do not edit it.
  - `onSubmit` → `fetch('/api/auth/login')`. Set `disabled` while in flight; set `error="Incorrect PIN"` on 401.
  - On success, redirect to `/`.
  - The PINPad wipes its own state after `onSubmit`; do not retain the PIN in the page.

- [x] **Task 10 — Seed script** (`src/server/db/seed.ts`) (AC: 5, 10)
  - Creates one tenant, one `tenant_config` row with the AC-5 defaults, and three staff — one waiter, one owner, one kitchen — with bcrypt-hashed PINs at cost 10.
  - Add `"db:seed": "tsx src/server/db/seed.ts"` to `package.json` scripts.
  - Printing the plaintext PINs to the console is acceptable **here and only here** — it is a developer tool, not application code. Guard it: refuse to run when `NODE_ENV === 'production'`.
  - Make it idempotent, or have it fail clearly if the tenant already exists. Re-seeding must not silently duplicate staff.

- [x] **Task 11 — Harden the `x-staff-role` cast** (`src/app/layout.tsx`) (AC: —)
  - Closes a deferred item from Story 1.2's review, explicitly assigned to this story.
  - `layout.tsx:21` currently does `as 'waiter' | 'owner' | 'kitchen' | null`, a compile-time-only cast. An unexpected header value writes an arbitrary string into `data-context`.
  - Replace with a runtime whitelist check; anything not in the list becomes `null`.

- [x] **Task 12 — Delete the Story 2.1 scaffold** (AC: 9)
  - Remove `src/app/pin-demo/page.tsx`. Story 2.1 created it as a temporary harness and flagged it for removal once a real login screen existed. That screen is Task 9.

---

## Dev Notes

### Reality check on existing schema

`src/server/db/schema.ts` has 14 tables:
`tenants`, `staff`, `zones`, `tables`, `menu_categories`, `menu_items`, `order_sessions`, `order_events`, `payment_records`, `comp_records`, `dispute_records`, `printer_configs`, `station_configs`, `tenant_config`.

**`staff` already has everything needed for auth** — do not add columns:
```ts
staff = { id, tenantId, name, role: staffRoleEnum, pinHash: text, isActive: boolean, createdAt }
```
`staffRoleEnum` is `['waiter', 'owner', 'kitchen']` and already exists. Reuse it for `staff_sessions.role`.

### The bcrypt performance characteristic you must understand

AC-1 requires comparing the submitted PIN against **every** active staff hash, and AC-3 forbids early exit. So every login costs N bcrypt operations where N is the active staff count — on both success and failure, by design.

bcryptjs at cost 10 is roughly 100–150ms per compare. At NFR-SC2's baseline of 8 staff that is **0.8–1.2 seconds per login attempt**, and because bcryptjs is pure JavaScript it occupies the event loop in chunks throughout. The same Node process also serves Socket.io (`server.ts`), so a login can add latency to real-time events for every connected device.

This is acceptable at 8 staff and it is what the ACs specify. **Record the measured timing in the Debug Log.** If a restaurant ever exceeds ~15 staff this design needs revisiting — note that in Completion Notes rather than solving it here.

### Security rules — non-negotiable

- **Never log the PIN** in any form: value, length, prefix, or hash. Not in success paths, not in catch blocks, not in development.
- Compare HMAC signatures with `crypto.timingSafeEqual`, never `===` — string comparison short-circuits and leaks.
- Do not return whether a PIN was "close" or how many attempts remain. `INVALID_PIN` is the only failure code.
- The response body must never echo the submitted PIN, even in a validation error from Zod. Zod's default error can include the received value — shape the error yourself.
- `staff_sessions` rows are the credential. Treat the session id as secret; never log it either.

### Architecture compliance

- **Route Handlers**, not Server Actions, for auth (`architecture.md:226`). Server Actions are reserved for owner config pages.
- **Error envelope** (`architecture.md:248`): every Route Handler returns `{ success: boolean, data?: T, error?: { code: string, message: string } }`. Machine-readable codes; the client maps them to copy.
- **Session storage is PostgreSQL, not JWT** (`architecture.md:207`). This is deliberate: JWTs cannot be invalidated immediately, and `session_short` mode needs idle expiry. Do not "simplify" this to a JWT.
- **bcrypt cost factor 10** (`architecture.md:205`). Not 12, not 8.
- Naming: files kebab-case (`session.service.ts`), components PascalCase, Zod schemas camelCase with `Schema` suffix, API routes plural kebab-case nouns.
- `import 'server-only'` on every file under `src/server/`.

### Previous story intelligence — Story 2.1 (PINPad)

The PINPad is **finished and reviewed**. Consume it, do not modify it.

```tsx
<PINPad
  onSubmit={(pin) => { /* pin is wiped from the pad immediately after this returns */ }}
  error={errorMessage}      // string | null — triggers shake + message
  disabled={isSubmitting}   // blocks all input
  label="Enter your PIN"
/>
```

Behaviour you can rely on:
- Auto-submits at 6 digits; the Submit button covers 4- and 5-digit PINs.
- Wipes its own state before invoking `onSubmit`, so a throwing callback cannot leave the PIN resident.
- Clears the displayed error as soon as the staff member types again.
- Renders dots only — the PIN never enters the DOM as text.

Five bugs were found and fixed during 2.1's self-review. Two are worth carrying forward as habits:
- **Never call a side effect from inside a `setState` updater.** React invokes updaters twice under Strict Mode; the first version double-submitted the credential.
- **A CSS animation does not replay while its class stays applied.** Repeating an identical error needs a changing `key`.

`src/app/globals.css` gained `--animate-shake`, `@keyframes shake`, and a `prefers-reduced-motion` override in Story 2.1. Do not duplicate them.

### Deferred items this story closes

From `deferred-work.md`, three items were explicitly assigned here:
1. **SESSION_SECRET has no runtime enforcement** (Story 1.1) → Task 8
2. **`x-staff-role` header cast without runtime validation** (Story 1.2) → Task 11
3. **`server-only` import-boundary test was abbreviated** (Story 1.1) — verified via `tsc` only. This story creates the first Route Handler that coexists with a client component, so the boundary is now genuinely exercised. Confirm `next build` still succeeds and note it.

### Environment and running the database

The stack is Docker Compose. `docker-compose.override.yml` supplies the build context locally, so `docker compose up -d db` gives you PostgreSQL on the internal network. For host-side `db:generate` / `db:seed` you need `DATABASE_URL` pointing at the mapped port.

**Story 1.4 has never been smoke-tested and its Docker build has never succeeded** — a build-blocking defect in `src/server/db/index.ts` was only fixed in Story 1.5. If `docker compose up` misbehaves, that is 1.4's problem, not yours. Running `pnpm dev` against a containerised `db` is the lower-risk path for this story.

### Testing

No test framework is installed. **Do not add one** — that is unrelated scope requiring its own decision.

Verify with:
1. `npx tsc --noEmit` → exit 0
2. `npx eslint` → 0 errors (one pre-existing warning in `src/server/socket/index.ts` is expected)
3. `pnpm db:generate` → inspect the generated SQL by hand
4. `pnpm db:migrate` against a running database
5. `pnpm db:seed`, then confirm in psql: `pin_hash` starts with `$2` and is 60 chars; no plaintext PIN anywhere
6. Manual flow at `/login`:
   - correct PIN → 200, cookie set, redirect
   - wrong PIN → 401, shake, no session row
   - `document.cookie` in the browser console must **not** show `__cdrms_session` (proves `httpOnly`)
   - tamper with the cookie signature → rejected
   - logout → row deleted, cookie cleared
7. **Time both paths.** Record success and failure durations in the Debug Log; they must be comparable (AC-3).
8. `env -u DATABASE_URL npx next build` → must still succeed (protects Story 1.5's fix)

Record actual output. Do not claim a check passed without running it.

### Project Structure

```
NEW:    src/app/api/auth/login/route.ts
NEW:    src/app/api/auth/logout/route.ts
NEW:    src/app/login/page.tsx
NEW:    src/server/services/session.service.ts
NEW:    src/server/db/seed.ts
NEW:    src/server/db/migrations/0003_*.sql        (generated)
UPDATE: src/server/db/schema.ts                    (staff_sessions, auth_mode enum, 3 tenant_config columns)
UPDATE: src/app/layout.tsx                         (runtime role whitelist)
UPDATE: server.ts                                  (SESSION_SECRET startup check)
UPDATE: package.json                               (bcryptjs, zod, db:seed script)
UPDATE: .env.example                               (document SESSION_SECRET requirement, HTTPS_ENABLED)
DELETE: src/app/pin-demo/page.tsx                  (Story 2.1 scaffold)
```

`src/server/services/` does not exist yet — this story creates it. `src/lib/validations/` exists with only a `.gitkeep`; put the Zod schema there if you prefer, but keep it consistent and note the choice.

### References

- [Source: epics.md#Story-2.2] — original ACs (AC-1 through AC-6)
- [Source: architecture.md:205-224#Authentication-and-Security] — bcrypt cost 10, sessions table, cookie name and attributes, no JWT
- [Source: architecture.md:226-250#API-and-Communication-Patterns] — Route Handlers, error envelope
- [Source: architecture.md:323-370#Naming-Patterns] — file, schema, and endpoint naming
- [Source: prd.md#NFR-S1] — plaintext PIN never persisted, logged, or transmitted
- [Source: prd.md#NFR-S6] — 30-minute idle timeout (contradicts the flag table's 5 minutes)
- [Source: prd.md:304-310] — tenant feature flag defaults
- [Source: ux-design-specification.md:1019] — PIN entry pattern
- [Source: 2-1-build-pinpad-component.md] — PINPad API and behaviour
- [Source: deferred-work.md] — SESSION_SECRET, `x-staff-role` cast, `server-only` boundary test
- [bcryptjs vs bcrypt for Alpine](https://www.pkgpulse.com/compare/bcrypt-vs-bcryptjs) · [Alpine native build failure](https://github.com/kelektiv/node.bcrypt.js/issues/741)

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

```
pnpm add bcryptjs zod        → bcryptjs 3.0.3, zod 4.5.4
                               bcryptjs ships its own types (index.d.ts present) —
                               @types/bcryptjs correctly NOT installed
npx tsc --noEmit             → exit 0
npx eslint                   → 0 errors (1 pre-existing warning, src/server/socket/index.ts:5)
next build (no DATABASE_URL) → SUCCESS
                               Routes: / , /_not-found , /api/auth/login ,
                                       /api/auth/logout , /api/health , /login

MIGRATION — 0003_rare_joseph.sql, additive only:
  CREATE TYPE auth_mode
  CREATE TABLE staff_sessions (7 cols, 2 FKs, 2 indexes)
  ALTER tenant_config ADD auth_mode / session_timeout_minutes / financial_action_reauth
  drizzle-kit migrate → applied successfully

AC-4 (psql):
  name  | role    | hash_prefix | hash_len | is_active
  Aruna | owner   | $2b$10$     |       60 | t
  Kumar | kitchen | $2b$10$     |       60 | t
  Nina  | waiter  | $2b$10$     |       60 | t
  ⇒ bcrypt cost 10 confirmed

AC-5 (psql):
  auth_mode=session_short | session_timeout_minutes=5 | financial_action_reauth=t

AC-2 (live POST /api/auth/login, pin 1234):
  HTTP/1.1 200 OK
  set-cookie: __cdrms_session=30803f7f-…-fe676deb71ac.3c349e56…d42ac2;
              Path=/; Max-Age=300; HttpOnly; SameSite=strict
  body: {"success":true,"data":{"role":"waiter","staffName":"Nina"}}
  ⇒ signed cookie, HttpOnly, SameSite=strict, Max-Age from tenant_config,
    no Secure flag (correct on HTTP — see Task 6 rationale)

AC-3 (401 body):
  {"success":false,"error":{"code":"INVALID_PIN","message":"Incorrect PIN"}}
Malformed PIN (400):
  {"success":false,"error":{"code":"INVALID_BODY","message":"PIN must be 4-6 digits"}}

AC-3 TIMING — 3 runs averaged, seed insert order Nina(1st) Aruna(2nd) Kumar(3rd):
  pin 1234 (matches 1st) → 0.3753s
  pin 5678 (matches 2nd) → 0.3057s
  pin 4321 (matches 3rd) → 0.3108s
  pin 0000 (no match)    → 0.2769s
  ⇒ Match POSITION does not affect timing — no early exit, all N compares always run.
  ⇒ Success is ~30ms slower than failure. See Completion Notes — partial AC.

AC-7 (tampered signature, last char flipped):
  POST /api/auth/logout → HTTP 200, staff_sessions count 14 → 14 (unchanged)
  ⇒ forged cookie rejected, no row touched

AC-6 (valid cookie):
  POST /api/auth/logout → HTTP 200
  set-cookie: __cdrms_session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT
  staff_sessions count 14 → 13
  ⇒ row deleted, cookie cleared

AC-8 (startup validation):
  unset SESSION_SECRET → "[server] SESSION_SECRET is not set. It must be at least
                          32 characters — it signs staff session cookies." + exit
  10-char secret       → "[server] SESSION_SECRET is only 10 characters. …" + exit

SECURITY — grep for 1234|5678|4321|0000|"pin" across full server log:
  NO PIN IN LOGS ✓
```

### Completion Notes List

**AC-3 is PARTIALLY met — read this before approving.**

The security-meaningful property holds: the bcrypt work is identical regardless of input. Matching the first, second, or third staff member all take the same time (0.375s / 0.306s / 0.311s — the first is warm-up noise), which proves there is no early exit and that every login costs all N compares.

But the AC's literal wording is "response time is not shorter than a successful attempt", and **failure is ~30ms faster than success** (0.277s vs ~0.31s). That delta is session creation on the success path — a `tenant_config` lookup, an INSERT, and an HMAC — not credential comparison.

I did not pad the failure path to hide it, for two reasons. The outcome is already disclosed by the 200 status and the `Set-Cookie` header, so the timing reveals nothing an attacker cannot read directly. And artificially slowing every failed login is cost with no security return. **Flagging rather than silently claiming a pass** — if the AC is meant literally, this needs a decision.

**Measured cost of the iterate-all-staff design.** ~250–310ms per login at 3 staff. Extrapolating linearly, NFR-SC2's 8-staff baseline lands around 700–800ms, and because bcryptjs is pure JavaScript that time occupies the same event loop serving Socket.io. Acceptable at this size; revisit past ~15 staff.

**Deviations from the story, all deliberate:**

1. **Table named `staff_sessions`, not `sessions`** (as the story specified). `order_sessions` already exists and means table occupancy. Documented in a schema comment.
2. **`dotenv` was NOT installed.** The seed script originally imported `dotenv/config`; `dotenv` is not a project dependency and was not pre-approved, so the import was removed rather than adding an unsanctioned package. `DATABASE_URL` must be passed explicitly to `pnpm db:seed`.
3. **Added a `db` port mapping to `docker-compose.override.yml`.** The base file keeps PostgreSQL internal-only (Story 1.4 AC-1) so nothing on the restaurant LAN can reach it — correct for production, but it makes `db:generate`, `db:migrate`, `db:seed`, and psql impossible from the host. Bound to `127.0.0.1:5432` in the dev-only override, which never ships to a server.
4. **Seed script uses its own `Pool`** rather than importing `@/server/db`. That module is marked `server-only` and throws outside a Next.js request context.

**Login redirect uses `window.location.assign('/')`, not `router.push()`.** The root layout reads the staff role server-side to set `[data-context]`, so a client-side navigation would leave the context attribute stale until the next full load.

**Three deferred items closed:**
- `SESSION_SECRET` runtime enforcement (Story 1.1) — Task 8, verified both failure modes
- `x-staff-role` cast without runtime validation (Story 1.2) — Task 11, replaced with a whitelist
- `server-only` import-boundary test (Story 1.1) — a Route Handler and a client component now genuinely coexist and `next build` succeeds, so the boundary is exercised for real rather than by `tsc` alone

**PRD inconsistency confirmed, not resolved.** NFR-S6 states a 30-minute idle timeout; the feature-flag table at `prd.md:304-310` says 5. Implemented as **5** and noted in a schema comment. The PRD still needs one of the two corrected.

**Known gap — no expired-session cleanup.** `staff_sessions` rows accumulate; expiry is stored but nothing deletes stale rows, and nothing yet enforces `expires_at` on read. Both belong to Story 2.3's middleware. 13 rows were left behind by this story's own testing.

**NOT verified:**
- No browser was used. `httpOnly` was confirmed from the `Set-Cookie` header, not by checking `document.cookie` in devtools.
- The `/login` page was never rendered — AC-9 is verified structurally (it imports the reviewed PINPad and calls the endpoint that was tested live) but not visually or interactively.
- Session expiry behaviour is untested because nothing reads `expires_at` yet.

**No test framework exists**, so none of the above is captured as an automated test. Everything in the Debug Log was run by hand against a live PostgreSQL container and a live server on port 3010.

### File List

- NEW: `src/app/api/auth/login/route.ts`
- NEW: `src/app/api/auth/logout/route.ts`
- NEW: `src/app/login/page.tsx`
- NEW: `src/server/services/session.service.ts`
- NEW: `src/server/db/seed.ts`
- NEW: `src/server/db/migrations/0003_rare_joseph.sql` (generated)
- UPDATE: `src/server/db/schema.ts` (authModeEnum, staffSessions table, 3 tenant_config columns)
- UPDATE: `src/app/layout.tsx` (runtime role whitelist replacing the compile-time cast)
- UPDATE: `server.ts` (SESSION_SECRET startup validation)
- UPDATE: `docker-compose.override.yml` (dev-only db port mapping)
- UPDATE: `package.json` (bcryptjs, zod, db:seed script)
- UPDATE: `.env.example` (SESSION_SECRET requirement, HTTPS_ENABLED)
- DELETE: `src/app/pin-demo/page.tsx` (Story 2.1 scaffold, superseded by /login)

### Change Log

- 2026-08-21: Story implemented. PIN auth end-to-end: staff_sessions table, HMAC-signed httpOnly cookie, login/logout Route Handlers, login screen, seed script. Verified live against PostgreSQL — bcrypt cost 10, no early exit on match, tampered cookies rejected, no PIN in logs. AC-3 partially met (see Completion Notes). Closed three deferred items from Stories 1.1 and 1.2.
- 2026-08-21: Story created. Four blockers surfaced that epics.md assumes away: no auth `sessions` table exists in the schema, `tenant_config` lacks all three auth flag columns, the architecture's `Secure` cookie flag would break login over the LAN's plain HTTP, and both `bcryptjs` and `zod` are uninstalled. Four ACs added beyond the epic (cookie integrity, startup secret validation, login screen wiring, seed data). The auth table is named `staff_sessions` rather than `sessions` to avoid collision with the existing `order_sessions`.
