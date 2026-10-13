# Story 6.4: Implement Per-Seat-Slot Independent Billing

Status: review

- **Epic:** 6 — Bill Settlement & Payment Recording (second story of the demo path)
- **Story ID:** 6.4
- **Requirements:** FR25, FR26, FR27; NFR-D1, NFR-S3
- **Depends on:** 6.2 (the `bills` / `bill_lines` / `bill_comps` machinery and `computeBillTotals`), 4.3 (seat slots), 4.5 (`order_events.seat_slot_id`)
- **Blocks:** 6.5 (a payment settles a bill, and "all bills settled" is what closes the table)

---

## ⚠️ Read this before starting

**This story CONTRADICTS a guard added to `order.service.ts` on 2026-10-13.** That is not a mistake in
either place — it is the thing to fix first, and Task 1 is about nothing else. See 🚨 Conflict 1.

**6.1 and 6.3 are deferred.** `SplitBillCanvas` and the person-split are post-demo (Teran, 2026-10-02).
The demo path is 6.2 → **6.4** → 6.5. Per-seat billing is how the demo splits a bill.

**Do NOT add a `status` column to anything.** Story 6.2 Decision 3 made bill status DERIVED from
payments, and the epic's text is written as though a stored status exists. See 🚨 Conflict 2.

---

## Story

As a waiter,
I want to bill one seat while the rest of the table keeps ordering,
So that a guest who has to leave early can pay and go without collapsing the whole table's order.

---

## Acceptance Criteria

**AC-1 — One seat, one bill**
**Given** a session with several seats, each holding items
**When** `POST /api/sessions/:sessionId/seats/:seatId/bill` is called
**Then** a `bills` row is created with `type: 'seat'`, the `seat_slot_id`, the `session_id`, the
`staff_id`, and the computed money; `bill_lines` are created for exactly the `ITEM_ADDED` events on
THAT seat, and no others.

**AC-2 — The rest of the table carries on**
**Given** seat 1 has been billed
**When** seat 2's waiter sends another round
**Then** it is accepted, the session stays open, and seat 2 can be billed afterwards. The ONLY thing
seat 1's bill forbids is adding to **seat 1**.

**AC-3 — A billed seat accepts nothing more**
**Given** seat 1 has been billed
**When** a round containing a line for seat 1 is sent
**Then** `409 SEAT_ALREADY_BILLED`, naming the seat, and **nothing is written** — not even the lines
for other seats in that same round. A round is all-or-nothing (Story 4.5).

**AC-4 — Nothing is billed twice, and nothing is left off**
**Given** seat 1 has a bill
**When** a bill is generated for seat 2, or a consolidated bill is generated for the remainder
**Then** seat 1's events are excluded, and every unbilled event is covered. The database enforces the
first half — `UNIQUE (order_event_id)` on `bill_lines`, which 6.2 built for exactly this story.

**AC-5 — A consolidated bill after seat bills covers the REMAINDER**
**Given** seats 1 and 2 are billed and seats 3 and 4 are not
**When** `POST /api/sessions/:sessionId/bills` is called
**Then** a consolidated bill is created covering only the unbilled events. It is NOT refused, and it
does not try to re-claim billed ones. If NOTHING is unbilled, `422 NOTHING_TO_BILL`.

**AC-6 — A seat already billed is refused**
**Given** seat 1 has a bill
**When** `POST /api/sessions/:sessionId/seats/1/bill` is called again
**Then** `409 { code: "SEAT_ALREADY_BILLED", billId }`, and no row is written.

**AC-7 — An empty seat cannot be billed**
**Given** a seat with no `ITEM_ADDED` events, or whose every event is already billed
**When** a seat bill is requested
**Then** `422 { code: "SEAT_HAS_NO_ITEMS" }`.

**AC-8 — The seat must be on this session**
**Given** a `seatId` belonging to a different session
**When** a seat bill is requested
**Then** `404 SEAT_NOT_ON_SESSION`. Do not bill it, and do not 500.

**AC-9 — Two waiters billing the same seat at once**
**Given** two tablets tap "Bill This Seat" on the same seat at the same instant
**When** both requests run
**Then** exactly one bill is created; the loser gets `409 SEAT_ALREADY_BILLED`. **The database decides
it.** Three mechanisms, and they fire at different statements — know which:
the session row lock serialises the two requests; `idx_bills_seat_slot` (partial unique) rejects the
second **`bills` INSERT**; `idx_bill_lines_order_event` rejects the second **`bill_lines` INSERT**. The
first is the one that fires here, and it is raised by a statement 6.2 left outside its try/catch — see
Task 3.

**AC-10 — The money is the same arithmetic**
**Given** a seat bill
**When** its totals are computed
**Then** they come from the SAME exported `computeBillTotals(...)` 6.2 wrote — service on the seat's
subtotal when the session has tables attached, tax on subtotal + service, each rounded once. No second
implementation.

