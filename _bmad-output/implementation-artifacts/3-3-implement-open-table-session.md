# Story 3.3: Implement Open Table Session

Status: done

- **Epic:** 3 — Zone & Table Navigation
- **Story ID:** 3.3
- **Story Key:** 3-3-implement-open-table-session
- **Created:** 2026-09-06

---

## ⚠️ READ FIRST

**You are the first producer of a real-time event in this system.**

Story 3.2 built the entire listening half of real-time — the socket client, the `table:status_changed` listener, the targeted cache patch, the reconnect resync — and **none of it has ever fired**, because nothing has ever emitted the event. Its review says so explicitly. You are the other end of that wire. When you emit correctly, real-time works for the first time; when you get the event name or payload shape wrong, nothing errors and nothing happens.

**The same is true of the occupied card.** No table in this system has ever had `status: 'occupied'`, because occupancy comes from an `order_sessions` row and none exist. `TableCard`'s occupied branch, the elapsed-minute tick, and the item-count query in `/api/tables` are all written, reviewed, and **never once executed**. Your story is what runs them. Expect to find bugs there that no amount of code review could have caught.

### Three things changed under you on 2026-09-06

Story 3.2's code review applied 21 patches. These three change what you must write:

| # | What changed | What it means for you |
|---|---|---|
| 1 | **`/api/tables` now DERIVES status from the session join** — `row.sessionId ? 'occupied' : 'open'`, with `tables.status` consulted only for `unavailable`. | The grid no longer depends on you updating the `tables.status` column. You should still update it (AC-1 asks for it and other readers will come), but a mismatch can no longer produce the silent revert bug. |
| 2 | **`TableCard` is now inert on `unavailable` from inside the component** — `onClick` is `undefined` and `aria-disabled` is set. | Do not rely on the caller-side guard in `TableGrid` alone; it is still there, but the component enforces it now too. |
| 3 | **`TableGrid` gained `handleSignOut`, a degraded-connection banner, and a session-expiry redirect.** | You are editing a file that changed materially since 3.2's File List was written. Read it before you touch it. |

---

## Story

As a waiter,
I want to open a new order session on an available table with a single tap,
So that I can start taking an order immediately without any setup steps.

---

## Acceptance Criteria

**AC-1: Tapping an open table creates a session**
**Given** a waiter taps an "open" table card
**When** the tap is registered
**Then** `POST /api/tables/:tableId/sessions` is called; a new `order_sessions` row is created with `table_id`, `opened_by_staff_id` (from the `x-staff-id` header), and `opened_at`; `closed_at` is left NULL, which is what marks the session open; `tables.status` updates to `occupied`

**AC-2: Success navigates to the order screen**
**Given** the session is created successfully
**When** the Route Handler returns
**Then** the waiter is navigated to the order entry screen for that table; the `ContextHeader` breadcrumb reflects the selected table; a `table:status_changed` Socket.io event is emitted to all connected clients

**AC-3: Concurrent taps produce exactly one session**
**Given** two waiters tap the same "open" table simultaneously
**When** both `POST /api/tables/:tableId/sessions` requests arrive concurrently
**Then** exactly one session is created; the second request receives HTTP 409 with `{ success: false, error: { code: "TABLE_ALREADY_OCCUPIED" } }`; no duplicate session rows exist — **enforced by the existing partial unique index `idx_order_sessions_one_open_per_table`, not by application logic**

**AC-4: Already-occupied table is rejected**
**Given** a waiter attempts to open a session on an already "occupied" table
**When** `POST /api/tables/:tableId/sessions` is called
**Then** HTTP 409 is returned with `{ success: false, error: { code: "TABLE_ALREADY_OCCUPIED" } }`; no new session is created

**AC-5: Unavailable table is rejected**
**Given** a waiter attempts to open a session on an `unavailable` table
**When** `POST /api/tables/:tableId/sessions` is called
**Then** HTTP 422 is returned with `{ success: false, error: { code: "TABLE_NOT_AVAILABLE" } }`; no session is created

**AC-6: Attribution is correct**
**Given** the `order_sessions` row that was just created
**When** inspected in the database
**Then** `opened_by_staff_id` matches the `x-staff-id` header from the request; `closed_at` is NULL; `closed_by_staff_id` is NULL

**AC-7: Real-time propagation actually works — END TO END** *(added beyond the epic)*
**Given** two devices have the grid open
**When** device A opens a session on table T
**Then** device B's card for T changes to occupied within 2 seconds **without a refetch of the full list**, showing elapsed time and item count; this must be **observed**, not reasoned about — it is the first genuine execution of Story 3.2's AC-3 and AC-4

**AC-8: The order screen route exists** *(added beyond the epic)*
**Given** a session has been opened on table T
**When** the waiter lands on `/tables/{tableId}`
**Then** a real route renders showing the table label, zone, elapsed time and cover count, with a clear "Epic 4 builds order entry here" placeholder; it is not a 404, and it reads the session from the database rather than from navigation state

**AC-9: A stale grid recovers gracefully** *(added beyond the epic)*
**Given** device B's grid still shows table T as `open` because it missed the event
**When** the waiter on device B taps T
**Then** the 409 is handled as a normal outcome, not an error screen — the grid refreshes and the card corrects itself to occupied, with a brief non-blocking message; the waiter is not navigated to a session they did not open

---

## Tasks / Subtasks

