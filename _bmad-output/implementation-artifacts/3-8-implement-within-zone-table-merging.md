# Story 3.8: Implement Within-Zone Table Merging

Status: done

- **Epic:** 3 — Zone & Table Navigation
- **Story ID:** 3.8
- **Story Key:** 3-8-implement-within-zone-table-merging
- **Created:** 2026-09-09
- **Origin:** `sprint-change-proposal-2026-09-06-merge-and-availability.md` — not in the original epic set

---

## ⚠️ READ FIRST

**This is the structural change Epic 3 has been building toward, and it must land before Epic 4.** Every order, ticket and billing story is about to be written on the assumption that a session belongs to exactly one table. `session.table_id` is referenced in **six** places today; after Epics 4–6 it will be everywhere.

The PRD has named merged tables a core differentiator since day one (`prd.md:38-40`) while the schema made it **inexpressible** — `order_sessions.table_id` is a single `notNull` column.

### Trap 1 — a hard-coded index name that fails silently

`src/app/api/tables/[tableId]/sessions/route.ts:22`:

```ts
const OPEN_SESSION_INDEX = 'idx_order_sessions_one_open_per_table'
```

`isOpenSessionConflict()` returns true only when the caught `23505` names **that** constraint. This story **moves the index to the join table under a new name**. If you do not update this constant, the function returns `false` for the new index, the error is rethrown, and the concurrency path returns **500 instead of 409**.

It fails silently in every way that matters: `tsc` passes, `eslint` passes, `next build` passes, and single-user testing never touches it. The only thing that catches it is a concurrent-tap test. Story 3.3's review established that the `23505` catch — not the pre-check — is the correctness mechanism for opening a table; breaking it undoes that.

### Trap 2 — five query sites join `order_sessions` to a table directly

Every one of these must go through the join table. Miss one and the grid, the order screen, or a guard silently stops seeing merged tables:

```
src/app/api/tables/route.ts:63                       ← the grid's leftJoin
src/app/api/tables/[tableId]/sessions/route.ts:121   ← open pre-check
src/app/api/tables/[tableId]/sessions/close/route.ts:95
src/app/api/tables/[tableId]/out-of-service/route.ts:95
src/app/tables/[tableId]/page.tsx:56                 ← order screen
```

That list is exhaustive as of 2026-09-09 (`grep -rn "orderSessions.tableId" src/`). Re-run the grep before you finish; if it returns anything you did not deliberately leave, you have missed one.

### Trap 3 — `closeSession` releases one table

`table-session.service.ts:109-111` does `UPDATE tables SET status='open' WHERE id = <tableId> AND status='occupied'`. A merged session must release **every** table in its group, or the others stay occupied forever with no session behind them — the exact permanently-stuck state Story 3.6 existed to eliminate.

---

## Story

As a waiter,
I want to seat one party across two or more tables in the same zone and take a single order for them,
So that a group that needs more space is still one order, one ticket and one bill.

---

## Acceptance Criteria

**AC-1: Merge is an explicit mode**
**Given** a waiter selects a table and taps "Merge"
**When** the merge mode is active
**Then** the action strip shows the anchor table, an instruction to tap tables to add, and Cancel / Done; tapping a table toggles it into the group with a clear visual state; single-tap never changes meaning outside this mode

**AC-2: Seat a party across several tables at once**
**Given** a merge group is confirmed on tables with no open session
**When** `POST /api/tables/:tableId/sessions` is called with `{ additionalTableIds: [...] }`
**Then** one `order_sessions` row is created and one `order_session_tables` row per table; every table's status becomes `occupied`; a `table:status_changed` event is emitted **per table**; HTTP 201 is returned

**AC-3: Cross-zone merges are refused**
**Given** a merge is attempted across zones
**When** the request is submitted
**Then** HTTP 422 is returned with `{ code: "CROSS_ZONE_MERGE" }`; all tables in a group must share a `zone_id`

**AC-4: Merge into a live session**
**Given** a waiter merges an additional table into a table that already has an open session
**When** `POST /api/tables/:tableId/merge` is called with `{ tableIds: [...] }`
**Then** the named tables join the existing session; they become `occupied`; the order, its items and its audit trail are untouched

**AC-5: Two live sessions cannot be combined**
**Given** both tables in a merge attempt already have open sessions
**When** the merge is submitted
**Then** HTTP 409 is returned with `{ code: "BOTH_TABLES_OCCUPIED" }` — combining two live orders is retroactive item re-assignment, a Growth-tier feature (`prd.md:113`)

**AC-6: A merged table explains itself on the grid**
**Given** a table belongs to a merged group
**When** its card renders
**Then** it displays as occupied, shows the group it belongs to (e.g. `BB1 + BB3`), and shares the group's elapsed time and item count — a waiter glancing at the second table must never see an unexplained occupied table

**AC-6 AMENDED (2026-09-10) — a merged group is ONE card, not two explained ones**

The original AC-6 asked a merged table to "explain itself" on the grid, and the implementation carried `groupTableLabels` to the action strip but never to the card - so two merged tables rendered as two ordinary occupied cards with the same timer and the same item count, reading as two separate parties who happened to sit down in the same second. Teran's call, and the right one: do not annotate the confusion, remove it.

**Given** a session occupies two or more tables
**When** the zone grid renders
**Then** the group appears as a **single card** titled with its tables (`B2 + B3`), spanning two grid columns, showing one timer, one item count and the **combined** seat count - and the member tables do not appear as separate cards until the session closes

Rejected alternatives, recorded so they are not re-proposed: a per-card partner chip plus a shared colour rail (annotates rather than removes); reordering the grid so group members sit adjacent (breaks the one thing card position buys a waiter); a frame drawn around the group (fails the moment someone merges Table 1 with Table 4).

**AC-14: The commit button states its consequence** *(added 2026-09-10)*
**Given** merge mode has staged at least one table
**When** the commit button renders
**Then** it reads `Merge B2 + B3`, naming the tables, rather than `Done (2)`

**AC-15: Merge and un-merge are undoable, and say so** *(added 2026-09-10)*
**Given** a merge or an un-merge has just committed
**When** the result notice appears
**Then** it offers **Undo** for 8 seconds; and if the undo cannot be applied - the released table was seated by another waiter, or the party settled inside the undo window - the notice reports the server's own reason rather than failing silently

**Carve-out:** the pre-merge path (opening a session with `additionalTableIds`) has no undo. It navigates to the order screen on success, so the grid that would host the notice is unmounted before there is anything to offer. Recorded here rather than left as a contradiction between this AC and Task 11.

**AC-16: Un-merge asks which table, and what happens to the food** *(added 2026-09-10)*
**Given** a merged group is selected
**When** Un-merge is tapped
**Then** the strip asks which table to release, and states that the released table returns to the floor while **its items stay on the order**