**AC-11b — The seat NOTE never reaches a bill**
**Given** a seat carrying a note ("red shirt", "bald man")
**When** any bill is generated or rendered
**Then** only `seat_label` appears. `seat_note` must not reach `BillDetail`, the API, or paper.
Teran's explicit decision, 2026-09-12, and `deferred-work.md` addresses it to THIS story by name. A
per-seat bill is the one bill where reaching for "how do I identify this guest" is most tempting, and
"Bald man — LKR 2,400" is not a mistake a customer forgives.

**AC-11 — A seat bill itemises itself (FR27)**
**Given** `GET /api/bills/:billId` on a seat bill
**When** it is rendered
**Then** it lists that seat's lines with the name, quantity and unit price **as snapshotted on
`bill_lines`** (migration 0019 — do NOT re-join `menu_items`), the seat label, the comps on those
items, and the four money figures with their two rates.

The bill-level seat label comes from the **already-snapshotted `bill_lines.seat_label`** (a seat bill's
lines all share one), NOT from a `seat_slots` join — migration 0019 removed that join deliberately and
re-adding it here would undo it. `bills.seat_slot_id` is the identity and uniqueness column only.

**AC-12 — The waiter can reach it, but only where seats mean something**
**Given** a seat is selected on the order screen **in a zone that uses seats** (`usesSeats`)
**When** that seat has unbilled items and the session is not fully billed
**Then** a "Bill This Seat" action is available; once billed, the seat is visibly marked as billed in
`SeatSelector` and the action is gone.

**Given** a Bean Bag, Sun Bed, Rooftop or counter order — zones where the seat section is hidden and
every item lands on Seat 1
**When** the order screen renders
**Then** there is NO per-seat option. `deferred-work.md` assigns this to Story 6.4 by name: per-seat
billing has nothing to split there, and offering "split by seat" on a one-seat order is a control that
can only confuse. The route must still be correct if called — this is a UI gate, not a security one.

**AC-13 — Integer paisa across the wire**
Every monetary field is an integer in paisa. No strings, no floats.

---

## Tasks / Subtasks

- [x] **Task 1 — Make the billing guards SEAT-AWARE** (AC-2, AC-3, AC-5) — *do this first*
  - [x] `order.service.ts`: `SessionAlreadyBilledError` currently fires when `findOpenBill` finds ANY
        bill on the session. Replace with a per-seat check — refuse only the seats that are billed, and
        keep refusing everything when a CONSOLIDATED bill exists.
  - [x] **The contract, concretely** (do not invent a different one): add
        `SeatAlreadyBilledError(seatSlotId, seatLabel, billId)`; KEEP `SessionAlreadyBilledError` for
        the consolidated case. `orders/route.ts` maps the new one to
        `409 { code: 'SEAT_ALREADY_BILLED', seatId, seatLabel, billId }`, beside the existing
        `SESSION_ALREADY_BILLED` mapping.
  - [x] **The client must have a branch for it.** `order-screen.tsx`'s send handler is a
        `switch (error.code)` that handles only `ITEM_UNAVAILABLE` and `PRICE_CHANGED` —
        `SESSION_ALREADY_BILLED` already falls through to a generic message today. Without a
        `case 'SEAT_ALREADY_BILLED'`, AC-3's "naming the seat" does not happen.
  - [x] `bill.service.ts`: `findOpenBill` is the wrong question now. Split it:
        `findConsolidatedBill(tx, sessionId)` and `findSeatBill(tx, sessionId, seatId)`, plus
        `billedSeatIds(tx, sessionId)` for the guard above.
  - [x] `generateConsolidatedBill` must bill the REMAINDER (AC-5), not refuse outright. Refuse only
        when a consolidated bill already exists, or nothing is unbilled.
  - [x] **Update `verify-bills.ts` case R1** — it currently asserts `SESSION_ALREADY_BILLED` for any
        round on a billed session, which this story deliberately makes wrong.

- [x] **Task 2 — Schema** (AC-1, AC-6)
  - [x] Migration 0020: `bills.seat_slot_id uuid NULL REFERENCES seat_slots(id)`. Nullable — a
        consolidated bill has no seat.
  - [x] **Partial unique index**: `UNIQUE (seat_slot_id) WHERE seat_slot_id IS NOT NULL`. This is AC-6
        and AC-9 in one line, decided by the database. Name it, and catch it BY NAME.
  - [x] Index `bills(session_id, seat_slot_id)`.
  - [x] No status column anywhere. No change to `seat_slots`. See Conflict 2.
  - [x] `pnpm db:generate`, check `meta/_journal.json` orders by `when`, then apply.

