# Story 2.3: Implement Session Middleware & Role-Based Access Control

Status: review

- **Epic:** 2 — Staff Authentication & Session Management
- **Story ID:** 2.3
- **Story Key:** 2-3-implement-session-middleware-and-role-based-access-control
- **Created:** 2026-08-21

---

## ⚠️ READ FIRST — five conflicts between epics.md and reality

| # | epics.md says | Reality |
|---|---|---|
| 1 | Roles `"staff"` and `"manager"` (AC-6) | **Neither exists.** `staffRoleEnum` is `['waiter', 'owner', 'kitchen']`. The PRD permission matrix uses four roles — Owner / Manager / Staff / Kitchen-Bar — but the schema only ever had three. See "The role model problem" below. |
| 2 | `src/middleware.ts` | **Next.js 16 renamed it to `proxy.ts`** and runs it on the Node.js runtime. You are on 16.2.9 — both `MIDDLEWARE_FILENAME` and `PROXY_FILENAME` constants exist in the installed package. Use `proxy.ts`. |
| 3 | "queries the `sessions` table" | The table is **`staff_sessions`** (Story 2.2). `order_sessions` is table occupancy — unrelated. |
| 4 | Column `last_activity_at` (AC-7) | Built as **`last_active_at`**, matching `architecture.md:210`. Use the column that exists. |
| 5 | Session expiry is idle-based (AC-4) | Story 2.2 wrote a **fixed** `expires_at` at creation time. `session_short` needs a **sliding** window. This story changes that behaviour — see Task 4. |

**Good news on #2:** because Next 16's proxy runs on Node.js rather than Edge, it *can* open a PostgreSQL connection. On Next 15 and earlier this AC was impossible as written — Edge middleware has no TCP sockets.

---

## The role model problem — read before Task 6

The PRD's permission matrix (`prd.md:341-357`) defines **four** roles:

| PRD role | Schema enum | Status |
|---|---|---|
| Owner | `owner` | ✅ exists |
| Manager | — | ❌ **does not exist** |
| Staff | `waiter` | ✅ exists, different name |
| Kitchen/Bar | `kitchen` | ✅ exists |

`Manager` has capabilities between Owner and Staff — it can comp items, view all-staff audit trails, toggle menu availability, see shift summaries, and manage inventory, but cannot do full menu management, staff management, or system configuration.

**Decision for this story: do NOT add a `manager` role.** Reasons:

- Adding an enum value requires a migration and touches Epics 7, 8, 9, and 10, none of which are built.
- Carpe Diem v1 has 8 staff with explicitly *fluid* roles (`prd.md:38`) — "any team member can take or close an order". A manager tier is a SaaS-customer need, not a Carpe Diem one.
- The demo path (Epics 3, 4, 5) needs only waiter and kitchen.

**Implement three roles.** Where the PRD grants a capability to Manager, grant it to `owner` for now. Record this in Completion Notes as a known divergence for whoever builds Epic 7+.

**AC-6 is rewritten below** to use roles that actually exist.

---

## Story

As the system,
I want every request validated against an active session with the staff member's identity injected into request headers,
So that all Route Handlers enforce RBAC without duplicating session validation logic.

---

## Acceptance Criteria

**AC-1: Proxy intercepts and classifies every request**
**Given** `src/proxy.ts` is the Next.js proxy (formerly middleware)
**When** any request arrives that is not `POST /api/auth/login`, `GET /api/health`, the `/login` page, or a static asset
**Then** it reads the `__cdrms_session` cookie, verifies the HMAC signature, looks up `staff_sessions`, and either injects `x-staff-id` and `x-staff-role` headers or rejects the request

**AC-2: Valid session injects identity headers**
**Given** a request with a valid, non-expired session cookie
**When** the proxy validates it
**Then** the request proceeds with `x-staff-id` set to the staff UUID and `x-staff-role` set to their role; both headers are readable by Route Handlers and Server Components

**AC-3: Invalid session is rejected by request type**
**Given** a request with no cookie, an invalid signature, an unknown session id, or an expired session
**When** the proxy validates it
**Then** requests to `/api/*` return HTTP 401 with `{ success: false, error: { code: "UNAUTHENTICATED", message: string } }`; page requests redirect (307) to `/login`

