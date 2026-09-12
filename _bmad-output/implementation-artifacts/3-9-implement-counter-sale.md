# Story 3.9: Implement Counter Sale (Orders Without a Table)

Status: done

- **Epic:** 3 — Zone & Table Navigation
- **Story ID:** 3.9
- **Requirement:** FR64 (added 2026-09-10), FR18 as amended
- **Source:** `sprint-change-proposal-2026-09-10-counter-sale.md`
- **Sequencing:** **before Epic 4.** Every route and screen in the system is addressed by `tableId`; a counter order has no table id to put in one. Building Epic 4's order screens table-addressed and retrofitting them later is the expensive path.

---

## Story

**As a** waiter or owner,
**I want** to take an order that is not tied to any table,
**so that** a customer buying at the bar can be served and recorded without occupying seating.

---

## Acceptance Criteria

**AC-1 AMENDED (2026-09-11) — counter sale is a PILL in the zone bar, not a button in the strip**

The first implementation put a **Counter sale** button in the action strip's no-selection state and a separate **Counter orders (n)** list above the zone chips. Teran's call, and the right one: in a table-first system that reads as two unexplained new surfaces bolted on. The counter is a *place* in the restaurant, and the zone bar is already the control for "where am I looking".

**Given** a waiter is on the floor screen
**When** they tap the **Counter** pill in the zone bar
**Then** the grid switches to counter orders; the first tile is **+ New counter sale**, and tapping it creates a session with `kind = 'counter'`, `table_id = NULL` and **no** `order_session_tables` rows, then opens the order screen

**Given** the Counter pill is active
**When** the grid renders
**Then** each open counter order is a **card** in the same grid, showing its name, elapsed time and item count — selected by a tap, with its actions in the action strip, exactly like an occupied table

**The Counter pill carries no count.** Every other pill shows *free tables* — "Tables 3" means three available. A count here would mean *active orders*, the opposite reading of an identically-styled number. The cards themselves say how many there are.

**Counter is a MODE, not a filter.** Counter orders never appear inside a zone or under "All zones" — they occupy no zone, and mixing them in would make "All zones" a lie.

**AC-2: A counter order occupies nothing**
**Given** a counter session is open
**When** the floor grid renders on any device
**Then** no table card changes state, no zone's open count changes, and no `table:status_changed` event is emitted — the grid is a view of tables, and a counter order is not one

**AC-3: The order screen is addressed by session**
**Given** any open session, table or counter
**When** the order screen is opened
**Then** it is reached at `/orders/:sessionId`; `/tables/:tableId` still resolves (for bookmarks and existing links) by looking up that table's open session and redirecting to the canonical URL

**AC-4: Close is addressable by session**
**Given** a counter session with no submitted items
**When** it is closed with reason `abandoned`
**Then** `POST /api/sessions/:sessionId/close` produces the **same** `order_sessions` and `order_events` records as a table close (Story 3.6), differing only in that no table is released and no socket event is emitted

**AC-5: A counter order can be seated later**
**Given** an open counter session
**When** one or more tables are attached to it
**Then** those tables become `occupied`, the group appears on the grid as an ordinary card, `kind` becomes `'table'`, `table_id` is set to the first attached table, and a `TABLE_MERGED` audit row is written

**AC-6: The last-table guard applies only to table sessions**
**Given** a session of `kind = 'counter'` with no attached tables
**When** any un-merge or last-table guard is evaluated
**Then** `SESSION_NEEDS_A_TABLE` does **not** fire — that guard exists to stop a *table* session becoming unreachable, and a counter session is reachable without one

**AC-7 AMENDED (2026-09-11) — reachability comes from the pill** *(added beyond the epic — see Trap 1)*
**Given** one or more counter sessions are open
**When** a waiter taps the **Counter** pill
**Then** every open counter order is listed as a card and can be opened — the separate "Counter orders (n)" strip above the zone bar is **removed**, since the pill now serves that purpose

The requirement behind this AC is unchanged and is not negotiable: a counter order that cannot be found again is invisible, unreachable, un-closable and still counted in every revenue query — the orphan state Story 3.6 exists to prevent, reached from a third direction. Only the surface that satisfies it has changed.

**AC-8: Audit and attribution are identical**
**Given** any action on a counter session
**When** it is recorded
**Then** the events, staff attribution and append-only immutability are identical to a table session — `SESSION_OPENED`, `SESSION_CLOSED`, `TABLE_MERGED` all key on `session_id`, which a counter session has

**AC-9: The new namespaces are explicitly policed** *(added beyond the epic — see Trap 2)*
**Given** a kitchen user calls any route under `/api/sessions` or loads `/orders/:sessionId`
**When** the proxy evaluates the route policy
**Then** a 403 is returned — **not** the default-allow that these prefixes currently fall through to

**AC-10: Counter sessions have no uniqueness constraint, deliberately**
**Given** three customers are buying at the bar at once
**When** three counter sessions are opened
**Then** all three coexist — `idx_one_open_session_per_table` constrains *tables*, and a counter session has none, so nothing serialises them and nothing should

**AC-11: Tickets label a counter order `COUNTER`** — **not deliverable in this story**
FR18 as amended requires it. No ticket generation exists (Epic 5 is unbuilt), so this AC is recorded and deferred with the rest of FR18's merged-table work. **Do not attempt it; do not mark it complete.** Log it in `deferred-work.md` against Epic 5.

---

## Tasks / Subtasks

- [x] **Task 1 — Schema: nullable table, explicit kind** (AC: 1, 5, 6)
  - `src/server/db/schema.ts`:
    ```ts
    export const sessionKindEnum = pgEnum('session_kind', ['table', 'counter'])
    // orderSessions:
    tableId: uuid('table_id').references(() => tables.id),          // .notNull() REMOVED
    kind:    sessionKindEnum('kind').notNull().default('table'),
    ```
  - **`kind` MUST be a column, never inferred from "zero attached tables".** A table session passes through zero attached rows *transiently* while un-merging, so inferring the type from that state lets a race silently reclassify a table order as a counter order. Epic 9 also wants counter revenue split out, which is a `GROUP BY kind`.
  - `order_session_tables` needs **no change**. It already expresses zero, one or many tables per session — Story 3.8 made the model order-first, and this story removes the last two constraints that still assumed a table.
  - **⚠️ MIGRATION JOURNAL — this has now bitten twice (Stories 3.7 and 3.8).** After `pnpm db:generate`, open `src/server/db/migrations/meta/_journal.json` and confirm the new entry's `when` is **greater than `1789060000000`** (0007's hand-set value, which is 2026-09-10 17:06 UTC and is very likely *ahead of the real clock when you generate*). `drizzle-kit migrate` orders by `when`, not by filename, and **silently reports success while doing nothing** if the new entry sorts older. Bump it if needed.