- [x] **Task 3 — The service** (AC-1, AC-4, AC-7, AC-8, AC-10, AC-11)
  - [x] `collectBillable` gains an optional seat filter and an **unbilled-only** filter. Both
        `generateConsolidatedBill` and the new `generateSeatBill` go through it.
  - [x] `generateSeatBill(tx, { sessionId, seatId, staffId })` — lock the session, verify the seat is
        on it (AC-8), collect that seat's UNBILLED events, refuse if empty (AC-7), insert.
  - [x] Reuse `computeBillTotals` unchanged (AC-10). Reuse every 6.2 guard: unpriced item, comps
        exceeding the order, integer overflow.
  - [x] **Catch the new seat index on the RIGHT STATEMENT.** In `generateConsolidatedBill` the `bills`
        INSERT sits OUTSIDE the `try { … } catch` — only the `bill_lines` / `bill_comps` inserts are
        wrapped. `idx_bills_seat_slot` is an index on `bills`, so its 23505 is raised by the `bills`
        INSERT and would escape to the route as an undifferentiated 500, not the 409 AC-6 and AC-9
        require. `generateSeatBill` must wrap its own `bills` INSERT and map
        `isUniqueViolation(error, 'idx_bills_seat_slot')` → `SeatAlreadyBilledError`, keeping the
        existing lines/comps catch separate.
  - [x] Re-raise 6.2's guards unchanged from the seat path: `UnpricedItemError`,
        `CompsExceedOrderError`, `BillTooLargeError`, `MissingTenantConfigError`. **Scope the unpriced
        check to the COLLECTED set**, not the whole session — one unpriced item on seat 4 must not
        block billing seat 1.
  - [x] Select `seat_label`, never `seat_note` (AC-11b).

- [x] **Task 4 — The route** (AC-1, AC-6, AC-7, AC-8, AC-13)
  - [x] `POST /api/sessions/[sessionId]/seats/[seatId]/bill` — note the path the epic specifies, and
        that a `seats/[seatId]` segment already exists for Story 4.3's seat routes.
  - [x] zod `safeParse` on both params; the re-auth seam, the `x-staff-id` UUID check and the guarded
        catch-block re-read all exist in the 6.2 bills route — **copy the shape, do not re-derive it**.
  - [x] Status codes: 201 · 400 · 401 · 403 · 404 no such session/seat · 409 `SEAT_ALREADY_BILLED` ·
        422 `SEAT_HAS_NO_ITEMS` · 500.
  - [x] **RBAC is INHERITED, not written.** `permissions.ts` covers the `/api/sessions` prefix
        (owner + waiter) and `proxy.ts` enforces it, so the 403 above needs no code in the handler —
        the sibling routes say so in comments and write no role check. The handler validates
        `x-staff-id` is a UUID (400) and nothing else. Verify as Kumar anyway; do not assume.
  - [x] **Fix the consolidated 409's fallback re-read while you are here.** It selects
        `bills WHERE session_id = $1 ORDER BY created_at ASC LIMIT 1`, and 6.2's review added that
        `ORDER BY` with the comment "wrong the moment 6.4's per-seat bills land". With seat bills the
        oldest row is usually a SEAT bill, so a consolidated 409 hands the client a seat bill's id.
        Filter it to `type = 'consolidated'`, and update the client's `BILL_ALREADY_OPEN` branch so it
        no longer reads any bill id as "the session is settled".

- [x] **Task 5 — The screen** (AC-12)
  - [x] The `['bill', sessionId]` query returns ONE bill. A session now holds several — change it to
        `bills[]` and update `loadSessionBill` → `loadSessionBills`. **There are exactly two callers**:
        `bills/route.ts` and `src/app/orders/[sessionId]/page.tsx`, which computes `initialBill` and
        passes it as a prop to seed the query. Rename that prop too (`initialBill` → `initialBills`).
        Missing the page breaks the build — or, patched carelessly, leaves the FIRST PAINT deriving
        `settling` from a single bill again, which is the exact refresh hole 6.2's review closed.
  - [x] `stripState` currently settles on `bill !== null`. It must settle only when **nothing is left
        to bill**. A table with one seat billed and three seats ordering is NOT settling.
  - [x] `SeatSelector`: mark a billed seat and offer "Bill This Seat" on the selected unbilled one.
  - [x] Refusals get the same treatment as Send's: name what happened, leave the screen usable.

- [x] **Task 6 — Verify** (AC: all)
  - [x] Extend `src/server/services/verify-bills.ts`. Matrix below.
  - [x] **`makeSession` creates exactly ONE seat, hard-coded `'S1'`.** Half this matrix needs three or
        four. Extend it to `makeSession(kind, { withTable, seats })` returning `seatIds: string[]` with
        labels `S1…Sn` — `idx_seat_slots_session_label` is `UNIQUE (session_id, seat_label)`, so the
        labels must differ.
  - [x] **Extend the cleanup registry BEFORE writing case 2.** See Trap 7 — this one bites silently.
  - [x] **The concurrent double-tap, the ordering-after-one-seat-is-billed case, and the remainder
        bill are not optional.** They are AC-9, AC-2 and AC-5, and the first two are the exact shapes
        that 6.2's review found broken.
  - [x] Every new case must be able to FAIL. 6.2 shipped four that could not — see Trap 5.

---

## Dev Notes

### 🚨 Conflict 1 — this story must UNDO part of yesterday's fix

