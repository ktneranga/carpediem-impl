# Sprint Change Proposal — Merged Tables & Table Availability

- **Date:** 2026-09-06
- **Raised by:** Teran, from UI mockups of the floor screen
- **Triggering context:** Reviewing the action-strip design ahead of Epic 4
- **Scope classification:** **Major** for merged tables (core data model + MVP scope decision) · **Minor** for table availability

---

## 1. Issue Summary

Two gaps, found the same way: a mockup showed an action the system cannot perform.

### Issue A — Merged tables are a stated differentiator with no implementation path

The PRD names merged tables as one of the two things the product exists for:

> "group dynamics where **merged tables from different zones settle individually**" — `prd.md:38`
> "**Merged table + split settlement engine.** Groups that span zones, merge mid-service, and settle in separate ways are **standard beach restaurant operations — not edge cases**." — `prd.md:40`

It also underpins the competitive claim at `prd.md:273` ("the operational signature — fluid roles, **merged outdoor zones**, cash-heavy — is ignored by general-purpose systems").

But:

| Where | Status |
|---|---|
| MVP feature list (`prd.md:100-109`) | **Absent.** Nine features; merging is not one. |
| Functional requirements | **No FR.** The nearest, FR10, is seat slots on *a single table*. |
| Epics / stories | **Nothing.** Epic 6 splits a bill by person — a different problem. |
| Growth (post-MVP) | Only "merged table mid-service **re-assignment**". |
| Schema | `order_sessions.table_id` — single, `notNull`. One session belongs to exactly one table. |

The schema line is decisive: this is not "unbuilt", it is **inexpressible**. And note the Growth tier defers only *retroactive* re-assignment — even the simple case, seating a party across two tables from the start, has no home in any tier.

**Scope clarification from Teran:** merging happens **within a zone**, not across. Two bean bags, or two adjacent tables — not a bean bag plus a rooftop table. This narrows the problem considerably and makes the constraint enforceable.

### Issue B — No way to change a table's availability

`tables.status` has an `unavailable` value that only the seed ever sets. No route changes it. A waiter finding a torn sun-bed cover cannot take it out of service; nobody can put it back.

Story 10.3 specifies `PATCH /api/tables/:tableId` for renaming, but not availability — and that route sits under the `/api/tables` policy, which is `owner + waiter` for every write. **The latent widening flagged in Story 3.3's code review is therefore already live in the plan**, not hypothetical: a table-configuration route reachable by waiters, against `prd.md:341-357` reserving configuration for owner.

**Decision from Teran:** asymmetric permissions. A **waiter can take a table out of service** with a reason; **only an owner can return it to service.**

### Evidence

- `grep` for merge-related FRs returns nothing; the only hits are positioning prose and a competitor analysis of Oracle MICROS (`ux:269`) describing what *they* do well.
- `order_sessions.table_id` is `uuid ... notNull` (`schema.ts:150`), with `idx_order_sessions_one_open_per_table` enforcing one open session per table.
- No code path writes `tables.status` except the seed, the open route (`→ occupied`) and the close route (`→ open`).

---

## 2. Impact Analysis

### Issue A — Merged tables

| Epic | Impact |
|---|---|
| **Epic 3** | **New story** (merge / unmerge). **Amend 3.3** — open a session on one *or more* tables. **Amend 3.6** — closing releases every table in the group. |
| **Epic 4** | Order entry is already session-scoped, so items need no change. The order screen header shows one table label and must show the group. |
| **Epic 5** | **FR18 conflict** — "each printed ticket includes **table identifier**" (singular). A merged order's KOT must name every table, or the kitchen runner cannot find the party. Story 5.1's `KOTTicket` shows "table identifier". |
| **Epic 6** | Structurally unaffected — bills hang off `session_id`. The PRD's "merged tables settle individually" is delivered by the existing split-by-person, with no new billing concept. **This is the payoff for keeping one session.** |
| **Epic 9** | 9.3's long-open-tables card counts sessions, not tables; a merged group is one row. Cosmetic. |
| Epics 7, 8, 10, 11, 12 | No impact. |

**Schema:** requires a migration — the first structural change since Story 1.3.

**MVP scope:** the MVP feature list does not currently include merging. Adding it **expands MVP scope**, which is a product decision, not a technical one. Flagged for explicit sign-off in §3.

### Issue B — Table availability