- [x] **Task 1 — `POST /api/tables/[tableId]/sessions` Route Handler** (AC: 1, 3, 4, 5, 6)
  - New file: `src/app/api/tables/[tableId]/sessions/route.ts`
  - **Next 16 route params are a Promise.** The signature is `{ params }: { params: Promise<{ tableId: string }> }` and you must `await params`. TypeScript catches the omission, but only if you type it — do not reach for `any` here.
  - Validate `tableId` is a UUID with `zod` (`z.string().uuid()`) before touching the database — an invalid id should be 400 `INVALID_TABLE_ID`, not a 500 from PostgreSQL's own uuid parser.
  - Read identity from the `x-staff-id` header ONLY. `src/proxy.ts` deletes any client-sent `x-staff-id` unconditionally and re-sets it from the validated session, so the header is trustworthy and the cookie is not your concern. If the header is somehow absent, return 401 rather than inserting a null.
  - Load the table (scoped to the tenant) and branch: not found → 404 `TABLE_NOT_FOUND`; `status === 'unavailable'` → 422 `TABLE_NOT_AVAILABLE`.
  - **`order_sessions.tenant_id` is `notNull`.** It is not derivable from the insert — carry it from the table row you just loaded (`tables.tenantId`), not from a second `tenants` query. Forgetting this is a not-null violation on your first insert.
  - **Success is `201`, not `200`** — this creates a resource. Response body:
    ```ts
    { success: true, data: { sessionId, tableId, openedAt /* ISO */, status: 'occupied' } }
    ```
    The client needs `sessionId` for navigation and later stories; `openedAt` lets it render elapsed time immediately without waiting for the socket round trip.
  - Standard envelope on every path: `{ success: true, data: ... }` / `{ success: false, error: { code, message } }`. Match `src/app/api/auth/login/route.ts` exactly — it is the reference implementation for this project's error shape.

- [x] **Task 2 — Let the database win the race** (AC: 3)
  - **Do NOT pre-check "is there an open session?" and then insert.** That is a check-then-act race: two requests both read "no session", both insert, and you get either two open sessions or an unhandled 500. The partial unique index `idx_order_sessions_one_open_per_table` on `table_id WHERE closed_at IS NULL` already makes the second insert impossible — your job is to *catch* its failure, not to prevent it.
  - Attempt the insert, and catch the unique-violation. PostgreSQL error code is **`23505`**; with `pg`/Drizzle it surfaces as `error.code === '23505'` (check `cause` too — Drizzle sometimes wraps). Map it to 409 `TABLE_ALREADY_OCCUPIED`.
  - A separate cheap read for the AC-4 "already occupied" case is fine as a fast path for a good error message, but it is **not** the correctness mechanism and must not be written as though it were. The catch is the correctness mechanism.
  - Verify the index actually exists before relying on it: `\d order_sessions` in psql, or query `pg_indexes`. It is declared in `schema.ts:159` — confirm the migration applied it.

