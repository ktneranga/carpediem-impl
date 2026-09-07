# Story 3.6: Implement Close Table Without Payment

Status: in-progress

- **Epic:** 3 — Zone & Table Navigation
- **Story ID:** 3.6
- **Story Key:** 3-6-implement-close-table-without-payment
- **Created:** 2026-09-06
- **Origin:** `sprint-change-proposal-2026-09-06.md` — not in the original epic set

---

## ⚠️ READ FIRST

**Why this story exists.** Teran opened the running app and asked why a table showed occupied with no order placed. Chasing that surfaced a gap in the *plan*, not the code: a table could be occupied but never released. The only close in the entire epic set was a side effect of full payment (Story 6.5), gated on a settled bill — which a session with no items can never produce. Mis-taps, parties leaving before ordering, and walkouts all left a table permanently occupied. Story 3.3's own testing left nine tables stuck and needed raw SQL to clear.

**Three things that make this smaller than it looks:**

| # | Fact | Why it matters |
|---|---|---|
| 1 | **No migration needed.** `SESSION_OPENED` and `SESSION_CLOSED` already exist in `orderEventTypeEnum`, distinct from `SESSION_SETTLED`. `order_sessions` already has `closed_at` and `closed_by_staff_id`. | The data model anticipated a close that is not a settlement. Do not add columns or enum values. |
| 2 | **RBAC already covers you.** `permissions.ts` has `{ prefix: '/api/tables', roles: ['owner','waiter'], exemptMethods: ['GET','HEAD'] }`. Your `POST /api/tables/:tableId/sessions/close` sits under that prefix. | AC-7 is satisfied by existing policy. **Verify it; do not add a new one.** |
| 3 | **Story 3.3 is your template.** Route shape, transaction, post-commit emit, error envelope, 409 handling — all solved one file over. | Reuse the patterns rather than inventing. |

**A naming trap that will bite you.** `src/server/services/session.service.ts` already exists and it is **staff auth sessions**, nothing to do with table sessions. Do NOT add table-session logic there and do NOT create a second `session.service.ts`. Name yours **`table-session.service.ts`**.

---

## Story

As a waiter,
I want to release a table that was opened by mistake or whose party left without ordering or paying,
So that the floor plan stays true and a wrong tap is not permanent.

---

## Acceptance Criteria

**AC-1: Close an empty session**
**Given** a waiter is on the order screen for an open session with no submitted items
**When** they tap "Close table" and choose the reason `abandoned`
**Then** `POST /api/tables/:tableId/sessions/close` is called with `{ reason: "abandoned" }`; the `order_sessions` row has `closed_at` and `closed_by_staff_id` set; `tables.status` returns to `open`; a `table:status_changed` event is emitted and every connected device updates within 2 seconds

**AC-2: `abandoned` is refused when items exist**
**Given** the session being closed has submitted items
**When** the waiter chooses the reason `abandoned`
**Then** HTTP 409 is returned with `{ success: false, error: { code: "SESSION_HAS_ITEMS" } }` — a session with orders in it is a walkout or a bill, never an abandonment

**AC-3: Walkout requires explicit confirmation**
**Given** a waiter closes a session with submitted items as `walkout`
**When** the close is submitted
**Then** an explicit confirmation is required before the request is sent, stating the unpaid total; the session closes; the unpaid amount is recorded so it is not silently lost from revenue

**AC-4: Every close writes an audit event**
**Given** any session is closed without payment
**When** the close transaction commits
**Then** an append-only `order_events` row is written with `event_type: 'SESSION_CLOSED'`, the acting `staff_id`, and `notes` carrying the reason; this happens in the same transaction as the close, so a closed session always has its audit record

**AC-5: Every open writes an audit event** *(retrofit to Story 3.3)*
**Given** a session is opened
**When** the `order_sessions` row is created
**Then** an append-only `order_events` row is written with `event_type: 'SESSION_OPENED'` and the acting `staff_id`, in the same transaction — closing the existing gap where sessions are created with no audit event at all despite the enum value existing

**AC-6: Concurrent closes produce one winner**
**Given** two devices attempt to close the same session simultaneously
**When** both requests arrive concurrently
**Then** exactly one succeeds; the second receives HTTP 409 with `{ code: "SESSION_ALREADY_CLOSED" }`; the close is conditional on `closed_at IS NULL` within the transaction, so the database decides the winner rather than application logic

