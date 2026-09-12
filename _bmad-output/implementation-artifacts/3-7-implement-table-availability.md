# Story 3.7: Implement Table Availability (Out of Service / Return to Service)

Status: review

- **Epic:** 3 — Zone & Table Navigation
- **Story ID:** 3.7
- **Story Key:** 3-7-implement-table-availability
- **Created:** 2026-09-07
- **Origin:** `sprint-change-proposal-2026-09-06-merge-and-availability.md` — not in the original epic set

---

## ⚠️ READ FIRST

**Why this story exists.** `tables.status` has an `unavailable` value that only the seed ever set. No route could change it, so a waiter finding a torn sun-bed cover could not stop guests being seated there, and nobody could put it back.

**The proposal said this story had one additive column and no migration. That was wrong, and here is why.**

### Finding 1 — there is nowhere to write the audit event

Every audit table in the schema requires a session:

```ts
orderEvents.sessionId    → notNull references orderSessions.id
paymentRecords.sessionId → notNull references orderSessions.id
compRecords.sessionId    → notNull references orderSessions.id
disputeRecords.sessionId → notNull references orderSessions.id
```

**A table taken out of service has no session** — that is the precondition. So the audit AC cannot be satisfied by any existing table, and making `order_events.session_id` nullable would weaken a core invariant for every other event type to accommodate one that is not an order event at all.

**This story therefore adds a table**, `table_status_events`, plus its append-only trigger. Larger than the proposal estimated, still additive, and the alternative is an availability change nobody can attribute — in a product whose stated core differentiator is the audit trail.

### Finding 2 — the action strip does not exist, and the grid taps the wrong way

Story 3.7's AC talks about "the action strip". There isn't one. The floor screen today is `ContextHeader` + `ZoneChipBar` + card grid, and **tapping an open card opens a session immediately** (Story 3.3, AC-1).

Teran's mockups show a different model: tap **selects**, a bottom strip shows the selected table's state, and an explicit button acts —

```
SELECTED  BB1 · no open order        [Counter sale] [Start order]
SELECTED  BB2 · 3 items              [Counter sale] [Merge] [Bill] [Add items]
SELECTED  BB4 · out of service       [Counter sale] [Return to service]
```

This story adopts that model, for three reasons:

