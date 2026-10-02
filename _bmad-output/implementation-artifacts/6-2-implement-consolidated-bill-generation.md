# Story 6.2: Implement Consolidated Bill Generation

Status: ready-for-dev

- **Epic:** 6 — Bill Settlement & Payment Recording (first story of the demo path)
- **Story ID:** 6.2
- **Requirements:** FR21, FR27; NFR-D1, NFR-S3; service-charge decision 2026-10-02
- **Depends on:** 4.5 (`order_events` with `unit_price_paisa` as quoted), 4.1 (`OrderActionStrip`'s `settling` state and its unwired `onGenerateBill` seam), 3.8 (a session can hold several tables)
- **Blocks:** 6.4 (a seat bill is a subset of the same machinery), 6.5 (a payment settles a bill)

---

## ⚠️ Read this before starting

**Story 6.1 is deferred.** The epic opens with `SplitBillCanvas`, which Teran deferred post-demo on
2026-10-02 along with 6.3 — drag-to-split is not in the demo. The demo path is **6.2 → 6.4 → 6.5**.
Nothing here depends on 6.1.

**There is no `bills` table.** The epic's acceptance criteria talk about creating "a `bill` record" as
though one exists; it does not, and neither does `bill_lines`. Creating them is Task 1 of this story,
and their shape is the most consequential decision in it — Stories 6.3, 6.4 and 6.5 all build on it.

**One prerequisite is unmet and needs Teran's answer before the route is finished** — see the question
at the end. `architecture.md:420` lists financial re-auth as something that "must be in place before
bill generation and payment routes are built". `financial_action_reauth` is `true` in the live config,
Story 2.4 is deferred post-demo, and no re-auth code exists.

---

## Story

As a waiter,
I want to generate a single consolidated bill for everything a table has ordered, with one tap,
So that I can hand a party settling together one correct total, without configuring a split.

---

## Acceptance Criteria

**AC-1 — One tap makes a bill**
**Given** a session with at least one submitted round
**When** `POST /api/sessions/:sessionId/bills` is called with `{ type: "consolidated" }`
**Then** a `bills` row is created carrying `session_id`, `type`, the `staff_id` from `x-staff-id`, the
computed money, and the RATES it was computed with; and a `bill_lines` row is created for every
`ITEM_ADDED` event on the session.

**AC-2 — The money is right, and computed in one defined order**
**Given** a bill is generated
**When** its totals are computed
**Then**
`subtotal = Σ(quantity × unit_price_paisa)` over its lines, minus any comps;
`service = round(subtotal × service_charge_bp / 10000)`, and **only when the session has tables
attached**;
`tax = round((subtotal + service) × tax_bp / 10000)`;
`total = subtotal + service + tax`.
Every value is an integer paisa, and each rounding happens **once, on the total — never per line**.

**AC-3 — Service charge is table service, not `kind`**
**Given** a counter sale that was later seated at a table (so `order_sessions.kind` is still `counter`)
**When** its bill is generated
**Then** the service charge IS applied, because the session has tables attached. A counter sale with no
table attached gets no service charge.

**AC-4 — The bill names what it is made of (FR27)**
**Given** a bill is retrieved with `GET /api/bills/:billId`
**When** it is rendered
**Then** it lists every line with item name, quantity, the unit price AS QUOTED on the event row, the
line amount, and the seat it belongs to; plus the subtotal, the service charge with its rate, the tax
with its rate, and the total. Comps appear as negative lines with their reason.

**AC-5 — An item can be on only one bill**
**Given** an `ITEM_ADDED` event already covered by a bill
**When** another bill tries to cover it
**Then** the database refuses it. This is the invariant 6.4's per-seat bills depend on — nothing may be
billed twice, and nothing may be silently left off.

**Given** two waiters tap Generate Bill on the same session at the same instant
**When** both requests run
**Then** exactly one bill is created; the loser gets `409 BILL_ALREADY_OPEN`. **The database decides
this** — not a read-then-write check.

**AC-6 — A second bill on an already-billed session is refused**
**Given** a session with an open, unsettled bill
**When** `POST /api/sessions/:sessionId/bills` is called again
**Then** `409 { success: false, error: { code: "BILL_ALREADY_OPEN", billId } }`, and no row is written.

**AC-7 — The strip moves to settling**
**Given** a bill has been generated
**When** the order screen re-renders
**Then** `OrderActionStrip` is in `settling`; Generate Bill and Add More Items are gone. The state and
its copy already exist from Story 4.1 — this story only passes the handler and the state.

**AC-8 — Integer paisa across the wire**
**Given** any bill response
**When** it is inspected
**Then** every monetary field is an integer in paisa. The API never returns a formatted string, a float,
or a rupee value; `lkrFromPaisa` is for rendering only.

**AC-9 — A bill is a fact, not working state**
**Given** a bill and its lines exist
**When** an UPDATE or DELETE is attempted
**Then** the database refuses it, as it does for `order_events`, `order_rounds` and `payment_records`.
A correction is a new record, which Epic 7 owns.

**AC-10 — A bill is a snapshot**
**Given** a bill was generated at 19:40
**When** the menu price of one of its items changes, or the tenant's service-charge rate changes
**Then** the bill is unaffected — its lines carry the price quoted on the event, and the bill carries
the rates it was computed with.

**AC-11 — A session with nothing on it cannot be billed**
**Given** a session with no `ITEM_ADDED` events
**When** a bill is requested
**Then** `422 { code: "NOTHING_TO_BILL" }`. An empty bill has no meaning, and `closeSession`'s
`abandoned` path already exists for a table that ordered nothing.

---

## Tasks / Subtasks

- [ ] **Task 1 — Schema and migration** (AC: 1, 5, 9, 10)
  - [ ] `tenant_config.service_charge_bp integer NOT NULL DEFAULT 0` — basis points, 1000 = 10.00%.
        Seed Carpe Diem's rate. See Decision 1 for why basis points and not integer percent.
  - [ ] `bills`: `id` uuid PK; `tenantId`, `sessionId`, `staffId` FKs; `type` enum
        (`consolidated` | `seat` — `person` waits for 6.3); the snapshot
        `subtotalPaisa`, `serviceChargePaisa`, `taxPaisa`, `totalPaisa`; the rates applied
        `serviceChargeBp`, `taxBp`; `createdAt`.
  - [ ] `bill_lines`: `id`, `billId` FK, `orderEventId` FK, `amountPaisa` (quantity × unit price, or
        negative for a comp), `compRecordId` nullable FK.
  - [ ] **`UNIQUE (order_event_id)` on `bill_lines`** — the whole of AC-5, and what decides the
        concurrent-tap race (Trap 2).
  - [ ] Append-only triggers on BOTH tables, exactly as migration 0001 does for `order_events`.
        Contrast with `print_jobs`, which is deliberately mutable — a bill is a fact.
  - [ ] Index `bills(session_id)`.
  - [ ] `pnpm db:generate`, then **check `meta/_journal.json` orders by `when`** before applying — it
        has silently skipped migrations three times on this project.

- [ ] **Task 2 — The bill service** (AC: 2, 3, 4, 10, 11)
  - [ ] `src/server/services/bill.service.ts`, `import 'server-only'`, taking `tx` from the caller —
        the shape `order.service.ts` established.
  - [ ] Lock the session with `lockOpenSession` (from `table-session.service.ts`) before reading
        anything. A round committing mid-bill is the race this prevents.
  - [ ] Read the session's `ITEM_ADDED` events, its attached tables, and `tenant_config`'s two rates in
        the same transaction.
  - [ ] Compute per AC-2. Put the arithmetic in ONE exported pure function —
        `computeBillTotals({ subtotalPaisa, serviceChargeBp, taxBp, hasTableService })` — so 6.4 and
        6.5 cannot grow a second version of it.
  - [ ] Insert `bills` then `bill_lines` in the same transaction; a `23505` on `order_event_id` is the
        409, caught **by index name** via `isUniqueViolation` (Story 3.8's pattern).

- [ ] **Task 3 — The routes** (AC: 1, 6, 8, 11)
  - [ ] `POST /api/sessions/[sessionId]/bills` — zod body `{ type: 'consolidated' }`, `safeParse`, 400
        on a malformed body (NOT `.catch()` — the defect Story 4.3's review found).
  - [ ] `GET /api/bills/[billId]` — the bill with its lines. RBAC for both is already in
        `permissions.ts` (`/api/sessions` and `/api/bills`, owner + waiter); **verify as Kumar (kitchen,
        PIN 4321) and expect 403** rather than assuming.
  - [ ] Status codes: 201 · 400 body · 401 · 403 · 404 no such session · 409 `BILL_ALREADY_OPEN` ·
        422 `NOTHING_TO_BILL` · 500.
  - [ ] Every monetary field an integer (AC-8).

- [ ] **Task 4 — Wire the order screen** (AC: 7)
  - [ ] Pass `onGenerateBill` to `OrderActionStrip` — the prop exists and is unwired; passing it is what
        makes the button appear (4.1: no handler, no button, deliberately).
  - [ ] On success, invalidate `['orders', sessionId]` and move the strip to `settling`.
  - [ ] Refusals get the same treatment as Send's: name what happened, leave the screen usable.
  - [ ] Do NOT add a service line to `order-summary.tsx`. Its total is "what has been ordered", not a
        bill — see Trap 3.

- [ ] **Task 5 — Verify** (AC: all)
  - [ ] Scripted, against the running server and database — the pattern every story since 3.3 uses.
        Matrix below.
  - [ ] **The concurrent double-tap and the seated-counter-sale cases are not optional.** They are AC-5
        and AC-3, and both have bitten this codebase before.

---

## Dev Notes

### 🚨 Decision 1 — `service_charge_bp` in basis points, not integer percent

Teran, 2026-10-02: the restaurant charges a service charge, and the owner will set the rate from the
back-office dashboard (Story 10.5 owns that screen). **The column and the arithmetic land here**, because
a bill cannot be computed without them and deferring the column would mean hardcoding a rate.

Basis points, even though the neighbouring `tax_rate_percent` is an integer: that column cannot express
SSCL's 2.5%, and shipping the same limitation twice is a choice, not an inheritance. Converting
`tax_rate_percent` → `tax_bp` is three files and no data (it is `0` everywhere) — do it in this story if
it is cheap, and if not, leave it and say so.

### 🚨 Decision 2 — a bill SNAPSHOTS its money and RECORDS its membership

Two things could have been derived instead and should not be:

**The totals are stored**, not recomputed on read. A bill is handed to a guest; if the menu price or the
service rate changes afterwards, the piece of paper does not. The rates are stored beside the amounts so
the bill can explain itself a week later.

**The lines are recorded** in `bill_lines`, not derived from a seat or a time range. A consolidated bill
could be derived — "every event on the session" — but 6.4's per-seat bill and 6.3's person split cannot,
and more importantly nothing would stop two bills covering the same item. `UNIQUE (order_event_id)` makes
double-billing impossible for every bill type at once, which is worth a table on its own.

### 🚨 Decision 3 — bill status is DERIVED from payments, not stored

A bill is append-only (AC-9), so it cannot carry a mutable `status`. "Open" means *payments recorded
against it sum to less than its total* — and 6.5 adds `payment_records.bill_id` to make that query
possible. FR32's "closes when all open bills are settled" reads the same way.

Until 6.5 exists there are no payments, so every bill is open, and AC-6's 409 is simply "this session
already has a bill". Write the check so that adding the payment sum later narrows it rather than
replacing it.

### 🚨 Trap 1 — do not reuse the floor card's running total

`dishTotalPaisa` (Story 5.0's floor-card figure) is the sum of what was sent, with **no service charge,
no tax and no comps**. It is the right number for a card that says "this table is standing at LKR 9,350"
and the wrong number for a bill. They will differ, and they are supposed to.

### 🚨 Trap 2 — the concurrent tap must be decided by the database

Two waiters on two tablets tapping Generate Bill at the same instant is the ordinary case, not an exotic
one. A `SELECT … if none exists … INSERT` has a window between the two statements, and this project has
already shipped one guard that merely *looked* atomic (Story 3.9's last-table check, caught in review).

`UNIQUE (order_event_id)` on `bill_lines` closes it with no extra work: the second transaction tries to
claim the same events and takes a `23505`. Catch it **by index name** — `isUniqueViolation(error,
'bill_lines_order_event_id_key')` — because matching bare `23505` means a future unrelated constraint
gets reported to a waiter as "bill already open" (the exact defect `errors.ts`'s header describes).

### 🚨 Trap 3 — `order-summary.tsx` is not the bill

It already computes tax correctly, in integer paisa, rounded once — reuse the *pattern*, not the
component. It shows the ROUND's total on the order screen and must not grow a service line, because the
number it shows is not what anyone will pay.

### 🚨 Trap 4 — comps exist in the schema and nowhere else

`comp_records` is a real table with `authorized_by_staff_id`, `amount_paisa` and a mandatory `reason`,
and FR27 says a bill shows comps. **Nothing writes comps until Epic 7.** So: join them, subtract them,
render them as negative lines — and verify with a hand-inserted row, because no UI can produce one.
A bill with zero comps is the only case that will occur in the demo, and the only one that will be
exercised by accident.

### 🚨 Trap 5 — round once, and never per line

`Math.round((subtotal * bp) / 10000)` on the total. Rounding each line and summing produces a bill that
disagrees with its own arithmetic by a few paisa, which a guest notices before you do. The existing
`order-summary.tsx:36` gets this right and says why in a comment.

### 🚨 Trap 6 — a bill for a session that is closing

`lockOpenSession` throws `SessionAlreadyClosedError` for a closed session, which maps to 409. A session
cannot be billed after it is closed, and the lock is also what stops a round committing while the bill
is being computed.

### Current state of the files this story touches

| File | Today | This story |
|---|---|---|
| `src/server/db/schema.ts` | 20 tables; `printJobs` newest; `paymentRecords` and `compRecords` exist and are unused | ADD `bills`, `billLines`, `tenant_config.service_charge_bp` |
| `src/server/db/migrations/` | latest `0017`; six `immutable_*` triggers | ADD 0018 WITH triggers on both new tables |
| `src/server/services/` | `order.service.ts`, `table-session.service.ts` — both take `tx` from the caller | ADD `bill.service.ts` in the same shape |
| `src/app/api/sessions/[sessionId]/` | `orders`, `seats`, `tables`, `close` | ADD `bills` |
| `src/app/api/bills/` | does not exist | ADD `[billId]/route.ts` |
| `src/components/pos/order-action-strip.tsx` | `settling` state built, `onGenerateBill` accepted and never passed | pass the handler |
| `src/components/pos/order-screen.tsx` | owns the send mutation, the strip state and the query keys | ADD the bill mutation |
| `src/components/pos/order-summary.tsx` | subtotal + optional tax, integer paisa, rounded once | UNCHANGED — Trap 3 |
| `src/server/auth/permissions.ts` | `/api/bills` and `/api/sessions` already owner+waiter | unchanged — but VERIFY, do not assume |

### Verification matrix

| # | Case | Expected |
|---|---|---|
| 1 | Table session, 3 rounds | 201; one bill; `bill_lines` = every ITEM_ADDED; subtotal = Σ(qty × quoted price) |
| 2 | Rate 1000 bp, subtotal 9,350.00 | service 935.00, tax on 10,285.00, total = sum; every value an integer |
| 3 | Counter sale, no table | NO service charge |
| 4 | **Counter sale seated at a table** | service charge APPLIED (`kind` is still `counter`) |
| 5 | Two simultaneous Generate Bill | exactly one bill; the other 409 `BILL_ALREADY_OPEN` |
| 6 | Second bill after the first | 409, nothing written |
| 7 | Hand-inserted comp row | negative line with its reason; subtotal reduced; service and tax follow |
| 8 | Session with no items | 422 `NOTHING_TO_BILL` |
| 9 | Menu price changed after billing | bill unchanged |
| 10 | Rate changed after billing | bill unchanged; it carries the rates used |
| 11 | `UPDATE` / `DELETE` on `bills` or `bill_lines` | refused by the trigger |
| 12 | Kumar (kitchen, 4321) | 403 on both routes |
| 13 | Closed session | 409 `SESSION_ALREADY_CLOSED` |
| 14 | Odd-paisa rounding (e.g. subtotal 3,333 at 1000 bp) | rounds once; total = subtotal + service + tax exactly |
| 15 | Every response field | integer paisa; no strings, no floats |

### Project Structure Notes

New: `src/server/services/bill.service.ts`, `src/app/api/sessions/[sessionId]/bills/route.ts`,
`src/app/api/bills/[billId]/route.ts`, migration 0018.

`architecture.md:451` plans `POST /api/bills/:billId/payment` — that is Story 6.5, not this one.
`architecture.md:520` and `:544` plan `split-bill-canvas.tsx` and `split-bill.store.ts` — Story 6.1,
deferred. Zustand is listed there as the split canvas's state library; **this story adds no new
dependency**, and none is in `package.json` today.

### References

- `epics.md:1661-1707` — Story 6.2, including the service-charge note added 2026-10-02
- `prd.md:FR21, FR27` — one consolidated bill per session; what a bill must itemise
- `epics.md` Epic 7 note — why waiving a charge is a discount, not a rate override
- `architecture.md:218` — financial re-auth, and the open question below
- `architecture.md:275` — "orders, bills, payments and the audit trail all key on `session_id`"
- `src/server/services/order.service.ts` — the service shape: `tx` from the caller, typed errors, the
  lock, `isUniqueViolation` by name
- `src/components/pos/order-summary.tsx:34-37` — the money arithmetic to copy
- `_bmad-output/implementation-artifacts/5-0-*.md` — Decision 2 and Trap 3 there are the closest
  precedents for "snapshot, do not re-read"

---

## ❓ Open question for Teran — answer before Task 3 is finished

**`financial_action_reauth` is `true`, and nothing implements it.**

`architecture.md:218`: when that flag is true, "bill generation and payment Route Handlers require a
fresh PIN in the request body, validated inline regardless of active session state. The `staff_id`
stored on that action is the one who provided the fresh PIN." `architecture.md:420` lists it as a
prerequisite *before* bill routes are built. The live `tenant_config` has it `true`. Story 2.4, which
owns the flow, is deferred post-demo. No re-auth code exists.

Three ways forward:

1. **Set the flag `false` for the demo** and have this route read it, so the seam is real: when the flag
   is true the route requires and validates a `pin` in the body, and when it is false it does not. The
   server side is then honest and 2.4 only adds the UI prompt. *Smallest, and my recommendation.*
2. **Un-defer 2.4** and build the flow first. Correct by the architecture, and it is a story's worth of
   work before any bill exists.
3. **Ignore the flag in 6.2.** Fastest, and it leaves a config value that claims a protection the code
   does not provide — the defect class this project's last retrospective was about.

Task 3 is written assuming (1). If you choose differently, the route's guard changes and nothing else
does.

---

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

### Change Log

- 2026-10-02: Story created. Written against `epics.md`'s Story 6.2 plus the service-charge decision
  recorded the same day. Two things the epic assumes but the codebase lacks: there is no `bills` table
  (nor `bill_lines`), and `financial_action_reauth` is enabled with nothing implementing it — the first
  is Task 1, the second is the open question above. Three decisions taken up front because each shapes
  the schema: basis points for the service rate; a bill snapshots its money and records its membership
  rather than deriving either; and bill status is derived from payments so the table can stay
  append-only. The `UNIQUE (order_event_id)` on `bill_lines` does double duty — it is the no-double-
  billing invariant 6.4 depends on, and it is what decides the concurrent-tap race in the database
  rather than in a read-then-write check.
