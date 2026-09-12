# Sprint Change Proposal — Counter Sale (Orders Without a Table)

- **Date:** 2026-09-10
- **Raised by:** Teran, from UI mockups of the floor screen — and again while questioning whether the table-first flow was the right architecture
- **Triggering context:** Epic 3 implementation complete; Epic 4 (order entry) about to start
- **Scope classification:** **Major** — expands MVP scope and changes URL addressing across three unbuilt epics
- **Decision:** **Option 1 — ship in v1.** Approved by Teran, 2026-09-10. FR64 added, FR18 amended, MVP feature 2 amended, Story 3.9 added to Epic 3 ahead of Epic 4, and Epic 4's goal amended to require session-addressed routing.

---

## 1. Issue Summary

A customer can walk to the bar, buy a beer, and leave. Carpe Diem RMS cannot record that sale.

Every order in the system begins by occupying a table. `order_sessions.table_id` is `notNull`, the only route that creates a session is `POST /api/tables/:tableId/sessions`, and the only entry point in the UI is a table card on the floor grid. There is no path from "a customer wants to buy something" to a recorded sale that does not pass through seating them.

### Where it is missing

| Where | Status |
|---|---|
| MVP feature list (`prd.md:95-109`) | **Absent.** Nine features; none covers a sale without a table. |
| Growth / Vision tiers | **Absent.** Not deferred — never considered. |
| Functional requirements | **No FR.** `grep -i "counter\|takeaway\|walk-in\|quick sale"` across the PRD, epics and UX spec returns **zero** hits. |
| Epics / stories | **Nothing** in any of the twelve epics. |
| Schema | `order_sessions.table_id uuid NOT NULL` — a session without a table is **inexpressible**. |

This is the same shape as the merged-tables gap found on 2026-09-06: not unbuilt, but unrepresentable, and absent from every tier so it cannot even be said to have been deferred.

### Why it surfaced now

Two independent routes to the same place:

1. **The mockups.** A counter-sale affordance appears in Teran's floor-screen designs and was parked on 2026-09-06 as "in the mockups, in no document", alongside "money on table cards".
2. **A challenge to the architecture.** On 2026-09-10 Teran asked whether the whole table-first flow was a mistake — whether an order should be started from items and have tables attached afterwards, "and if we don't need a table we can remove them as well."

The second is worth recording, because the answer reframes the problem. **Story 3.8 already made the model order-first.** Tables now attach to a session through `order_session_tables`; `order_sessions.table_id` is only a primary-table breadcrumb for ticket headers. A session with three attachment rows is a merged party, one row is an ordinary table — and **zero rows is a counter sale.** The model reached that shape as a side effect of merging. Only two constraints and the UI still assume a table exists.

So this is not an architectural reversal. It is finishing a change already made.

### Evidence

- `order_sessions.table_id` is `uuid('table_id').notNull()` — `src/server/db/schema.ts`
- Session creation is `POST /api/tables/:tableId/sessions`; close is `POST /api/tables/:tableId/sessions/close`; the order screen is `src/app/tables/[tableId]/page.tsx`. **Every one is addressed by table, not by session.**
- `SESSION_NEEDS_A_TABLE` (Story 3.8 AC-11) refuses to release the last table from a session, on the reasoning that an open session attached to nothing is unreachable. That reasoning is correct *for a table session* and must not be applied to a counter session.
- FR18 requires every ticket to name every table in the session. A counter sale has none.

---

## 2. Impact Analysis

### The cheap part — the data model

| Change | Cost |
|---|---|
| `order_sessions.table_id` → nullable | One migration |
| `order_sessions.kind` → `'table' \| 'counter'` (new enum, default `'table'`) | Same migration |
| `SESSION_NEEDS_A_TABLE` becomes conditional on `kind = 'table'` | Two lines |

**`kind` should be an explicit column, not inferred from "zero attachment rows".** A table session passes through zero attached rows transiently while un-merging, and inferring the type from a transient state means a race can turn a table order into a counter order. The owner dashboard will also want to separate counter revenue from table revenue, which is a query against a column, not against the absence of join rows.

`order_session_tables` needs no change at all. It already expresses zero, one, or many tables per session.

### The expensive part — every URL is addressed by table

This is the real finding, and it is the argument for doing this **before Epic 4 rather than after**.

| Epic | Impact |
|---|---|
| **Epic 3** | New entry point. The action strip's "No table selected" state is currently a dead end reading *"Tap a table to see what you can do with it"* — that is where **Counter sale** belongs, filling a state that has no other purpose. **Amend Story 3.6**: closing must be addressable by session, since a counter session has no table id to close through. |
| **Epic 4** | **Largest impact, and entirely avoidable if done first.** The order screen is `/tables/[tableId]`. A counter order has no `tableId`. Order entry must be addressed by **session** — `/orders/[sessionId]`, with the table route redirecting to it — or every screen Epic 4 builds will have to be retrofitted. Story 4.1 (`OrderActionStrip`) and 4.5 (submission) both assume a table context. |
| **Epic 5** | **FR18 conflict.** Every ticket must name every table in the session; a counter ticket names none, and a blank destination line sends the runner nowhere. Needs an explicit `COUNTER` label. Same class of conflict FR18 already absorbed for merged tables on 2026-09-06. |
| **Epic 6** | Structurally fine — bills key on `session_id`. Two behavioural notes: a counter sale should close on payment with **no table to release**, and it is the one order type that is realistically **paid before it is prepared**. Story 6.5's auto-close needs to tolerate a session with no tables. |
| **Epic 9** | Counter revenue should be distinguishable on the dashboard. One `GROUP BY kind`. Minor, and only possible because `kind` is a column. |
| **Epic 7** | No impact. Audit events key on `session_id`. |
| **Epics 8, 10, 11, 12** | No impact. |

