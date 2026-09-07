# Sprint Change Proposal — Table Release Without Payment

- **Date:** 2026-09-06
- **Raised by:** Teran, from the running application
- **Triggering story:** 3.3 — Implement Open Table Session (`done`)
- **Scope classification:** **Moderate** — new story in an existing epic, one AC amended in a later epic, one new functional requirement. No architecture or schema change.

---

## 1. Issue Summary

**A table can be occupied but never released.**

Tapping an open table card creates an `order_sessions` row and marks the table `occupied`. Nothing anywhere in Epics 3 through 12 can set `closed_at`. The only close in the entire plan is a side effect of payment, in Story 6.5:

> **Given** the last open bill in a session is marked `"settled"`
> **Then** the `order_sessions` record is closed by setting `closed_at` and `closed_by_staff_id`

Working backwards from that, releasing a table requires: **orders submitted → bill generated → payment recorded → auto-close.** Each step gates the next. Story 6.2 triggers bill generation from the `OrderActionStrip` in state `"submitted"`, which a session with no items never reaches. With no bill, 6.5's condition can never be satisfied.

**So an empty session is permanently unreleasable, and remains so even after Epic 6 ships.** This is not an early-implementation gap that later work closes — there is no path in the plan at all.

### How it was found

Teran, using the running application, asked why a table showed as occupied when no order had been placed and no confirmation had been given. Investigating the "should there be a confirmation?" question surfaced the larger problem: a confirmation would reduce mis-taps but would not create a way back from one.

### Evidence

- `grep` across `src/` finds no code path writing `closed_at`, `closed_by_staff_id`, or closing a session. The only matches are read filters (`isNull(orderSessions.closedAt)`).
- `grep` across `prd.md` and `epics.md` for `walkout`, `abandon`, `void`, `release`, `no-show`, `cancel session` returns **zero** matches.
- Story 3.3's own verification left nine of thirteen tables stuck occupied. Clearing them required raw SQL against the database, because the application offers no way to do it. That is the bug demonstrating itself.
- FR60 / Story 9.3 surfaces "long-open tables" on the owner dashboard — it flags the symptom and offers no remedy.

### Real-world cases this blocks

This is not only about mis-taps. Three ordinary service situations produce a session that can never close:

| Situation | Why the plan cannot handle it |
|---|---|
| Mis-tap on the wrong card | No orders → no bill → no close |
| Party seated, leaves before ordering | Same |
| **Walkout** — guests leave without paying | Orders exist, but no payment is ever recorded, so the bill never settles |

The walkout case is the most serious: it is a real event in any restaurant, it has direct revenue and audit consequences, and the plan has no representation for it.

---

## 2. Impact Analysis

### Epic Impact

| Epic | Impact |
|---|---|
| **Epic 3 — Zone & Table Navigation** | **Add one story.** This is where a table's lifecycle lives; opening is 3.3, so releasing belongs here. |
| **Epic 6 — Bill Settlement** | **Amend Story 6.5.** Its auto-close should delegate to the new close service rather than reimplementing the write, so both paths produce identical audit records. |
| **Epic 9 — Owner Dashboard** | **No change required.** Story 9.3's long-open card becomes genuinely actionable once a close path exists, but its ACs stand as written. |
| Epics 4, 5, 7, 8, 10, 11, 12 | No impact. |

Epic 3 can still be completed as planned; this adds to it rather than invalidating anything. No epic becomes obsolete, and no resequencing is needed.

### Artifact Conflicts

| Artifact | Conflict | Action |
|---|---|---|
| `prd.md` | No requirement covers releasing a table without payment. FR60 flags long-open tables but nothing resolves them. | Add **FR61**. |
| `epics.md` | Epic 3 has no close story; Story 6.5 owns the only close and assumes settlement. | Add Story 3.6; amend one AC in 6.5. |
| `architecture.md` | **No conflict.** `table:status_changed` is already the specified event, and the Core Data Flow pattern (emit co-located with the DB write) covers this unchanged. | None. |
| `ux-design-specification.md` | No screen or flow currently offers a close action. | Note only — the button lives on the order screen, which Epic 4 rebuilds. |
| `schema.ts` / migrations | **No conflict — the model already supports this.** See below. | None. |

### The schema already anticipated this

```ts
orderEventTypeEnum = pgEnum('order_event_type', [
  'SESSION_OPENED', 'SESSION_CLOSED', ..., 'SESSION_SETTLED',
])
```