**AC-4: Idle timeout is a sliding window**
**Given** `auth_mode` is `session_short` and `session_timeout_minutes` is 5
**When** a request arrives whose session has `last_active_at` more than 5 minutes in the past
**Then** the session is treated as expired and its row is deleted; the staff member must re-enter their PIN
**And when** the session is still within the window
**Then** `last_active_at` and `expires_at` are advanced, so continuous activity never forces a re-login

**AC-5: Header spoofing is impossible**
**Given** a client sends its own `x-staff-id` or `x-staff-role` header
**When** the proxy processes the request
**Then** the incoming values are discarded and overwritten with values derived from the validated session; a forged header can never reach a Route Handler

**AC-6: Role-based route restriction** *(rewritten — epics.md referenced non-existent roles)*
**Given** a route declares a required role
**When** a staff member whose role is not permitted requests it
**Then** HTTP 403 is returned with `{ success: false, error: { code: "FORBIDDEN", message: string } }` for API routes, or a redirect for page routes; the underlying action is not executed
**And** `kitchen` is restricted to ticket-view routes only; `owner` may access everything; `waiter` may access order and billing routes but not configuration or staff management

**AC-7: Attribution comes from the header, never from ambient state**
**Given** a Route Handler records any action
**When** it writes `staff_id`
**Then** it uses the `x-staff-id` header value directly; it never re-reads the cookie, re-queries the session, or infers identity from any other source

**AC-8: Session table shape**
**Given** the `staff_sessions` table
**When** its schema is inspected
**Then** it contains `id` (PK), `tenant_id` (FK), `staff_id` (FK → staff), `role`, `created_at`, `expires_at`, `last_active_at`; no plaintext credential is stored in any column

**AC-9: Expired sessions do not accumulate**
**Given** expired rows exist in `staff_sessions`
**When** the proxy encounters one, or a periodic sweep runs
**Then** the expired row is deleted; the table does not grow without bound

**AC-10: Home route is protected and useful**
**Given** an authenticated staff member lands on `/`
**When** the page renders
**Then** it shows who they are signed in as and their role, and offers a working logout; the Next.js starter content is gone

---

## Tasks / Subtasks

- [x] **Task 1 — Create `src/proxy.ts`** (AC: 1, 5)
  - **Filename is `proxy.ts`, not `middleware.ts`.** Next 16 renamed it. If the proxy does not appear to fire, verify empirically before assuming the name is wrong — add a `console.log` at the top and watch the dev server output.
  - Export a `config.matcher` that excludes static assets:
    ```ts
    export const config = {
      matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
    }
    ```
  - Public routes, checked inside the handler rather than the matcher so the list is readable and testable:
    `POST /api/auth/login`, `GET /api/health`, `/login`.
  - **`POST /api/auth/logout` must NOT be public** — it needs a session to know what to delete, and it already handles an absent one gracefully.
  - **Strip incoming `x-staff-id` / `x-staff-role` before doing anything else** (AC-5). A client can send any header it likes; if you only ever *set* them on the happy path, an unauthenticated request carrying forged headers would sail through on a route you later forget to protect. Delete them unconditionally at entry, then set them from the validated session.

- [x] **Task 2 — Session validation service** (`src/server/services/session.service.ts`) (AC: 1, 2, 4, 9)
  - Extend the existing file — do not create a second one. It already exports `verifySessionCookie`, `createSession`, `destroySession`, `getSessionTimeoutMinutes`, and `SESSION_COOKIE_NAME`.
  - Add `validateSession(cookieValue): Promise<{ staffId, role, tenantId, sessionId } | null>`:
    1. `verifySessionCookie` → null on bad signature (**no DB query** — this is why the HMAC exists)
    2. Look up the row; null if absent
    3. If `last_active_at + timeout < now` → delete the row, return null (AC-4, AC-9)
    4. Otherwise return the identity
  - Add `touchSession(sessionId, timeoutMinutes)` — advances `last_active_at` and `expires_at`.

- [x] **Task 3 — Wire validation into the proxy** (AC: 2, 3)
  - Valid → `NextResponse.next()` with request headers rewritten to carry `x-staff-id` and `x-staff-role`. Use the request-headers form:
    ```ts
    const headers = new Headers(request.headers)
    headers.delete('x-staff-id')
    headers.delete('x-staff-role')
    headers.set('x-staff-id', session.staffId)
    headers.set('x-staff-role', session.role)
    return NextResponse.next({ request: { headers } })
    ```
    Setting them on the *response* instead is a common and silent mistake — Route Handlers read *request* headers.
  - Invalid + path starts `/api/` → 401 JSON in the standard envelope.
  - Invalid + page route → `NextResponse.redirect(new URL('/login', request.url))`.