Story 6.2's code review (2026-10-13) found that items sent after a bill existed were billed by nobody,
and the fix was a server-side refusal in `submitRound`:

```ts
const existingBill = await findOpenBill(tx, sessionId)
if (existingBill) throw new SessionAlreadyBilledError(existingBill.id)
```

`findOpenBill` returns the first bill on the SESSION. So the moment seat 1 is billed, that guard
refuses every round for every other seat — which is precisely what AC-2 says must work.

**Both are right.** The hole 6.2 closed is real: an item that can never land on a bill is lost revenue.
The rule was simply stated at the wrong granularity, because when it was written a session could only
have one bill. The correct rule is:

> A round is refused if it contains a line for a seat that is already billed, or if the session has a
> CONSOLIDATED bill (which covers everything).

Do not weaken it to a warning, and do not delete it. Narrow it. `verify-bills.ts` case R1 asserts the
old behaviour and must be updated in the same change — leaving it green while the behaviour changes
underneath is how a test stops meaning anything.

### 🚨 Conflict 2 — the epic says "bill record" fields that do not exist

The epic's AC text for this story predates the schema. It asks for `status: "open"` and talks about a
seat slot's status becoming `"closed"`. Neither column exists, and 6.2 decided deliberately that
neither should:

- **Bill status is derived** from payments summing to the total (6.2 Decision 3). `payment_records`
  gains `bill_id` in **Story 6.5**, which is what makes that query possible. Until then every bill is
  open, which is also why AC-6 here is simply "this seat already has a bill".
- **`seat_slots` has no status column** and gains none here.

### 🚨 Conflict 3 — AC-4 of the epic belongs to 6.5, not here

The epic's fourth criterion ("when the payment is recorded … the table only auto-closes when all seat
bills are settled") is FR32 and is **Story 6.5's**. Nothing in 6.4 records a payment. This story ends
when the bill exists. It is listed here so the dev agent does not go hunting for a payment flow that
is not in scope — but note the shape 6.5 will need: "all bills settled" is a question about every bill
on the session, which is why `loadSessionBills` is plural from the start.

**And a hazard this story CREATES for 6.5, which did not exist before it.** After 6.4 a session can
have every bill settled and still have unbilled items — seats 1 and 2 paid and left, seats 3 and 4
still eating. Epic 6.5's criterion reads "the last open bill in a session is marked settled";
implemented literally, it would auto-close a table mid-service and release it on the floor plan.

The correct predicate is **every bill settled AND nothing left to bill**. That is the same question
Task 5 needs for `stripState`, so define it ONCE in `bill.service.ts` and export it — do not let 6.5
write a second version. Recorded in `deferred-work.md` under this story.

### 🚨 Decision 1 — a consolidated bill after seat bills bills the REMAINDER

The alternative is refusing it, which would strand a table where two guests paid individually and the
remaining four want one bill — the ordinary case this feature exists for. So `generateConsolidatedBill`
changes from "refuse if any bill exists" to "cover everything not yet covered".

That makes the `NOTHING_TO_BILL` 422 do real work: it now also means "everything here is already
billed", which is the correct answer for a fully-settled table.

One consequence to accept: a consolidated remainder bill carries `type: 'consolidated'` while covering
a subset. The type describes how it was generated, not how much it covers. If that turns out to read
badly in Epic 7's audit view, the fix is a new enum value, not a stored subset list.

### 🚨 Decision 2 — the partial unique index IS the concurrency answer

```sql
CREATE UNIQUE INDEX idx_bills_seat_slot ON bills (seat_slot_id) WHERE seat_slot_id IS NOT NULL;
```

**There is already a precedent for this exact shape in `schema.ts`** —
`uniqueIndex('idx_one_open_session_per_table').on(t.tableId).where(sql\`${t.releasedAt} IS NULL\`)` —
and drizzle-kit emits it correctly in this project. Copy that Drizzle expression rather than
hand-writing raw SQL into the migration.

`WHERE seat_slot_id IS NOT NULL` is load-bearing. Without it, consolidated bills (all with a NULL seat)
would be fine anyway — PostgreSQL treats NULLs as distinct in a unique index — but the partial form
says so explicitly and is what a reader checks. **This was mis-stated once already:** 6.2's record
originally claimed a nullable column would weaken a unique index. It does not. Verified.

Catch it **by index name** via `isUniqueViolation(error, 'idx_bills_seat_slot')`. Matching bare `23505`
means a future unrelated constraint is reported to a waiter as "seat already billed" — the exact defect
`errors.ts` describes, and one 6.2's review found had already been reintroduced once.

### 🚨 Trap 1 — the round is all-or-nothing

A round can hold lines for several seats. If ONE of them names a billed seat, the whole round is
refused (AC-3) — do not partially accept. Story 4.5 made a round atomic and the kitchen ticket assumes
it. Refusing the whole thing and naming the offending seat lets the waiter move that line to a new
seat and resend.

### 🚨 Trap 2 — events with NO seat