- [x] **Task 2 — Service: open, close and attach without a table** (AC: 1, 4, 5, 6)
  - `src/server/services/table-session.service.ts`.
  - `openCounterSession(tx, { tenantId, staffId })` — inserts an `order_sessions` row with `kind: 'counter'`, `tableId: null`, **no** join rows, and writes `SESSION_OPENED`. Do **not** overload `openSession` with a nullable table id; the two have different invariants and one function that sometimes takes a table is how the table-shaped assumptions leak back in.
  - **`freeTables` and `occupyTables` must early-return on an empty array.** `closeSession` calls `freeTables(tx, attachedTableIds(...))`, and for a counter session that array is `[]`. Do not rely on Drizzle's `inArray(col, [])` behaviour — add `if (tableIds.length === 0) return` to both.
  - `attachTables` gains the AC-5 promotion: when the session has `kind = 'counter'`, set `kind: 'table'` and `table_id` to the first attached table in the same transaction. It already upserts (Story 3.8) so re-attachment is safe.
  - `closeSession` needs **no change** — it already derives its table set from the join table and handles zero correctly once the empty-array guard above is in.

- [x] **Task 3 — Route policy BEFORE any route exists** (AC: 9) — **do this before Task 4**
  - `src/server/auth/permissions.ts` — add:
    ```ts
    { prefix: '/api/sessions', roles: ['owner', 'waiter'] },
    { prefix: '/orders',       roles: ['owner', 'waiter'] },
    ```
  - **Why first:** `findRoutePolicy` returns `null` for an unmatched prefix and `isRoleAllowed` treats null as *allow any authenticated role*. `/api/sessions` and `/orders` match **nothing** today. Ship a route under either one before the policy and every kitchen user can open, close and read orders — with no error anywhere to reveal it.
  - No `exemptMethods`. Unlike `/api/tables`, nothing needs to read these but owner and waiter; `/api/tables` is exempt on GET only because every role's landing screen calls it.
  - Verify as Kumar (4321, `kitchen`): every `/api/sessions` call and `/orders/:id` must 403.

- [x] **Task 4 — Routes** (AC: 1, 4, 5, 7, 10)
  - `POST /api/sessions` — creates a counter session. Empty body. Returns `{ sessionId }`. **No uniqueness check and no 409 path** (AC-10).
  - `POST /api/sessions/:sessionId/close` — same body schema and same `CLIENT_CLOSE_REASONS` as the table close; same `SESSION_HAS_ITEMS` guard for `abandoned`. **Emit `table:status_changed` only for tables that were actually released** — a counter close releases none and must emit nothing.
  - `GET /api/sessions?kind=counter&open=true` — open counter sessions with elapsed time and item count, for AC-7.
  - `POST /api/sessions/:sessionId/tables` — attach tables to a counter session (AC-5). Same zone rule and same 409/422 codes as `/api/tables/:tableId/merge`; reuse `attachTables`.
  - **Keep** `POST /api/tables/:tableId/sessions/close`. It already resolves table → session and delegates to the same service; both routes staying thin over one service is the Story 3.6 pattern and must not be duplicated.

- [x] **Task 5 — The order screen moves to `/orders/:sessionId`** (AC: 3)
  - **NEW** `src/app/orders/[sessionId]/page.tsx`. Start the query `.from(orderSessions)` and **left**-join tables through `order_session_tables` — a counter session has no table and an inner join can never return it. The current page starts `.from(tables)`, which is precisely why it cannot.
  - `OrderScreenProps` must tolerate no table: `tableId: string | null`, `tableLabel: string | null`, `zoneName: string | null`. Where there is no table, the header reads **Counter**.
  - `order-screen.tsx`'s `closeTable()` posts to `/api/tables/${tableId}/sessions/close`. Re-point it at `/api/sessions/${sessionId}/close`.
  - **REWRITE** `src/app/tables/[tableId]/page.tsx` as a redirect: resolve the table's open session, then `redirect('/orders/' + sessionId)`. Keep its existing UUID guard and its `redirect('/')` for no-open-session — both were added deliberately (a malformed segment raises 22P02 and there is no `error.tsx` anywhere under `src/app`).
  - `table-grid.tsx` pushes `/tables/${tableId}` in two places (`onSuccess` of `openTable`, and `onOpenOrder`). Point both at `/orders/${sessionId}` — **`TableGridRow.sessionId` is already on the row**, so no extra fetch. The redirect route stays for bookmarks.

- [x] **Task 6 — Floor screen: entry point and the counter list** (AC: 1, 2, 7)
  - `floor-action-strip.tsx` — the `!table` branch currently renders a dead end: *"No table selected · Tap a table to see what you can do with it."* That is where **Counter sale** belongs; it is the only state with no other purpose. Gate it on `canSeat` exactly as the seating actions are.
  - `table-grid.tsx` — a **Counter orders (n)** control near the zone chip bar when `n > 0`, opening a panel that lists each open counter order and navigates to its screen. Reuse the existing notice/panel idiom; **do not introduce a modal** (see the design note in the strip).
  - Counter sessions must **not** enter `toGridUnits` and must **not** affect `zones[].openCount` or `totalOpenCount`. They are not tables.

- [x] **Task 8 — The Counter pill** (AC: 1 amended, 7 amended)
  - `zone-chip-bar.tsx` — a **Counter** pill after the zone pills. No count (see AC-1). Needs `counterActive` and `onCounterSelect`; the component stays presentational.
  - `table-grid.tsx` — `counterMode` state. While it is on, `activeZoneId` is ignored and the grid renders counter orders instead of tables. Selecting any zone pill (or "All zones") turns it off.
  - **End merge mode when the view changes**, exactly as the zone handlers already do — the same bug class as Story 3.8's review finding, and the counter pill is a third way to change view.

- [x] **Task 9 — Counter cards and the strip** (AC: 1 amended, 7 amended)
  - A **+ New counter sale** tile first in the grid. It acts on tap: it is an explicitly labelled create affordance, the same as a strip button, so the select-then-act rule from Story 3.7 does not apply to it.
  - Each counter order renders as a card — `Counter 1 · 14 min · 3 items`. A tap **selects**, and the strip offers **Add items**. That keeps Story 3.7's rule intact for anything representing a live order.
  - Counter orders have no `tableId`, so selection needs its own state (`selectedCounterId`) rather than being forced through `selectedTableId`.
  - **Remove** the strip's `onCounterSale` button and the `Counter orders (n)` list — both are replaced, and leaving either would give one action two homes.
  - Empty state inside counter mode: "No counter sales. Tap + to start one."

- [x] **Task 7 — Verify** (AC: all except 11)
  - No test framework; manual, as every prior story. Matrix in Dev Notes.
  - **The RBAC check is not optional** — it is the only thing that catches Trap 2, and Trap 2 is silent.