| Artifact | Impact |
|---|---|
| **Epic 3 or 10** | New story — take out of service / return to service. |
| **Story 10.3** | Owns table configuration but does not cover availability; its `PATCH /api/tables/:tableId` sits on a waiter-reachable prefix. |
| `permissions.ts` | Needs owner-only enforcement for return-to-service that prefix matching can express. |
| Audit | `tables.status` changes are currently unrecorded — no who, no why. |

### Artifact conflicts summary

| Artifact | Conflict |
|---|---|
| `prd.md` | Positioning promises merging; MVP scope omits it; no FR for either issue. |
| `epics.md` | No merge story; FR18 assumes one table per ticket; 10.3 lacks availability. |
| `architecture.md` | Data-model section needs the join table; `table:status_changed` payload carries a single `tableId`. |
| `ux-design-specification.md` | Action strip variants (`ux:679`) list Start Order / Add Round / Settle / Split — no Merge, no availability actions. |
| `schema.ts` | `order_sessions.table_id` single-valued; unique index must move. |

---

## 3. Recommended Approach

### Issue A — Direct Adjustment, **one session across many tables**

```sql
order_session_tables (
  session_id  uuid not null references order_sessions(id),
  table_id    uuid not null references tables(id),
  attached_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (session_id, table_id)
)

create unique index idx_one_open_session_per_table
  on order_session_tables (table_id) where released_at is null;
```

**Why one session and not linked sessions.** Orders, bills, payments and the audit trail already hang off `session_id`. Keep one session and all of them work unchanged — Epic 6 in particular needs no new concept. Linked sessions would mean fanning out across a group on every read, forever, in application code.

**Why the index moves.** The current `idx_order_sessions_one_open_per_table` cannot express the invariant once tables live in a join table — a partial index cannot reach into another table to ask whether the session is open. Putting `released_at` on the join row makes the constraint self-contained, and gives un-merge for free.

`order_sessions.table_id` is retained as the **primary** table (breadcrumbs, labels, ticket headers). The join table holds every table including the primary.

**Within-zone constraint** is enforced server-side: all tables in a group must share `zone_id`. Cheap to check, and it prevents the cross-zone case the PRD describes but the restaurant does not actually run.

- **Effort:** Medium — one migration, one new story, three amended stories
- **Risk:** Medium now, **High if deferred** (see below)
- **Timeline:** No impact on Epic 4 if done first

### Issue B — Direct Adjustment, routed as configuration

Return-to-service is a *configuration* action, so it belongs under the prefix that is already owner-only:

```
POST /api/config/tables/:tableId/return-to-service      → owner only, via existing policy
POST /api/tables/:tableId/out-of-service  { reason }    → owner + waiter, via existing policy
```

`{ prefix: '/api/config', roles: ['owner'] }` already exists. **Zero permissions changes**, and the asymmetry falls straight out of the two prefixes.

- **Effort:** Low · **Risk:** Low

### Why not defer merging

`session.table_id` is referenced in four places today. Epics 4, 5 and 6 are about to build order entry, ticket routing and the entire billing engine on the one-table-per-session assumption. Deferring means reworking the billing engine later; doing it now is a migration and one story.

This is the same shape as the close-table gap found this morning, one layer deeper.

### Rollback / MVP Review

Rollback is not applicable — nothing built is wrong, something is missing. MVP Review **is** relevant and is the one thing needing your explicit call: merging is not currently in the MVP list, and adding it grows v1.

---

## 4. Detailed Change Proposals

### 4.1 PRD — add FR62 and FR63

**NEW, after FR61:**

> - **FR62:** Staff can merge two or more tables **within the same zone** into a single order, either before taking the order or mid-service. A merged group behaves as one session for ordering, ticketing and billing, while every table in the group displays as occupied and shows the group it belongs to. Staff can un-merge a table from a group while the session is open. Merging across zones is out of scope for v1.
> - **FR63:** Any staff member can take a table **out of service** with a reason. **Only an owner can return a table to service.** Both actions are recorded in the append-only audit trail with the acting staff member, the reason, and a timestamp.

**Also amend the MVP feature list (`prd.md:100-109`), item 1:**

> OLD: **Zone-aware table management** — 4 zones (bean bags, sun beds, tables, rooftop), table status (open/occupied/closed)
> NEW: **Zone-aware table management** — 4 zones (bean bags, sun beds, tables, rooftop), table status (open/occupied/unavailable), within-zone table merging, and staff-initiated out-of-service with owner-only restoration

*(Note: the existing text says "closed", which is not a value in `tableStatusEnum` — corrected to `unavailable` in passing, consistent with the 2026-08-21 schema note.)*

### 4.2 Epics — new Story 3.7 (Merge and Un-merge Tables)