`order_events.seat_slot_id` is nullable. Nothing in the app writes a null — `submitRound` requires a
seat on every line — but the column permits it, and a seat bill filtered by `seat_slot_id = $1` would
silently never cover such a row. The consolidated remainder bill (AC-5) is what catches them, because
it filters by "unbilled", not by seat. Make sure it does not also filter by seat.

### 🚨 Trap 3 — seat bills do not have to sum to a consolidated bill

Four seat bills at 10% service, each rounded once on its own subtotal, can total a few paisa away from
one consolidated bill over the same items. **That is correct, not a bug.** Each guest paid a bill that
is internally right, and there is no "whole" being split — that is 6.3's problem, not this one. Do not
add a reconciliation step, and do not round differently to make the numbers match.

### 🚨 Trap 4 — `UNIQUE (order_event_id)` already does most of AC-4

6.2 built it precisely for this story. You do not need a "mark as billed" flag on `order_events`, and
adding one would be a second source of truth about the same fact. "Unbilled" is
`NOT EXISTS (SELECT 1 FROM bill_lines WHERE order_event_id = oe.id)`.

### 🚨 Trap 5 — write verification cases that can FAIL

Four of 6.2's original fifteen could not. The worst asserted `total === subtotal + service + tax`,
which the code computes by construction, under a heading claiming to test rounding. Before adding a
case, state what change to the production code would make it go red. If the answer is "none", the case
is decoration. `verify-bills.ts` case 14b is the pattern: it picks amounts where round-once and
round-per-line give different answers, and asserts the right one.

### 🚨 Trap 7 — case 2 is the first ACCEPTED send, and it will break cleanup

Every `order_events` row the script has ever written came from its own `addItem`, which registers the
id in `mine.events`. Matrix case 2 is the **first case anywhere in `verify-bills.ts` that sends a round
through the real route and expects it to succeed** — R1's send is refused, so nothing has ever
committed.

An accepted round writes an `order_rounds` row, `order_events` rows that `mine.events` never sees, and
`print_jobs` rows whose `session_id` and `round_id` are both NOT NULL foreign keys. `cleanup()` deletes
only tracked events and then `DELETE FROM order_sessions`, which will raise a foreign-key violation,
abort the cleanup, leak every session of that run, and poison the next run's table-recycling path.

This is not hypothetical — it is exactly how the 6.2 run that exhausted its table fixture left 9 bills
and 18 open sessions behind.

**Before case 2 exists:** add `mine.rounds` and `mine.printJobs` (or a `sendRound()` helper that
registers everything the route writes), and make `cleanup()` delete `print_jobs` → `order_rounds` →
`order_events WHERE session_id = ANY(mine.sessions)` before `order_sessions`.

### 🚨 Trap 6 — the verification script mutates shared state

`verify-bills.ts` disables append-only triggers and rewrites `tenant_config`. It now wraps both in
`try/finally` and recycles its own tables when the floor runs out (13 tables, more sessions than that).
Keep those guarantees when you extend it — a run that dies holding a disabled `immutable_order_events`
leaves the whole project's core invariant off.

### Current state of the files this story touches

| File | Today | This story |
|---|---|---|
| `src/server/services/bill.service.ts` | `generateConsolidatedBill`, `getBill`, `loadSessionBill`, `findOpenBill`, `computeBillTotals`, **7** typed errors | ADD `generateSeatBill`; SPLIT `findOpenBill`; `collectBillable` gains seat + unbilled filters; `loadSessionBill` → plural |
| `src/server/services/order.service.ts` | `SessionAlreadyBilledError` fires on ANY bill (added 2026-10-13) | NARROW to per-seat — Conflict 1 |
| `src/server/db/schema.ts` | `bills` has no seat column; `billTypeEnum` already has `'seat'` | ADD `bills.seatSlotId` + partial unique index |
| `src/app/api/sessions/[sessionId]/seats/` | `route.ts`, `[seatId]/route.ts` (Story 4.3) | ADD `[seatId]/bill/route.ts` |
| `src/app/api/sessions/[sessionId]/bills/route.ts` | POST (consolidated) + GET (bill state) | POST now bills the remainder; GET returns a LIST |
| `src/components/pos/order-screen.tsx` | `['bill', sessionId]` holds ONE bill; `stripState` settles on `bill !== null` | plural; settle only when nothing is left to bill |
| `src/components/pos/seat-selector.tsx` | selection, add, note, remove | mark billed seats; "Bill This Seat" |
| `src/server/services/verify-bills.ts` | 60 checks, guarded cleanup, table recycling | UPDATE R1; ADD the matrix below |
| `src/types/bills.ts` | `BillDetail`, `BillTotals`, `BillLineDetail`, `BillCompDetail` | ADD `seatSlotId` / `seatLabel` to `BillDetail` |

### Verification matrix