- [x] **Task 4 — Sliding expiry** (AC: 4)
  - Story 2.2 set `expires_at` once at login. That is a fixed window; `session_short` requires an **idle** window, so activity must extend it.
  - **Throttle the write.** Updating `last_active_at` on every request means a DB write per page load and per API call, which will show up against NFR-P2. Only write when `last_active_at` is older than ~30 seconds; otherwise skip. Idle detection stays accurate to well within the 5-minute window.
  - Refresh the cookie's `Max-Age` when you touch the session, or the browser will drop a cookie for a session the server still considers live.

- [x] **Task 5 — Route permission map** (`src/server/auth/permissions.ts`) (AC: 6)
  - A declarative map from path prefix to allowed roles. Keep it as data, not scattered `if` statements.
    ```ts
    export const ROUTE_ROLES: Array<{ prefix: string; roles: StaffRole[] }> = [
      { prefix: '/api/config',  roles: ['owner'] },
      { prefix: '/api/staff',   roles: ['owner'] },
      { prefix: '/api/kitchen', roles: ['owner', 'kitchen'] },
      { prefix: '/kitchen',     roles: ['owner', 'kitchen'] },
      { prefix: '/owner',       roles: ['owner'] },
    ]
    ```
  - **Default allow for authenticated users.** Only listed prefixes are restricted. Default-deny sounds safer but would break every unbuilt Epic 3/4/5 route the moment it is added, and the failure would look like a bug rather than a policy.
  - Longest matching prefix wins.

- [x] **Task 6 — Enforce roles in the proxy** (AC: 6)
  - After identity is established, match the path against `ROUTE_ROLES`. On mismatch: 403 JSON for `/api/*`, redirect to `/` for pages.
  - `kitchen` must not reach order-entry or billing routes. Add `/kitchen` to the map now even though Epic 5 builds the screen — the policy belongs with the policy, not with the feature.

- [x] **Task 7 — Replace the home page** (`src/app/page.tsx`) (AC: 10)
  - It is still the untouched `create-next-app` starter, complete with the Next.js logo.
  - Replace with a Server Component that reads `x-staff-id` / `x-staff-role` via `headers()` and shows the staff name, role, and a logout control.
  - This is a **placeholder**, not the real waiter home — Epic 3 replaces it with the zone/table grid. Keep it deliberately small so replacing it is trivial.
  - Logout: client component posting to `/api/auth/logout`, then `window.location.assign('/login')`.

- [x] **Task 8 — Expired-session sweep** (AC: 9)
  - Deleting on encounter (Task 2) only reaps sessions someone actually revisits. A staff member who never returns leaves a row forever.
  - Add `deleteExpiredSessions()` to the session service and call it from `server.ts` on an interval (every 10 minutes is ample).
  - Guard against overlapping runs, and never let a failure crash the process — log and continue.

- [x] **Task 9 — Verify header spoofing is blocked** (AC: 5)
  - Explicitly test: `curl -H "x-staff-id: <a-real-uuid>" -H "x-staff-role: owner" http://localhost:3000/api/...` with **no cookie**.
  - Must return 401. If it returns 200, Task 1's unconditional header strip is missing or misplaced.
  - Record the actual command and output in the Debug Log. This is the single most security-critical check in the story.

---

## Dev Notes

### What exists after Story 2.2 — reuse, do not rebuild

| Asset | Location |
|---|---|
| `verifySessionCookie`, `createSession`, `destroySession`, `getSessionTimeoutMinutes`, `SESSION_COOKIE_NAME` | `src/server/services/session.service.ts` |
| `staff_sessions` table (7 columns, 2 indexes) | `src/server/db/schema.ts` |
| `POST /api/auth/login`, `POST /api/auth/logout` | `src/app/api/auth/` |
| `/login` page wired to the PINPad | `src/app/login/page.tsx` |
| Runtime role whitelist `toStaffContext()` | `src/app/layout.tsx` |
| Seed: Nina/1234 waiter · Aruna/5678 owner · Kumar/4321 kitchen | `src/server/db/seed.ts` |