**AC-7: Kitchen staff cannot close**
**Given** a kitchen staff member attempts to close a session
**When** `POST /api/tables/:tableId/sessions/close` is called
**Then** HTTP 403 is returned — already enforced by the method-scoped `/api/tables` policy

**AC-8: The grid is correct immediately after closing** *(added beyond the epic)*
**Given** a waiter closes a table from the order screen
**When** the close succeeds
**Then** they are returned to the grid and the card shows `open` — without a manual refresh, and without relying on the socket event having arrived first

---

## Tasks / Subtasks

- [x] **Task 1 — Extract a shared table-session service** (AC: 1, 4, 5)
  - New file: `src/server/services/table-session.service.ts`. **Not** `session.service.ts` — that name is taken by staff auth sessions and confusing the two would be a genuine mess.
  - Two exported functions, both taking a Drizzle transaction handle so callers control the boundary:
    - `openSession(tx, { tableId, tenantId, staffId })` — inserts the session, sets `tables.status = 'occupied'`, writes the `SESSION_OPENED` audit event.
    - `closeSession(tx, { sessionId, staffId, reason })` — sets `closed_at`/`closed_by_staff_id`, returns `tables.status` to `open`, writes the `SESSION_CLOSED` audit event.
  - `reason` is a union: `'abandoned' | 'walkout' | 'settled'`. Export the type. Story 6.5 will call `closeSession` with `'settled'`, so do not hard-code an unpaid assumption anywhere inside the service.
  - Both functions must be callable inside an existing transaction. Do **not** open their own — the caller composes.