### Artifact conflicts summary

| Artifact | Conflict | Resolution |
|---|---|---|
| `prd.md` MVP list | No counter sale | Add to feature 2 (Order entry), pending the scope decision in §3 |
| `prd.md` FR18 | "every table identifier in the session" | Amend — a counter ticket is labelled `COUNTER` |
| `prd.md` FRs | No FR for table-less orders | **New FR64** |
| `epics.md` Epic 3 | No story | **New Story 3.9** |
| `epics.md` Story 3.6 | Close is addressed by table | Amend — close by session |
| `epics.md` Epic 4 | Order screen assumes a table | Amend 4.1 and 4.5 — session-addressed routing |
| `epics.md` Story 6.5 | Auto-close releases a table | Amend — tolerate zero tables |
| `schema.ts` | `table_id notNull` | Migration 0008 |

---

## 3. The Decision That Is Not Mine

**Adding counter sale expands MVP scope.** The MVP list is prefaced *"Nothing is optional within this list"*, and this would become the tenth item. That is a product call, not a technical one, and it is flagged here for explicit sign-off exactly as merged tables was.

The technical recommendation is narrower and holds either way:

> **Whether or not counter sale ships in v1, Epic 4 should address the order screen by `session_id` rather than `table_id`.**

Session-addressed routing costs nothing extra to build now and is the whole cost of the feature later. Building Epic 4 table-addressed is the decision that would be expensive to reverse — every order screen, the submission flow, and the ticket routing would need retrofitting. If counter sale is deferred to Growth, this one change keeps the door open for a migration and a button.

### Options

| | Path | Consequence |
|---|---|---|
| **1** | **Counter sale in v1** — new FR64, Story 3.9 before Epic 4 | MVP grows by one feature. The gap that makes the product look unfinished to anyone POS-literate closes. Recommended if walk-up sales happen at Carpe Diem at all. |
| **2** | **Defer to Growth, but route by session now** | No MVP growth. Epic 4 built session-addressed. Counter sale becomes a small story later — a migration and a button — instead of a retrofit. |
| **3** | **Defer entirely** | Cheapest today. Epic 4 hard-codes table addressing, and adding counter sale later means reworking the order screen, submission and ticket routing. **Not recommended.** |

---

## 4. Proposed FR

> **FR64:** Staff can start an order that is not attached to any table — a counter sale — for walk-up customers who are not seated. A counter order behaves as an ordinary session for item entry, ticketing, billing, payment and audit; it differs only in having no table, appearing on no floor-plan card, and being labelled `COUNTER` on tickets and bills. Tables can be attached to a counter order later if the customer is subsequently seated, and a counter order may be settled before the items are produced. *(Added 2026-09-10 — sprint-change-proposal-2026-09-10-counter-sale.md. A customer buying a beer at the bar could not be recorded at all: `order_sessions.table_id` was `notNull` and every route was addressed by table.)*

**FR18 amendment:** *"Each printed ticket includes every table identifier in the session (e.g. `BB1 + BB3` for a merged group) — or the label `COUNTER` where the session has no table — seat identifiers, item names, quantities, and the ticket type label."*

---

## 5. Proposed Story — 3.9: Implement Counter Sale

**As a** waiter or owner,
**I want** to take an order that is not tied to any table,
**so that** a customer buying at the bar can be served and recorded without occupying seating.

Acceptance criteria in outline — full BDD to be written by `create-story`:

1. A **Counter sale** action exists on the floor screen in the no-selection state, and creates a session with no table
2. A counter session appears on **no** table card and changes **no** table's status
3. The order screen is reachable for a session that has no table
4. A counter session can be closed without payment, addressed by session id, with the same reasons and the same audit records as a table session
5. Tables can be attached to a counter session afterwards, at which point it behaves as an ordinary table order
6. `SESSION_NEEDS_A_TABLE` applies only to sessions of kind `table` — a counter session legitimately has none
7. Tickets and bills for a counter session are labelled `COUNTER` (FR18 as amended)
8. Counter sessions are attributable and audited identically to table sessions

**Sequencing:** before Epic 4, for the addressing reason in §2. Same argument that put Stories 3.6, 3.7 and 3.8 before Epic 4 rather than after.

---

## 6. Explicitly Out of Scope

- **Takeaway packaging, collection codes or customer names.** A counter sale is an anonymous immediate sale. Anything else is a different feature.
- **Tabs at the bar** — a counter order left open across several rounds. The model permits it; nothing in this proposal requires it.
- **"Money on table cards"** — still parked, still in the mockups and in no document. Unrelated to this change.