Placed after 3.6. Key ACs:

- Merging is entered explicitly from the action strip, never by ambiguous multi-select; the strip switches to a merge mode naming the anchor table with Done / Cancel
- All tables in a group must share a zone → 422 `CROSS_ZONE_MERGE` otherwise
- Merging an occupied table into another occupied table is refused in v1 → 409 `BOTH_TABLES_OCCUPIED` (that is the Growth-tier "retroactive re-assignment", which requires deciding whose items are whose)
- Every table in the group renders occupied, shows the group membership, and shares the group's elapsed time and totals
- Un-merge releases one table while the session continues; un-merging the primary promotes another table
- `table:status_changed` is emitted for every affected table
- Merge and un-merge each write an append-only audit event

### 4.3 Epics — new Story 3.8 (Table Availability)

- `POST /api/tables/:tableId/out-of-service { reason }` — owner + waiter; refused with 409 if the table has an open session
- `POST /api/config/tables/:tableId/return-to-service` — **owner only**, enforced by the existing `/api/config` policy
- Action strip is role-aware: a waiter selecting an unavailable table sees the state and reason, no button
- Both transitions write an audit event with actor, reason and timestamp

### 4.4 Epics — amend Story 3.3

> **Then** `POST /api/tables/:tableId/sessions` is called *(amended: accepts an optional `additionalTableIds` array for a merged seating; all tables must share a zone)*; a row is created in `order_sessions` **and one row per table in `order_session_tables`** …

### 4.5 Epics — amend Story 3.6

> **Then** … the `order_sessions` row has `closed_at` and `closed_by_staff_id` set; **`released_at` is set on every `order_session_tables` row for the session**; every table in the group returns to `open` …

### 4.6 Epics — amend Story 5.1 and FR18

> OLD (FR18): Each printed ticket includes **table identifier**, seat identifiers, item names, quantities, and ticket type label
> NEW (FR18): Each printed ticket includes **every table identifier in the session** (e.g. `BB1 + BB3`), seat identifiers, item names, quantities, and ticket type label

Without this a kitchen runner carrying a KOT for a merged party has one table name and two possible destinations.

### 4.7 Epics — amend Story 10.3

Add a note that availability is owned by Story 3.8 and routed under `/api/config`, and that `PATCH /api/tables/:tableId` (rename) must be moved under `/api/config` or given owner-only enforcement — it is currently waiter-reachable.

### 4.8 Architecture — data model and event payload

- Document `order_session_tables` and the moved unique index
- `table:status_changed` currently carries a single `tableId`; a merge changes several tables at once. Either emit per table (simplest, keeps the existing client patch logic) or add a `groupId`. **Recommend per-table emits** — the client's `setQueryData` patch already handles one table per event and needs no change.

---

## 5. Implementation Handoff

**Scope: Major** (merged tables) · **Minor** (availability)

| Recipient | Responsibility |
|---|---|
| **Teran / PM** | Confirm merging enters v1 MVP scope — it is not in the current MVP list. |
| **Architect** | Approve the join-table model and the index move before the migration is written. |
| **Developer** | Story 3.8 (availability, small) then Story 3.7 (merge, with migration). |

### Sequencing

1. **Story 3.8 — availability.** Small, self-contained, no schema change. Unblocks the mockup's third state.
2. **Story 3.7 — merge.** Must land **before Epic 4**. Every order, ticket and billing story built on one-table-per-session raises the cost.
3. Then Story 4.1.

### Success criteria

- A party seated across two bean bags produces **one** session, one order, one KOT naming both tables, and one bill splittable by person
- Every table in a group shows as occupied with visible group membership
- Un-merging releases one table without disturbing the order
- Cross-zone merges are refused
- A waiter can take a table out of service; only an owner restores it
- Every merge, un-merge and availability change is in the audit trail with actor and reason

### Explicitly out of scope

- **Cross-zone merging** — the PRD describes it; Teran confirms the restaurant does not work that way. FR62 states v1 is within-zone. `prd.md:38` and `:40` keep their language as market positioning, but the FR is the buildable truth.
- **Merging two already-occupied tables** — that is the Growth-tier "mid-service re-assignment", and it needs an item-ownership decision this proposal does not make.
- **Counter sale** — visible in the mockups, in no document, and impossible today (`order_sessions.table_id` is `notNull`). Parked as a separate decision.
- **Money on table cards** — the mockups show LKR totals; not in `TableCard`'s contract or `/api/tables`. Belongs with Epic 4/6.