1. **Availability has no other entry point.** An unavailable card is inert by design (Story 3.2's review made `TableCard` refuse clicks on `unavailable`). Without a strip there is nowhere to put "Return to service".
2. **Story 3.8 needs it too** — merge mode is specified as a strip mode.
3. **It answers the original complaint.** Teran's question that started all of this was *"how could it be occupied without placing the order? doesn't it need a confirmation?"* Tap-to-select-then-"Start order" **is** that confirmation, arrived at through the design rather than bolted on as a dialog.

**This changes shipped, reviewed behaviour in Story 3.3.** Do not treat it as incidental: 3.3's AC-1 ("a waiter taps an open table card → the session is created") becomes "a waiter taps a card → it is selected; tapping **Start order** creates the session". Amend 3.3's AC-1 as part of this story and note it in the change log.

---

## Story

As a waiter,
I want to take a broken or unusable table out of service immediately,
So that guests are not seated at it while I find someone to fix it.

As an owner,
I want to be the only person who can return a table to service,
So that a table is not made bookable again before the problem is actually resolved.

---

## Acceptance Criteria

**AC-1: Take a table out of service**
**Given** a waiter or owner has selected a table with no open session
**When** `POST /api/tables/:tableId/out-of-service` is called with `{ reason: string }`
**Then** `tables.status` becomes `unavailable`; the reason is stored on the table; a `table:status_changed` event is emitted and every device updates within 2 seconds; HTTP 200 is returned

**AC-2: A table with guests cannot vanish**
**Given** a table has an open session
**When** taking it out of service is attempted
**Then** HTTP 409 is returned with `{ success: false, error: { code: "TABLE_HAS_OPEN_SESSION" } }` — close or settle first

**AC-3: Only an owner returns a table to service**
**Given** an owner has selected an out-of-service table
**When** `POST /api/config/tables/:tableId/return-to-service` is called
**Then** `tables.status` returns to `open`; the stored reason is cleared; a `table:status_changed` event is emitted; HTTP 200 is returned

**AC-4: Waiters and kitchen are refused**
**Given** a waiter or kitchen staff member attempts to return a table to service
**When** `POST /api/config/tables/:tableId/return-to-service` is called
**Then** HTTP 403 is returned, enforced by the existing `{ prefix: '/api/config', roles: ['owner'] }` policy — no new policy is added

**AC-5: Reason is required and meaningful**
**Given** a request to take a table out of service
**When** the body carries no reason, an empty string, or whitespace only
**Then** HTTP 400 is returned with `{ code: "INVALID_BODY" }` — an unattributed "not in service" is what this story exists to prevent

**AC-6: Every change is auditable**
**Given** any availability change in either direction
**When** the transaction commits
**Then** an append-only `table_status_events` row records the tenant, table, acting staff member, `from_status`, `to_status`, the reason, and a timestamp — written in the same transaction, so a changed table always has its record

**AC-7: The floor screen has a state-driven action strip**
**Given** a waiter selects any table card
**When** the strip renders
**Then** it shows the table label, its state summary, and the actions valid for that state; tapping a card **selects** it rather than acting on it

**AC-8: The strip is role-aware**
**Given** a waiter selects an out-of-service table
**When** the strip renders
**Then** it shows the state and the stored reason with **no** return-to-service control; an owner in the same position sees the control. Hiding it is courtesy — AC-4 is the enforcement

**AC-9: Opening a table now takes two taps** *(amends Story 3.3 AC-1)*
**Given** a waiter selects an open table
**When** they tap "Start order"
**Then** the session is created exactly as Story 3.3 specifies and they are navigated to the order screen; **tapping the card alone no longer creates a session**

---

## Tasks / Subtasks

- [x] **Task 1 — Schema: reason column and audit table** (AC: 1, 6)
  - `tables` gains `unavailableReason: text('unavailable_reason')`, nullable.
  - New table:
    ```ts
    export const tableStatusEvents = pgTable('table_status_events', {
      id:         uuid('id').primaryKey().defaultRandom(),
      tenantId:   uuid('tenant_id').notNull().references(() => tenants.id),
      tableId:    uuid('table_id').notNull().references(() => tables.id),
      staffId:    uuid('staff_id').notNull().references(() => staff.id),
      fromStatus: tableStatusEnum('from_status').notNull(),
      toStatus:   tableStatusEnum('to_status').notNull(),
      reason:     text('reason'),
      createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    }, (t) => [
      index('idx_table_status_events_table_id').on(t.tableId),
      index('idx_table_status_events_created_at').on(t.createdAt),
    ])
    ```
  - `pnpm db:generate` for the structural migration, then a **hand-written** migration adding the append-only trigger. The function already exists — `0001_append_only_rules.sql` defines `prevent_immutable_table_mutation()` — so the new file only adds a trigger that calls it:
    ```sql
    CREATE TRIGGER table_status_events_immutable
      BEFORE UPDATE OR DELETE ON table_status_events
      FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
    ```
  - Run `pnpm db:migrate` and verify with a tampering attempt — an `UPDATE` must raise `[immutable-table]`.

- [x] **Task 2 — Extend the table-session service** (AC: 1, 3, 6)
  - `src/server/services/table-session.service.ts` already owns table-state writes and the audit-in-the-same-transaction pattern. Add there; do not start a third service.
  - `setTableAvailability(tx, { tableId, tenantId, staffId, toStatus, reason })` — updates `tables.status` and `unavailable_reason`, writes the `table_status_events` row, returns the previous status for the event payload.
  - Takes a transaction handle like its neighbours. The caller composes.
  - Guard inside: the transition must be `open → unavailable` or `unavailable → open`. An `occupied` table is AC-2's 409 and must never reach here.

- [x] **Task 3 — `POST /api/tables/[tableId]/out-of-service`** (AC: 1, 2, 5)
  - New file: `src/app/api/tables/[tableId]/out-of-service/route.ts`.
  - Shape copies the close route exactly: async `params`, zod UUID → 400 `INVALID_TABLE_ID`, `x-staff-id` → 401, JSON body → 400 `INVALID_BODY`.
  - Reason schema: `z.string().trim().min(1).max(200)` — AC-5. Trim **before** the length check or `"   "` passes.
  - Open session present → 409 `TABLE_HAS_OPEN_SESSION`. Already `unavailable` → 409 `TABLE_NOT_AVAILABLE` (idempotent-ish; do not silently succeed).
  - Emit **after** commit: `{ tableId, status: 'unavailable', sessionId: null, openedAt: null, itemCount: 0 }`.
  - 200, not 201 — nothing is created from the caller's point of view.

- [x] **Task 4 — `POST /api/config/tables/[tableId]/return-to-service`** (AC: 3, 4)
  - New file: `src/app/api/config/tables/[tableId]/return-to-service/route.ts`. **This is the first route under `/api/config`** — the directory does not exist yet.
  - No body. Clears `unavailable_reason`, sets status `open`, writes the audit row, emits after commit.
  - Not currently `unavailable` → 409 `TABLE_NOT_UNAVAILABLE`.
  - **Verify AC-4 rather than implementing it.** `{ prefix: '/api/config', roles: ['owner'] }` already exists in `permissions.ts` and the proxy already enforces it. Adding a policy here would be duplicate and risks widening. Confirm with a waiter session that the 403 fires.

- [x] **Task 5 — Floor action strip** (AC: 7, 8, 9)
  - New file: `src/components/pos/floor-action-strip.tsx`.
  - Props: the selected table row (or null), the viewer's role, and callbacks. Renders label, a state summary, and role-filtered actions.
  - States for this story — Epic 4 and Story 3.8 add the rest:
    | Table state | Waiter sees | Owner sees |
    |---|---|---|
    | none selected | prompt to select a table | same |
    | `open` | `Start order`, `Take out of service` | same |
    | `occupied` | `Add items` (navigates to the order screen) | same |
    | `unavailable` | reason text, no action | reason text, `Return to service` |
  - Taking out of service needs the reason. Keep it light — a small prompt with a few common reasons (`Broken`, `Cover torn`, `Cleaning`, `Reserved`) plus free text. Do not build a modal system; a section that replaces the strip contents is enough, matching the walkout confirmation already in `order-screen.tsx`.
  - **Role comes from the server.** `layout.tsx` reads `x-staff-role` and sets `data-context` on `<html>`; pass the role down from `page.tsx` as a prop rather than sniffing the DOM attribute.

- [x] **Task 6 — Rewire the grid to select-then-act** (AC: 7, 9)
  - `src/components/pos/table-grid.tsx` — **read it fully first.** It carries three stories plus 16 review patches: socket patching, reconnect resync, degraded banner, session-expiry redirect, sign-out, the open mutation with its `ForbiddenError`/`TableTakenError` handling, and the `isNavigating` guard.
  - `onSelect` becomes selection only. Move `openTable.mutate(...)` behind the strip's "Start order", and occupied-card navigation behind "Add items".
  - **Everything else stays.** The mutation, its error classes, the notice nonce, the navigation guard, `refetchOnMount: 'always'` — all still needed, just triggered from the strip instead of the card.
  - An `unavailable` card must become **selectable** while staying non-actionable. `TableCard` currently sets `onClick={undefined}` and `aria-disabled` for `unavailable` — that has to relax to "selectable, not operable", or the strip can never show a table to return to service. This is the one place where a Story 3.2 review patch is deliberately revised; say so in the completion notes.

- [x] **Task 7 — Amend Story 3.3's AC-1 in epics.md** (AC: 9)
  - Only the AC text, with a dated note pointing at this story. Do not touch the rest of 3.3.

- [x] **Task 8 — Verify** (AC: all)
  - No test framework; manual, as every prior story. Matrix in Dev Notes. Be explicit about observed versus reasoned.

---


### Review Findings

Code review 2026-09-09 — three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor) plus verification. Run **before** the browser pass, which turned out to be the right order: several findings below are things a single-user browser check would not have caught, and two of them are things it would.