---

### Review Findings

Code review 2026-09-11 — three parallel layers (Blind Hunter on the diff alone, Edge Case Hunter with project access, Acceptance Auditor against the spec), every claim re-verified against the working tree. **All three independently reached findings 1, 3, 4, 5 and 6.**

#### Decision needed

- [x] [Review][Decision] **A seated counter sale can never go back to being one** [`table-session.service.ts`] — `attachTables` flips `kind` to `'table'` permanently and nothing flips it back, while `releaseTable` exempts only `kind = 'counter'` from the last-table guard. So a guest who buys at the bar, sits at a table, then decides to stand at the bar again cannot be un-seated: the un-merge is refused with `SESSION_NEEDS_A_TABLE` and the table stays occupied until the bill is settled. This also makes AC-6's counter branch **unreachable in practice** — no session can hold a table *and* `kind = 'counter'` — so the Dev Agent Record's "verification" of it came from hand-editing `kind` in SQL, which is not evidence. Options: (a) accept it — a seated party is a table order, and record AC-6 as covering only never-seated sales; (b) flip `kind` back to `'counter'` when the last table is released, making seating reversible; (c) drop `kind` from the guard entirely and refuse the last table only when the session has *ever* had one. **(b) matches how a bar actually works** and costs three lines, but it is a product call.

#### Patch