`layout.tsx` already reads `x-staff-role` and sets `data-context` on `<html>`. **Once this story ships, that attribute starts working for the first time** — the `waiter:`, `owner:`, and `kitchen:` Tailwind variants from Story 1.2 become live. Check that the app still looks right; a context-specific style could appear unexpectedly.

### The `[data-context]` constraint

From Story 1.2's review, still binding: the variant is `&:is([data-context="waiter"] *)`, which requires the target to be a **descendant** of the attribute holder. `<html>` is not its own descendant, so never apply `waiter:` / `owner:` / `kitchen:` utilities to `<html>` itself.

### Next.js 16 proxy specifics

- File is `src/proxy.ts` (alongside `src/app/`, not inside it).
- Runs on the **Node.js runtime** in Next 16 — `pg` and the existing `db` import work. This was impossible on Edge.
- The `db` singleton is lazily initialised behind a `Proxy` (Story 1.5), so importing it in the proxy will not construct a pool at module load.
- `config.matcher` is evaluated at build time and cannot use runtime values.

### Sliding vs fixed expiry — what changes

Story 2.2 created sessions with `expires_at = now + timeout` and never moved it. Under that behaviour a waiter mid-shift would be logged out exactly 5 minutes after login regardless of activity — clearly wrong for `session_short`, whose intent is an *idle* timeout.

This story makes the window slide off `last_active_at`. Two consequences to get right:
- The DB write must be throttled (Task 4) or every request writes.
- The cookie's `Max-Age` must be refreshed alongside, or the cookie expires while the session lives.

### Security rules

- **Strip `x-staff-id` / `x-staff-role` unconditionally on entry.** Everything downstream trusts them absolutely; they are the identity of record for the audit trail (NFR-S3). A spoofable header would let anyone attribute an order to anyone.
- Signature verification happens **before** any DB query — a forged cookie must cost nothing.
- Never log session ids or cookie values.
- 401 and 403 are different and both matter: 401 means "you are not authenticated", 403 means "you are, but not allowed". Conflating them makes debugging RBAC miserable.
- Do not leak whether a session id existed. An unknown id and an expired one both produce the same 401.

### Architecture compliance

- Error envelope `{ success, data?, error?: { code, message } }` on every API response (`architecture.md:248`).
- Session validation lives in middleware/proxy so Route Handlers never repeat it (`architecture.md:211`).
- `import 'server-only'` on files under `src/server/`. **Do not put it in `proxy.ts`** — the proxy is not a Server Component and the marker will error.
- Naming: files kebab-case, types PascalCase.

### Previous story intelligence — Story 2.2

- **AC-3 there is partially met**: failure is ~30ms faster than success because success does extra session-creation work. Not fixed. Unrelated to this story but do not "helpfully" change the login handler while you are in there.
- **13+ stale session rows** are sitting in the database from 2.2's testing. Task 8's sweep should clear them — good live verification.
- `dotenv` is deliberately absent. Pass `DATABASE_URL` explicitly to any script.
- The dev-only `db` port mapping lives in `docker-compose.override.yml` at `127.0.0.1:5432`.
- Redirect after login uses `window.location.assign('/')`, not `router.push()`, so the server re-renders and picks up `data-context`. Keep that pattern for the logout redirect.

### Testing

No test framework, and **do not add one** — out of scope.

Verify with:
1. `npx tsc --noEmit` → exit 0
2. `npx eslint` → 0 errors (one pre-existing warning in `src/server/socket/index.ts` expected)
3. `env -u DATABASE_URL npx next build` → must still succeed
4. Live flow, with the stack running:
   - `GET /` with no cookie → 307 to `/login`
   - `GET /api/health` with no cookie → 200 (public)
   - Log in as Nina → `/` shows "Nina · waiter"
   - **Spoof test (Task 9)** — forged headers, no cookie → 401
   - Log in as Kumar (kitchen) → `/owner` must be refused
   - Log in as Aruna (owner) → `/owner` allowed
   - Wait past the idle window → next request redirects to `/login` and the row is gone
   - Stay active across the window → never logged out (proves sliding)
   - Logout → `/` redirects to `/login`
5. `psql` before and after the sweep to confirm expired rows disappear

Record real command output in the Debug Log. Do not claim a check passed without running it.

### Project Structure

```
NEW:    src/proxy.ts
NEW:    src/server/auth/permissions.ts
NEW:    src/components/pos/logout-button.tsx
UPDATE: src/server/services/session.service.ts   (validateSession, touchSession, deleteExpiredSessions)
UPDATE: src/app/page.tsx                         (replace starter with authenticated placeholder)
UPDATE: server.ts                                (periodic sweep)
```