Baseline: `tsc --noEmit` clean, `eslint src` clean, `next build` clean. Every finding is semantic.

**AC verdict:** AC-1 to AC-7 and AC-9 verified in code. **AC-8 is violated** — the strip shows the wrong reason on any device that did not initiate the change, and role-awareness covers owner-vs-rest but not kitchen.

**All eight of the story's own constraint checks passed**, including the one that mattered most: `permissions.ts` is genuinely untouched, and the proxy does apply `{ prefix: '/api/config', roles: ['owner'] }` to the new route. The namespace-carries-permission argument holds. Task 6's "lose nothing from `table-grid.tsx`" also holds — all four error classes, the notice nonce, `isNavigating`, `refetchOnMount`, the socket patch, the reconnect resync, the degraded banner and sign-out survived the rewiring.

#### Patch

- [x] [Review][Patch] **HIGH — the socket payload omits `unavailableReason`, so remote devices show a missing or actively wrong reason** [`server/socket/events.ts:13-19`, `table-grid.tsx:190-197`] — Found independently by all three layers. `TableStatusChangedPayload` has five fields and the cache patch overwrites four; the reason is never carried. Device A takes a table out with "Cover torn"; device B patches to `unavailable` with `unavailableReason: null` and renders "No reason recorded". Worse in the other direction: after a return-to-service the stale reason survives in B's cache, so the next outage displays the *previous* one. Nothing refetches to correct it — `refetchOnWindowFocus` is off, there is no interval, `refetchOnMount` only fires on remount, and the reconnect resync only fires on reconnect. This is the whole point of the feature ("who took table 6 out, and why") failing on every device but one. Add the field to the payload and the patch; both routes already hold the value.
- [x] [Review][Patch] **HIGH — the reason prompt retargets to whatever is selected when you submit** [`floor-action-strip.tsx:50-51, 71-79, 82`] — `reasonOpen` and `customReason` are component state with nothing resetting them on selection change, and `submitReason` reads `table.id` at submit time, not at open time. The grid stays fully interactive behind the prompt. Select table 5 → "Take out of service" → tap table 7 to check something → tap "Broken" → **table 7 goes out of service**, carrying table 5's typed reason. Two further reachable states: the prompt is offered for an `occupied` table (its branch is evaluated before the status branches), and after a zone change it re-opens unbidden on the next table selected. Fix: `key={table?.id}` on the strip, or reset on `table?.id` change.
- [x] [Review][Patch] **`isNavigating` is never reset, and now latches the entire strip dead** [`table-grid.tsx:138, 226, 471, 462`] — Every write is `true`; there is no reset, no `onSettled`, no cleanup. Before this story it only blocked a second `openTable.mutate`. It is now folded into `busy`, which disables *every* control in the strip — Start order, Take out of service, Return to service, all four quick-reason buttons. If a `router.push` ever resolves without unmounting `TableGrid` (a kitchen user's `/tables/:id` redirect back to `/` is the concrete path), the strip is permanently inert with no explanation and no recovery short of a page reload.
- [x] [Review][Patch] **Kitchen staff are offered three buttons that always 403** [`floor-action-strip.tsx:153, 191-208`] — `role` is consulted once, for "Return to service" only. Kitchen users reach the grid (no policy covers `/`, so default-allow) and are shown "Start order", "Take out of service" and "Add items" — all three refused by the `/api/tables` and `/tables` policies. The component's own comment says hiding a doomed button is courtesy; it applies that in one direction only. The story's Dev Notes said "test as Kumar (4321)" — that test would have caught it.
- [x] [Review][Patch] **A 403 on the take-out path reports the return-to-service rule** [`table-grid.tsx:275-278`] — One mutation serves both directions and `onError` never looks at which. A kitchen user tapping "Take out of service" is told "Only an owner can return a table to service" — a rule that does not exist for the action they attempted (any owner *or waiter* may take a table out; kitchen is the excluded role). TanStack passes `variables` as `onError`'s second argument; it is available and unused.
- [x] [Review][Patch] **All 409s collapse into one message, discarding the server's actionable text** [`table-grid.tsx:85`] — The client throws `TableTakenError` on the status code before reading the body, so three distinct conditions become one string. `TABLE_HAS_OPEN_SESSION` deliberately says "This table has guests at it. Close or settle the session first." — the waiter instead sees "That table changed before the update went through", re-taps, and gets the same thing. That 409 is precisely the race AC-2 exists for.
- [x] [Review][Patch] **`sticky bottom-0` does not pin the strip on a short floor plan** [`floor-action-strip.tsx` Shell, `table-grid.tsx:453-456`] — `position: sticky` only shifts an element toward its sticky edge from its static position; it never pushes it down to fill `min-h-screen`. With one zone of four tables the strip renders mid-viewport with white space beneath. It behaves as intended only once the grid overflows. Fix: `flex flex-col min-h-screen` on the wrapper with `flex-1` on `<main>`, or `fixed bottom-0` with matching bottom padding. Also: `min-h-24` is a floor, not a fixed height, and the reason row's seven controls wrap to two or three lines on a portrait tablet — reflowing the grid under the user's finger at the exact moment they are aiming at a quick-reason button, which is what the "fixed height" comment claims to prevent.
- [x] [Review][Patch] **The strip is invisible to assistive tech** [`floor-action-strip.tsx` Shell and every branch] — Three separate gaps, all introduced by this story's interaction change. (1) Tapping a card's only consequence is a strip at the very end of the document with no `role`, no accessible name and no live region — a screen-reader user hears `aria-pressed` flip and must traverse the rest of the document to discover the actions changed. (2) Opening the reason prompt unmounts the focused button and nothing takes focus, so it falls to `document.body`; same on Cancel and on submit. (3) No `autoFocus` on the text input. Minimum fix: `role="region" aria-label="Selected table actions"` plus `aria-live="polite"` on the label block, and move focus on branch change.
- [x] [Review][Patch] **`aria-pressed` models a radio group as N independent toggles** [`table-card.tsx:60`] — Selection is mutually exclusive and there is no way to deselect. A screen reader announces "pressed"; activating again changes nothing, because the state was already this table's id. Selecting another card silently un-presses the first with no announcement. `aria-pressed` promises a state change the control cannot deliver. Radio semantics, or drop `aria-pressed` and let the strip carry the selection.
- [x] [Review][Patch] **The availability mutations have no in-flight guard, and the text input opts out of the only one that exists** [`table-grid.tsx:474-477`, `floor-action-strip.tsx:98-113`] — `onStartOrder` checks `openTable.isPending || isNavigating`; `onTakeOutOfService` and `onReturnToService` check nothing and call `mutate` directly. The sole protection is the buttons' `disabled={busy}` — and the "Other…" input has no `disabled`, with an unconditional Enter handler that calls `submitReason`. So Enter fires a POST while every button around it is greyed out.
- [x] [Review][Patch] **`availability.isPending` clears before the refetch lands** [`table-grid.tsx:265-269`] — `invalidateQueries` is fired with `void` rather than returned from `onSuccess`, so the mutation is not held pending across the refetch. The strip re-renders from stale cache with an enabled button, and an impatient second tap 409s and tells the user the table "changed before the update went through" — alarming and untrue. Return the promise, or include `isFetching` in `busy`.
- [x] [Review][Patch] **The reason prompt closes before the request resolves, and Cancel is disabled while busy** [`floor-action-strip.tsx:74, 126`] — `submitReason` clears the text and closes the panel, then fires the mutation. On a 409 or network failure the user gets a notice with no prompt and must reopen and retype a custom reason. Separately, Cancel carries `disabled={busy}`, so the one control that should always work is the one that stops working.
- [x] [Review][Patch] **Three comments added in this change assert the opposite of code added in the same change** [`table-grid.tsx:437-438, 444-445`, `floor-action-strip.tsx:15-16`] — They say `TableCard` keeps unavailable cards "non-OPERABLE (aria-disabled, no press animation)" and "deliberately inert", while `table-card.tsx` in the same commit deletes `aria-disabled`, restores the press animation and sets `onClick` unconditionally. The removal is correct — the button now genuinely does something — but the comments are the justification a later reader will act on, and they point the wrong way.
- [x] [Review][Patch] **`schema.ts:136` names the wrong migration file** — It cites `0004_table_status_events_append_only.sql`; the trigger lives in `0005_...`. `0004` is the generated structural migration.
- [x] [Review][Patch] **`setTableAvailability`'s return value is dead and its type too wide** [`table-session.service.ts`] — Declared `Promise<{ fromStatus: 'open' | 'occupied' | 'unavailable' }>`, but the derivation makes `'occupied'` unreachable and neither route reads the result. Task 2 said it should return the previous status "for the event payload"; both routes emit hardcoded payloads instead. Narrow to `'open' | 'unavailable'` or drop it.
- [x] [Review][Patch] **Nothing but one zod schema enforces "a reason is required"** [`schema.ts`, `table-session.service.ts`] — The schema comment states the invariant ("Null whenever status is not `unavailable`") and the audit column says "Required going out of service", but both columns are plain nullable `text` and the service accepts `reason: string | null` unchecked in either direction. Any second caller — a seed, Story 10.3's config screen, a test helper — can write an immutable audit row that answers "who" but not "why". `CHECK ((status = 'unavailable') = (unavailable_reason IS NOT NULL))` and `CHECK (to_status <> 'unavailable' OR reason IS NOT NULL)` would make the comments true.

#### Deferred

- [x] [Review][Defer] **Neither new route scopes the table lookup by tenant** [`out-of-service/route.ts`, `return-to-service/route.ts`] — deferred, pre-existing. Both select by id alone and take `tenantId` from the row, matching `sessions/route.ts` and every route before it. Under NFR-SC1 (single tenant per stack) this is unreachable; it would let a cross-tenant table id be actioned and pair one tenant's table with another's staff in an immutable audit row. Already logged from Story 3.3's review; re-confirmed here across two more routes. Revisit if multi-tenancy lands.
- [x] [Review][Defer] **A table with availability history can never be deleted** [`0004_cold_lifeguard.sql`, `0005_...sql`] — deferred. The FK is `ON DELETE no action` and the append-only trigger blocks deleting the referencing rows, so a table that was ever taken out of service cannot be removed. The same trap already exists for every other audit table, but this extends it to `tables` — an entity an owner does expect to remove, and Story 10.3 specifies exactly that. Needs a soft-delete or documented archival path before 10.3 ships.

#### Dismissed as noise (4)

Verified false: **`ForbiddenError` undefined** (declared at `table-grid.tsx:39`; the layer correctly flagged it as needing verification); **selection surviving a zone change** (`table-grid.tsx:393` clears it); **missing `0005_snapshot.json`** (`0001` is hand-written and has no snapshot either — that is the established convention, and the Acceptance Auditor independently confirmed migration 0005 will run); **`CREATE OR REPLACE TRIGGER` requiring PG14** (`0001` already uses the identical syntax and the stack is postgres:17).
## Dev Notes

### Why the audit table, restated

The proposal claimed one additive column. Reality: no existing audit table can hold this row, because all four hang off a session and an out-of-service table has none. The choice is a new table or weakening `order_events.session_id` to nullable for every event type. New table.

It also has to be append-only. `order_events` and friends are protected by triggers from `0001_append_only_rules.sql`; an availability log that can be edited is not a log. The function exists — you are adding one trigger.

### Routing, and why it looks asymmetric

```
POST /api/tables/:tableId/out-of-service        → owner + waiter   (existing /api/tables policy)
POST /api/config/tables/:tableId/return-to-service → owner only    (existing /api/config policy)
```

The asymmetry is deliberate and matches how the risk runs: taking a table **out** fails safe — worst case a table sits idle. Putting it **back** is the risky direction, because a broken table becomes bookable again.

The namespace carries the permission because prefix matching cannot distinguish `/api/tables/:id/x` from `/api/tables/:id/y` — the dynamic segment defeats longest-prefix specialisation. This is exactly why Story 10.3's `PATCH /api/tables/:tableId` is currently waiter-reachable; a note was added there on 2026-09-06.

### What exists — reuse, do not rebuild

| Asset | Location | Note |
|---|---|---|
| `setTableAvailability`'s neighbours | `src/server/services/table-session.service.ts` | `openSession` / `closeSession`; same tx-handle pattern |
| `emitTableStatusChanged()` | `src/server/socket/events.ts` | Has its own try/catch; cannot throw |
| Route shape, `fail()` helper | `src/app/api/tables/[tableId]/sessions/close/route.ts` | Closest template |
| Append-only trigger function | `src/server/db/migrations/0001_append_only_rules.sql` | Reuse it; do not redefine |
| `/api/config` owner-only policy | `src/server/auth/permissions.ts` | Verify, do not add |
| Confirmation-panel pattern | `src/components/pos/order-screen.tsx` | The walkout panel; copy the shape for the reason prompt |
| `ForbiddenError` handling | `src/components/pos/table-grid.tsx` | 403 → notice, **never** a redirect to `/login` |

### Testing

| Case | Expect |
|---|---|
| Waiter takes an open table out, with reason | 200, status `unavailable`, reason stored |
| Same on a table with an open session | 409 `TABLE_HAS_OPEN_SESSION` |
| Empty / whitespace reason | 400 `INVALID_BODY` |
| Owner returns to service | 200, status `open`, reason cleared |
| Waiter returns to service | 403, session still valid afterwards |
| Kitchen returns to service | 403 |
| Return a table that is not unavailable | 409 `TABLE_NOT_UNAVAILABLE` |
| Audit rows | one per change, both directions, with from/to/reason/staff |
| `UPDATE table_status_events` | `[immutable-table]` error |
| Second device watching | card flips within 2s |
| **Regression** — open a table via the strip | Story 3.3's full matrix still passes |
| Browser | select each of the three card states, confirm the strip matches the table above |

Audit check:
`psql -c "select from_status, to_status, reason, created_at from table_status_events order by created_at;"`

### Previous story intelligence (3.6 and its predecessors)

- **Services take a transaction handle**, never open their own — Story 6.5 must compose a close into a payment transaction.
- **The database decides races.** 3.3 catches `23505`; 3.6 uses a conditional UPDATE and a row count. Here, guard the transition inside the UPDATE predicate rather than trusting a prior read.
- **Emit after commit**, never inside.
- **403 is not 401.** Conflating them produced a sign-out loop for kitchen users that a browser pass missed because the tester was a waiter. Test as Kumar (4321).
- **`tsc` and `eslint` clean means little.** Story 3.2 passed both while silently deleting its entire font scale.
- **`cn()` carries a custom `extendTailwindMerge` config.** Any new `--text-*` / `--shadow-*` token must be registered in `src/lib/utils.ts` or it is dropped silently.
- **A repeated identical `setNotice` string is a React bail-out** — pair notices with a nonce.

### Project Structure Notes

- NEW: `src/app/api/tables/[tableId]/out-of-service/route.ts`, `src/app/api/config/tables/[tableId]/return-to-service/route.ts`, `src/components/pos/floor-action-strip.tsx`, one generated migration, one hand-written trigger migration
- UPDATE: `src/server/db/schema.ts`, `src/server/services/table-session.service.ts`, `src/components/pos/table-grid.tsx`, `src/components/pos/table-card.tsx`, `src/app/page.tsx` (pass role), `_bmad-output/planning-artifacts/epics.md` (3.3 AC-1)
- VERIFY ONLY: `src/server/auth/permissions.ts`
- `/api/config` is a new directory. Story 10.3 will fill it with the rest of configuration.

### References

- [Source: epics.md#Story-3.7] — ACs, added 2026-09-06
- [Source: sprint-change-proposal-2026-09-06-merge-and-availability.md] — why this story exists; note its "one column, no migration" estimate is corrected here
- [Source: prd.md#FR63] — the requirement
- [Source: schema.ts:166-221] — the four session-bound audit tables that cannot hold this event
- [Source: migrations/0001_append_only_rules.sql] — the trigger function to reuse
- [Source: ux-design-specification.md:297,677,679] — the state-driven action strip, specified and until now unbuilt
- [Source: 3-3-...md, 3-6-...md] — route patterns and their review findings

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

Verified with curl, psql, `drizzle-kit`, and `next build`. No browser — see the gap at the end.

**Migrations.** `drizzle-kit generate` produced `0004_cold_lifeguard.sql` (the `table_status_events` table plus `tables.unavailable_reason`). The trigger migration `0005_table_status_events_append_only.sql` is hand-written and needed a manual `meta/_journal.json` entry — `drizzle-kit migrate` skips any file the journal does not list, so a hand-written migration silently never runs without it. Both applied:

```
trigger attached : immutable_table_status_events
column added     : tables.unavailable_reason
```

**AC-1 / AC-3 / AC-4 — the asymmetry, which is the point of the story:**

```
waiter  POST /api/tables/:id/out-of-service            → 200  status=unavailable, reason stored
waiter  POST /api/config/tables/:id/return-to-service  → 403  FORBIDDEN
kitchen POST /api/config/tables/:id/return-to-service  → 403  FORBIDDEN
owner   POST /api/config/tables/:id/return-to-service  → 200  status=open
```

**Zero permission code was written.** `{ prefix: '/api/config', roles: ['owner'] }` already existed; putting the restore route under that namespace is the entire enforcement.

**AC-2 / AC-5 and the guards:**

```
out-of-service on a table with an open session → 409 TABLE_HAS_OPEN_SESSION
reason "   " (whitespace only)                 → 400 INVALID_BODY
out-of-service on an already-unavailable table → 409
return-to-service on an open table             → 409
malformed tableId                              → 400
```

**AC-6 — the audit trail:**

```
 label | change              | reason     | staff
 B2    | open -> unavailable | Cover torn | Nina
 B2    | unavailable -> open | —          | Aruna
```

Both directions, correct attribution where it differs, reason on the way out and null on the way back. Append-only confirmed by attempting to tamper:

```
UPDATE table_status_events SET reason='tampered';
ERROR: [immutable-table] UPDATE on table_status_events is not permitted.
```

And the reason is cleared, not carried: `B2: status=open reason=NULL`.

**Regression — Stories 3.3 and 3.6 still work end to end:**

```
open  → 201     open again → 409     close → 200
```

**Grid payload** now carries `unavailableReason` per row, so the strip can show why a table is out.

**Static checks:** `tsc --noEmit` clean; `eslint src` clean apart from the pre-existing warning at `src/server/socket/index.ts:5`; `next build` succeeds with both new routes registered (`ƒ /api/tables/[tableId]/out-of-service`, `ƒ /api/config/tables/[tableId]/return-to-service`).

### Completion Notes List

**The story's central correction held up.** No existing audit table could hold this event — `order_events`, `payment_records`, `comp_records` and `dispute_records` all carry a `notNull session_id`, and a table taken out of service has no session. `table_status_events` was added rather than relaxing `order_events.session_id` to nullable, which would have weakened a core invariant for every order event to accommodate one that is not an order event.

**The hand-written migration needs a journal entry.** `drizzle-kit migrate` reads `meta/_journal.json`, not the directory, so `0005` would have been silently skipped. Worth knowing for the next hand-written migration — Story 3.8's merge index will be one.

**`setTableAvailability` guards the transition in the UPDATE predicate**, not in a prior read: `WHERE id = ? AND status = <expected from-status>`, with the row count deciding. Same principle as `closeSession`'s `closed_at IS NULL`. A concurrent change loses cleanly instead of being silently overwritten.

**Two routes rather than one with a direction flag.** A single `PATCH /api/tables/:id/availability` could not express the asymmetry, because prefix matching cannot distinguish two paths under `/api/tables` — the dynamic segment defeats longest-prefix specialisation. Splitting by namespace is what made this free.

**`TableCard` was deliberately reverted on one point from Story 3.2's review.** That review made `unavailable` cards non-operable — `onClick={undefined}`, `aria-disabled`, no press feedback — because a tap then meant "seat this table". A tap now means "select this table", and selecting an unavailable table is the only route to "Return to service". So the card is operable again and `aria-disabled` is gone; keeping it would have been a lie, since the button now does have an effect. The state is still carried by the red band, the hatch, "Not in service", and the accessible name.

**Role comes from the database row, not the `x-staff-role` header.** The header is trustworthy — the proxy strips client-sent values and sets it from the validated session — but it drives styling, and this drives which controls exist. One extra column on a query already being made.

**The strip is `FloorActionStrip`, not Epic 4's `OrderActionStrip`.** This one is driven by TABLE state on the floor; that one is driven by ORDER state on the order screen. Left as separate components with a note for whoever builds Story 4.1 to decide whether they converge.

**The reason prompt replaces the strip contents rather than opening a modal**, matching the walkout confirmation already in `order-screen.tsx`. Four quick reasons plus free text; a POS does not need a modal system for a four-option question.

**BROWSER PASS DONE — 2026-09-10, by Teran — with ONE gap, recorded because it was caused by bad instructions rather than by anything in the code.**

Confirmed working: select-then-act (AC-7, AC-9), the strip showing the right actions per state, "Start order" still opening a table, the reason prompt and its quick reasons, and the grid not reflowing on selection.

**AC-8's owner half — confirmed 2026-09-11.** The first pass checked it against the wrong account: the checklist named Kumar (4321) as the owner, but Kumar is `kitchen` and **Aruna (5678) is the `owner`**. Re-checked by Teran signing in as Aruna, selecting an out-of-service table, and seeing "Return to service" — the one branch that is the entire point of this story. With the server side already verified over curl (owner 200, waiter 403, kitchen 403), the asymmetry is now proven end to end.

The rest of the original gap list, now closed:

- **AC-7 and AC-9 — select-then-act.** That a tap now selects rather than opening a session, that the strip shows the right actions per state, and that "Start order" still opens a table correctly. This is the biggest behavioural change in the story and it is entirely unobserved.
- **AC-8 — role-aware strip.** The server 403 is verified; that a waiter sees no "Return to service" button while an owner does is not.
- The reason prompt, its quick-reason buttons and free-text entry.
- That the strip does not reflow the grid on selection.

The dev server was left running on `http://localhost:3000`. Worth checking as **two** users: Nina (1234) should see a table's reason but no restore button; Aruna (5678) should see the button.

**Still no test framework**, so none of this is captured as a regression test — including the append-only trigger and the transition guard.

### File List

- NEW: `src/app/api/tables/[tableId]/out-of-service/route.ts` (any staff; reason required; refuses a table with an open session)
- NEW: `src/app/api/config/tables/[tableId]/return-to-service/route.ts` (owner only via existing `/api/config` policy; first route under that namespace)
- NEW: `src/components/pos/floor-action-strip.tsx` (state-driven floor strip; role-aware; reason prompt)
- NEW: `src/server/db/migrations/0004_cold_lifeguard.sql` (generated — table + column)
- NEW: `src/server/db/migrations/0005_table_status_events_append_only.sql` (hand-written — append-only trigger)
- UPDATE: `src/server/db/schema.ts` (`tables.unavailableReason`, `tableStatusEvents`)
- UPDATE: `src/server/db/migrations/meta/_journal.json` (entry for the hand-written migration)
- UPDATE: `src/server/services/table-session.service.ts` (`setTableAvailability`, `InvalidAvailabilityTransitionError`)
- UPDATE: `src/app/api/tables/route.ts` (`unavailableReason` on `TableGridRow`)
- UPDATE: `src/components/pos/table-grid.tsx` (select-then-act, availability mutation, strip mounted)
- UPDATE: `src/components/pos/table-card.tsx` (selectable in every state)
- UPDATE: `src/app/page.tsx` (passes `role`)
- UPDATE: `_bmad-output/planning-artifacts/epics.md` (Story 3.3 AC-1 amended)

### Change Log

- 2026-09-08: Story implemented. A table can now be taken out of service by any staff member with a required reason, and returned only by an owner — an asymmetry enforced entirely by which namespace each route lives in, with no new permission code. The story's central correction proved right: no existing audit table could hold the event, since all four require a `session_id` and an out-of-service table has none, so `table_status_events` was added with the same append-only trigger the other audit tables use. The floor action strip was built, which changes the grid from tap-to-act to tap-to-select and amends Story 3.3's AC-1 — the change that happens to answer the question that started this line of work, since the second tap is the confirmation a table should not go occupied by accident. Story 3.2's decision to make unavailable cards non-operable was deliberately reverted, because selecting one is now the only path to restoring it. Task 8 (browser verification of the whole select-then-act interaction) is NOT done and the story is deliberately left short of `review`.
- 2026-09-09: Code review completed — 16 patches applied, 2 deferred, 4 dismissed as verified-false, 0 decisions. Highest-value fix: the socket payload now carries `unavailableReason`, so a device that did not make the change shows the real reason instead of "No reason recorded" — and a stale reason can no longer survive a return-to-service to be displayed against the next outage. Also fixed: the reason prompt retargeted to whatever table was selected at submit time (now keyed on the selection, so it cannot outlive it); `isNavigating` had no reset and, once folded into `busy`, could latch the entire strip dead; kitchen staff were offered three buttons that always 403; 403 and 409 messages were generic where the server had specific, actionable ones; `sticky bottom-0` could not pin the strip on a short floor plan (now a flex column with a flex-1 main); the strip had no landmark, no live region and no focus management; and `aria-pressed` modelled an untoggleable radio selection — replaced with `aria-current`. Added migration 0006 with CHECK constraints making the reason invariants true at the database layer rather than in one zod schema. **That constraint immediately caught a real defect: the seed created `unavailable` tables with no reason at all** — the exact gap it exists to prevent — so the seed was fixed and the migration backfills pre-existing rows before constraining. Verified: both constraints reject either half of the mismatch; kitchen 403s in both directions; owner restores; the 409 now returns "This table has guests at it. Close or settle the session first."; and a live socket client confirmed the reason travels with the event.
- 2026-09-10: Browser pass completed by Teran. Select-then-act, the strip, the reason prompt and the no-reflow behaviour all confirmed. AC-8's owner branch was NOT confirmed: the test checklist misidentified Kumar (kitchen) as the owner, so the one role that should see "Return to service" was never signed in as. Aruna (5678) is the owner. Story held at `in-progress` for that single check rather than moved to `review` on an assumption.
- 2026-09-11: AC-8's owner branch confirmed by Teran as Aruna (5678) — "Return to service" renders for `owner` and for no one else. That was the only outstanding item; Task 8 checked and status moved to `review`.