- [x] [Review][Patch] **Counter sales open across midnight vanish from the only list that reaches them** [`src/app/api/sessions/route.ts`] — `gte(openedAt, startOfDay)` was added to compute the day sequence but filters the LISTING too, and the rows it filters are the OPEN ones. A sale opened 23:50 and still open at 00:05 appears on no card, in no list, and at no URL anyone knows — un-closable, still counted in revenue and audit. Verbatim the orphan state this endpoint's own doc comment claims to eliminate, and a bar trading past midnight hits it nightly. List on `closedAt IS NULL` and use the day window only for numbering.
- [x] [Review][Patch] **The day boundary is the container's timezone, not the restaurant's** [`src/app/api/sessions/route.ts`, `docker-compose.yml`] — `new Date().setHours(0,0,0,0)` runs in the Node process TZ. `docker-compose.yml` passes `TIMEZONE=Asia/Colombo`, but **Node reads `TZ`**, and `tenant_config.timezone` (seeded to `Asia/Colombo`) is read by nothing. In the container the process is UTC, so "today" begins at **05:30 local**: every `Counter #n` renumbers mid-service, and the window disagrees with whatever Epic 9's dashboard uses for the same day. Invisible in dev — the dev host's own TZ is Asia/Colombo, so it looks correct there and breaks only in production.
- [x] [Review][Patch] **The seat route never checks `kind`, so it will cross-zone merge any session** [`src/app/api/sessions/[sessionId]/tables/route.ts`] — It selects only `id`/`openedAt`, and its zone rule compares the incoming tables **only among themselves**, on the stated premise that "there is no anchor to compare against". True for a table-less counter sale; false for any session that already has tables — which this route accepts. Post a table session's id with a table from another zone and it attaches with no complaint, producing the cross-zone group `/api/tables/:tableId/merge` refuses, and skipping that route's `expectedSessionId` / `ANCHOR_CHANGED` guard. It also breaks `toGridUnits`' stated safety argument ("safe over the zone-filtered list because a merge cannot span zones"), so the group renders as two cards with duplicate timers. Worse with finding 4: two devices seating the same sale both pass, because the first flips `kind` and the second still sees an open session.
- [x] [Review][Patch] **Seating mode can outlive its anchor, leaving no Cancel button** [`src/components/pos/table-grid.tsx`] — The banner renders from the derived `seating`, but card taps branch on the raw `seatingSessionId`. When the sale leaves the counter list mid-flow (closed or seated elsewhere, or the query refetches on reconnect), `seating` goes null, the strip falls through to the "No table selected" shell — **which has no Cancel** — while every tap still stages tables and paints them dashed. This is verbatim the defect Story 3.8's review found in merge mode, reproduced by rendering off a derived value and branching off the raw one. `seatMutation.onError` has the same shape: it shows a notice and leaves the mode and the staged tables intact.
- [x] [Review][Patch] **The counter list has no live channel at all** [`src/components/pos/table-grid.tsx`, `src/app/api/sessions/route.ts`] — Counter sessions deliberately emit no `table:status_changed` (correct — they are not tables), but nothing was put in its place: the query has `refetchOnMount: 'always'` and no interval, no socket subscription, and the `connect` resync invalidates only `TABLES_QUERY_KEY`. On a second tablet left on the Counter view a sale started at the bar never appears, and one closed elsewhere stays tappable — "Add items" then bounces to `/` with no message. It is also what turns the double-seat race above from a millisecond window into an everyday occurrence.
- [x] [Review][Patch] **The item-count aggregate is unbounded — a regression of a fix that already exists** [`src/app/api/sessions/route.ts`] — `select(count()).from(orderEvents).where(eq(eventType,'ITEM_ADDED')).groupBy(sessionId)` has no session filter, no tenant filter, no date filter, despite `rows` being in scope. `/api/tables/route.ts` fixed exactly this with `inArray(orderEvents.sessionId, openSessionIds)` and documents why: `order_events` is append-only and only grows, and the index is unusable without the predicate. This runs on every waiter tablet's landing screen.
- [x] [Review][Patch] **`releaseTable`'s lock has no `closedAt` filter, and a missing row falls into the wrong guard** [`src/server/services/table-session.service.ts`] — Unlike `attachTables` directly above it, the `FOR UPDATE` does not filter `isNull(closedAt)`, so a closed session is locked and processed. And `locked?.kind !== 'counter'` optional-chains a missing row to `undefined`, which is `!== 'counter'`, so a session that does not exist reads zero attachments and surfaces as `SessionNeedsATableError` — "this is the only table on the order" — for a session that is gone.
- [x] [Review][Patch] **Kitchen staff are offered the Counter pill and a create button that always 403s** [`src/components/pos/zone-chip-bar.tsx`, `table-grid.tsx`] — Only the data query is role-gated (`enabled: role === 'owner' || role === 'waiter'`). A kitchen user taps Counter, sees "No counter sales open" — indistinguishable from a genuinely empty bar — and the create button 403s. The strip's own rule: "Offering buttons that always 403 is the same defect as the dead 'Switch user' control two stories ago."
- [x] [Review][Patch] **"This table has 3 items on it" on a counter sale** [`src/components/pos/order-screen.tsx`] — The walkout heading was made label-agnostic (`displayLabel`); the sentence directly beneath it was not. Reads "Close Counter as a walkout? / This table has 3 items…" — same screen, adjacent lines.
- [x] [Review][Patch] **`sequence` has no tiebreaker, so a "never moves" number can swap** [`src/app/api/sessions/route.ts`] — Ordered by `openedAt` alone. Two sales committing in the same tick can return in either order on successive requests, renaming both. The same nondeterminism was already fixed in `releaseTable`'s promotion and in `/api/tables`. Append `asc(orderSessions.id)`.
- [x] [Review][Patch] **A successful seating can select a table the zone filter is hiding** [`src/components/pos/table-grid.tsx`] — Zone changes deliberately do not end seating, so a waiter can stage a table in zone A, switch to zone B, and confirm. `setSelectedTableId(variables.tableIds[0])` then points at a table absent from `units`, so the strip reads "No table selected" directly under the notice "Order moved to the table. Same bill."
- [x] [Review][Patch] **A failed seat leaves the staged tables staged** [`src/components/pos/table-grid.tsx`] — After "That table already has its own order", the now-occupied table is still dashed-pending and still in the next confirm's payload, which 409s again until the waiter untaps it by hand.
- [x] [Review][Patch] **`undoUnmerge` drops the anchor-staleness guard the forward path was given** [`src/components/pos/table-grid.tsx`] — `mergeTables` takes `expectedSessionId` precisely so the server can refuse a moved anchor, and `onConfirmMerge` passes it. The undo — fired up to 8 seconds later against a table id whose session the server resolves fresh — passes nothing. If the party settles and a new one is seated inside that window, the undo re-attaches the table to a different party's session: the same "two parties on one bill" outcome `mergeAnchor` exists to prevent.
- [x] [Review][Patch] **`availability.onError` flattens the messages the shared handler was written to preserve** [`src/components/pos/table-grid.tsx`] — It ends in the generic line while merge, unmerge, seat and counter-sale all route through `handleTableActionError`, which surfaces `error.message`. Two paths that should agree, written at the same time.
- [x] [Review][Patch] **Dead round trip in the session close route** [`src/app/api/sessions/[sessionId]/close/route.ts`] — Selects `id` from a set of ids it already holds, on FK-constrained rows that cannot be absent, then loops the result instead of `releasedTableIds`. Its only possible effect is to silently drop an event.
- [x] [Review][Patch] **Two doc comments sit above the wrong code** [`table-session.service.ts`, `table-grid.tsx`] — The "UPSERT, not a plain insert" block is separated from its insert by the session-lock block; the "Open counter sales. Fetched rather than derived…" block sits above `seatSession` rather than `fetchCounterSessions`. In a codebase whose review rules treat comments as load-bearing claims, these now document the wrong statements.
- [x] [Review][Patch] **Counter empty state is not the string Task 9 specifies** [`table-grid.tsx`] — "No counter sales open." drops the actionable half, "Tap + to start one."
- [x] [Review][Patch] **Dev Agent Record contains three claims the code does not support** [spec] — (a) "All three are cleared by the same `endMergeMode`" — they are two separate functions, and finding 4 is exactly the gap that paragraph calls impossible; (b) "server-assigned day sequence… fixed at creation and never moves" — nothing is persisted, it is `index + 1` recomputed per request; (c) the AC-6 verification came from hand-edited SQL, not the app.
- [x] [Review][Patch] **File List misdescribes and omits** [spec] — It credits the strip with "**Counter sale** in the no-selection state", a button Task 9 deleted; and omits `zone-chip-bar.tsx` (Task 8's entire deliverable), `src/lib/format.ts` (`clockTime`, load-bearing for counter identity) and `src/app/api/tables/[tableId]/sessions/close/route.ts`. The "Not verified — the browser" paragraph still names both deleted surfaces.

#### Deferred — real, but not caused by this change

- [x] [Review][Defer] **The `abandoned` item check runs outside the close transaction** — deferred, pre-existing; the same shape as the table-addressed close route from Story 3.6
- [x] [Review][Defer] **`openSession` does not dedupe `additionalTableIds` while the seat route does** — deferred; the open route dedupes before calling it, so unreachable over HTTP
- [x] [Review][Defer] **No CHECK constraint pairs `kind` with `table_id`** — deferred; the invariant is maintained by one `if` in `attachTables` and read by the last-table guard and Epic 9's revenue split
- [x] [Review][Defer] **`attachTables` picks the primary table by tap order, not label order** — deferred, pre-existing; `openSession` has the same ordering, now also reachable from the counter path

**Dismissed as noise (0).**


---

## Dev Notes

### The model is already order-first — this story finishes the change

Story 3.8 inverted the relationship. Tables attach to a **session** through `order_session_tables`; `order_sessions.table_id` is only a primary-table breadcrumb for ticket headers. Read the join table in that direction:

| `order_session_tables` rows | Meaning |
|---|---|
| 3 | a merged party |
| 1 | an ordinary table order |
| **0** | **a counter sale** |

The zero case already works everywhere it matters — `closeSession` derives its table set from the join table, orders/bills/payments/audit all key on `session_id`. **Only two constraints and the UI still assume a table exists**, and Tasks 1–2 remove them. This is not an architectural reversal; it is the last 20% of a change already made.

---

### 🚨 Trap 1 — a counter session with no way back to it is an orphan

Story 3.6 exists to eliminate sessions that can be created but never released. A counter order appears on **no card**, and any number can be open at once (AC-10). So without AC-7, a waiter who creates one and navigates away has produced a session that is:

- invisible on every screen
- unreachable by any URL they know
- impossible to close through the UI
- still counted in every revenue and audit query

That is the exact orphan state Story 3.6 was written to eliminate, arrived at from a third direction. **AC-7 is not a nice-to-have; it is what stops this story re-opening the hole Story 3.6 closed.** Build it in the same pass, not "later".

---

### 🚨 Trap 2 — `/api/sessions` and `/orders` are default-allow, silently

`findRoutePolicy` returns `null` when no prefix matches, and `isRoleAllowed` reads null as **allow any authenticated role**. Default-allow is deliberate (`permissions.ts`) so that new routes surface as missing-policy rather than confusing 403s — but it means:

```
/api/sessions/...   → matches NOTHING → every role, including kitchen
/orders/:sessionId  → matches NOTHING → every role, including kitchen
```

`/orders` does **not** inherit `/api/orders` — the page path does not start with the API prefix. And the existing `{ prefix: '/tables', roles: ['owner','waiter'] }` exists specifically to stop kitchen staff reading an order screen by typing a URL; moving that screen to `/orders` without a matching policy **undoes that protection**.

Nothing errors. Nothing logs. The only signal is a kitchen user succeeding where they should not. **Task 3 before Task 4.**

**Forward constraint for Epic 6/7 — decide it now, it is free now.** Epic 6 specifies `GET /api/sessions/:sessionId/history` with *"any authenticated staff member can view the history"*, and Epic 7.4 builds the audit view. Under the `/api/sessions` policy this story adds, kitchen gets 403 — and **you cannot fix it with a longer prefix, because the session id sits in the middle of the path and a dynamic segment defeats prefix specialisation** (the same limitation already documented against `/api/tables`). Whoever builds that endpoint should put it under its own namespace — `/api/audit/...` — rather than trying to carve an exemption out of `/api/sessions`.

---

### 🚨 Trap 3 — the migration journal, for the third time

Journal state today:

```
5  1788880408292  0005_table_status_events_append_only
6  1789052408292  0006_availability_reason_checks
7  1789060000000  0007_worthless_bloodstorm      ← hand-set: 2026-09-10 17:06 UTC
```

0006 and 0007 both carry hand-picked timestamps **ahead of the real clock**. `drizzle-kit migrate` reads the journal and orders by `when`; a new entry that sorts older is **skipped silently, with a success message**. Story 3.7 hit this, Story 3.8 hit it again from the opposite direction. Check `_journal.json` after `db:generate` and bump `when` above `1789060000000`.

---

### 🚨 Trap 4 — a live defect in the close path, found while writing this story

`src/app/api/tables/[tableId]/sessions/close/route.ts` emits **one** `table:status_changed`, hardcoded to the table the request was addressed through:

```ts
emitTableStatusChanged({ tableId: table.id, status: 'open', ... })
```

But `closeSession` releases **every** attached table (Story 3.8, verified). So closing a merged group `B1 + B2 + B3` from B1 tells other devices about **B1 only** — B2 and B3 stay `occupied` on every other tablet until a refetch or a socket reconnect. The acting device is fine because it invalidates its own query; nobody else is.

`closeSession` returns only `{ closedAt }`, so the route has no way to know what it released. **Fix:** have `closeSession` return the released table ids and emit one event per id. Task 4 rewrites this emit path anyway (a counter close must emit **nothing**), so fix it in the same pass rather than leaving a known-wrong emit in a file you are already editing.

**This is a defect in Story 3.8, which is currently at `review`.** Flag it there too — do not let it be silently absorbed into this story's changelog.

---

### Current state of every file this story modifies

| File | Today | This story |
|---|---|---|
| `src/server/db/schema.ts` | `tableId` is `notNull`; no `kind` | Nullable + `sessionKindEnum` |
| `src/server/services/table-session.service.ts` | `openSession` requires a table; `freeTables`/`occupyTables` unguarded on `[]`; `attachTables` upserts | Add `openCounterSession`; guard empty arrays; promote `kind` on attach; `closeSession` returns released ids |
| `src/server/auth/permissions.ts` | No `/api/sessions`, no `/orders` | Two policies, added first |
| `src/app/api/tables/[tableId]/sessions/close/route.ts` | Emits one event; correct otherwise | Emit per released table (Trap 4) |
| `src/app/tables/[tableId]/page.tsx` | Full order screen, `.from(tables)` + inner joins — a counter session is unreachable by construction | Becomes a redirect to `/orders/:sessionId` |
| `src/components/pos/order-screen.tsx` | Props require `tableId`, `tableLabel`, `zoneName`; closes via the table route | Nullable table props; close via the session route |
| `src/components/pos/floor-action-strip.tsx` | `!table` branch is a dead end | **Counter sale** lives there |
| `src/components/pos/table-grid.tsx` | `toGridUnits` over table rows; pushes `/tables/:tableId` | Counter list; push `/orders/:sessionId` |
| `src/app/api/tables/route.ts` | Grid rows only | **No change** — counter sessions must not appear |

**Preserve, do not regress:**

- The UUID guard and `redirect('/')` in `tables/[tableId]/page.tsx` — there is no `error.tsx` under `src/app`, so a malformed id becomes a full-page server error without it.
- `ForbiddenError` distinct from `SessionExpiredError` everywhere. Conflating them produced an infinite sign-out loop for kitchen users; re-authenticating cannot change a role.
- Item counting is `ITEM_ADDED` without subtracting `ITEM_REMOVED` in **three** places (`/api/tables`, the close route, the order page). Keep them consistent; all three change together when Epic 4 adds removal.
- Socket emits go **after** commit, never inside the transaction.

---

### Verification matrix

| Case | Expected |
|---|---|
| `POST /api/sessions` as waiter | 201, `kind='counter'`, `table_id IS NULL`, zero join rows |
| Grid after creating a counter session | **unchanged** — 13 tables, same cards, same zone counts |
| Three counter sessions at once | all three open, no 409 (AC-10) |
| `/orders/:sessionId` for a counter session | renders, header reads **Counter** |
| `/tables/:tableId` for an open table | redirects to `/orders/:sessionId` |
| `/tables/:tableId` for a closed table | redirects to `/` |
| `POST /api/sessions/:id/close` `{reason:'abandoned'}` | 200; `SESSION_CLOSED` written; **no** socket event |
| Attach a table to a counter session | 200; table `occupied`; `kind='table'`; `table_id` set; `TABLE_MERGED` row |
| Un-merge the only table of a **counter** session | 200 — `SESSION_NEEDS_A_TABLE` must NOT fire |
| Un-merge the only table of a **table** session | 409 `SESSION_NEEDS_A_TABLE` (unchanged) |
| **Kumar (4321, kitchen) → any `/api/sessions` route** | **403** |
| **Kumar (4321, kitchen) → `/orders/:sessionId`** | **403** |
| Nina (1234, waiter) → both | allowed |
| Close a merged group, watch a **second** device | every table in the group returns to `open` (Trap 4) |
| Counter orders (n) affordance | appears at n>0, lists each, navigates correctly |

Seed accounts: **Nina 1234 `waiter`**, **Aruna 5678 `owner`**, **Kumar 4321 `kitchen`**.

---

### Project Structure Notes

- `architecture.md:741` places order entry at `(waiter)/tables/[tableId]/page.tsx`, inside a route group. **No route groups exist** — `src/app` is flat — and `tables/[tableId]/page.tsx` already records this divergence. This story adds `orders/[sessionId]/` at the same flat level. Whoever introduces `(waiter)`/`(owner)`/`(kitchen)` moves all of them together.
- `architecture.md:367` specifies plural-noun REST paths; `/api/sessions` follows it and matches the `/api/sessions/:sessionId/...` shape Epic 6 already assumes.
- Naming: `session_kind` for the enum type, `kind` for the column — consistent with `table_status` / `status` and `order_event_type` / `event_type`.

### References

- [Source: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-09-10-counter-sale.md`] — full impact analysis and the v1 scope decision
- [Source: `prd.md` FR64, FR18 as amended, MVP feature 2]
- [Source: `epics.md` Story 3.9; Epic 4 goal amendment; Story 3.6 and Story 6.5 amendments]
- [Source: `architecture.md:256-273`] — `order_session_tables` and why the unique index moved
- [Source: `src/server/auth/permissions.ts`] — default-allow, longest-prefix-wins, dynamic segments defeat specialisation
- [Source: `_bmad-output/implementation-artifacts/3-8-implement-within-zone-table-merging.md`] — the join table, the upsert in `attachTables`, and the journal trap

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

Verified with curl, psql, a real socket.io client, `tsc`, `eslint` and `next build`. No browser — see the gap at the end.

**Trap 3 fired exactly as written.** `drizzle-kit generate` produced `0008_faithful_satana` with `when: 1789036901592` — **6.4 hours EARLIER** than 0007's hand-set `1789060000000`. The journal orders by `when`, not filename, so `drizzle-kit migrate` would have reported success and applied nothing. Third occurrence in three stories. Bumped to `1789070000000`, then applied:

```
table_id  | uuid         |          |          (NOT NULL dropped)
kind      | session_kind | not null | 'table'::session_kind
```

**Trap 2 — the silent one — closed before it could open.** The policy went in before the first route existed under either prefix. Verified against the running app:

```
kumar (kitchen) POST /api/sessions   -> 403
kumar (kitchen) GET  /api/sessions   -> 403
kumar (kitchen) GET  /orders/:id     -> 307 -> /      (same shape as the existing /tables policy)
nina  (waiter)  POST /api/sessions   -> 201
nina  (waiter)  GET  /orders/:id     -> 200
```

The `/orders` result was checked against the `/tables` control rather than taken at face value — a 307 could equally have been the page's own `redirect('/')` for a missing session. Kitchen and waiter differ on the *same valid* session id, which is what proves the policy is doing it.

**AC-1 / AC-2 — a counter sale occupies nothing:**

```
POST /api/sessions -> 201
  kind=counter  table_id=NULL  join_rows=0
grid after:  13 rows, 0 occupied  (unchanged)
```

**AC-10 — deliberately unconstrained.** Three consecutive counter sales, three 201s, three open sessions. No index applies, and none should: `idx_one_open_session_per_table` constrains tables, and this has none.

**AC-7 — reachable.** `GET /api/sessions` listed all three with elapsed time and item count. Without it they would have been invisible, unreachable and un-closable while still counting in every revenue query — the Story 3.6 orphan state from a third direction.

**AC-3 — session-addressed order entry:**

```
GET /orders/:sessionId  (counter)      -> 200, header reads "Counter"
GET /tables/:tableId    (open table)   -> 307 -> /orders/:sessionId
GET /tables/:tableId    (closed table) -> 307 -> /
```

**AC-5 — a counter sale that gets seated:**

```
POST /api/sessions/:id/tables {"tableIds":["<Table 1>"]}  -> 200
  kind=table   table_id set   Table 1 = occupied
  grid: 13 rows, 1 occupied (Table 1);  counter list drops 2 -> 1
```

**AC-6 — the guard is about `kind`, not shape.** Both directions, on sessions holding exactly one table:

```
kind=table   un-merge its only table -> 409 SESSION_NEEDS_A_TABLE
kind=counter un-merge its only table -> 200, session still open, 0 attached
```

**AC-4 — close by session id:**

```
POST /api/sessions/:id/close {"reason":"abandoned"} -> 200
  releasedTableIds: []          (nothing to release)
  audit: SESSION_OPENED, SESSION_CLOSED   (identical to a table close)
```

**Socket behaviour, observed with a real client:**

```
open a counter sale   -> (no events)
close a counter sale  -> (no events)
attach a table to one -> occupied group=Table 3     ← the moment it joins the floor
```

Silence on the first two is the requirement, not an omission: the grid is a view of tables, and emitting for a session with none would make every device patch a row that does not exist.

**Not verified — the browser.** The **Counter** pill, the counter list, the **Seat at table** flow and the `+ New counter sale` tile are unexercised by curl. All are new UI. `tsc`, `eslint` and `next build` pass, and every endpoint behind them is verified above.

**Counter pill rework — 2026-09-11 (Tasks 8-9).**

The strip button and the separate `Counter orders (n)` list are both **deleted**. One pill replaces them:

```
floor page markup:  "Counter" x1   "No table" x1   "All zones" x1
                    "Counter sale" x0   <- the old strip button is gone
3 open counter sales, reachable only through the pill
```

The cards and the `+ New counter sale` tile are client-rendered on tap, so they are correctly absent from the initial HTML.

Three decisions worth recording:

- **The pill carries no count, it carries "No table".** Every other chip counts FREE tables — "Tables 3" means three available. A number here would mean ACTIVE ORDERS: the same-looking figure in the same-looking chip with the opposite meaning. The cards say how many there are, unambiguously.
- **The `+` tile acts on tap; counter cards select.** Story 3.7 made a tap SELECT because tapping a table used to seat a party. A labelled create affordance is the same thing a strip button is, and putting it behind select-then-confirm would be ceremony with nothing to protect. Anything representing a *live order* still selects.
- **`selectedCounterId` is separate state, and `selectedCounter` is derived from the live list.** Counter orders have no `tableId`, and forcing them through `selectedTableId` would mean inventing a fake one — the exact table-shaped assumption this story removes. Deriving means a counter sale closed on another device simply stops being selected, rather than leaving the strip offering actions on an order that no longer exists.

Switching view now has three entry points (zone chip, breadcrumb, Counter pill) and **all three end merge mode and clear the selection** — the same duty, applied consistently, after Story 3.8's review found merge mode surviving a zone change.

**Counter view is a LIST, not a grid — 2026-09-11.**

Teran's call again, and the reasoning holds: a grid implies *space*. A table card's position means that table is over there, which is the entire reason the floor plan is a grid. Counter sales have no location, so a grid promises a floor plan that does not exist — and the card size exists to carry status colour readable from ten metres, which is pointless for an order you are standing next to. A list is the honest form: a queue, not a place. It also expresses oldest-first, which a grid cannot.

Rows carry what a card had no room for: `Counter #4 · 11:41 am    No items yet · Nina`.

**Identity needed three fixes, and the last two were found by running it and by review.**

Start-time naming was proposed to avoid position numbers shifting — close the first of three and the second silently renames itself mid-service. But the live list immediately showed the flaw in that too:

```
Counter · 11:41 am   No items yet · Nina
Counter · 11:41 am   No items yet · Nina    <- same label, different customers
```

Two sales in the same minute is ordinary at a bar. The fix is a **day sequence derived per request** from every counter-origin sale in the day window, closed ones included — so the number is stable for as long as that window and that day's rows are, which is what "does not move mid-service" actually requires. (It is not persisted; an earlier note here claimed it was "assigned at creation", which the code does not do.) Verified:

```
before closing #1:  #1  #4  #5  #6  #7  #8
after  closing #1:      #4  #5  #6  #7  #8    <- nothing renumbered
```

The gaps are sales closed earlier in the day, which is correct: numbering the OPEN sales alone is precisely the bug being avoided.

**Closed sales are deliberately absent.** Same rule as tables — a settled table leaves the floor and a settled counter sale leaves with it. This screen is a live view of what still needs attention; completed sales belong to Epic 9's dashboard, where they can be totalled by day, and Epic 7's audit trail, where they can be filtered. Neither is something a floor screen should try to be.

**Seat at table — the UI for AC-5, 2026-09-11.**

AC-5 was satisfied server-side from the first pass but had no button: attaching tables to a counter session was reachable by API only. Teran asked what happens when a guest buys at the bar and then sits down, which is exactly the case with no way to perform it.

The flow reuses merge mode's shape, because it IS merge mode with a different anchor:

```
select the counter sale -> "Seat at table" -> tap the table -> "Seat at Table 1"
```

Entering it leaves the Counter view — the waiter has to see the floor to pick a table — and the staging banner is what keeps the sale in context while they are looking at it. On success the table they chose is selected, so the strip is already pointing at the order they are about to keep working on.

Verified end to end:

```
before: counter list = 3   Table 1 = open
seat -> 200
after:  counter list = 2   Table 1 = occupied
session kind = table, SAME session id throughout
audit: SESSION_OPENED, TABLE_MERGED
```

Same session, same items, same bill, same audit trail — only what it occupies changed. That is the payoff of Story 3.8's join table, and the reason this was half an hour rather than a story of its own.

**`seatTableIds` is separate state from `mergeTableIds`, deliberately.** The two have different anchors and different endpoints. One flag meaning two things is how Story 3.8's merge-anchor bug happened, and this is the third card-staging mode on one screen.

They are torn down by *different* functions, though — `endMergeMode` and `endSeating` — because merge is anchored to a TABLE and genuinely cannot outlive a zone change, while seating is anchored to a COUNTER SESSION that sits in no zone. Browsing zones to find where the guest sat is the entire point of the flow.

### Code Review Pass — 2026-09-11

Three parallel layers, every finding re-verified against the working tree. 18 patched, 1 decision resolved, 4 deferred, 0 dismissed. All three layers independently reached the same top five.

**The two that would have shipped broken:**

*Counter sales vanished at midnight.* The `startOfDay` filter was added to compute the day sequence and was applied to the LISTING as well — so a sale opened 23:50 and still open at 00:05 appeared on no card, in no list, at no URL anyone knew: un-closable, still counted in revenue and audit. Verbatim the orphan state this endpoint exists to prevent, and nightly for a bar. Open sales are now always listed whenever they started; the day window only decides numbering.

*The day boundary was the container's timezone.* `new Date().setHours(0,0,0,0)` gives midnight wherever Node runs. `docker-compose.yml` passes `TIMEZONE`, but **Node reads `TZ`** — so in production "today" began at 05:30 local and every Counter number renumbered mid-service. Invisible in development, because a developer's own machine is already in the restaurant's timezone. `tenant_config`… in fact `tenants.timezone`, seeded to `Asia/Colombo` since Story 1.3 and read by nothing until now, is what the boundary is computed from (`src/server/time.ts`). `TZ` is also set in compose, but only so logs match the restaurant's clock — correctness does not depend on deployment config.

**The decision, and what it exposed.** Seating was a one-way door: `attachTables` flipped `kind` to `'table'`, `releaseTable` exempts only `'counter'`, so a guest who bought at the bar, sat down and went back to the bar could not be un-seated. Teran chose to make it reversible — and the first attempt failed in verification, which is what produced the right design: **`kind` records where an order STARTED, not what it currently occupies.** It is set once and never changes; what the order occupies is `order_session_tables`' job and always was. The exemption then means what it says, Story 3.8's AC-11 is untouched for table-origin sessions, and Epic 9's revenue split is by origin, which is the honest basis for it.

This also means AC-6's counter branch is now genuinely reachable. The earlier "verification" of it came from hand-editing `kind` in SQL, which was not evidence and is corrected here.

**Live verification after the fixes:**

```
backdated counter sale (20h old, still open)  -> listed
seat a TABLE-origin session                   -> 409 NOT_A_COUNTER_SALE
seat a counter sale   -> 200, leaves the list, S1 occupied, kind stays 'counter'
un-seat               -> 200, back in the list, S1 open, table_id NULL
un-merge a table order's only table           -> 409 SESSION_NEEDS_A_TABLE
```

**Also fixed:** an unbounded `ITEM_ADDED` aggregate (a regression of a fix `/api/tables` already carried and documented); `releaseTable` locking closed sessions and reporting a missing one as "the only table on the order"; the seating mode able to outlive its anchor with no Cancel button — the same defect 3.8's review found in merge mode, reproduced by rendering from a derived value while branching on the raw one; a counter list with no live channel at all, now served by a payload-free `counter:changed` event; kitchen staff being shown a Counter pill and a create button that always 403; "This table has 3 items" on an order with no table; `undoUnmerge` dropping the anchor-staleness guard the forward path carries; a sequence with no tiebreaker; staged tables surviving a failed seat; and a successful seat selecting a table the zone filter was hiding.

### Completion Notes List

- **The model needed almost nothing.** Story 3.8's join table already expressed zero, one or many tables per session, so this story removed two constraints (`table_id NOT NULL`, and the last-table guard) rather than adding a concept. `order_session_tables` was not touched at all.
- **`kind` is a column, never inferred.** A table session passes through zero attached rows transiently while un-merging, so inferring "counter" from that state would let a race reclassify a table order. It also makes Epic 9's counter-vs-table revenue split a `GROUP BY`.
- **`openCounterSession` is separate from `openSession`.** One function that "sometimes takes a table" is how table-shaped assumptions leak back in — every guard grows a null branch. They share `writeAuditEvent`, which is the part that genuinely must be identical.
- **The order screen query was inverted, not patched.** The old page started `.from(tables)` and INNER JOINed to the session, so a table-less session was unreturnable *by construction*. The new one starts at the session and LEFT joins outward. That is the whole reason this story ran before Epic 4 rather than after.
- **`/tables/:tableId` was kept as a redirect.** Bookmarks and history keep working. The grid does not go through it — every row already carries `sessionId`, so it navigates straight to `/orders/:sessionId` and the redirect costs a round trip only for the stale-link case it exists to serve.
- **Both close routes stayed.** The table-addressed one resolves table → session and delegates to the same `closeSession`; a settled, unpaid and counter close must produce identical records. Story 3.6 established that and it was not re-litigated.
- **`freeTables` and `occupyTables` guard the empty array explicitly** rather than relying on Drizzle's `inArray(col, [])` behaviour, which is an implementation detail this code should not depend on.

### File List

**New**
- `src/app/api/sessions/route.ts` — open a counter sale (POST), list open counter sales (GET)
- `src/app/api/sessions/[sessionId]/close/route.ts` — close by session id
- `src/app/api/sessions/[sessionId]/tables/route.ts` — seat a counter sale (AC-5)
- `src/app/orders/[sessionId]/page.tsx` — session-addressed order entry
- `src/server/db/migrations/0008_faithful_satana.sql`
- `src/server/db/migrations/meta/0008_snapshot.json`

**Modified**
- `src/server/db/schema.ts` — `sessionKindEnum`; `order_sessions.table_id` nullable; `kind` column
- `src/server/db/migrations/meta/_journal.json` — 0008 entry, `when` corrected (Trap 3)
- `src/server/auth/permissions.ts` — `/api/sessions` and `/orders` policies (Trap 2)
- `src/server/services/table-session.service.ts` — `openCounterSession`; empty-array guards; `attachTables` promotes `counter` → `table`; last-table guard scoped to `kind = 'table'`
- `src/app/tables/[tableId]/page.tsx` — now a redirect to the canonical session URL
- `src/components/pos/order-screen.tsx` — keyed on `sessionId`; nullable table props; closes via the session route
- `src/components/pos/floor-action-strip.tsx` — counter and seating branches (the no-selection Counter sale button was replaced by the zone-bar pill in Task 8)
- `src/components/pos/table-grid.tsx` — counter list, seating mode, `counter:changed` subscription; navigates to `/orders/:sessionId`
- `src/components/pos/zone-chip-bar.tsx` — the Counter pill (Task 8)
- `src/lib/format.ts` — `clockTime()`, part of counter-sale identity
- `src/server/time.ts` — **NEW** — the restaurant's day boundary, from `tenants.timezone`
- `src/server/socket/events.ts` — `counter:changed`
- `src/app/api/tables/[tableId]/sessions/close/route.ts` — per-released-table emit (Story 3.8 Trap 4)
- `src/app/api/tables/[tableId]/unmerge/route.ts` — emits `counter:changed` when a session returns to the counter
- `docker-compose.yml` — `TZ`, so the process clock matches the restaurant

### Change Log

- 2026-09-10: Story created. Five ACs added beyond the epic: AC-7 (open counter orders must be reachable, or this story re-opens the orphan hole Story 3.6 closed), AC-9 (`/api/sessions` and `/orders` are default-allow and must be policed before any route ships under them), AC-10 (counter sessions are deliberately unconstrained), and AC-11 recorded as not deliverable until Epic 5. Four traps documented from reading the current code, one of which is a **live defect in Story 3.8**: the close route emits a single `table:status_changed` while `closeSession` releases every attached table, so closing a merged group leaves stale occupied cards on every other device.
- 2026-09-10: Implemented, Tasks 1-7. The model needed almost nothing — Story 3.8's join table already expressed zero tables per session, so this removed two constraints rather than adding a concept. Trap 3 (the migration journal) fired again and was caught by the check the story mandated: 0008 generated 6.4 hours *earlier* than 0007's hand-set timestamp and would have been silently skipped. Trap 2 was closed before it could open — the route policy went in before the first route existed under either prefix, and kitchen access was verified refused against a waiter control on the same session id. AC-11 (COUNTER ticket label) remains deferred to Epic 5, which still has no ticket generation. Browser pass outstanding for the two new UI surfaces.
- 2026-09-11: AC-1 and AC-7 amended after Teran reviewed the built UI. A strip button plus a separate counter-orders list read as two bolted-on surfaces in a table-first system; both are replaced by a **Counter pill in the zone bar**, which is already the "where am I looking" control, and counter orders become ordinary cards in the grid. The pill deliberately carries **no count**: every other pill counts FREE tables, so a count here would be the same-looking number with the opposite meaning. Tasks 8-9 added; status returned to `in-progress`. The reachability requirement behind AC-7 is unchanged — only the surface satisfying it.
- 2026-09-11: Tasks 8-9 built. Counter sale moved from a strip button plus a separate list to a single **Counter** pill in the zone bar, with counter orders as ordinary cards in the grid. Net deletion of UI surfaces: two became one, and counter orders now reuse the card, the selection model and the action strip. `tsc`, `eslint` and `next build` clean; pill and absence of the old button verified in the served markup. Status returned to `review`.
- 2026-09-11: Counter view rebuilt as a list after Teran flagged the card grid as unfriendly — correctly: a grid implies spatial position and counter sales have none. Rows now carry elapsed time, item count and who started the sale. Identity moved from list position to a server-assigned day sequence plus start time, after the running list showed two sales in the same minute sharing a label; stability verified by closing the first and confirming nothing renumbered. `GET /api/sessions` gained the staff name and the sequence. `tsc`, `eslint`, `next build` clean.
- 2026-09-11: Added the **Seat at table** flow, the UI half of AC-5. A guest who buys at the counter and then sits down keeps the same session, items, bill and audit trail; only the tables attached to it change. Reuses merge mode's staging shape with a counter session as the anchor. Verified end to end: counter list 3 -> 2, Table 1 open -> occupied, `kind` counter -> table, session id unchanged, `TABLE_MERGED` written. Staging state is separate from merge's but cleared by the same function, so the mode-survives-a-view-change defect found in 3.8's review cannot return through a third path.
- 2026-09-11: Fixed — seating only worked from "All zones". Zone changes called the shared `endMergeMode`, which cleared seating too, so tapping the Tables pill mid-flow silently ended the mode. The two are now separate: merge is anchored to a TABLE and genuinely cannot outlive a zone change, while seating is anchored to a COUNTER SESSION that sits in no zone — and browsing zones to find where the guest sat is the entire point of the flow. Seating now survives zone changes and the breadcrumb; it ends on Cancel, on success, or on returning to the Counter list.
- 2026-09-11: Code review (3 layers). 18 patched, 1 decision resolved, 4 deferred. Two would have shipped broken: counter sales vanished from the only list that reaches them at midnight, and the day boundary was the container's timezone rather than the restaurant's — the second invisible in development because a developer's machine is already in the right zone. The decision (should seating be reversible?) was resolved by making `kind` record where an order STARTED rather than what it occupies, which makes the last-table exemption mean what it says, leaves Story 3.8's AC-11 untouched, and makes AC-6 genuinely reachable rather than requiring hand-edited SQL to demonstrate. Three Dev Agent Record claims the review found unsupported were corrected rather than left standing. Status moved to `done`.