- [x] **Task 2 — Retrofit Story 3.3's open path to use the service** (AC: 5)
  - `src/app/api/tables/[tableId]/sessions/route.ts` currently inlines the insert and the status update. Move that into `openSession()` and have the route call it.
  - **Everything that route already does must keep working**: the 23505 catch keyed on `idx_order_sessions_one_open_per_table`, the `ne(tables.status, 'unavailable')` re-assertion inside the transaction with its row-count check, the post-commit emit, and every status code in its table. That route survived a full adversarial review — you are refactoring it, not redesigning it.
  - Re-run its verification afterwards (the manual matrix in Story 3.3's Testing section). A refactor that quietly drops the unavailable re-assertion would be invisible until service.

- [x] **Task 3 — `POST /api/tables/[tableId]/sessions/close`** (AC: 1, 2, 6, 7)
  - New file: `src/app/api/tables/[tableId]/sessions/close/route.ts`.
  - Same shape as the open route: async `params`, zod-validate `tableId` as a UUID → 400 `INVALID_TABLE_ID`, `x-staff-id` header → 401 if absent.
  - Body: `{ reason: 'abandoned' | 'walkout' }` validated with zod → 400 `INVALID_BODY` otherwise. **`settled` must be rejected from the HTTP surface** — it is for Story 6.5's internal call only, and accepting it here would let a client close a table as settled with no payment.
  - Load the open session for the table (`closed_at IS NULL`). None → 409 `SESSION_ALREADY_CLOSED`. (Not 404: the table exists, the session does not.)
  - Count submitted items for the session. `reason === 'abandoned'` with a non-zero count → 409 `SESSION_HAS_ITEMS`.
  - Emit `table:status_changed` **after** the transaction commits, with `{ tableId, status: 'open', sessionId: null, openedAt: null, itemCount: 0 }`.
  - Success: **200**, not 201 — this closes a resource, it does not create one. Body `{ success: true, data: { sessionId, tableId, closedAt, reason } }`.

- [x] **Task 4 — Let the database decide the concurrency winner** (AC: 6)
  - The partial unique index does **not** help here — it constrains open sessions, not closes. Your guard is the UPDATE predicate.
  - `UPDATE order_sessions SET closed_at = now(), closed_by_staff_id = ? WHERE id = ? AND closed_at IS NULL`, then check the returned row count. Zero rows means someone else closed it first → 409 `SESSION_ALREADY_CLOSED`.
  - Same principle as Story 3.3: the pre-check read is a fast path for a good message; **the conditional UPDATE is the correctness mechanism.** Do not rely on the read.

- [x] **Task 5 — Close control on the order screen** (AC: 1, 3, 8)
  - `src/components/pos/order-screen.tsx` — currently header + session facts + an Epic 4 placeholder. Add a "Close table" action.
  - `useMutation`, guard with `isPending`, and carry the same navigation guard lesson from Story 3.3: `isPending` clears before `router.push` finishes, so hold an `isNavigating` flag too.
  - On success: `queryClient.invalidateQueries({ queryKey: ['tables'] })` then `router.push('/')`. **Both.** `TableGrid` has `refetchOnMount: 'always'`, which covers it — but invalidating explicitly means AC-8 does not depend on that setting staying in place.
  - Reason selection: `abandoned` is the default and needs no ceremony. `walkout` requires a confirmation step stating the unpaid total before the request is sent.
  - Handle 403 with its own error class and a notice — **never a redirect to `/login`**. Conflating 403 with session expiry is exactly what produced the sign-out loop in Story 3.3's review. Reuse the `ForbiddenError` pattern from `table-grid.tsx`.

- [x] **Task 6 — Reason copy and audit legibility** (AC: 4)
  - `notes` on the audit row should be machine-readable first: store the bare reason string, not a sentence. Epic 7's audit view and Epic 9's dashboard will filter on it.
  - Owner-facing wording is not this story's job, but do not make it impossible: a bare `'walkout'` is filterable, `'Closed by Nina because the party left'` is not.

- [ ] **Task 7 — Verify** (AC: all)
  - Still no test framework. Manual, as every prior story. Be explicit in your completion notes about what you *observed* versus *reasoned* — Story 3.2 shipped unverified real-time claims and the gap between those two is where its real bugs lived.
  - Minimum matrix in Dev Notes below.

---

## Dev Notes

### The lifecycle you are completing

```
tap open card ──► POST /sessions        ──► order_sessions row, tables.status='occupied'
                                            + SESSION_OPENED audit  (AC-5, new)
                                            + table:status_changed

                  POST /sessions/close  ──► closed_at, closed_by_staff_id
                    reason: abandoned        tables.status='open'
                          | walkout          + SESSION_CLOSED audit  (AC-4)
                                            + table:status_changed

Epic 6, Story 6.5 ──► closeSession(tx, { reason: 'settled' })   ← same service, same records
```

The whole point of the shared service is that the last line produces records identical to the middle one apart from the reason. Two implementations would drift, and the audit trail is the one place in this product where drift is unacceptable.

### Schema — everything you need already exists

```ts
orderEventTypeEnum = ['SESSION_OPENED', 'SESSION_CLOSED', 'ITEM_ADDED', ...,
                      'ITEM_COMPED', 'ITEM_VOIDED', 'PAYMENT_REQUESTED', 'SESSION_SETTLED']

orderSessions = { id, tenantId, tableId, openedByStaffId, closedByStaffId,
                  openedAt, closedAt, coverCount }

orderEvents   = { id, sessionId /* notNull */, staffId /* notNull */,
                  menuItemId /* nullable — leave null for session events */,
                  eventType, seatSlot, quantity /* default 1 */,
                  unitPricePaysa, notes /* text — the reason */, createdAt }
```

**`order_events` is append-only.** `0001_append_only_rules.sql` installs a BEFORE UPDATE OR DELETE trigger on it (also on `payment_records`, `comp_records`, `dispute_records`). INSERT is fine; never try to correct an audit row, insert a compensating one.

`order_sessions` has **no** such trigger, which is what makes the close UPDATE legal.

### What counts as "has items"

Count `order_events` rows for the session with `eventType = 'ITEM_ADDED'`. Do not subtract `ITEM_REMOVED` — removal does not exist until Epic 4, and `/api/tables` already documents the same simplification. Match it rather than inventing a second rule.

**Be honest about what this means today:** no item can exist until Epic 4 ships, so the count is always zero. **AC-2's 409 branch and AC-3's walkout confirmation cannot be exercised in this story.** Write them, note in your completion notes that they are unverified, and say plainly that the first real test is Epic 4. This is the same trap Story 3.2 hit by shipping real-time that had never fired — the difference is that you know in advance.

### Files being modified — current state

**`src/app/api/tables/[tableId]/sessions/route.ts`** — Story 3.3's open endpoint, post-review. It holds: async params + zod UUID guard; `x-staff-id` → 401; table load with `unavailable` → 422; a fast-path occupied read → 409; a transaction inserting the session and updating `tables.status` with `ne(tables.status,'unavailable')` and a row-count check that throws `TableWentUnavailableError`; a `23505` catch keyed on the constraint **name**; and a post-commit `emitTableStatusChanged`. Task 2 moves the transaction body into the service and leaves everything else intact.

**`src/components/pos/order-screen.tsx`** — client component: `ContextHeader` (with `onStaffTap={signOut}`), a facts panel (zone, elapsed via `useMinuteTick`, covers), and an Epic 4 placeholder section. Task 5 adds the close action.

**`src/server/auth/permissions.ts`** — **read it, do not change it.** Confirm `/api/tables` + `exemptMethods: ['GET','HEAD']` already governs your route.

### What exists — reuse, do not rebuild

| Asset | Location | Note |
|---|---|---|
| `emitTableStatusChanged()` | `src/server/socket/events.ts` | Correct and typed. Has its own try/catch — it cannot throw. |
| Error envelope + `fail()` helper | `src/app/api/tables/[tableId]/sessions/route.ts` | Copy the shape exactly. |
| `db.transaction()` | same file, and `seed.ts` | Established pattern. |
| `ForbiddenError` / notice pattern | `src/components/pos/table-grid.tsx` | 403 must never redirect to `/login`. |
| `signOut()` | `src/lib/auth-client.ts` | Already wired into the order screen header. |
| RBAC policy | `src/server/auth/permissions.ts` | Already covers this route. |

### Testing

| Case | Expect |
|---|---|
| Close an empty session as `abandoned` | 200, `closed_at` set, table back to `open` |
| Close again immediately | 409 `SESSION_ALREADY_CLOSED` |
| Two concurrent closes (curl `&` both) | exactly one 200, one 409, one `closed_at` |
| `reason: 'settled'` over HTTP | 400 — rejected at the API surface |
| Malformed body / missing reason | 400 `INVALID_BODY` |
| Malformed `tableId` | 400 `INVALID_TABLE_ID` |
| Kitchen user (PIN 4321) | 403, session still valid afterwards |
| Waiter (1234) and owner (5678) | 200 |
| Audit rows | one `SESSION_OPENED` per open, one `SESSION_CLOSED` per close, reason in `notes` |
| Browser: close from order screen | returns to grid, card is `open`, no manual refresh |
| Second device watching | card flips to `open` within 2s |
| `reason: 'abandoned'` with items | **cannot be tested — no items exist until Epic 4** |

Verify audit rows directly:
`psql -c "select event_type, notes, created_at from order_events order by created_at;"`

Re-run Story 3.3's open matrix after Task 2's refactor — a dropped `unavailable` re-assertion would otherwise go unnoticed.

### Previous story intelligence (Story 3.3 + its review)

- **The database decides races, not application logic.** 3.3's open path catches `23505`; your close path uses a conditional UPDATE and a row count. Same principle, different mechanism — the unique index does not cover closes.
- **Drizzle wraps driver errors.** `error.code` is `undefined`; `23505` lives on `cause`. 3.3's `isOpenSessionConflict` walks the chain and matches the constraint name. If you need error inspection, copy it.
- **403 is not 401.** Conflating them produced a sign-out loop for kitchen users that survived a browser pass because the tester was a waiter. Give 403 its own class and a notice.
- **`isPending` clears before navigation completes.** 3.3 could open a second session during the `router.push` round trip. Hold `isNavigating` too.
- **Emit after commit, never inside.** A client can otherwise refetch and read pre-commit state.
- **`tsc` and `eslint` being clean means very little.** 3.2 passed both while silently deleting its entire font scale. Verify behaviour.
- **A repeated identical `setNotice` string is a React bail-out** — pair notices with a nonce if you add any.

### Project Structure Notes

- NEW: `src/server/services/table-session.service.ts`, `src/app/api/tables/[tableId]/sessions/close/route.ts`
- UPDATE: `src/app/api/tables/[tableId]/sessions/route.ts`, `src/components/pos/order-screen.tsx`
- UNCHANGED, verify only: `src/server/auth/permissions.ts`
- No migration. No schema edit. No new dependency.
- `architecture.md:442` anticipates `server/services/order.service.ts` for Epic 4's order logic. `table-session.service.ts` is a sibling, not a substitute — do not merge them.

### References

- [Source: epics.md#Story-3.6] — ACs, added 2026-09-06
- [Source: sprint-change-proposal-2026-09-06.md] — why this story exists, and the Story 6.5 amendment that depends on it
- [Source: prd.md#FR61] — the requirement this satisfies
- [Source: epics.md#Story-6.5] — amended to call this story's service with reason `settled`
- [Source: architecture.md:372-386] — Socket.io event names
- [Source: schema.ts:18-30, 147-183] — the enum and tables you are writing
- [Source: migrations/0001_append_only_rules.sql] — append-only triggers
- [Source: 3-3-implement-open-table-session.md#Review-Findings] — 16 patches whose lessons apply directly

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

Verified with curl, psql and `next build`. No browser — see the gap at the end.

**Regression first.** Task 2 refactored Story 3.3's open route, which had just come through a full adversarial review, so its matrix was re-run before anything else:

```
POST /sessions (open table)        → 201
POST /sessions (same table again)  → 409 TABLE_ALREADY_OCCUPIED
POST /sessions (unavailable table) → 422 TABLE_NOT_AVAILABLE
```

The `ne(tables.status,'unavailable')` re-assertion, its row-count check, the `23505` catch keyed on the constraint name, and the post-commit emit all moved into the service intact.

**AC-5 — the audit gap closed.** A `SESSION_OPENED` row now exists for the first time in this project; before this story, sessions were created with no audit event at all despite the enum value having been there since Story 1.3.

**AC-1 / AC-6 — close and idempotency:**

```
POST /sessions/close {"reason":"abandoned"} → 200, closedAt returned, table → open
POST /sessions/close (again)                → 409 SESSION_ALREADY_CLOSED
POST /sessions/close {"reason":"settled"}   → 400 INVALID_BODY   ← rejected at the HTTP surface
```

**AC-6 — 8 concurrent closes against one open session:**

```
200  409  409  409  409  409  409  409
closed rows: 1     still open: 0
```

Exactly one winner, decided by the `WHERE closed_at IS NULL` predicate and its row count — not by the pre-check read.

**AC-7 — RBAC (no policy change was needed; `/api/tables` already governs this route):**

```
kitchen POST /sessions/close → 403 FORBIDDEN
kitchen GET  /api/tables     → 200   ← session survives the 403 intact
owner   POST /sessions/close → 200
waiter  POST /sessions/close → 200
bad uuid                     → 400 INVALID_TABLE_ID
{"reason":"nonsense"}        → 400 INVALID_BODY
```

**AC-4 — the audit trail, which is the point of the story:**

```
 event_type     | reason    | staff | tbl
 SESSION_OPENED | —         | Nina  | R1
 SESSION_CLOSED | abandoned | Nina  | R1
 SESSION_OPENED | —         | Nina  | R2
 SESSION_CLOSED | abandoned | Nina  | R2
 SESSION_OPENED | —         | Nina  | B1
 SESSION_CLOSED | walkout   | Aruna | B1     ← opened by one, closed by another
```

Every open paired with a close, reason recorded, attribution correct where it differs. Append-only enforcement confirmed by attempting to tamper:

```
UPDATE order_events SET notes='tampered' ...
ERROR: [immutable-table] UPDATE on order_events is not permitted.
```

**Floor state after verification:** 11 open, 2 unavailable, **0 open sessions**. Story 3.3's testing left nine tables stuck and needed raw SQL to clear; this story's testing cleaned up after itself using the feature it added.

**Static checks:** `tsc --noEmit` clean; `eslint src` clean apart from the pre-existing warning in `src/server/socket/index.ts:5`; `next build` succeeds with `ƒ /api/tables/[tableId]/sessions/close` registered.

### Completion Notes List

**The service takes a transaction handle rather than opening its own.** Story 6.5 must close a session in the same transaction as the final payment write; a service that opened its own transaction could not participate. Both `openSession` and `closeSession` therefore compose into a caller's transaction, and the route keeps the policy (which tables may be opened or closed, what each failure returns) while the service keeps the writes.

**Named `table-session.service.ts`, deliberately not `session.service.ts`** — that name is already taken by staff auth sessions, and merging the two concepts would be a genuine mess.

**Concurrency uses a different mechanism from the open path, and this matters.** The partial unique index enforces one-open-session-per-table, so it makes a duplicate *open* impossible — but it says nothing about closes. The close guard is `UPDATE ... WHERE closed_at IS NULL` plus the returned row count. Same principle as Story 3.3 (the database decides), different instrument. The pre-check read exists only for a good error message.

**`settled` is excluded from the HTTP schema, not just undocumented.** `CLIENT_CLOSE_REASONS` is `['abandoned','walkout']` while the service's `SessionCloseReason` also accepts `'settled'` for Story 6.5's internal call. Accepting `settled` over HTTP would let any client mark a table paid with no payment record behind it.

**Closing only returns an `occupied` table to `open`.** The UPDATE is `WHERE status = 'occupied'`, so a table taken out of service while occupied stays `unavailable` after the party leaves. `unavailable` is a property of the table, not of the seating.

**A 409 on close navigates rather than errors.** If another device closed it first, the table is released either way — the waiter should land on a grid reflecting reality, not an error telling them about a state that no longer exists.

**403 gets its own error class on this screen too.** Story 3.3's review found that conflating 403 with session expiry produced an infinite sign-out loop for kitchen users. The same shape existed here waiting to be written; it was not.

**`isNavigating` alongside `isPending`.** `isPending` clears the instant `onSuccess` runs, leaving the screen interactive for the whole `router.push` round trip — the same window that let Story 3.3 open a second session on an unseated table.

**Invalidate AND navigate.** `TableGrid` already has `refetchOnMount: 'always'`, which would cover AC-8 on its own, but relying on that makes this screen's correctness depend on a setting configured in a different file. The explicit invalidation makes it local.

**NOT VERIFIED — the browser half.**

Task 7 is deliberately left unchecked. Everything server-side is verified above, but no browser was used, and these live only on the client:

- The "Close table" button and the navigation back to a corrected grid (AC-1's UI half, AC-8 entirely)
- The walkout confirmation dialog (AC-3) — and note it is **doubly unverifiable**: no item can exist until Epic 4, so `itemCount` is always 0, `isWalkout` is always false, and the confirmation branch cannot be reached at all through the UI today. The `walkout` reason itself was verified over curl.
- AC-2's `SESSION_HAS_ITEMS` 409 — same cause. The branch is written and unreachable until Epic 4 creates items.
- The 403 notice on the close screen (the server returns the right 403; what the UI does with it is untested)

This was flagged in the story before implementation rather than discovered after, which is the improvement over Story 3.2. The first genuine test of AC-2 and AC-3 is Epic 4.

The dev server was left running on `http://localhost:3000` for that pass: sign in as Nina (1234), tap a table, then use "Close table" on the order screen.

**Still no test framework**, so none of this is captured as a regression test — including the concurrency behaviour, which is the subtlest part.

### File List

- NEW: `src/server/services/table-session.service.ts` (shared open/close writes, audit events, close-reason types)
- NEW: `src/app/api/tables/[tableId]/sessions/close/route.ts` (close endpoint; reason validation, has-items guard, conditional close)
- UPDATE: `src/app/api/tables/[tableId]/sessions/route.ts` (open path delegates to the service; error class now imported)
- UPDATE: `src/app/tables/[tableId]/page.tsx` (passes `tableId` and `itemCount` to the screen)
- UPDATE: `src/components/pos/order-screen.tsx` (close control, walkout confirmation, 403/409 handling, notice)

### Change Log

- 2026-09-06: Story implemented. A table can now be released without payment — the gap that made a mis-tap permanent and left walkouts unrepresentable. Open and close writes were extracted into `table-session.service.ts` so Story 6.5's settled close will share one implementation and produce identical records; Story 3.3's open route was refactored onto it and its full matrix re-run to confirm nothing regressed. Closing uses a conditional `WHERE closed_at IS NULL` UPDATE with a row-count check — the partial unique index constrains opens, not closes — verified with 8 concurrent requests producing exactly one winner. Every open and close now writes an append-only audit row, closing a pre-existing gap where `SESSION_OPENED` was defined in the enum but never written by anything. `settled` is rejected at the HTTP surface so no client can close a table as paid without a payment record. Task 7 (browser verification) is NOT done and the story is deliberately left short of `review`; AC-2 and AC-3 additionally cannot be exercised until Epic 4 creates items, which was flagged in the story before implementation.