| # | Case | Expected |
|---|---|---|
| 1 | Seat 1 of 3 billed | 201; `type: 'seat'`; lines = seat 1's events ONLY |
| 2 | **Round for seat 2 after seat 1 billed** | **201 — accepted** (AC-2; the Conflict 1 regression) |
| 3 | **Round for seat 1 after seat 1 billed** | 409 `SEAT_ALREADY_BILLED`, nothing written |
| 4 | Round with lines for seat 1 (billed) AND seat 2 | 409; seat 2's lines NOT written either (Trap 1) |
| 5 | Seat 2 billed after seat 1 | 201; no overlap in `bill_lines`; union = both seats |
| 6 | **Consolidated bill with seats 1–2 billed, 3–4 not** | 201 covering ONLY seats 3–4 (AC-5) |
| 7 | Consolidated bill when everything is billed | 422 `NOTHING_TO_BILL` |
| 8 | Round after a CONSOLIDATED bill | 409 — still refused for every seat |
| 9 | Same seat billed twice | 409 `SEAT_ALREADY_BILLED` with the billId |
| 10 | **Two simultaneous "Bill This Seat"** | exactly one bill; the other 409 |
| 11 | Seat with no items | 422 `SEAT_HAS_NO_ITEMS` |
| 12 | Seat whose every item is already on a consolidated bill | 422 `SEAT_HAS_NO_ITEMS` |
| 13 | `seatId` from another session | 404 `SEAT_NOT_ON_SESSION` |
| 14 | Seat bill on a table session | service charge applied on the SEAT's subtotal |
| 15 | Seat bill on a counter sale with no table | NO service charge |
| 16 | Hand-inserted comp on a seat's item | negative line on THAT seat's bill only |
| 17 | **Two concurrent bills on DIFFERENT seats of one session** | both 201 — the session lock must not turn AC-2 into a serialisation failure |
| 18 | **Seat 4 has an unpriced item; bill seat 1** | 201 — the unpriced guard is scoped to the COLLECTED set, not the session |
| 19 | Closed session | 409 `SESSION_ALREADY_CLOSED` |
| 20 | **Remainder bill with an `ITEM_ADDED` whose `seat_slot_id` IS NULL** | the null-seat row IS covered (Trap 2) |
| 21 | **A seat carrying a `seat_note`** | the note appears NOWHERE in the response (AC-11b) |
| 22 | `GET /api/sessions/:id/bills` with 2 seat bills | both returned |
| 23 | **Consolidated 409 when a seat bill is the oldest row** | the `billId` returned is the CONSOLIDATED one |

> **Cases 17, 18, 20, 21 and 23 replaced an earlier draft's four that could not fail** — trigger
> immutability, Kumar's 403, the snapshotted name and integer paisa are all already asserted by 6.2's
> checks 11, 12, 9b and 15, on paths this story does not touch. They were decoration by Trap 5's own
> test. The replacements each name a change to production code that would turn them red.

### Project Structure Notes

New: `src/app/api/sessions/[sessionId]/seats/[seatId]/bill/route.ts`, migration 0020.

`architecture.md:451` plans `POST /api/bills/:billId/payment` — Story 6.5. `architecture.md:520`/`:544`
plan `split-bill-canvas.tsx` and `split-bill.store.ts` — Story 6.1, deferred. **No new dependency.**

### References

- `epics.md:1743` — Story 6.4's acceptance criteria, and Conflicts 2 and 3 above
- `prd.md` FR25, FR26, FR27
- `_bmad-output/implementation-artifacts/6-2-implement-consolidated-bill-generation.md` — the
  machinery this story extends, its Review Findings, and the corrected Decision 1
- `src/server/db/errors.ts` — `isUniqueViolation`, and why the index NAME matters
- `src/server/services/verify-bills.ts` — the verification shape, cases 14b and R1 especially
- `deferred-work.md` — the four items deferred from 6.2's review; the close-while-billed one becomes
  more reachable with several bills per session

---

## ❓ Open question for Teran — answer before Task 5 is finished

**What does the action strip say when a table is half-billed?**

`OrderActionStrip` has one state for the whole screen, and a session can now be partly billed: seats 1
and 2 paid and gone, seats 3 and 4 still ordering. `settling` is wrong — three of the four actions
still apply. `submitted` is wrong too — it offers "Generate Bill" with no hint that half the table is
already settled.

Three ways:

1. **Stay in `submitted`, and let `SeatSelector` carry the billed marks.** The strip's "Generate Bill"
   means "bill whatever is left", which is exactly what AC-5 makes it do. *Smallest, and my
   recommendation — it needs no new state and no new copy.*
2. **A new `partially-billed` state** with its own wording ("2 of 4 seats settled"). Clearer at a
   glance, and a fifth state in a component three stories already depend on.
3. **Per-seat strips.** Truest to the feature and a redesign of the screen; not demo work.

Task 5 is written assuming (1). If you choose differently only the strip changes — the service, the
routes and the schema are the same either way.

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

`src/server/services/verify-bills.ts` — **98/98 passing** against the running dev server and the live
database, up from 60 at the end of Story 6.2.

```
pnpm exec tsx --env-file=.env src/server/services/verify-bills.ts
```