`SESSION_CLOSED` and `SESSION_SETTLED` are **distinct enum values**, and both already exist. The data model was designed for a close that is not a settlement; only the epics failed to spec the story. `order_sessions` already has `closed_at` and `closed_by_staff_id`, and `order_events` already has a nullable `menu_item_id` and a `notes` column suitable for a session-level record.

**Consequence: no migration, no schema change, no architecture revision.** This is materially cheaper than it first appeared.

### Related finding — `SESSION_OPENED` is never written

Nothing writes a `SESSION_OPENED` audit event either. Story 3.3 creates the session row but records no audit event, though the enum value exists and the append-only audit trail is the product's stated core differentiator (`architecture.md:78`). The new story should close both halves so open and close are symmetric in the audit trail.

### Technical Impact

Small and contained: one Route Handler, one service function, one button, one audit-event write, reusing the existing `emitTableStatusChanged`. No new dependencies. Roughly a third of Story 3.3's size.

---

## 3. Recommended Approach

### Option 1 — Direct Adjustment ✅ **Selected**

Add Story 3.6 to Epic 3; amend Story 6.5 to delegate; add FR61 to the PRD.

- **Effort:** Low
- **Risk:** Low — additive, no migration, no rework of shipped code
- **Timeline:** No impact on Epic 4; 3.6 can run in parallel or immediately before

### Option 2 — Rollback

Not viable, and not desirable. Story 3.3 is correct as built — a table *should* go occupied when guests are seated, before any order exists. That is standard POS behaviour and matches FR-level intent ("single tap without any setup steps"). Nothing needs reverting; something needs adding.

### Option 3 — MVP Review

Not warranted. The MVP is achievable; this is a missing capability inside it, not a scope problem. If anything, the MVP is *more* achievable with this story than without it, because a demo currently degrades with every accidental tap and cannot be reset without database access.

### Why not a confirmation dialog instead

Considered and rejected as the primary fix:

- It fights the stated requirement — Story 3.3 exists to make seating a one-tap action with no setup steps, and waiters seat tables constantly during service.
- It does not address walkouts or parties that leave before ordering, which are not mistakes.
- It does not help the common error, which is tapping the *wrong* table and confirming out of habit.

A close action makes every one of these recoverable. **A confirmation only makes the mistake slower to commit.**

---

## 4. Detailed Change Proposals

### 4.1 PRD — add FR61

**Section:** Functional Requirements (after FR60)

**NEW:**

> - **FR61:** Staff can close an open table session without payment, recording a reason (`abandoned` — opened in error or the party left before ordering; `walkout` — the party left without paying). The table returns to `open` immediately on all devices. Closing without payment is recorded in the append-only audit trail with the acting staff member, and appears on the owner dashboard distinctly from settled sessions.

**Rationale:** No existing requirement covers releasing a table without money changing hands. FR60 flags long-open tables; nothing resolves them. Walkouts are a real revenue event with no representation in the product.

---

### 4.2 Epics — add Story 3.6 to Epic 3

**Section:** Epic 3 — Zone & Table Navigation, after Story 3.5

**NEW:**