- [x] **Task 3 — One transaction, emit after commit** (AC: 1, 2)
  - Wrap the `order_sessions` INSERT and the `tables.status = 'occupied'` UPDATE in a single `db.transaction(async (tx) => { ... })`. A session with a stale table row is exactly the divergence 3.2's review removed from the read path; do not reintroduce it on the write path.
  - **Emit the socket event AFTER the transaction commits, never inside it.** Emitting inside means a client can receive the event, refetch, and read pre-commit state — a race that is rare, real, and miserable to debug. Build the payload inside, emit outside.
  - Note `tables.status` is now *advisory* for the grid (see READ FIRST #1) — `/api/tables` derives occupancy from the session join. Keep the column correct anyway: it is what AC-1 asks for, `unavailable` still lives there, and future readers will expect it to be true.

- [x] **Task 4 — Emit `table:status_changed` with the full payload** (AC: 2, 7)
  - Use `emitTableStatusChanged()` from `src/server/socket/events.ts`. It already exists and is already correct — do not write a second emitter.
  - **All five fields are required** by `TableStatusChangedPayload`: `{ tableId, status, sessionId, openedAt, itemCount }`. For a freshly opened session: `status: 'occupied'`, `sessionId` from the insert, `openedAt` as an **ISO string** (`row.openedAt.toISOString()` — the column is `timestamptz` and Drizzle returns a `Date`), and `itemCount: 0`.
  - The epic's task text for 3.2 omitted `itemCount`; that was corrected on 2026-09-06. The type is exported, so TypeScript will catch you, but know why it is there.
  - Call `getIO()` **inside the request function**, never at module top level — a module-level call runs at import time before `server.ts` has started and throws. `emitTableStatusChanged` already does this correctly; just do not hoist anything.

- [x] **Task 5 — Order entry placeholder route** (AC: 2, 8)
  - New file: `src/app/tables/[tableId]/page.tsx`, a Server Component.
  - Architecture (`architecture.md:713`) specifies `(waiter)/tables/[tableId]/page.tsx` inside a route group. **No route groups exist yet** — `src/app/` is flat. Create the plain `tables/[tableId]` path now; introducing `(waiter)`/`(owner)` groups is its own refactor and would move `page.tsx` and `login/`. Note the divergence in your completion notes so whoever adds the groups knows this is waiting.
  - Load the table, zone and open session server-side by `tableId`. Render restaurant name, `ContextHeader` with the breadcrumb populated (`zoneName` + `tableLabel`), elapsed time, cover count, and an explicit placeholder stating Epic 4 builds order entry here.
  - If the table has no open session, do not render a broken order screen — redirect to `/`. That is the state after Story 3.4/6.5 closes a session, and a bookmarked URL will hit it.

- [x] **Task 6 — Wire the tap in `TableGrid`** (AC: 1, 2, 9)
  - `src/components/pos/table-grid.tsx` — **read the current file first**, it changed materially in 3.2's review (sign-out handler, degraded banner, session-expiry redirect, derived-status assumptions).
  - Today `onSelect` only calls `setSelectedTableId`. Replace with a mutation: `POST` the session, then `router.push('/tables/' + tableId)` on success.
  - Use **`useMutation`** from TanStack Query, not a bare `fetch` in the handler — you need `isPending` to disable the card while the request is in flight. Two taps on the same card by the same waiter must not fire two POSTs.
  - Keep the `unavailable` guard. It is now enforced in `TableCard` too, but the caller-side check is still the one that stops the request.
  - `router.push` (from `next/navigation`), not `window.location.assign` — this is an in-app navigation and the layout does not need to re-derive `data-context`. Contrast with `handleSignOut`, which deliberately uses a full navigation because the role changes.
  - `selectedTableId` currently drives the `ContextHeader` breadcrumb on the grid. Once a tap navigates away, that state is transient — set it before the push so the breadcrumb is correct during the transition, and do not try to preserve it across the navigation. The order screen derives its own breadcrumb server-side (Task 5).
  - **Do not optimistically patch the cache to `occupied` before the POST returns.** A 409 would then require unwinding it, and the socket event is already going to deliver the true state within milliseconds of the commit. Let the server win.

- [x] **Task 7 — Handle 409 as a normal outcome** (AC: 9)
  - A 409 means another device got there first. That is ordinary restaurant life during service, not an error condition.
  - On 409: invalidate `['tables']` so the grid corrects itself, show a brief non-blocking message ("Table just taken by someone else"), and **do not navigate**. Do not use the full-screen error state — the waiter needs the rest of the floor plan.
  - On 422 (`TABLE_NOT_AVAILABLE`): same treatment, different message. The card should already have been inert, so reaching this means the grid was stale.
  - On 401/403: the existing `SessionExpiredError` pattern in `fetchTables` redirects to `/login`. Reuse it; do not invent a second mechanism.

- [x] **Task 8 — Decide the RBAC question** (AC: 1) — **NEEDS A DECISION, see Dev Notes**
  - `findRoutePolicy('/api/tables/...')` returns `null` today, and `permissions.ts` documents that null means default-allow. So a **kitchen** user can currently open a table session.
  - The obvious fix — adding `{ prefix: '/api/tables', roles: ['owner', 'waiter'] }` — **would break the grid for kitchen users**, because `findRoutePolicy` is path-only and cannot distinguish `GET /api/tables` from `POST /api/tables/:id/sessions`. The landing page renders `TableGrid` for every role.
  - Two viable options, both acceptable; pick one and say which in your completion notes:
    - **(a)** Check `x-staff-role` in this Route Handler and reject `kitchen` with 403. Minimal, but puts policy outside `permissions.ts`, which the file explicitly exists to prevent.
    - **(b)** Make `ROUTE_ROLES` method-aware (add an optional `methods?: string[]` to `RoutePolicy`) and add the policy properly. Correct long-term, touches shared auth code, needs its own regression check on every existing policy.
  - Do **not** silently leave it default-allow without recording the decision.

- [x] **Task 9 — Verify real-time end to end, in a browser** (AC: 7)
  - This is not optional and it is not a formality. Story 3.2 shipped its real-time claims unverified and its review said so.
  - Two browser windows, both on `/`. Open a table in window A. Window B's card must go occupied within 2 seconds. Confirm in the Network tab that **no `GET /api/tables` fired** in window B — the whole point of AC-4 is a targeted cache patch.
  - Then watch the elapsed time cross a minute boundary without a refetch (Story 3.2's AC-8, also never observed).
  - Then kill the server, restart it, and confirm the grid resyncs on reconnect (the patch added in 3.2's review, also never observed).

- [x] **Task 10 — Seed a verifiable occupied state** (AC: 7, 8)
  - AC-9 of Story 3.2 was amended on 2026-09-06 to require only `open` and `unavailable` in the seed, precisely because an `occupied` table with no session row is incoherent. Do not add one.
  - Instead, confirm the occupied path by opening a real session through the API — which is what this story builds. That is the correct fixture.

---


### Review Findings

Code review 2026-09-06 — three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor) plus verification. Scope: Story 3.3's files plus the same-day 4-digit PIN change.

All nine ACs audited. AC-1 through AC-6, AC-8 and AC-9 verified; AC-7's client half rests on Teran's browser pass, recorded as user-attested rather than agent-observed.

**The browser pass was signed in as Nina, a waiter.** That is why the highest-severity finding below went unseen — it only manifests for a kitchen user.

#### Decision needed

- [x] [Review][Decision] **A 4-digit PIN is the entire credential, and nothing enforces uniqueness** [`api/auth/login/route.ts`, `schema.ts`] — The login request carries no staff id or selector: the PIN alone identifies the person. The handler loops every active staff member and takes the first bcrypt match. There is no unique constraint on `pin_hash` (and with bcrypt salting there could not be a naive one), so two staff members can hold the same PIN — at which point every action by the second is attributed to the first, silently and permanently. The append-only audit trail is this product's stated premise, so misattribution is not a cosmetic bug. Narrowing to 4 digits raised the collision probability roughly 100x: at 3 staff it is negligible; at ~25 staff sharing a 10,000-value space it is better than even odds that some pair collides. Options: (a) enforce uniqueness at PIN-set time by comparing the candidate against every active hash before saving, (b) add a staff selector to the login screen so the PIN is a password rather than an identifier, (c) accept it for the demo and revisit before real staff onboarding. This is a consequence of a decision already taken deliberately — the question is only what to do about the collision case. **RESOLVED 2026-09-06 — option (a), enforce uniqueness at PIN-set time.** Preserves the one-tap sign-in exactly as designed and closes the attribution hole. Enforcement belongs wherever a PIN is written: Story 10.2 (staff management) is the real home and does not exist yet, so an AC was added there, and the one PIN-setting path that exists today — the seed — was guarded. Raised as a patch below.

#### Patch

- [x] [Review][Patch] **Enforce PIN uniqueness at set time** (from the resolved Decision, 2026-09-06) [`epics.md` Story 10.2, `src/server/db/seed.ts`] — A PIN is the whole credential, so two staff sharing one silently misattributes the second's actions to the first. bcrypt salting means no naive unique index works: uniqueness has to be checked by comparing a candidate PIN against every active staff hash before saving. Add it as an AC on Story 10.2, which owns staff creation and PIN changes, and guard the seed — the only path that writes a PIN today — so fixtures cannot collide. Reject with a clear message ("That PIN is already in use") rather than silently accepting.

- [x] [Review][Patch] **HIGH — kitchen staff tapping any open table are signed out in a loop** [`table-grid.tsx:35`] — `openSession` throws `SessionExpiredError` on 403 as well as 401, and `onError` responds to that by hard-navigating to `/login`. The RBAC change in this story is exactly what made 403 reachable on this path: `GET /api/tables` stays open so kitchen users land on the grid by design, nothing in the grid disables cards by role, and their POST is refused by the proxy. A wrong *role* is not an expired *session* — re-authenticating cannot help, so the user bounces between grid and PIN pad indefinitely. Found independently by two layers. Fix: give 403 its own error class and surface it as a notice ("Kitchen staff cannot open tables"), not a redirect. Apply the same split in `fetchTables`, where the conflation is currently unreachable but equally wrong.
- [x] [Review][Patch] **`/tables/<non-uuid>` is an unhandled 500, not a redirect** [`app/tables/[tableId]/page.tsx:25-48`] — `tableId` goes straight into `eq(tables.id, tableId)` with no shape guard, so PostgreSQL raises `22P02` and the throw reaches Next's default error page. There is no `error.tsx` or `not-found.tsx` anywhere under `src/app`. The sibling Route Handler guards this exact case deliberately and says so in a comment; the page skipped it. Reachable from any mistyped or truncated bookmark — the precise scenario the `redirect('/')` branch exists for. Found by all three layers.
- [x] [Review][Patch] **The order screen has a dead "Switch user" control and no way to sign out** [`order-screen.tsx:43`] — `ContextHeader` is rendered without `onStaffTap`, so it draws a 44px button announced to screen readers as "Signed in as {name}. Switch user." that does nothing. This is the identical defect the 3.2 review raised and this same story's `TableGrid` comment explicitly claims to have fixed. A waiter who navigates into a table has no sign-out at all on that screen.
- [x] [Review][Patch] **The in-flight guard is disarmed during navigation, so a second session can be opened** [`table-grid.tsx:150-153, 334`] — `onSuccess` flips the mutation to `success` (clearing `isPending`) and only then calls `router.push`, which is not wrapped in `useTransition`. The grid stays mounted and fully interactive for the whole RSC round trip. Tapping a different open table in that window commits a second session on a table nobody is seated at, and then the router lands on the first table. Fix: hold a navigating flag, or wrap the push in `useTransition` and gate on `isPending || isNavigating`.
- [x] [Review][Patch] **Remounting the grid within `staleTime` serves stale data with no resync** [`table-grid.tsx:141-143`] — The `connect` invalidation only fires on an actual socket connect, and the socket is a module singleton that deliberately survives unmount. So unmount → remount never reconnects and never invalidates, while the listener *was* removed, so every event during that window is lost. With `staleTime: 30_000`, `refetchOnWindowFocus: false`, no `refetchInterval`, and the cache surviving in the layout-level provider, a waiter returning from an order screen inside 30s sees a grid that silently missed everything. Fix: `refetchOnMount: 'always'` for this query, or invalidate on mount.
- [x] [Review][Patch] **Kitchen users can open the order screen directly** [`permissions.ts`] — `ROUTE_ROLES` covers `/api/tables` but nothing covers the `/tables/*` page. A kitchen user blocked from `POST` can still navigate to `/tables/<id>` and read the session, covers and timing; tapping an already-occupied card even routes there with no API call at all. Add a policy for the page route to match the API's intent.
- [x] [Review][Patch] **The `methods` allowlist inverts the file's default-deny direction** [`permissions.ts:60`] — `methods: ['POST','PATCH','DELETE']` means any *unlisted* verb matches no policy and falls to default-allow for every role, including kitchen. A future `PUT /api/tables/:id` inherits kitchen access silently, with no missing-policy error to surface it — which is precisely the failure mode the file's own comment says default-deny was rejected to avoid. Separately, the prefix grants `waiter` any `POST /api/tables`, including a future table-CRUD handler that `prd.md:341-357` reserves for owner. Neither is reachable today. Fix: make the policy deny-by-default for unlisted methods, or narrow the prefix and document the CRUD gap.
- [x] [Review][Patch] **A concurrent "mark unavailable" is clobbered back to occupied** [`sessions/route.ts:93, 127-130`] — The `unavailable` check reads outside the transaction; the `UPDATE tables SET status='occupied'` inside it carries no `AND status <> 'unavailable'` and takes no row lock. The partial unique index protects the session row and says nothing about `tables.status`, and `GET /api/tables` still sources `unavailable` from that column, so the clobber is user-visible. A manager taking a table out of service concurrently is silently reverted and guests are seated at it. Not reachable until a status-writing route exists — but `methods` already anticipates `PATCH`. Fix: add the predicate and check the row count inside the transaction.
- [x] [Review][Patch] **`isUniqueViolation` does not check which constraint fired** [`sessions/route.ts`] — It matches on `code === '23505'` alone, never `constraint`, though the debug log captured `idx_order_sessions_one_open_per_table` and the field is available. Verified safe today — the whole schema has exactly two unique indexes and neither other one is reachable from this insert — but the story itself warns that nothing except a comment protects this function. Match on the constraint name so a future index cannot silently report itself as "table already occupied".
- [x] [Review][Patch] **A repeated identical notice reuses the previous timer** [`table-grid.tsx:178-182`] — `setNotice` with the same string is a React bail-out, so the effect never re-runs and no fresh 4s timer starts; the banner is cleared by the *previous* occurrence's timer. All three call sites pass fixed literals, so consecutive identical values are the common case. Two 409s in a row can make the second banner appear and vanish in under a second. Pair the message with a nonce.
- [x] [Review][Patch] **The in-flight guard also blocks navigation that needs no request** [`table-grid.tsx:334`] — `if (openTable.isPending) return` sits above the occupied-card branch, so while any POST is in flight, tapping an already-occupied table — a pure `router.push` — does nothing, with no spinner and no disabled styling. On a slow connection during service that reads as a frozen tablet. Scope the guard to the mutating branch and give the pending card a visible busy state.
- [x] [Review][Patch] **The shared clock's doc comment describes behaviour it does not have** [`use-minute-tick.ts`] — It claims "one store ticking once a minute" shared by every consumer. `useSyncExternalStore` calls `subscribe` once per consumer, so it is one interval *per mounted component*, and the interval is 30s, not 60s. Harmless at two consumers; actively misleading the moment someone adds `useMinuteTick()` to `TableCard`, which is exactly what the comment promises is safe. Also, `elapsedMinutesFrom`'s comment describes the NaN bug in the present tense as though live, when the guard directly beneath it prevents it.
- [x] [Review][Patch] **Story 2.1's 80×80px key AC was missed by the PIN amendment** [`epics.md:700`] — The 2026-09-06 amendment covered the Submit button and the short-PIN error and says so explicitly, but the same AC line still ends "all digit buttons are 80×80px" while `pin-pad.tsx` now uses `size-24` (96px). Either amend it in the same pass or fold it into the pending design retro-spec — but it should not sit as a live contradiction.
- [x] [Review][Patch] **`design/claude-design-brief.md` still specifies "4–6 digits"** [`design/claude-design-brief.md:25`] — A live working-tree document driving the design canvases beside it, not a historical record. It is the one place a designer would read the PIN requirement and get the pre-amendment answer.
- [x] [Review][Patch] **Story 2.1 and 2.2 artifacts document removed behaviour with no forward pointer** [`2-1-build-pinpad-component.md`, `2-2-…md`] — They carry "Auto-submit at six digits", a `Submit ("Submit PIN")` aria-label spec, a decisions row asserting "PINs are 4–6 digits, so 4- and 5-digit PINs require a Submit button", and the old `PIN must be 4-6 digits` error string. These are point-in-time records so rewriting them would be wrong, but `epics.md` and `prd.md` both got a dated amendment banner and these did not. Add a forward-pointing note so a dev told to "read Story 2.1" is not handed the superseded spec.

#### Deferred

- [x] [Review][Defer] **Role and active-status changes do not invalidate live sessions** [`session.service.ts`, `schema.ts:86`] — deferred, pre-existing. `session.role` is denormalised at login by deliberate design (Story 2.3), and `validateSession` never re-joins `staff` or checks `isActive`. Demote a waiter to kitchen, or deactivate them, and they keep the old role for the idle window — indefinitely while they keep tapping, since `touchSession` slides it. **This story's method-scoped RBAC now depends on that denormalised role for a write authorization decision, which raises the stakes on an existing gap rather than creating it.** Needs an owner: session invalidation on staff change, or a re-check in `validateSession`.
- [x] [Review][Defer] **Cross-tenant table id is not rejected** [`sessions/route.ts`, `tables/[tableId]/page.tsx`] — deferred, pre-existing. Task 1 said "load the table scoped to the tenant"; the implementation filters on id alone and then takes `tenantId` from the row. Under NFR-SC1 (single tenant per stack) this is unreachable, and taking the tenant from the row is arguably safer than trusting the caller's — but the deviation from the task was not recorded. Revisit if multi-tenancy ever lands.
- [x] [Review][Defer] **`tenantConfig` read with no WHERE and no ORDER BY** [`tables/[tableId]/page.tsx`] — deferred, pre-existing. Same unordered `limit(1)` pattern as `src/app/page.tsx`; already logged from the 3.2 review. Two rows would make the header show an arbitrary restaurant name.
- [x] [Review][Defer] **FK violations inside the transaction return a generic 500** [`sessions/route.ts:136-140`] — deferred. The inner catch handles `23505` only; a `23503` from a table or staff row deleted between the pre-check and the insert becomes "Could not open the table. Try again." and the waiter retries forever instead of seeing a 404. Not reachable through the HTTP API — there are no delete routes — only by direct database action.
- [x] [Review][Defer] **A fourth-digit typo is unrecoverable** [`pin-pad.tsx`] — deferred, by design. Auto-submit fires in the same handler as the keypress, so backspace is never reachable for the last digit and every mistype is a recorded failed attempt. This is the accepted cost of the 2026-09-06 decision to remove the confirm tap; the mitigation is that a failed attempt is cheap and the shake plus message make it obvious. Becomes material if attempt-based lockout is ever added — see the rate-limiting item already logged.
- [x] [Review][Defer] **No rate limiting on login** [`api/auth/login/route.ts`] — deferred, already logged the same day. 10,000-value keyspace with no throttling, no backoff, no lockout. Re-surfaced by two layers; the existing entry stands.

#### Dismissed as noise (4)

Verified false: **socket emit throwing after commit** (`emitTableStatusChanged` wraps `getIO().emit` in its own try/catch, so the orphaned-session-plus-500 scenario is impossible — independently confirmed by a second layer); **`openedAt` null or non-Date** (`schema.ts:153` is `.notNull().defaultNow()` with default Date mode); **repeated identical error shows no shake** (`login/page.tsx:15` calls `setError(null)` before each attempt, so the prop transitions string → null → string and the render-phase `prevError` comparison fires both times — the layer flagged this as needing verification and was right to); **CSRF on the session POST** (the session cookie is `sameSite: 'strict'`).
## Dev Notes

### The three-way relationship you must keep straight

```
order_sessions row (closed_at IS NULL)   ← the TRUTH about occupancy
        │
        ├─ /api/tables DERIVES status from this (since 2026-09-06)
        │     row.status === 'unavailable' ? 'unavailable'
        │       : row.sessionId ? 'occupied' : 'open'
        │
        └─ tables.status column  ← advisory for occupancy, AUTHORITATIVE for 'unavailable'
```

`tables.status` is no longer what the grid reads for open/occupied, but it is still the only place `unavailable` lives. Keep it updated; never treat it as the source of truth for occupancy.

### Why the unique index, not a pre-check

`schema.ts:159`:

```ts
uniqueIndex('idx_order_sessions_one_open_per_table')
  .on(t.tableId)
  .where(sql`${t.closedAt} IS NULL`)
```

A partial unique index on `table_id` filtered to open sessions. It permits unlimited *closed* sessions per table and exactly one open one. Two concurrent inserts: PostgreSQL serialises them, one commits, the other raises `23505`. No application-level locking, no `SELECT FOR UPDATE`, no advisory lock. This is also what guarantees `/api/tables`' left join cannot fan out.

### What exists — reuse, do not rebuild

| Asset | Location | Notes |
|---|---|---|
| `emitTableStatusChanged()` | `src/server/socket/events.ts` | Correct and typed. Use it. |
| `getIO()` | `src/server/socket/index.ts` | Call inside request functions only. |
| Error envelope + status codes | `src/app/api/auth/login/route.ts` | The reference for this project's API shape. |
| `db` singleton | `src/server/db/index.ts` | Lazy Proxy, safe to import server-side. |
| `db.transaction()` | used in `src/server/db/seed.ts` | Added 2026-09-06; copy the shape. |
| Proxy + `x-staff-id` | `src/proxy.ts` | Headers stripped then set from validated session. Trust the header. |
| `TableCard`, `ZoneChipBar`, `ContextHeader` | `src/components/pos/` | Restyled in the 3.2 design pass; a retro-spec is pending. Do not restyle further. |
| `elapsed()` | `src/lib/format.ts` | `67 min` under an hour, `1h 07m` at or over. |

### Schema you are writing

```ts
orderSessions = {
  id, tenantId, tableId, openedByStaffId, closedByStaffId,
  openedAt   /* timestamptz, defaultNow */,
  closedAt   /* timestamptz, NULL = open */,
  coverCount /* integer, notNull, default 1 */,
}
```

`coverCount` defaults to 1. This story does not ask for a cover-count prompt, so take the default and leave it — Story 3.4's summary view is where cover counts start mattering.

**`tenantId` is `notNull` and has no default.** You must supply it. Take it from the table row you already loaded for the `unavailable` check — a second query to `tenants` is both wasteful and wrong (it would let a table from one tenant be opened under another's id).

**There is no `status` column on `order_sessions`.** Earlier epic drafts referenced `status: "active"`. It does not exist and never did.

### Status codes, in one place

| Outcome | Code | Error code |
|---|---|---|
| Session created | **201** | — |
| Malformed `tableId` | 400 | `INVALID_TABLE_ID` |
| No `x-staff-id` header | 401 | `UNAUTHENTICATED` |
| Kitchen role, if you choose Task 8 (a) | 403 | `FORBIDDEN` |
| Table does not exist | 404 | `TABLE_NOT_FOUND` |
| Table already occupied (fast path or `23505`) | 409 | `TABLE_ALREADY_OCCUPIED` |
| Table is `unavailable` | 422 | `TABLE_NOT_AVAILABLE` |
| Anything else | 500 | `INTERNAL_ERROR` |

Both the fast-path occupied check and the caught unique-violation return the **same** 409 body. The client must not be able to tell which one fired — they are the same fact arriving by two routes.

### Files being modified — current state

**`src/components/pos/table-grid.tsx`** — changed substantially on 2026-09-06. It now holds: a `handleSignOut` that clears the socket and full-navigates; a `useSocketStatus()` degraded banner above the chip bar; a `SessionExpiredError` class and a `useEffect` redirect for 401/403; a `!current` branch in the socket handler that invalidates rather than dropping the event; and a `useSocketEvent('connect')` resync. Your mutation slots into `onSelect` — everything else stays.

**`src/proxy.ts`** — no changes needed, but read `isPublic()` and the header-stripping block so you understand why you can trust `x-staff-id`.

**`src/server/auth/permissions.ts`** — only if you choose Task 8 option (b).

### Testing

**There is still no test framework in this project.** Every prior story verified by hand. Do the same, and be specific in your completion notes about what you actually observed versus what you reasoned about — 3.2's review found the gap between those two was where the real bugs lived.

Minimum manual matrix:

| Case | Expect |
|---|---|
| Tap open table | 201, row created, navigate to `/tables/:id` |
| Tap same table from second browser | 409, grid corrects, no navigation |
| Two concurrent POSTs (curl `&` both) | exactly one row, one 409 |
| POST to unavailable table | 422, no row |
| POST to nonexistent UUID | 404 |
| POST with malformed id | 400, no PostgreSQL error in logs |
| Watch device B's grid | occupied within 2s, **no GET /api/tables** |
| Wait past a minute boundary | elapsed ticks, no refetch |
| Restart server | grid resyncs on reconnect |

Verify the session row directly: `psql -c "select id, table_id, opened_by_staff_id, opened_at, closed_at, closed_by_staff_id, cover_count from order_sessions;"` — AC-6 is a database assertion, not a UI one.

**Environment note carried forward:** the Docker container clock ran 120s ahead of the host in Story 2.3. `openedAt` comes from PostgreSQL, elapsed time is computed against the browser clock. If elapsed time looks wrong, suspect clock skew before suspecting your code.

### Previous story intelligence (Story 3.2 + its review)

- **`useSyncExternalStore` is the house style** for anything clock- or socket-shaped. Three stories in a row hit `react-hooks/set-state-in-effect` doing it with `useEffect` + `setState`. Do not be the fourth.
- **`setQueryData` to patch, `invalidateQueries` only when you must refetch.** AC-4 of 3.2 forbids refetching the list on an event.
- **`tsc` and `eslint` being clean means very little here.** 3.2 passed both while silently deleting its entire font scale via `tailwind-merge`. Verify behaviour, not compilation.
- **`cn()` now carries a custom `extendTailwindMerge` config** (`src/lib/utils.ts`). If you add a new custom `--text-*`, `--shadow-*` or `--inset-shadow-*` token, you must register it there or it will be silently dropped.
- **The design pass in the working tree is unspecified and a retro-spec is pending.** Do not extend it. Style your placeholder route with existing tokens and components.

### Project Structure Notes

- **Divergence:** architecture specifies `(waiter)/tables/[tableId]/page.tsx`; you are creating `tables/[tableId]/page.tsx` because no route groups exist yet. Record this.
- New: `src/app/api/tables/[tableId]/sessions/route.ts`, `src/app/tables/[tableId]/page.tsx`
- Modified: `src/components/pos/table-grid.tsx`, possibly `src/server/auth/permissions.ts`
- Architecture (`architecture.md:442`) anticipates `server/services/order.service.ts`. This story's logic is small enough to live in the Route Handler; extract to a service when Epic 4 adds order submission and the logic is shared. Do not create an empty service file now.

### References

- [Source: epics.md#Story-3.3] — ACs, plus the 2026-08-21 schema note on `closed_at IS NULL`
- [Source: architecture.md:341-346#API-endpoints] — REST conventions, plural nouns
- [Source: architecture.md:372-386#Socket.io-events] — authoritative event names
- [Source: architecture.md:825-857#Core-Data-Flow] — emit co-located with the DB write
- [Source: architecture.md:713#Structure] — the `(waiter)` route group this story diverges from
- [Source: schema.ts:147-160] — `order_sessions` and the partial unique index
- [Source: permissions.ts] — default-allow policy and the three-role model
- [Source: 3-2-...-real-time-status.md#Review-Findings] — the 21 patches and 8 decisions that changed this story's ground

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

Verification was done with curl, psql, a real `socket.io-client`, and `next build`. No browser was used — see the gap section below, it is significant.

**Environment:** `carpe-diem-rms-db-1` healthy on 5432; dev server via `tsx server.ts` on 3000; seed already applied (1 tenant, 4 zones, 13 tables, 3 staff, 0 sessions at start).

**Pre-flight — the index this story's concurrency AC depends on:**

```
idx_order_sessions_one_open_per_table
  CREATE UNIQUE INDEX ... ON public.order_sessions USING btree (table_id) WHERE (closed_at IS NULL)
```

Confirmed present before writing any code that relies on it.

**AC-1 / AC-6 — session created and attributed:**

```
POST /api/tables/b88ff58c.../sessions   → HTTP 201
{"sessionId":"adbd6065-...","tableId":"b88ff58c-...",
 "openedAt":"2026-09-06T04:58:23.025Z","status":"occupied"}
```

```
 label | opened_by |           opened_at           | closed_at | closed_by | covers | tenant | table_status
 B1    | Nina      | 2026-09-06 04:58:23.025582+00 |           |           |      1 | t      | occupied
```

`closed_at` and `closed_by_staff_id` both NULL, `cover_count` defaulted to 1, `tenant_id` populated from the table row, and `tables.status` moved to `occupied` inside the same transaction.

**AC-3 — 10 concurrent POSTs against one open table:**

```
201  409  409  409  409  409  409  409  409  409
open sessions for that table: 1
```

**The unique-violation error shape — this is the finding of the story.** Verified against the real driver by attempting a duplicate insert through Drizzle:

```
top-level code   : undefined
cause code       : 23505
constraint       : idx_order_sessions_one_open_per_table
isUniqueViolation: true
```

Drizzle **wraps** the driver error. `error.code` — the obvious implementation, and what the task text's first reading suggests — is `undefined`, so a top-level-only check would have fallen through to a 500 on every genuinely concurrent tap. The cause-chain walk in `isUniqueViolation()` is load-bearing, not defensive padding.

**Error paths:**

```
already occupied  → 409 TABLE_ALREADY_OCCUPIED
unavailable table → 422 TABLE_NOT_AVAILABLE
nonexistent UUID  → 404 TABLE_NOT_FOUND
malformed id      → 400 INVALID_TABLE_ID   (no PostgreSQL error in logs)
no session cookie → 401 UNAUTHENTICATED
```

**AC-7 (server half) — the first event ever to travel this path.** A real `socket.io-client` connected over websocket, then a session was opened from curl:

```
[client] connected vPfDwXcxIoElmsbiAAAB
[client] RECEIVED table:status_changed
{ "tableId": "40a00f7b-...", "status": "occupied",
  "sessionId": "ffb73946-...", "openedAt": "2026-09-06T04:59:51.633Z",
  "itemCount": 0 }
payload complete: YES      openedAt parses: true
```

Event name matched, all five required fields present, timestamp parseable. Story 3.2's emit/listen wiring is correct — it had simply never been exercised.

**Grid reflects derived occupancy:**

```
B1  occupied     session=yes  openedAt=2026-09-06T04:58:23.025Z  items=0
B2  occupied     session=yes  openedAt=2026-09-06T04:58:55.046Z  items=0
B3  occupied     session=yes  openedAt=2026-09-06T04:59:51.633Z  items=0
S2  unavailable  session=no   openedAt=null                      items=0
R3  unavailable  session=no   openedAt=null                      items=0
```

This is also the first execution of `/api/tables`' item-count branch, which had never run because `openSessionIds` was always empty. It returns 0 correctly for sessions with no events.

**AC-8 — order screen:**

```
GET /tables/{tableId}  (open session)  → 200, renders "B1", "Bean Bags", "Open for", "Covers", Epic 4 placeholder
GET /tables/{tableId}  (no session)    → 307 → http://localhost:3000/
```

**RBAC (Task 8, option b) — the point of the method-scoped policy:**

```
kitchen GET  /api/tables            → 200   (grid still works)
kitchen POST /api/tables/:id/sessions → 403 FORBIDDEN
owner   POST /api/tables/:id/sessions → 201
```

**RBAC regression — existing method-less policies unchanged:**

```
waiter  → /api/config  : 403   (policy denies, as before)
owner   → /api/config  : 404   (policy passes; route does not exist yet)
kitchen → /api/orders  : 403   (policy denies, as before)
waiter  → /api/orders  : 404   (policy passes; route does not exist yet)
```

The 404s are the proof the policy was evaluated and allowed — a 403 there would have meant the change broke something.

**Build and static checks:** `tsc --noEmit` clean; `eslint src` clean apart from the one pre-existing deferred warning in `src/server/socket/index.ts:5`; `next build` succeeds with both new routes registered as dynamic (`ƒ /api/tables/[tableId]/sessions`, `ƒ /tables/[tableId]`).

### Completion Notes List

**Task 8 decision — method-aware RBAC (option b).** `RoutePolicy` gained an optional `methods?: string[]`; omitting it means all methods, so every pre-existing policy keeps its exact prior meaning. `/api/tables` is now `owner + waiter` for `POST/PATCH/DELETE` only, leaving `GET` unrestricted so every role's landing screen still loads the grid. Method filtering happens **during** prefix matching, not after — filtering afterwards would let a method-mismatched longest prefix shadow a shorter policy that does apply, silently widening access. `isRoleAllowed` takes `method` as an optional third argument; `src/proxy.ts` is the only caller and now passes `request.method`.

Option (a) — a role check inside the Route Handler — was rejected because `permissions.ts` exists specifically to keep policy in one reviewable place, and scattering the first exception sets the precedent for all of Epics 4–10.

**The pre-check is a fast path, not the mechanism.** The handler does read for an existing open session before inserting, but only to produce a good error without a wasted write. Correctness comes from catching `23505`. Both paths return a byte-identical 409 body so a client cannot distinguish them — they are the same fact arriving by two routes.

**Emit is outside the transaction.** Building the payload inside and emitting after commit avoids a client receiving the event, refetching, and reading pre-commit state.

**Shared minute clock extracted.** `TableGrid` and the new `OrderScreen` both need a ticking elapsed time. Rather than a second `setInterval` and a second module-level snapshot cache, the store moved to `src/hooks/use-minute-tick.ts` (`useMinuteTick` + the pure `elapsedMinutesFrom`), and `TableGrid` now imports it. Behaviour is unchanged; there is simply one clock instead of two.

**Occupied cards are now tappable and walk into the existing session** rather than attempting a second one the database would reject. This is not in the ACs, but a grid where occupied tables do nothing on tap would be unusable the moment this story ships — AC-2 sends the waiter to the order screen, and they need a way back to it.

**No optimistic cache patch on tap.** A 409 would have to unwind it, and the socket event delivers true state within milliseconds of commit. The server wins.

**`useMutation`, not a bare fetch**, so `isPending` blocks a double-tap from firing a second POST that would 409 against the session the first just created.

**Structure divergence recorded:** `architecture.md:713` places the order screen at `(waiter)/tables/[tableId]/page.tsx`. No route groups exist yet, so it was built at the plain `tables/[tableId]` path. Whoever introduces `(waiter)`/`(owner)` moves this along with `page.tsx` and `login/`.

**NOT VERIFIED — read this before marking the story done.**

Task 9 is deliberately left unchecked. Everything server-side is verified above, but **no browser was used**, and five things live only on the client:

- **AC-7's client half.** The event provably leaves the server with the right payload, but that device B's card visibly flips to occupied within 2 seconds — and that **no `GET /api/tables` fires** while it does — is unobserved. That no-refetch claim is the whole point of Story 3.2's AC-4 and it has still never been watched.
- **AC-2's navigation and breadcrumb.** `router.push` and the `ContextHeader` crumb are unexercised.
- **AC-9 entirely.** The 409 notice, the grid self-correcting, and the absence of a full-screen error are all client-side. The server returns the right 409; what the UI does with it is untested.
- **The elapsed-time tick across a minute boundary.** SSR renders `—` by design (`getServerMinuteSnapshot` returns 0); the value fills in at hydration and advances on the store's 30s interval. Neither the hydration nor the tick was observed.
- **Reconnect resync.** The `useSocketEvent('connect')` invalidation added in 3.2's review is still unwatched.

The dev server was left running on `http://localhost:3000` so this pass can be done immediately. Sign in as Nina (PIN 1234) in two windows; open a table in one and watch the other.

**Test data left behind:** four open sessions (B1, B2, B3, S1) from verification. Useful for seeing occupied cards, but it is not seeded state. To clear:
`docker exec carpe-diem-rms-db-1 psql -U postgres -d cdrms -c "delete from order_sessions; update tables set status='open' where status='occupied';"`

**Still no test framework.** Everything above is manual, exactly as the story's Testing section directs. None of it is captured as a regression test, so the `23505` cause-chain finding — the subtlest thing in this story — is protected by nothing but the comment explaining it.

### File List

- NEW: `src/app/api/tables/[tableId]/sessions/route.ts` (open-session endpoint; transaction, 23505 catch, post-commit emit)
- NEW: `src/app/tables/[tableId]/page.tsx` (order screen route; redirects when no open session)
- NEW: `src/components/pos/order-screen.tsx` (session facts + Epic 4 placeholder)
- NEW: `src/hooks/use-minute-tick.ts` (shared minute clock, extracted from table-grid)
- UPDATE: `src/components/pos/table-grid.tsx` (open-session mutation, 409/422 notice, occupied-card navigation, uses shared clock)
- UPDATE: `src/server/auth/permissions.ts` (method-aware `RoutePolicy`; `/api/tables` write policy)
- UPDATE: `src/proxy.ts` (passes `request.method` to `isRoleAllowed`)

### Change Log

- 2026-09-06: Story implemented. `POST /api/tables/:tableId/sessions` creates the session and flips `tables.status` in one transaction, emitting `table:status_changed` after commit — the first real-time event this system has ever produced, verified received with a full five-field payload by a real socket client. Concurrency is enforced by the existing partial unique index, not application logic: 10 simultaneous requests produced exactly one session and nine 409s. Verifying the error shape against the driver revealed that Drizzle wraps the PostgreSQL error, so `23505` appears only on `cause` — a top-level-only check would have 500'd every concurrent tap. RBAC was made method-aware so kitchen staff keep the table grid but cannot open sessions, with existing policies confirmed unchanged. The minute clock was extracted to a shared hook rather than duplicated for the new order screen. Task 9 (browser verification of AC-7's client half, AC-2 navigation, AC-9 handling, the elapsed tick, and reconnect resync) is NOT done — no browser was available — and the story is deliberately left short of `review` because of it.

- 2026-09-06: Browser verification completed by Teran — the gap flagged in the completion notes is closed. Confirmed working as expected: AC-7's client half (card flips to occupied on the second device), AC-2's navigation and breadcrumb, AC-9's 409 handling, the elapsed-time tick, and reconnect resync. Verified by the user directly, not by the implementing agent. Task 9 checked and status moved to review.
- 2026-09-06: PIN length fixed at 4 (separate change, same day). PINPad auto-submits on the fourth digit and the Sign in button is gone; the login schema narrowed from `/^\d{4,6}$/` to `/^\d{4}$/`. Touches `pin-pad.tsx` and `api/auth/login/route.ts`, which are Story 2.1 and 2.2 files, not this story's — included in this working tree but reviewed against Story 2.1's amended ACs, not 3.3's.
- 2026-09-06: Code review completed — 1 decision resolved, 16 patches applied, 6 items deferred, 4 dismissed as verified-false. The significant finding was self-inflicted: the method-aware RBAC added by this story made 403 reachable on the open-session path, where the client treated it as an expired session and redirected to /login — so a kitchen user tapping any table was signed out, signed back in, and bounced again indefinitely. 403 now has its own error class and surfaces as a notice. Also fixed: a malformed table id crashed the order screen with a 500 instead of redirecting; the order screen had a dead "Switch user" control and no sign-out (the same defect this story's own grid comment claimed to have eliminated, reintroduced one file over — sign-out is now shared in src/lib/auth-client.ts); the in-flight guard was disarmed during router.push, allowing a second session on a table nobody was seated at; returning to the grid inside staleTime served a stale floor plan because the singleton socket never reconnects on remount; the exempt-method policy shape was inverted so unlisted verbs are governed rather than default-allow; the tables.status write now re-asserts "not unavailable" inside the transaction; unique-violation matching is keyed on the constraint name; and the notice carries a nonce so repeats get their own timer. Verified by runtime RBAC matrix across three roles and five methods — kitchen keeps GET /api/tables (200) and the grid, is refused PUT/PATCH (403) where every verb was previously unrestricted, is redirected away from /tables/* (307), and its session survives the 403 intact. The client-side half of the 403 fix (notice rather than redirect) is verified by code inspection only, not in a browser.