**Why no confirmation dialog.** A merge is reversible, and confirmation dialogs on a reversible action are the weakest error-prevention available - staff who merge twenty times a shift stop reading them within days and tap through reflexively, paying a tap every time for protection only against mistakes they were already making carefully. The rule applied here: **confirm what cannot be undone, undo what can.** A commit button that names the tables (AC-14) is read at the moment of decision; a dialog is read after it. The modal primitive is deliberately deferred to Epic 6 and Epic 7 - payment recording, voids and comps - where the action is irreversible, touches money, and writes an audit row that outlives the mistake. Spending the ceremony here would devalue it there.

**AC-7: Un-merge releases one table**
**Given** a waiter un-merges a table from an open group
**When** `POST /api/tables/:tableId/unmerge` is called
**Then** `released_at` is set on that `order_session_tables` row; the table returns to `open`; the session and its order continue on the remaining tables; if the released table was the primary, another table in the group is promoted

**AC-8: Closing releases the whole group**
**Given** a merged session is closed
**When** the close transaction commits
**Then** `released_at` is set on **every** table in the group and all of them return to `open`

**AC-9: Tickets name every table**
**Given** an order is submitted from a merged session
**When** the ticket is generated
**Then** it names every table in the session (FR18, amended 2026-09-06)

**AC-10: Merges are audited**
**Given** any merge or un-merge
**When** the transaction commits
**Then** an append-only row records the acting staff member, the tables affected, and the direction

**AC-11: The last table cannot be un-merged** *(added beyond the epic)*
**Given** a session has exactly one attached table
**When** un-merge is attempted on it
**Then** HTTP 409 is returned with `{ code: "SESSION_NEEDS_A_TABLE" }` — releasing it would leave an open session attached to nothing, which is the orphan state the whole close-table story exists to prevent. Close the session instead

**AC-12: Concurrency is decided by the database** *(added beyond the epic)*
**Given** two devices simultaneously merge the same free table into two different sessions
**When** both requests arrive
**Then** exactly one succeeds; the other receives 409 `TABLE_ALREADY_OCCUPIED`; the winner is decided by the partial unique index on the join table, not by application logic

---

## Tasks / Subtasks

- [x] **Task 1 — Schema: the join table and the index move** (AC: 2, 7, 8, 12)
  - `src/server/db/schema.ts`:
    ```ts
    export const orderSessionTables = pgTable('order_session_tables', {
      sessionId:  uuid('session_id').notNull().references(() => orderSessions.id),
      tableId:    uuid('table_id').notNull().references(() => tables.id),
      attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
      releasedAt: timestamp('released_at', { withTimezone: true }),
    }, (t) => [
      primaryKey({ columns: [t.sessionId, t.tableId] }),
      uniqueIndex('idx_one_open_session_per_table').on(t.tableId).where(sql`${t.releasedAt} IS NULL`),
      index('idx_order_session_tables_session_id').on(t.sessionId),
    ])
    ```
  - `primaryKey` is NOT currently imported in `schema.ts` — every existing table uses the `.primaryKey()` column modifier, which is a different thing. Add `primaryKey` to the `drizzle-orm/pg-core` import for the composite key.
  - **Remove** `uniqueIndex('idx_order_sessions_one_open_per_table')` from `orderSessions` (schema.ts:195). Keep `order_sessions.table_id` — it stays as the **primary** table for breadcrumbs, labels and ticket headers.
  - Why the index has to move: a partial index cannot reach into another table to ask whether a session is open. Holding `released_at` on the join row makes the invariant self-contained — and gives un-merge for free.
  - `pnpm db:generate`, then **check the generated SQL by hand**. It must backfill before it constrains:
    ```sql
    INSERT INTO order_session_tables (session_id, table_id, attached_at, released_at)
      SELECT id, table_id, opened_at, closed_at FROM order_sessions;
    ```
    Drizzle will not write that for you. Put it in a hand-written migration between the create and the unique index, or the index is created over an empty table and every existing open session loses its table.
  - Hand-written migrations need a `meta/_journal.json` entry — `drizzle-kit migrate` reads the journal, not the directory, and silently skips anything unlisted. Story 3.7 hit this.

- [x] **Task 2 — Fix the hard-coded index name** (AC: 12) — **do this immediately after Task 1**
  - `sessions/route.ts:22` — `OPEN_SESSION_INDEX` must become the new index name. See Trap 1: getting this wrong turns every concurrent tap into a 500 and nothing in the toolchain notices.
  - Update the two prose references too (`sessions/route.ts:61`, `api/tables/route.ts:44`).