### References

- [Source: epics.md#Story-2.3] — original ACs; AC-6 rewritten, AC-1/AC-7 corrected for real filenames and columns
- [Source: architecture.md:207-224#Authentication-and-Security] — middleware header injection, session storage
- [Source: architecture.md:248#Error-handling-standard] — response envelope
- [Source: prd.md:341-357] — four-role permission matrix (three implemented; see role model note)
- [Source: prd.md#NFR-S2] — no action without a valid authenticated PIN session
- [Source: prd.md#NFR-S6] — idle timeout (states 30 min; flag table says 5 — use 5)
- [Source: 2-2-implement-pin-authentication-and-session-creation.md] — session service API, seed credentials
- [Source: 1-2-configure-design-token-system.md] — `[data-context]` descendant constraint
- [Node.js middleware runtime stable in Next 16](https://medium.com/@mernstackdevbykevin/node-js-middleware-runtime-in-next-js-16-now-stable-what-this-means-for-your-full-stack-apps-d8f1660f4193) · [Edge runtime limitations](https://oneuptime.com/blog/post/2026-01-24-fix-nextjs-edge-runtime-limitations/view)

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

```
npx tsc --noEmit              → exit 0
npx eslint                    → 0 errors (1 pre-existing warning, src/server/socket/index.ts:5)
next build (no DATABASE_URL)  → SUCCESS, and crucially prints:
                                  ƒ Proxy (Middleware)
                                ⇒ Next 16 registered src/proxy.ts

AC-9 — sweep on startup:
  rows before: 15   (stale rows left by Story 2.2's testing)
  log: "[sessions] Swept 15 expired session(s)"
  rows after: 0

AC-5 / Task 9 — HEADER SPOOFING (the critical test):
  curl -X POST /api/auth/logout \
       -H "x-staff-id: <real Aruna UUID>" -H "x-staff-role: owner"   [NO COOKIE]
  → HTTP 401 {"success":false,"error":{"code":"UNAUTHENTICATED",...}}
  ⇒ forged identity headers cannot reach a Route Handler

AC-3 — unauthenticated handling:
  POST /api/auth/logout  (no cookie) → 401 UNAUTHENTICATED
  GET  /                 (no cookie) → 307 → http://localhost:3000/login
AC-1 — public routes still open:
  GET /api/health → 200
  GET /login      → 200

AC-6 — RBAC matrix (403 = blocked, 404 = allowed but route not built yet):
  role     /api/config   /api/kitchen   /api/orders
  kitchen      403           404            403
  owner        404           404            404
  waiter       403           403            404
  ⇒ exactly the intended policy

AC-2 — identity reaches the Server Component:
  GET / with Nina's cookie → page renders "Signed in as", "Nina", "waiter"

AC-4 — sliding window (AFTER the clock fix):
  backdate last_active_at to now()-2min → idle 121s
  one request                            → HTTP 200
  idle after                             → 4s      ⇒ window slid
  backdate to now()-10min                → request → 307 → /login
  row remaining                          → 0       ⇒ deleted on encounter
  throttle: two rapid requests on a fresh session
    last_active_at 08:17:30.177 → 08:17:30.177     ⇒ no redundant write

CLOCK SKEW MEASUREMENT (the bug this story uncovered):
  db   epoch = 1788164041
  node epoch = 1788163921
  skew       = 120 seconds (container ahead of host)
```

### Completion Notes List

**A real bug was found and fixed mid-implementation: the code mixed two clocks.**

The first implementation stored `last_active_at` via PostgreSQL's `defaultNow()` but compared it against Node's `Date.now()`, and wrote `expires_at` from Node while sweeping it with SQL `now()`. Three code paths, two different clocks.

It surfaced during AC-4 testing. A session backdated **120,000ms** was reported by `touchSession` as **2,539ms** old, so the sliding window silently never advanced. Measuring directly showed the Docker container's clock running **120 seconds ahead of the host** — ordinary drift for a VM-backed Docker Desktop, and typically worse after a host sleep/resume.

This would not have stayed a test-only curiosity. In production the same skew logs staff out minutes early, or keeps dead sessions alive past their window — and either failure is intermittent, environment-dependent, and miserable to diagnose.

**Fix: PostgreSQL is now the sole clock authority for sessions.** `validateSession` computes idle age with `extract(epoch from (now() - last_active_at))` in SQL; `createSession` and `touchSession` write timestamps with `now() + make_interval(...)`; the sweep compares `expires_at < now()`. `Date.now()` no longer appears anywhere in session expiry logic. A `CLOCK AUTHORITY` block in `session.service.ts` explains why, so nobody "simplifies" it back.

**Second issue: `server-only` broke the sweep.** `server.ts` runs as plain Node, outside Next's module graph, so importing `@/server/db` (which carries `import 'server-only'`) threw at startup. Same constraint `seed.ts` hit in Story 2.2. Fixed with `src/server/db/sweep-sessions.ts` — a standalone reaper owning a `max: 1` pool and issuing one DELETE, importing neither the db singleton nor the session service.

**`session.service.ts` deliberately does NOT carry `import 'server-only'`.** `proxy.ts` imports it, and the proxy is neither a Server Component nor a Route Handler, so the marker throws there. The module stays server-side by construction — every export touches `db`, which carries its own guard. This is noted in the file.

**Role model divergence — Manager does not exist.** The PRD matrix defines Owner / Manager / Staff / Kitchen-Bar; `staffRoleEnum` has only `owner` / `waiter` / `kitchen`. Three roles implemented, Manager capabilities folded into `owner`. Documented at the top of `permissions.ts`. **Epics 7 (audit), 8 (inventory), 9 (dashboard) and 10 (config) must revisit this** — they are where Manager-tier permissions actually bite.

**Route policy is default-allow.** Only prefixes listed in `ROUTE_ROLES` are restricted; anything else permits any authenticated staff member. Default-deny would block every Epic 3/4/5 route the moment it is added, surfacing as a confusing 403 rather than an obvious missing policy. `/api/kitchen` and `/kitchen` are already listed even though Epic 5 builds those screens — policy belongs with the policy.

**`[data-context]` is now live for the first time.** `layout.tsx` has read `x-staff-role` since Story 1.2 but the header was never populated. Story 1.2's `waiter:` / `owner:` / `kitchen:` Tailwind variants now actually apply. No visual regression was observed, but no component uses those variants yet either — the first one that does is the real test.

**NOT verified:**
- No browser was used. All checks were curl and psql against a live stack.
- The `/` placeholder and logout button were verified by HTML content grep, not by clicking.
- The 10-minute sweep interval was verified only via its startup run; the recurring timer was not observed firing.
- Concurrent-request behaviour on the throttled touch was not tested — two simultaneous requests on a stale session could both issue the update. Harmless (both write `now()`), but untested.

**No test framework exists**, so none of this is captured as an automated test.

### File List

- NEW: `src/proxy.ts` (session validation, RBAC, header injection)
- NEW: `src/server/auth/permissions.ts` (route policy map)
- NEW: `src/server/db/sweep-sessions.ts` (standalone expired-session reaper)
- NEW: `src/components/pos/logout-button.tsx`
- UPDATE: `src/server/services/session.service.ts` (validateSession, touchSession, deleteExpiredSessions; all time arithmetic moved into SQL; `server-only` removed with rationale)
- UPDATE: `src/app/page.tsx` (Next.js starter replaced with authenticated placeholder)
- UPDATE: `server.ts` (periodic expired-session sweep)

### Change Log

- 2026-08-21: Story implemented. proxy.ts validates sessions and enforces RBAC; identity headers stripped then set from the validated session only; sliding idle window; expired-session sweep; Next.js starter page replaced. Uncovered and fixed a clock-mixing bug — session time arithmetic compared PostgreSQL timestamps against Node Date.now(), and the container clock ran 120s ahead of the host, silently disabling the sliding window. All session time arithmetic now happens in SQL.
- 2026-08-21: Story created. Five conflicts corrected against the codebase: epics.md references roles (`staff`, `manager`) that do not exist in `staffRoleEnum`; `middleware.ts` is `proxy.ts` in Next 16; the table is `staff_sessions` not `sessions`; the column is `last_active_at` not `last_activity_at`; and Story 2.2's fixed expiry must become a sliding idle window. Four ACs added beyond the epic: header-spoofing prevention, expired-session sweeping, sliding-window behaviour, and replacing the Next.js starter home page. The PRD's four-role matrix is implemented as three roles, with Manager capabilities folded into Owner for v1.