> ### Story 3.6: Implement Close Table Without Payment
>
> As a waiter,
> I want to release a table that was opened by mistake or whose party left without ordering or paying,
> So that the floor plan stays true and a wrong tap is not permanent.
>
> **Acceptance Criteria:**
>
> **Given** a waiter is on the order screen for an open session with no submitted items
> **When** they tap "Close table" and choose the reason `abandoned`
> **Then** `POST /api/tables/:tableId/sessions/close` is called with `{ reason: "abandoned" }`; the `order_sessions` row has `closed_at` and `closed_by_staff_id` set; `tables.status` returns to `open`; a `table:status_changed` event is emitted and every connected device updates within 2 seconds
>
> **Given** the session being closed has submitted items
> **When** the waiter chooses the reason `abandoned`
> **Then** HTTP 409 is returned with `{ code: "SESSION_HAS_ITEMS" }` — a session with orders in it is a walkout or a bill, never an abandonment; the reason must be `walkout`, which requires the confirmation below
>
> **Given** a waiter closes a session with submitted items as `walkout`
> **When** the close is submitted
> **Then** an explicit confirmation is required before the request is sent, stating the unpaid total; the session closes; the unpaid amount is recorded so it is not silently lost from revenue
>
> **Given** any session is closed without payment
> **When** the close transaction commits
> **Then** an append-only `order_events` row is written with `event_type: 'SESSION_CLOSED'`, the acting `staff_id`, and `notes` carrying the reason; this happens in the same transaction as the close, so a closed session always has its audit record
>
> **Given** a session is opened
> **When** the `order_sessions` row is created
> **Then** an append-only `order_events` row is written with `event_type: 'SESSION_OPENED'` and the acting `staff_id`, in the same transaction — closing the existing gap where sessions are created with no audit event despite the enum value existing (retrofit to Story 3.3's endpoint)
>
> **Given** two devices attempt to close the same session simultaneously
> **When** both requests arrive concurrently
> **Then** exactly one succeeds; the second receives HTTP 409 `{ code: "SESSION_ALREADY_CLOSED" }`; the close is conditional on `closed_at IS NULL` within the transaction, so the database decides the winner
>
> **Given** a kitchen staff member attempts to close a session
> **When** `POST /api/tables/:tableId/sessions/close` is called
> **Then** HTTP 403 is returned — closing is a write on `/api/tables`, already owner + waiter under the method-scoped policy
>
> **Note:** No schema change is required. `SESSION_OPENED` and `SESSION_CLOSED` already exist in `orderEventTypeEnum`, and `order_sessions` already has `closed_at` and `closed_by_staff_id`.

**Rationale:** Gives the table lifecycle a terminal state that does not require payment, makes mis-taps recoverable, and gives walkouts a first-class representation in the audit trail.

---

### 4.3 Epics — amend Story 6.5

**Section:** Epic 6, Story 6.5, the auto-close AC

**OLD:**

> **Given** the last open bill in a session is marked `"settled"`
> **When** the payment Route Handler checks remaining open bills
> **Then** the `order_sessions` record is closed by setting `closed_at` and `closed_by_staff_id` (there is no `status` column — see the schema note on Story 3.3); a `table:status_changed` Socket.io event is emitted; `tables.status` returns to `open` on all connected devices within 2 seconds

**NEW:**

> **Given** the last open bill in a session is marked `"settled"`
> **When** the payment Route Handler checks remaining open bills
> **Then** it calls the shared session-close service introduced in Story 3.6 with reason `settled`, which sets `closed_at` and `closed_by_staff_id` (there is no `status` column — see the schema note on Story 3.3), writes the `SESSION_CLOSED` audit event, and emits `table:status_changed`; `tables.status` returns to `open` on all connected devices within 2 seconds. The close is **not** reimplemented here — a settled close and an unpaid close must produce identical session and audit records, differing only in reason.

**Rationale:** Two independent implementations of "close a session" would drift, and the audit trail is the one place in this product where drift is unacceptable. One service, three reasons (`settled`, `abandoned`, `walkout`).

---

### 4.4 Architecture — no change

`table:status_changed` is already the specified event for occupancy changes (`architecture.md:381`), and the Core Data Flow pattern of emitting alongside the database write already covers this. Recorded here explicitly so the absence of a change is a decision, not an oversight.

---

## 5. Implementation Handoff

**Scope: Moderate** — backlog reorganization within an existing epic, plus a downstream AC amendment.

| Recipient | Responsibility |
|---|---|
| **Developer** | Implement Story 3.6 after `create-story`. Reuses Story 3.3's route, transaction and emit patterns directly. |
| **Sprint tracking** | Add `3-6-implement-close-table-without-payment` to `sprint-status.yaml` under Epic 3, status `backlog`. |
| **Whoever builds Epic 6** | Story 6.5 must call the shared service, not write its own close. |

### Sequencing

Story 3.6 should land **before Epic 4**, not after. Every demo and every Epic 4 development session opens tables; without a close, each one degrades the environment and needs database access to reset. It pays for itself immediately.

### Success criteria

- A table opened by mistake can be released from the UI in under three taps, with no database access
- A walkout is recorded with its unpaid total rather than silently disappearing
- Every session close — settled or unpaid — produces one `SESSION_CLOSED` audit row, written in the same transaction as the close
- Every session open produces a `SESSION_OPENED` audit row, closing the existing gap
- Story 6.5's settled path and 3.6's unpaid path produce identical records apart from the reason

### Explicitly out of scope

- Reason codes beyond `abandoned`, `walkout` and `settled` — Story 10.x can make them configurable if needed
- Surfacing walkout totals on the owner dashboard — belongs with Story 9.3, and is worth raising there once 3.6 exists
- Any confirmation on table *open*. Considered and rejected: it adds friction to the most frequent action in service and does not make a wrong tap recoverable. The close action addresses the actual problem.