- [x] **Task 3 — Audit event types** (AC: 10)
  - `orderEventTypeEnum` has no merge event. Add `TABLE_MERGED` and `TABLE_UNMERGED`.
  - **PostgreSQL constraint:** `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction that then *uses* the new value. Adding them in their own migration is fine — the code uses them at runtime, long after. Do not try to add a value and insert a row using it in one migration.
  - `order_events.session_id` is `notNull`, and a merge always has a session, so these belong there rather than in `table_status_events`. Put the affected table labels in `notes`.

- [x] **Task 4 — Service: attach, release, and release-all** (AC: 2, 4, 7, 8)
  - `table-session.service.ts` — all of these take a transaction handle, like their neighbours.
  - `openSession` gains an optional `additionalTableIds`; it inserts one join row per table and sets every table `occupied`.
  - `attachTables(tx, { sessionId, tableIds, staffId })` — AC-4. Inserts join rows, sets status, writes `TABLE_MERGED`.
  - `releaseTable(tx, { sessionId, tableId, staffId })` — AC-7. Sets `released_at`, returns the table to `open`, promotes a new primary if this was it, writes `TABLE_UNMERGED`.
  - **`closeSession` must release every table** — see Trap 3. Change `WHERE id = <tableId>` to a set drawn from the join table, and set `released_at` on all of them.
  - Concurrency: rely on the partial unique index. Catch `23505` on the new index name for AC-12 rather than pre-checking.

- [x] **Task 5 — Rewrite the five join sites** (AC: 2, 6, 8)
  - The list is in Trap 2. Each currently does `eq(orderSessions.tableId, <table>)`; each must go through `order_session_tables` filtered on `released_at IS NULL`.
  - `/api/tables` is the important one: it derives `status` from whether a session row came back, and that derivation must now see a table attached to a session through the join table. It also needs the group for AC-6 — add `groupTableLabels: string[]` (or a prepared `groupLabel`) to `TableGridRow`. Every table in a group shows the same elapsed time and item count, because they share one session.
  - Watch the join cardinality. The old `leftJoin` could not fan out because of the one-open-session-per-table index; the new one must not fan out either. Verify the grid returns exactly 13 rows for the seed, not more.

- [x] **Task 6 — Routes** (AC: 2, 3, 4, 5, 7, 11, 12)
  - `POST /api/tables/:tableId/sessions` — accept optional `additionalTableIds: string[]` (zod, each a UUID, deduplicated, anchor excluded). All tables must share a `zone_id` → 422 `CROSS_ZONE_MERGE`. Any already occupied → 409.
  - `POST /api/tables/:tableId/merge` — new. `{ tableIds: [...] }`. Anchor must have an open session; the named tables must not → 409 `BOTH_TABLES_OCCUPIED`. Same-zone rule applies.
  - `POST /api/tables/:tableId/unmerge` — new. 409 `SESSION_NEEDS_A_TABLE` when it is the last attached table (AC-11).
  - All three sit under `/api/tables`, already `owner + waiter` for writes via the existing policy. **Verify; do not add a policy** — Story 3.7 confirmed the namespace carries it.
  - Emit `table:status_changed` **per affected table**, after commit. The payload gained `unavailableReason` in 3.7's review; a merge does not change availability, so pass the table's existing value rather than hardcoding `null` — passing null would wipe the reason from every other device's cache.

- [x] **Task 7 — Merge mode in the action strip** (AC: 1, 6)
  - `floor-action-strip.tsx` — add a merge mode alongside the existing reason prompt, following the same pattern (a branch that replaces the strip contents, not a modal).
  - Mode state must not survive a selection change. Story 3.7's review found exactly this bug in the reason prompt: it retargeted to whatever was selected at submit time. The strip is keyed on `selectedTable?.id` in `table-grid.tsx`, which handles the anchor — but merge mode holds a *set* of tables, so it must live where it can span selections. Put the merge set in `TableGrid`, not in the strip.
  - While merge mode is active, tapping a card toggles membership rather than changing the selection. That is the one place single-tap changes meaning — it is why the mode is explicit, with a visible header and Cancel/Done.
  - Cards in the pending set need a distinct visual state, separate from `selected`.

- [x] **Task 9 — Collapse merged groups into one card** (AC: 6 amended)
  - `table-grid.tsx` - derive grid units from `visibleTables` before the map: rows with a `sessionId` **and** `groupTableLabels.length > 1` group by `sessionId`; everything else stands alone. A group is placed at the position of its first member so cards do not jump.
  - Grouping is safe over the zone-filtered list because a merge cannot span zones (AC-3). Do not group across the unfiltered set.
  - `selectedTableId` stays a **table** id; the strip receives the unit that contains it. That is what makes selection migrate for free when another device merges the selected table - the unit containing the id is found whether it is a single or a group.
  - Key the strip on the **unit** key, not the table id, so strip state resets when a selected table becomes part of a group.
  - **No backend change.** `sessionId` and `groupTableLabels` are already on `TableGridRow`.

- [x] **Task 10 — The merged card** (AC: 6 amended)
  - `table-card.tsx` - `groupLabels: string[]` and `wide: boolean`. Two tables spell out (`B2 + B3`); three or more truncate to `Table 1 +2` with the full list in the body.
  - Body reads `3 items · 2 tables · seats 8`. The seat count is **summed** - the number nobody can get today without adding cards in their head, and exactly what is needed to place a party of seven.
  - The status word in the band stays `OCCUPIED`. It is never replaced by "MERGED": merged is a second fact, not a substitute, and the card's existing note says the status word is not optional.
  - Accessible name names every table and the merge: `"B2 and B3, merged, occupied, 12 min"`.

- [x] **Task 11 — Commit wording and undo** (AC: 14, 15)
  - `floor-action-strip.tsx` - the merge commit button reads `Merge B2 + B3`, built from the anchor plus the staged labels; `Merge 4 tables` past three.
  - `table-grid.tsx` - extend the existing notice (`notice` state, already auto-dismissing) with an optional action and a per-notice TTL. 8 seconds for undo, the existing 4 for plain messages.
  - Undo of a **merge** un-merges each table that was added. Only applies to the merge-into-a-live-session path - the open-with-`additionalTableIds` path navigates to the order screen on success, so the grid is gone and there is nothing to undo onto.
  - Undo of an **un-merge** merges the table back, and can legitimately fail with a 409 because another waiter seated it. Say so: *"Couldn't undo — B3 was seated by someone else."*

- [x] **Task 12 — Un-merge picker** (AC: 16)
  - `floor-action-strip.tsx` - Un-merge opens a branch in the strip, the same shape as the reason prompt, listing the group's tables as buttons. The strip needs `groupTables: { id, label }[]`; `TableGridRow.groupTableLabels` carries labels only.
  - The consequence line is the point of the panel: *"The table returns to the floor. Its items stay on the order."* Nobody currently knows whether un-merging takes the food with it. It does not.
  - The picker is a **question**, not a confirmation - it exists because with one collapsed card there is no longer a selected table to infer the target from.

- [x] **Task 8 — Verify** (AC: all)
  - No test framework; manual, as every prior story. Matrix in Dev Notes.
  - **The concurrency test is not optional** — it is the only thing that catches Trap 1.

---

### Review Findings

Code review 2026-09-10 — three parallel layers (Blind Hunter on the diff alone, Edge Case Hunter with project access, Acceptance Auditor against the spec) plus verification of every claim against the working tree. **All three layers independently reached findings 1, 2 and 3.**

#### Decision needed

- [x] [Review][Decision] **Merge mode does not notice its anchor being taken by another device** [`src/components/pos/table-grid.tsx`] — Merge mode renders from `mergeTableIds` and never re-checks the anchor. Waiter 1 selects free table B2, taps Merge, stages B3 and B4. Waiter 2 opens an order on B2 from another tablet; the socket patches B2 to `occupied` with session S. Waiter 1's strip still reads "Merging with B2", unchanged. On confirm, `selectedTable.status === 'occupied'` is now true, so it takes the `mergeMutation` branch and **B3 and B4 are attached to waiter 2's session** — two parties' items on one bill. The server cannot detect this; the request is valid. Options: (a) capture the anchor's `status`+`sessionId` at `onBeginMerge` and refuse on confirm if either changed, showing a notice; (b) cancel merge mode automatically when the anchor's status changes underneath it; (c) send the expected `sessionId` with the request and have the server 409 on mismatch. **(c) is the only one that closes it across devices rather than just in this client.**
- [x] [Review][Decision] **A 3+ table group is never named on the card** [`src/components/pos/table-card.tsx`] — Task 10 specified "three or more truncate to `Table 1 +2` **with the full list in the body**". The body renders only a count (`· 3 tables`); the full list went to the action strip instead. So the grid shows `B1 +2` and nothing on the card says which tables — a waiter must select it to find out. The accessible name does carry every label, so the sighted grid is now strictly worse than the screen-reader one. Options: (a) build what Task 10 says — full list in the card body; (b) amend Task 10 to record the strip as the intended home. Note the card is `h-30` with a two-line body, so (a) needs a real layout decision, not just a string.

#### Patch

- [x] [Review][Patch] **The socket payload carries no group membership, so a merge only collapses on the device that performed it** [`src/server/socket/events.ts`, `src/components/pos/table-grid.tsx`] — `TableStatusChangedPayload` has six fields; `groupTableLabels` is not one, and the cache patch writes five. But `toGridUnits` decides a group exists *solely* by `groupTableLabels.length > 1`. Aruna merges B3 into B2: on Nina's tablet B3 patches to occupied with a `sessionId` but keeps `groupTableLabels: []`, and B2 gets no event at all, so both fail the length test and render as **two separate occupied cards with identical timers** — precisely the ambiguity the 2026-09-10 amendment exists to remove. Un-merge is the mirror: survivors keep labels naming a table that is now a free green card elsewhere in the same grid. Does not self-correct until a remount or socket reconnect. This also falsifies the open route's comment claiming "no client change was needed to support merging".
- [x] [Review][Patch] **Closing a merged session emits one event; the rest of the group stays occupied everywhere else** [`src/app/api/tables/[tableId]/sessions/close/route.ts`] — `closeSession` releases every attached table, but the route emits a single `table:status_changed` for the table the URL named. Closing `B1+B2+B3` from B1 leaves B2 and B3 occupied with stale `sessionId` and a running timer on every other tablet, indefinitely — nothing refetches on its own. The open and merge routes both loop; close was not updated. `closeSession` returns only `{ closedAt }`; have it return the released ids.
- [x] [Review][Patch] **AC-11's last-table guard is a read-then-write across two transactions** [`src/app/api/tables/[tableId]/unmerge/route.ts`] — The count runs in its own `db.transaction`, which closes before the release transaction opens, and `releaseTable` has no remaining-table check of its own. Two devices un-merging the two tables of a pair both read `attached.length === 2`, both pass, both commit under READ COMMITTED. Result: an open session with zero attachments — invisible on the floor plan, unreachable from any card, impossible to close through the UI, recoverable only by SQL. That is verbatim the state the route's own doc comment says it prevents, and it violates the story's own rule that the database decides races. Wrapping the read in a transaction makes it *look* atomic while buying nothing.
- [x] [Review][Patch] **A merge committing after a concurrent close leaves a table permanently stuck** [`src/server/services/table-session.service.ts` `attachTables`] — The merge route reads the open session outside the transaction and `attachTables` never re-asserts `closed_at IS NULL`. Device A closes the group and commits; device B's in-flight merge then inserts a join row with `released_at IS NULL` against the closed session and sets the table `occupied`. Every recovery path then refuses it: close → 409, un-merge → 409, out-of-service → 409 (fails the `status = 'open'` predicate), re-open → 409 on the unique index. Fix with a conditional `UPDATE … WHERE closed_at IS NULL RETURNING` or `SELECT … FOR UPDATE` on the session inside the transaction.
- [x] [Review][Patch] **Merge mode survives a zone change and becomes invisible and inescapable** [`src/components/pos/table-grid.tsx:786`, `:718`] — `onZoneChange` and `onNavigate` both clear `selectedTableId` and neither clears `mergeTableIds`. `selectedUnit` is derived from the zone-filtered list, so it goes null, the strip's merge branch (`mergeTableIds && table`) is skipped, and it falls through to the "No table selected" shell — **which has no Cancel button**. Meanwhile every card tap still takes the merge branch and stages tables silently, and the cross-zone guard is written `selectedTable && …` so a null anchor skips it entirely. No way out but a page reload.
- [x] [Review][Patch] **`openBodySchema.catch()` turns a malformed merge into a silent single-table seating** [`src/app/api/tables/[tableId]/sessions/route.ts`] — `.catch()` is applied to the whole object, so one non-UUID id or a 12-entry array discards the entire array rather than rejecting the request. The route returns **201** having seated the anchor alone, and the client treats 201 as success and navigates to the order screen — the waiter believes a party of eight is merged while eleven tables sit free. `.optional()` plus `request.json().catch(() => ({}))` already covers the absent-body case this was written for; the object-level `.catch()` only hides real errors. The sibling merge route does it correctly with `safeParse` → 400.
- [x] [Review][Patch] **The merge route broadcasts `itemCount: 0` for a session that may already have items** [`src/app/api/tables/[tableId]/merge/route.ts`] — Copied from the open route, where zero is true by definition; here it is false, because merging into a live session is the whole point of AC-4. Remote caches record 0 for the newly attached table, and since `buildUnit` picks `primary = ordered[0]` (first by label), merging A9 into B2 makes the group card read the merged-in table's count — a live twenty-item order showing "No items yet".
- [x] [Review][Patch] **`isUniqueViolation` in the merge route drops the index-name check the open route argues is mandatory** [`src/app/api/tables/[tableId]/merge/route.ts`] — Its comment says "same cause-chain walk as the open route"; it is not the same. The open route matches on the index NAME and spends a paragraph explaining why code-alone is unacceptable — a collision on any future second unique index would be reported to the waiter as "table already occupied" while the real cause never reaches a log, because the 409 branch does not log. Reintroduced 200 lines after the argument against it, in the same changeset. Extract one shared helper.
- [x] [Review][Patch] **A case-variant anchor UUID defeats the dedupe and produces a 500** [`src/app/api/tables/[tableId]/sessions/route.ts`] — The anchor is filtered out of `additionalTableIds` with a JavaScript string comparison, but PostgreSQL compares `uuid` case-insensitively and zod's `.uuid()` accepts either case. The anchor sent in uppercase survives the filter, so `allTableIds` contains it twice, and the insert violates the **primary key** rather than `idx_one_open_session_per_table` — so the name-matched `isOpenSessionConflict` returns false and it escapes as a 500. The filter also compares against `rawTableId` rather than the validated `tableId` used everywhere else in the function.
- [x] [Review][Patch] **Primary-table promotion is nondeterministic** [`src/server/services/table-session.service.ts` `releaseTable`] — `LIMIT 1` with no `ORDER BY`. The comment above it says the promotion exists because breadcrumbs and ticket headers read `order_sessions.table_id` directly — i.e. the value is user-visible — yet which table is promoted is whatever PostgreSQL returns first. The same party can print under different table names.
- [x] [Review][Patch] **The group-members query is missing the `zones.isActive` filter the grid query has** [`src/app/api/tables/route.ts`] — The main query filters `eq(zones.isActive, true)`; the members query that builds `groupTableLabels` does not. A group with a member in a deactivated zone therefore reports `groupTableLabels.length === 2` while only one row reaches the client. `buildUnit` sets `isGroup` from the server count (true) but `TableCard` recomputes `isMerged` from the assembled labels (false), so the card renders as an ordinary single table **spanning two grid columns**. The two sources must agree — pass the group size explicitly rather than deriving it twice.
- [x] [Review][Patch] **The reason prompt stays open after a successful take-out-of-service** [`src/components/pos/floor-action-strip.tsx`] — `submitReason` leaves the panel open, relying on "the parent unmounts this component on success via its `key`". The key is `selectedUnit.key`, which for a single table is the table id — unchanged by a status flip. So the panel re-renders asking "Why is B2 out of service?" for a table that already is, with `busy` cleared, and a second tap POSTs again for a 409. Pre-existing from Story 3.7; surfaced here because this diff introduced the file.
- [x] [Review][Patch] **The un-merge picker stays open after committing on a 3+ table group** [`src/components/pos/floor-action-strip.tsx`] — The strip is keyed on `selectedUnit.key`, which for a group is the session id and does not change when one table leaves. `onUnmerge` never calls `setUnmergeOpen(false)`, so the picker re-renders listing the now-smaller group while the undo notice is up — a double-release is one tap away at exactly the moment the waiter is being offered an undo.
- [x] [Review][Patch] **Undo-of-un-merge reports "seated by someone else" for every failure** [`src/components/pos/table-grid.tsx` `undoUnmerge`] — `throwFromResponse` maps both 409 and 422 to `TableTakenError`, so `SESSION_ALREADY_CLOSED`, `CROSS_ZONE_MERGE` and `TABLE_NOT_AVAILABLE` all surface as "Couldn't undo — B3 was seated by someone else", discarding the server's own wording this file otherwise goes out of its way to preserve. The common real path is the party settling inside the 8-second undo window.
- [x] [Review][Patch] **Non-409/422 server messages are read and then thrown away** [`src/components/pos/table-grid.tsx` `handleTableActionError`] — `throwFromResponse` is documented as "reads the server's own wording out of an error response", but only `ForbiddenError` and `TableTakenError` messages reach the user. A 404 `TABLE_NOT_FOUND` ("One of the tables does not exist") is parsed, carried all the way, then flattened to "Could not update the table. Try again."
- [x] [Review][Patch] **Stale comment asserts an invariant this diff removed** [`src/components/pos/table-grid.tsx`] — `/** Thrown when the table is out of service. The card should already be inert. */` survives untouched while the same changeset deletes `isInert`, `aria-disabled` and the grid's unavailable-tap guard. An unavailable card is now fully operable by design; the comment asserts the opposite.
- [x] [Review][Patch] **AC-15 is written unconditionally but the pre-merge path has no undo** [spec] — Task 11 carves out the open-with-`additionalTableIds` path (the grid unmounts on navigation, so there is nothing to undo onto) but AC-15 says "a merge **or** an un-merge" with no qualification, and is marked satisfied. Record the carve-out in AC-15.
- [x] [Review][Patch] **File List claims a change that does not exist** [spec] — `src/app/page.tsx - join-table lookup`. The actual change is a `staff.role` read added for Story 3.7's action strip; there is no session join on that page.
- [x] [Review][Patch] **Tasks 9 and 10 are labelled `(AC: 6 amended, 13)` — there is no AC-13** [spec] — The ACs run 1–12 plus 14–16. Two tasks are marked complete against an acceptance criterion that does not exist.

#### Deferred — real, but not caused by this change

- [x] [Review][Defer] **New routes perform no tenant scoping** [`merge/route.ts`, `unmerge/route.ts`] — deferred, pre-existing; already logged from Stories 3.3 and 3.7 reviews, unreachable under NFR-SC1
- [x] [Review][Defer] **Server rejects only `unavailable` merge targets while the client rejects anything not `open`** — deferred, pre-existing; requires drift between `tables.status` and the join table, and the join table is authoritative
- [x] [Review][Defer] **Group size is capped per request (11) but never in total** — deferred, pre-existing shape; `attachTables` has no cap and nothing counts existing members
- [x] [Review][Defer] **`idx_order_session_tables_session_id` duplicates the composite PK's leading column** — deferred; write cost for no read benefit, but removing it needs a migration
- [x] [Review][Defer] **`groupTableLabels` is ordered by plain SQL collation while the client sorts numerically** — deferred; latent, since only `.length` is consumed today, but the field's doc comment presents it as ordered and consumable
- [x] [Review][Defer] **`unavailableReason` hardcoded `null` in four emit sites, against Task 6's explicit instruction** — deferred; benign today because migration 0006's CHECK makes a reason impossible on a non-`unavailable` table, but the safety now rests entirely on a constraint from another story

**Dismissed as noise (1):** `ALTER TYPE … ADD VALUE` sharing migration 0007 with DDL — flagged against Task 3, but nothing in the file *uses* the new values and the project targets PostgreSQL 17, where this is valid.


---

## Dev Notes

### The model, and why one session

```
order_sessions            one row per PARTY
  ├─ table_id             the PRIMARY table (breadcrumbs, labels, ticket header)
  └─ order_session_tables one row per table the party occupies
       released_at NULL = currently attached