**Trap 7 was real, and the fix is proven by the run completing.** `cleanup()` sits in a `finally` and
`98/98 passed` prints only after it returns, so a foreign-key violation on `DELETE FROM order_sessions`
would have surfaced as a thrown error instead of a pass line. It did not.

**The post-run database check is now DONE (2026-10-13, after Docker Desktop was restarted).** It
could not be run immediately after the suite because the Docker engine stopped
(`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`). Result:

```
bills 1 · bill_lines 10 · disabled_triggers 0 · config 1000/0/false
rounds_today 0 · print_jobs_today 0 · sessions_today 0
```

`disabled_triggers 0` is the one that matters — no run died holding an append-only trigger off.
`rounds_today 0` and `print_jobs_today 0` are the direct evidence that Trap 7's registry fix works:
cases S2 and S3 send rounds through the real route, and nothing they wrote survived. The remaining
`bills 1 / bill_lines 10` is the manual bill from 2026-10-02, unchanged. Two `order_events` dated today
also survive; they belong to sessions opened 2026-10-02 and were written at 03:16, before any run in
this session, so they are pre-existing data rather than residue.

Three cases failed during development and all three were the SCRIPT asserting superseded behaviour,
not the code:

- **R1** asserted that ANY bill on a session refused ANY round. True for a consolidated bill, and
  exactly what this story makes false for a seat bill. Narrowed to the consolidated case; S2 now covers
  the other half.
- **R4** asserted the singular `{ bill }` shape from the GET endpoint, which is now
  `{ bills, hasUnbilled }`.
- **R4 again**, after my first correction: I asserted `hasUnbilled === true` on a session queried
  BEFORE anything was ordered. The endpoint was right and the assertion was wrong — nothing ordered
  means nothing to bill.

### Completion Notes List

Written from the run output above, not from memory.

**The conflict this story existed to resolve.** Story 6.2's review closed a real hole with a
session-wide refusal in `submitRound`; AC-2 here required it to be seat-scoped. `findOpenBill` is now
three functions — `findConsolidatedBill`, `findSeatBill`, `billedSeats` — and the guard refuses a round
only when it touches a billed seat, or when a consolidated bill has swept everything. **Case S2 is the
proof**: seat 1 billed, a round for seat 2 returns 201, a round for seat 1 returns 409 naming "S1".

**One builder, not two.** `generateConsolidatedBill` and `generateSeatBill` are thin wrappers over a
shared `buildBill`, which is parameterised by `seatId | null`. AC-10 demanded one arithmetic
implementation and the cheapest way to guarantee that was to leave only one code path.

**The validator's finding #2 was correct and would have been a silent 500.** The `bills` INSERT sat
outside Story 6.2's try/catch — fine while `bills` carried no unique index, and wrong the moment
`idx_bills_seat_slot` existed, because that index raises its 23505 on exactly that statement. It now
has its own try/catch mapping to `SeatBillAlreadyExistsError`. Case S7 is what proves it: two
simultaneous taps on one seat give one 201 and one 409, not a 500.

**A consolidated bill now covers the REMAINDER** (Decision 1). `collectBillable` filters to events no
`bill_lines` row claims — there is deliberately no `billed` flag on `order_events`, which would be a
second source of truth next to the unique index. S5 bills two of four seats then takes a consolidated
bill over the other two; S11 proves an event with a NULL `seat_slot_id`, which no seat bill can reach,
is picked up by that remainder.

**`settling` means "nothing left to bill", not "a bill exists".** Those became different statements in
this story, and `bill !== null` would have frozen the screen for three guests still eating. The
predicate is `hasUnbilledItems`, computed on the server and exported so Story 6.5 imports it rather
than writing a second version — see `deferred-work.md` on why 6.5's auto-close condition is
`everyBillSettled AND NOT hasUnbilled`. S14 walks a three-seat table through all three states.

**Both deferred-work items addressed to this story by name are implemented**, having been missed in the
story's first draft and caught by the validator:
- The seat NOTE reaches no bill. S12 sets a note to "bald man", bills the seat, and greps the whole
  response and the stored `bill_lines` rows for it.
- "Bill This Seat" is gated on `usesSeats`, so it does not appear for Bean Bags, Sun Beds, Rooftop or
  counter sales. The ROUTE still works if called — this is a UI gate, not a security one, and S13
  bills a counter seat deliberately.

**Deviation from the stated task order.** Task 1 is marked "do this first", but `billedSeats` and
`findSeatBill` cannot exist without `bills.seat_slot_id`, which Task 2 adds. Task 2 ran first.

**Also fixed, because this story is the moment it broke:** the consolidated 409's fallback re-read was
`ORDER BY created_at LIMIT 1` over all of a session's bills. 6.2's review added that ordering with the
comment "wrong the moment 6.4's per-seat bills land" — on a part-settled table the oldest row is
usually a seat bill, so a consolidated 409 handed the client a seat bill's id. Now filtered to
`seat_slot_id IS NULL`. S5's last check asserts it.