```

Orders, bills, payments and the audit trail all key on `session_id`. Keeping one session means every one of them works unchanged — **Epic 6 needs no new concept**, and the PRD's "merged tables settle individually" is delivered by the split-by-person it already specifies. Linked sessions would mean fanning out across a group on every read, in application code, forever.

### Existing invariants you must not break

| Invariant | Where | Note |
|---|---|---|
| One open session per table | moves to `order_session_tables` | The whole point of the index move |
| `23505` catch keyed on the index NAME | `sessions/route.ts:22` | Trap 1 |
| Status derived from the session join, never `tables.status` | `api/tables/route.ts:118` | Story 3.3's review; `tables.status` still owns `unavailable` only |
| Availability reason mirrors status | CHECK constraint, migration 0006 | Setting `occupied` with a null reason satisfies it; do not touch `unavailable_reason` |
| Emit after commit, never inside | every route | |
| 403 ≠ 401 on the client | `table-grid.tsx` | A sign-out loop, twice reviewed |

### Testing

| Case | Expect |
|---|---|
| Open with `additionalTableIds` (same zone) | 201; one session; N join rows; all tables occupied |
| …across zones | 422 `CROSS_ZONE_MERGE` |
| …one table already occupied | 409 |
| Merge into a live session | 200; order untouched; new table occupied |
| Merge two live sessions | 409 `BOTH_TABLES_OCCUPIED` |
| Un-merge a non-primary table | 200; table open; session continues |
| Un-merge the primary | 200; another table promoted |
| Un-merge the last table | 409 `SESSION_NEEDS_A_TABLE` |
| Close a merged session | every table returns to `open`; every join row has `released_at` |
| **Two devices merge the same free table concurrently** | **exactly one 201/200, one 409 — NOT a 500** |
| Grid row count with the seed | exactly 13 — proves the join does not fan out |
| Audit | `TABLE_MERGED` / `TABLE_UNMERGED` with staff and table labels |
| Browser | both cards show `BB1 + BB3`, same elapsed time, same item count |

Re-run Story 3.3, 3.6 and 3.7's matrices afterwards — this story rewrites code all three of them own.

`grep -rn "orderSessions.tableId" src/` must return only sites you deliberately kept.

### Previous story intelligence

- **The database decides races.** 3.3 catches `23505`; 3.6 and 3.7 use conditional UPDATE predicates with row counts. Never a read-then-write check.
- **Hand-written migrations need a journal entry** (3.7).
- **A CHECK constraint caught a real defect the moment it was added** (3.7 — the seed created `unavailable` tables with no reason). Constraints earn their keep here.
- **The socket patch carries whole fields.** Omitting one leaves the previous value in every remote cache — that was 3.7's High finding. If you add group info to `TableGridRow`, it must be in the payload and the patch too, or merged cards will show stale groups on other devices.
- **Mode state must not outlive its subject** (3.7: the reason prompt retargeted).
- **`tsc` + `eslint` + `build` clean means very little.** 3.2 passed all three while silently deleting its entire font scale.
- **Emit per table.** `architecture.md:381` documents `table:status_changed` as a per-table event precisely so the client's existing single-row patch keeps working.

### Project Structure Notes

- NEW: `src/app/api/tables/[tableId]/merge/route.ts`, `src/app/api/tables/[tableId]/unmerge/route.ts`, migrations (generated + hand-written backfill), possibly an enum migration
- UPDATE: `schema.ts`, `table-session.service.ts`, `api/tables/route.ts`, `sessions/route.ts`, `sessions/close/route.ts`, `out-of-service/route.ts`, `tables/[tableId]/page.tsx`, `table-grid.tsx`, `floor-action-strip.tsx`, `table-card.tsx`, `seed.ts` (join rows if it ever seeds sessions — it does not today)
- VERIFY ONLY: `permissions.ts`

### References

- [Source: epics.md#Story-3.8] — ACs, added 2026-09-06
- [Source: sprint-change-proposal-2026-09-06-merge-and-availability.md] — the model and why one session
- [Source: prd.md#FR62] — within-zone merging; cross-zone is explicitly out of v1
- [Source: prd.md:38-40, 273] — the positioning this finally implements
- [Source: architecture.md#Data-model-—-merged-table-sessions] — the join table and the index move
- [Source: epics.md#Story-6.5] — amended to delegate to the shared close service; it must release all tables
- [Source: 3-3, 3-6, 3-7 story files] — route patterns and 37 review findings between them

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

Verified with curl, psql, `drizzle-kit`, `tsc`, `eslint` and `next build`. No browser - see the gap at the end.

**Migrations.** `drizzle-kit generate` produced `0007_worthless_bloodstorm.sql`; the backfill INSERT was hand-added between the CREATE TABLE and the unique index, exactly as Task 1 warned - Drizzle does not write it, and without it every open session loses its table the moment the index lands.

`0007` also needed its `meta/_journal.json` `when` bumped to `1789060000000`. Migration 0006's hand-picked timestamp was ahead of drizzle's real clock, so 0007's generated `when` sorted as *older* and `drizzle-kit migrate` reported success while doing nothing. The journal is ordered by `when`, not by filename - a second instance of the trap Story 3.7 hit, arriving from the opposite direction.

**AC-2 / AC-6 - seating a party across two tables in one act:**

```
POST /api/tables/:B2/sessions {"additionalTableIds":["<B3>"]}   -> 201
B2 = occupied, B3 = occupied, one session, same openedAt
groupTableLabels = ["B2","B3"] on both cards
grid row count   = 13          (no join fan-out - Task 5's cardinality check)
```

**AC-3 / AC-4 / AC-5 - the merge policy:**

```
merge across zones                      -> 422 CROSS_ZONE_MERGE
merge a table with its own open session -> 409 BOTH_TABLES_OCCUPIED
merge a free table into a live session  -> 200
```

**AC-7 / AC-11 - un-merge and the last-table guard:**

```
un-merge Table 3 from a two-table group -> 200   Table 1 occupied, Table 3 open
un-merge the only remaining table       -> 409   SESSION_NEEDS_A_TABLE
```

**AC-8 - closing releases the whole group.** Closed from Table 2; Table 3 was released by the same transaction:

```
before : Table 2 + Table 3
close  -> 200
after  : Table 2 open (released), Table 3 open (released)
```

Trap 3 confirmed closed - the old `WHERE id = <tableId>` would have left Table 3 occupied forever, with no session to reach it from.

**AC-12 - concurrency, run twice because Trap 1 has two faces.** Both races fired as genuinely simultaneous requests from two authenticated sessions:

```
two devices MERGE the same free table into different sessions
  A -> 409 BOTH_TABLES_OCCUPIED      B -> 200
  resulting open attachments for that table: 1

two devices OPEN a session on the same free table   (the Trap 1 site)
  A -> 201                           B -> 409 TABLE_ALREADY_OCCUPIED
  resulting open attachments for that table: 1
```

Neither returned a 500, which is the whole point: a stale `OPEN_SESSION_INDEX` makes the `23505` catch miss and every losing tap becomes an internal error. The constant was renamed in Task 2, and this is the only check that proves it.

**AC-10 - the audit trail, and a gap found while checking it:**

```
 event_type     | notes   | staff
 TABLE_MERGED   | Table 3 | Nina
 TABLE_UNMERGED | Table 3 | Nina
 TABLE_MERGED   | Table 3 | Aruna
```

The gap: opening a session *with* `additionalTableIds` wrote only `SESSION_OPENED`. Seating a party across three tables in one tap is a merge by any reading of AC-10, and the event stream - which is what Epic 7's audit view reads - could not say which tables were put together, or by whom. The join rows carry `attached_at`, so the fact existed, but not where the audit lives. `openSession` now takes `additionalTableLabels` and writes a second `TABLE_MERGED` row when the list is non-empty:

```
 SESSION_OPENED |         | Aruna
 TABLE_MERGED   | Table 3 | Aruna
```

**Browser pass done - 2026-09-10, by Teran.** AC-1 and the client half of the amended AC-6 confirmed in the running app: merge mode as an explicit mode, tapping cards to toggle membership, the collapsed group card, the un-merge picker, and undo on both directions. Nothing behaved unexpectedly.

**AC-9 is not deliverable in this story.** It constrains ticket generation, and no ticket generation exists - Epic 5 is unbuilt. `groupTableLabels` is the data it will need; recorded in deferred-work.md so it is not lost when Epic 5 starts.

**Collapsed group card, undo, and the picker (2026-09-10).**

Live payload with a three-table group standing, and the units the card map derives from it:

```
label    status     session   groupTableLabels
B1       occupied   7b2f298d  ['B1','B2','B3']
B2       occupied   7b2f298d  ['B1','B2','B3']
B3       occupied   7b2f298d  ['B1','B2','B3']
S1..R3   open       -         []

-> grid units
B1 +2            GROUP wide   seats=8      (2 + 2 + 4, summed)
S1 … R3          single       seats=2..8
13 tables, 11 cards
```

The truncation rule fires at three (`B1 +2`), the full list moves to the strip's detail line, and the seat count is summed — which is the number a waiter actually needs and could not previously get without adding cards up in their head.

**A real bug found by building undo.** Un-merging a table and then merging it back returned **409 BOTH_TABLES_OCCUPIED** — a message describing a situation that was not happening. The join row's primary key is `(session_id, table_id)`, so a table that was once on this session still has a row, released but present; the plain INSERT hit that key and the 23505 handler reported it as someone else's order. The effect in service: **un-merge the wrong table and you could never put it back.** Undo was what walked into it, but the bug was reachable by hand from the first day of the story.

`attachTables` now upserts — `onConflictDoUpdate` on the primary key, setting `released_at = null`. The partial unique index is untouched by this: a table attached to a *different* open session has no primary-key conflict, so the insert still violates `idx_one_open_session_per_table` and still returns a 409 that now means what it says.

```
re-merge a table previously on this session      -> 200   B1 + B2 + B3
un-merge B3, undo, group restored                -> 200   B1 + B2 + B3
release B3, Aruna seats it, then undo            -> 409   BOTH_TABLES_OCCUPIED
   (surfaces as "Couldn't undo — B3 was seated by someone else.")

join rows for B3: one per distinct session, reopened rather than duplicated
```

**Anchor labelling.** The commit button and the undo notice both named only the anchor's own label, so merging a fourth table into `B1 + B2 + B3` promised `Merge B1 + Table 5` for an action producing a four-table party. Both now build from the whole group. That was the one thing the button exists to get right.

`tsc` clean, `eslint` clean, `next build` passes.

### Code Review Pass — 2026-09-10

Three parallel layers (Blind Hunter on the diff alone, Edge Case Hunter with project access, Acceptance Auditor against the spec). **All three independently reached the same top three findings**, and every finding was re-verified against the working tree before being recorded. 21 fixed, 6 deferred, 1 dismissed.

**The review earned its keep on one finding above all.** `groupTableLabels` was added to `TableGridRow` and to nothing else — not the socket payload, not the cache patch — while `toGridUnits` decides a group exists SOLELY from that array. So the collapsed group card worked only on the device that performed the merge; every other tablet rendered the party as two occupied cards with identical timers, which is the exact ambiguity the 2026-09-10 amendment was written to remove. The browser pass could not have caught it: the acting device invalidates its own query and therefore looks correct.

**Four findings meant the feature was broken across devices**, three of them needing a specific two-device interleaving:

| Finding | Failure |
|---|---|
| Socket payload carried no group | Merged card collapsed only on the acting device |
| Close emitted one event | Closing a group left the other tables occupied everywhere else |
| Last-table guard read-then-write | Two devices could orphan a session with zero tables |
| `attachTables` never re-checked `closed_at` | A merge landing after a close stranded a table that *every* recovery route then refused |

**Resolved decisions.** The anchor race — merge mode staged against a free table that another device then seated, silently attaching the staged tables to the stranger's order — is closed at the server: the client snapshots the anchor at `onBeginMerge`, branches on that snapshot rather than on current status, and sends `expectedSessionId`; the server returns 409 `ANCHOR_CHANGED` on mismatch. Chosen over a client-only guard because it protects every device rather than one. And Task 10's "full list in the body" was built rather than amended away: a merged card already spans two columns, so `B1 + B2 + B3` fits, and the sighted grid should not be worse informed than the accessible name.

**Live re-verification after the fixes:**

```
invalid additionalTableIds (non-UUID)  -> 400   (was 201 with a silent single-table seating)
invalid additionalTableIds (12 entries)-> 400
absent body                            -> 201   (unchanged — absent is still valid)

two devices release the last two tables of a pair, simultaneously
  A -> 200        B -> 409 SESSION_NEEDS_A_TABLE
  attached after the race: 1 table — no orphan

socket, observed with a real client through a full merge lifecycle:
  open R1 + R2      -> occupied group=R1+R2 · occupied group=R1+R2
  un-merge R2       -> open group=[]        · occupied group=R1      ← survivor told
  close a 2-table group -> open group=[]    · open group=[]          ← both released
```

The survivor event is the one worth noting: un-merge previously emitted only for the released table, so other devices kept a group card titled "B2 + B3" while B3 sat beside it as a free green card — the same table in two contradictory states on one screen.

**Not re-checked in a browser.** The card-body group list (Task 10, built during this pass) has never been seen rendered. It is one line of text in a card that already spans two columns, and `tsc`, `eslint` and `next build` all pass — but it is a visual change nobody has looked at.

### Known Defect — found 2026-09-10 while writing Story 3.9, FIXED in the review pass above

**Closing a merged group notifies other devices about one table only.**

`closeSession` releases **every** attached table (verified above, AC-8). But the close route emits a single `table:status_changed`, hardcoded to the table the request was addressed through:

```ts
// src/app/api/tables/[tableId]/sessions/close/route.ts
emitTableStatusChanged({ tableId: table.id, status: 'open', ... })
```

So closing `B1 + B2 + B3` from B1 tells other tablets about **B1 only**. B2 and B3 stay `occupied` on every device except the one that acted — which invalidates its own query and therefore looks correct to whoever made the change. It self-corrects on a refetch or a socket reconnect, so it presents as "the grid was wrong for a while".

The cause is that `closeSession` returns only `{ closedAt }`, giving the route no way to know what it released. **Fix:** return the released table ids and emit one event per id.

Triaged by the 2026-09-10 code review, which reached it independently on two of three layers, and **fixed**: `closeSession` now returns `releasedTableIds` and the route emits one event per released table. Verified with a socket client — closing a two-table group produces two `open` events.

### Completion Notes List

- **The index moved rather than being duplicated.** A partial unique index cannot reach into another table to ask whether a session is open, so `idx_one_open_session_per_table` now lives on `order_session_tables (table_id) WHERE released_at IS NULL`. That single move buys three things: the one-session-per-table invariant stays self-contained, un-merge becomes a timestamp write rather than a delete, and AC-12 needs no application-level locking.
- **`order_sessions.table_id` was kept**, as the *primary* table for breadcrumbs and ticket headers. Removing it would have touched every read in the app for no gain; `releaseTable` promotes a new primary when the primary itself is un-merged.
- **One session, not linked sessions.** Orders, bills, payments and the audit trail all key on `session_id`, so keeping one session means Epic 6 needs no new concept at all, and the PRD's "merged tables settle individually" is delivered by the split-by-person it already specifies.
- **Merge mode state lives in `TableGrid`, not the strip.** The strip is keyed on the selected table id, so its own state is destroyed on every selection change - which is what fixed Story 3.7's retargeting bug - but a merge set spans selections by definition. Putting it in the strip would have recreated 3.7's defect with worse consequences: one party's items on another party's bill.
- **`emitTableStatusChanged` passes `unavailableReason: null` from both new routes deliberately.** Merge refuses `unavailable` tables and un-merge returns a table to `open`, so null is the true value in both - not a hardcode that wipes a live reason from other devices' caches, which is what 3.7's review warned about.

- **Collapsing is a pure rendering change.** `toGridUnits` groups the already-fetched rows by `sessionId`; no endpoint, query or socket payload changed. The data was on the row from Task 5 — it had simply never reached the card.
- **Selection is looked up by unit membership, which is what makes it survive a remote merge.** Nina has B3 selected; Aruna merges it into B2 from the other tablet; B3's card stops existing. Because the strip is handed *the unit containing the selected table id*, the selection becomes the group card instead of going null and emptying the strip out from under her.
- **A group takes the grid position of its first member.** Collapsing must not shuffle the rest of the zone, or every merge would cost every waiter their card positions.
- **`isGroup` reads the server's `groupTableLabels`, not the number of rows assembled.** If a member row were ever missing from the filtered list, the card must still say "group" rather than quietly presenting a party's second table as an ordinary single.
- **Open tables are never merged, so the zone chip counts are unaffected.** The concern that a manager counting cards would miscount free tables turns out not to arise: only occupied cards collapse, and the chip bar counts `status === 'open'`.
- **No confirmation dialog, by decision.** See the story's rationale above AC-7. The commit button names the tables, and undo carries the recovery; the modal primitive is left for Epic 6/7 where actions are irreversible.

### File List

**New**
- `src/app/api/tables/[tableId]/merge/route.ts`
- `src/app/api/tables/[tableId]/unmerge/route.ts`
- `src/server/db/migrations/0007_worthless_bloodstorm.sql`
- `src/server/db/migrations/meta/0007_snapshot.json`

**Modified**
- `src/server/db/schema.ts` - `orderSessionTables`; unique index moved off `orderSessions`; `TABLE_MERGED` / `TABLE_UNMERGED` enum values; `primaryKey` import
- `src/server/db/migrations/meta/_journal.json` - 0007 entry, `when` corrected
- `src/server/services/table-session.service.ts` - `attachTables`, `releaseTable`, `attachedTableIds`; `openSession` gains `additionalTableIds` / `additionalTableLabels`; `closeSession` releases every attached table
- `src/app/api/tables/[tableId]/sessions/route.ts` - `OPEN_SESSION_INDEX` renamed (Trap 1); `additionalTableIds` body schema; per-table events
- `src/app/api/tables/[tableId]/sessions/close/route.ts` - join-table lookup
- `src/app/api/tables/route.ts` - two-hop grid query; `groupTableLabels` on `TableGridRow`
- `src/app/tables/[tableId]/page.tsx` - join-table lookup
- `src/app/page.tsx` - reads `staff.role` for the action strip (Story 3.7 work, carried in this changeset)
- `src/components/pos/floor-action-strip.tsx` - merge mode, Un-merge, group in the detail line
- `src/components/pos/table-grid.tsx` - merge set state, toggle-on-tap while merging
- `src/components/pos/table-card.tsx` - `pendingMerge` visual state
- `src/server/socket/events.ts` - emitted per table
- `src/lib/format.ts` - `mergedTitle()`
- `src/components/pos/table-card.tsx` - `groupLabels`, `wide`, summed seats, group-aware accessible name
- `src/components/pos/table-grid.tsx` - `GridUnit` / `toGridUnits`, unit-based selection, undo notices
- `src/components/pos/floor-action-strip.tsx` - un-merge picker, commit button naming, group title in the header
- `src/server/services/table-session.service.ts` - `attachTables` upserts, so a released table can be re-attached

### Change Log

- 2026-09-09: Story created. Two ACs added beyond the epic: AC-11 (the last attached table cannot be un-merged, or an open session is left attached to nothing — the orphan state Story 3.6 exists to prevent) and AC-12 (concurrency decided by the partial unique index, stated explicitly because the index move is what makes it fragile). Three traps documented from reading the current code: a hard-coded index name in `sessions/route.ts:22` whose staleness would turn every concurrent tap into a 500 with no compile-time or lint signal; a complete five-site inventory of direct `orderSessions.tableId` joins that must all move to the join table; and `closeSession` releasing only one table, which on a merged session would leave the others permanently occupied.
- 2026-09-09: Implemented. Join table and index move applied (migration 0007, backfill hand-added). Trap 1 (stale index constant), Trap 2 (five direct-join sites) and Trap 3 (close releasing one table) all closed and verified. AC-10 extended beyond the written implementation after finding that a pre-merged open recorded no merge event. AC-1 and the visual half of AC-6 await the browser pass shared with Stories 3.6 and 3.7; AC-9 deferred to Epic 5, which has no ticket generation to constrain yet. Status held at `in-progress`.
- 2026-09-10: AC-6 amended and AC-14/15/16 added after Teran ran the merge on the floor screen. Merged tables were indistinguishable from single occupied ones - the card never received `groupTableLabels`, so a group rendered as two ordinary cards sharing a timer. Resolved by collapsing a group to one card rather than labelling two, which removes the ambiguity structurally instead of annotating it. A confirmation dialog was considered and rejected in favour of a self-describing commit button plus undo; the modal primitive is deferred to Epic 6/7 where the actions are irreversible. Tasks 9-12 added. No backend change - the data was already on the row.
- 2026-09-10: Built Tasks 9-12. Merged groups now render as one card; the commit button names the tables; merge and un-merge both offer undo; un-merge asks which table and states that items stay on the order. One genuine bug fixed on the way: `attachTables` could not re-attach a table that had previously been on the same session (primary-key collision reported as BOTH_TABLES_OCCUPIED), which made a mistaken un-merge irreversible. Verified against the running stack. Browser pass still outstanding, so the story stays `in-progress`.
- 2026-09-10: Browser pass completed by Teran; merge mode, the collapsed group card, the un-merge picker and undo all confirmed in the running app. Status moved to `review`. AC-9 (tickets name every table) is still not deliverable here and stays logged against Epic 5.
- 2026-09-10: Code review (3 layers, 28 findings). 21 patched, 6 deferred, 1 dismissed. The material outcome: merging was broken across devices in four separate ways, none of them visible to a single-tablet browser pass — the socket payload never carried group membership, closing a group notified one table, the last-table guard was a read-then-write across two transactions, and a merge landing after a concurrent close could strand a table beyond every recovery route. Both open decisions were resolved and built: the anchor race is closed server-side with `expectedSessionId` / 409 `ANCHOR_CHANGED`, and Task 10's full group list is now on the card. Status moved to `done`.