**Not done, and not in scope:** no payment is recorded, no seat or session is closed, and nothing
auto-closes a table. Story 6.5 owns all of that. A bill is not a payment.

### File List

New:
- `src/server/db/migrations/0020_nice_vision.sql`
- `src/server/db/migrations/meta/0020_snapshot.json`
- `src/app/api/sessions/[sessionId]/seats/[seatId]/bill/route.ts`

Modified:
- `src/server/db/schema.ts` — `bills.seatSlotId`, `idx_bills_seat_slot` (partial unique),
  `idx_bills_session_seat`
- `src/server/db/migrations/meta/_journal.json`
- `src/server/services/bill.service.ts` — `findOpenBill` split into three; `collectBillable` gains seat
  and unbilled filters; `buildBill` + `generateSeatBill`; `loadSessionBill` → `loadSessionBills`;
  `hasUnbilledItems`; four new typed errors; the `bills` INSERT wrapped
- `src/server/services/order.service.ts` — `SeatAlreadyBilledError`, the guard narrowed
- `src/app/api/sessions/[sessionId]/orders/route.ts` — 409 `SEAT_ALREADY_BILLED`
- `src/app/api/sessions/[sessionId]/bills/route.ts` — GET returns the list plus `hasUnbilled`; the
  409 re-read scoped to consolidated
- `src/app/orders/[sessionId]/page.tsx` — `initialBills` / `initialHasUnbilled`
- `src/components/pos/order-screen.tsx` — plural bill query, the `settling` predicate, the seat-bill
  mutation, "Bill This Seat", the `SEAT_ALREADY_BILLED` send branch
- `src/components/pos/seat-selector.tsx` — billed seats struck through and announced
- `src/types/bills.ts` — `seatSlotId`, `seatLabel`
- `src/server/services/verify-bills.ts` — R1 and R4 updated; 15 new case groups; `sendRound` helper;
  multi-seat fixture; `print_jobs` / `order_rounds` added to the cleanup

### Change Log

- 2026-10-13: Story created, immediately after 6.2's code review closed. The dominant finding is that
  this story **contradicts a guard added to `order.service.ts` hours earlier**: 6.2's review closed a
  real hole — items sent after a bill existed could never be billed — with a session-wide refusal, and
  AC-2 here requires exactly that refusal to be seat-scoped instead. Both are correct; the rule was
  written at the wrong granularity because a session could only hold one bill when it was written.
  Task 1 narrows it and updates the verification case that asserts the old behaviour, because leaving
  that case green while the behaviour changes underneath is how a test stops meaning anything. Two
  further mismatches between the epic's text and the built schema are recorded as Conflicts 2 and 3:
  the epic assumes a stored `status` on bills and seats, which 6.2 deliberately derived from payments
  instead, and its fourth criterion is Story 6.5's work. One decision taken up front because it shapes
  the service: a consolidated bill generated after some seats are billed covers the REMAINDER rather
  than being refused, which is the ordinary case of two guests paying individually and the rest sharing.
- 2026-10-13: Validated against the create-story checklist by an independent reviewer in a fresh
  context; 15 findings applied. Three mattered most. **Two deferred-work items address Story 6.4 by
  name** and the first draft missed both: the seat NOTE must never reach a guest-facing bill (Teran,
  2026-09-12 — now AC-11b), and per-seat billing must be hidden in zones that do not use seats
  (2026-09-16 — now AC-12). **The new partial unique index fires on the `bills` INSERT, which Story
  6.2 left outside its try/catch**, so AC-6 and AC-9 would have returned 500 instead of 409 — Task 3
  now says which statement to wrap. And **matrix case 2 is the first accepted send in the whole
  verification script**, which writes `order_rounds` and `print_jobs` rows the cleanup registry does
  not track, so it would have failed with a foreign-key violation and leaked every session of the run
  — Trap 7. The draft also shipped four matrix cases that could not fail, under a trap warning against
  exactly that; they are replaced with five that name the production change that would turn them red.
- 2026-10-13: Implemented. All six tasks complete; **98/98 verification checks pass** (60 before this
  story). The conflict the story was written around is resolved and proved by case S2: with seat 1
  billed, a round for seat 2 is accepted and a round for seat 1 is refused by name. The validator's
  warning about the `bills` INSERT sitting outside Story 6.2's try/catch was correct — the new partial
  unique index raises its 23505 on exactly that statement, so AC-6 and AC-9 would have been 500s; S7
  now proves they are 409s. Trap 7 was also correct: case S2 is the first accepted send in the script's
  history, and the cleanup registry needed `print_jobs` and `order_rounds` before it could survive one.
  Task 2 ran before Task 1 out of necessity — `billedSeats` cannot exist without the column Task 2 adds.
  The post-run database check was blocked at the time by Docker Desktop's engine stopping; it was run
  once Docker was back and is recorded in the Debug Log. Nothing leaked and no trigger was left
  disabled — `rounds_today 0`, `print_jobs_today 0`, `disabled_triggers 0`.
