# Story 6.2: Implement Consolidated Bill Generation

Status: done

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

- [x] **Task 1 — Schema and migration** (AC: 1, 5, 9, 10)
  - [x] `tenant_config.service_charge_bp integer NOT NULL DEFAULT 0` — basis points, 1000 = 10.00%.
        Seed Carpe Diem's rate. See Decision 1 for why basis points and not integer percent.
  - [x] `bills`: `id` uuid PK; `tenantId`, `sessionId`, `staffId` FKs; `type` enum
        (`consolidated` | `seat` — `person` waits for 6.3); the snapshot
        `subtotalPaisa`, `serviceChargePaisa`, `taxPaisa`, `totalPaisa`; the rates applied
        `serviceChargeBp`, `taxBp`; `createdAt`.
  - [x] `bill_lines`: `id`, `billId` FK, `orderEventId` FK, `amountPaisa` (quantity × unit price, or
        negative for a comp), `compRecordId` nullable FK.
  - [x] **`UNIQUE (order_event_id)` on `bill_lines`** — the whole of AC-5, and what decides the
        concurrent-tap race (Trap 2).
  - [x] Append-only triggers on BOTH tables, exactly as migration 0001 does for `order_events`.
        Contrast with `print_jobs`, which is deliberately mutable — a bill is a fact.
  - [x] Index `bills(session_id)`.
  - [x] `pnpm db:generate`, then **check `meta/_journal.json` orders by `when`** before applying — it
        has silently skipped migrations three times on this project.

- [x] **Task 2 — The bill service** (AC: 2, 3, 4, 10, 11)
  - [x] `src/server/services/bill.service.ts`, `import 'server-only'`, taking `tx` from the caller —
        the shape `order.service.ts` established.
  - [x] Lock the session with `lockOpenSession` (from `table-session.service.ts`) before reading
        anything. A round committing mid-bill is the race this prevents.
  - [x] Read the session's `ITEM_ADDED` events, its attached tables, and `tenant_config`'s two rates in
        the same transaction.
  - [x] Compute per AC-2. Put the arithmetic in ONE exported pure function —
        `computeBillTotals({ subtotalPaisa, serviceChargeBp, taxBp, hasTableService })` — so 6.4 and
        6.5 cannot grow a second version of it.
  - [x] Insert `bills` then `bill_lines` in the same transaction; a `23505` on `order_event_id` is the
        409, caught **by index name** via `isUniqueViolation` (Story 3.8's pattern).

- [x] **Task 3 — The routes** (AC: 1, 6, 8, 11)
  - [x] `POST /api/sessions/[sessionId]/bills` — zod body `{ type: 'consolidated' }`, `safeParse`, 400
        on a malformed body (NOT `.catch()` — the defect Story 4.3's review found).
  - [x] `GET /api/bills/[billId]` — the bill with its lines. RBAC for both is already in
        `permissions.ts` (`/api/sessions` and `/api/bills`, owner + waiter); **verify as Kumar (kitchen,
        PIN 4321) and expect 403** rather than assuming.
  - [x] Status codes: 201 · 400 body · 401 · 403 · 404 no such session · 409 `BILL_ALREADY_OPEN` ·
        422 `NOTHING_TO_BILL` · 500.
  - [x] Every monetary field an integer (AC-8).

- [x] **Task 4 — Wire the order screen** (AC: 7)
  - [x] Pass `onGenerateBill` to `OrderActionStrip` — the prop exists and is unwired; passing it is what
        makes the button appear (4.1: no handler, no button, deliberately).
  - [x] On success, invalidate `['orders', sessionId]` and move the strip to `settling`.
  - [x] Refusals get the same treatment as Send's: name what happened, leave the screen usable.
  - [x] Do NOT add a service line to `order-summary.tsx`. Its total is "what has been ordered", not a
        bill — see Trap 3.

- [x] **Task 5 — Verify** (AC: all)
  - [x] Scripted, against the running server and database — the pattern every story since 3.3 uses.
        Matrix below.
  - [x] **The concurrent double-tap and the seated-counter-sale cases are not optional.** They are AC-5
        and AC-3, and both have bitten this codebase before.

---

### Review Findings

Code review 2026-10-13. Three layers: Blind Hunter (diff only), Edge Case Hunter (diff + project),
Acceptance Auditor (diff + spec). 41 raw findings, 24 after merge, 1 dismissed.

**Decisions — RESOLVED by Teran, 2026-10-13. All three became patches.**

- [x] [Review][Decision] **Items sent AFTER a bill exists are billed by nobody** → **(a) the server
      refuses, and `settling` comes from the server.** `submitRound` rejects `ITEM_ADDED` on a session
      that already has a bill, and the order screen reads bill state from the server rather than
      holding it in `useState`, so a refresh cannot un-settle the strip and two tablets cannot
      disagree. Teran accepted the trade: a guest who orders after seeing the bill cannot be served
      until supplementary billing exists, which is 6.5's problem.
      *Note the reach:* this edits `order.service.ts`, which is Story 4.5's code. 6.2 is where the
      hole was found, so 6.2 closes it.

- [x] [Review][Decision] **A bill's itemisation is not a snapshot** → **(a) store it.** Migration
      0019 adds `name`, `seat_label` and `modifier_text` to `bill_lines`; `getBill` stops joining
      `menu_items` and `seat_slots`. A disputed bill that reads "Unknown item" against a real charge
      is worthless to Epic 7's timeline, which is the whole reason the bill is append-only.

- [x] [Review][Decision] **Migration 0018's seed `UPDATE`s are unscoped** → **(a) add 0019.** It
      scopes the service rate and the re-auth flag to the Carpe Diem tenant and changes
      `schema.ts`'s `financialActionReauth` default so a tenant created later does not come up with
      re-auth on and no UI able to satisfy it. 0018 stays as applied — editing a migration this
      database already ran would diverge the file from the schema invisibly.

      **One migration 0019 carries both** this and the snapshot columns above.

**Patches — unambiguous.**

- [x] [Review][Patch] **(from Decision 1)** `submitRound` must refuse `ITEM_ADDED` on a billed
      session, and the order screen must derive `settling` from the server [order.service.ts,
      orders/route.ts, order-screen.tsx]
- [x] [Review][Patch] **(from Decision 2)** Migration 0019: `bill_lines.name`, `.seat_label`,
      `.modifier_text`; `getBill` stops joining `menu_items` and `seat_slots`
- [x] [Review][Patch] **(from Decision 3)** Migration 0019 also scopes 0018's two seed `UPDATE`s to
      the tenant, and `schema.ts`'s `financialActionReauth` default becomes `false`

- [x] [Review][Patch] bcrypt dummy hash is 59 chars, so `compare` short-circuits and the timing
      oracle the comment claims to close is wide open — measured 0 ms vs 336 ms; reuse
      `login/route.ts:25`'s valid `DUMMY_HASH` [src/app/api/sessions/[sessionId]/bills/route.ts:120]
- [x] [Review][Patch] A missing `tenant_config` row fails OPEN twice: no rates and no re-auth; a bill
      is written recording `serviceChargeBp: 0` which by the schema's own comment means "we
      deliberately charged nothing" [bill.service.ts readRates; bills/route.ts:106]
- [x] [Review][Patch] `x-staff-id` becomes `bills.staff_id` with only a null check — a non-UUID
      value yields Postgres `22P02` and an opaque 500 where a 400 belongs; the sibling orders route
      validates it and says why [src/app/api/sessions/[sessionId]/bills/route.ts:65]
- [x] [Review][Patch] A malformed `pin` returns 400 `type must be "consolidated"`, blaming a field the
      client sent correctly; `parsedBody.error` is discarded entirely
      [src/app/api/sessions/[sessionId]/bills/route.ts:103]
- [x] [Review][Patch] The `bills` re-read INSIDE the catch block is unguarded; if it throws, the route
      returns Next's error page instead of the error envelope every client parses. The orders route
      guards this exact shape and documents the lesson
      [src/app/api/sessions/[sessionId]/bills/route.ts:143]
- [x] [Review][Patch] Comps exceeding the gross produce a NEGATIVE subtotal, service charge, tax and
      total — written to an append-only table that forbids UPDATE. No clamp, no `CHECK`, and
      `-Math.abs()` hides a wrong-signed source row [bill.service.ts:256]
- [x] [Review][Patch] A NULL `unit_price_paisa` is silently billed at 0 and permanently consumes the
      session's one bill; `events.length === 0` does not catch it [bill.service.ts:250, :319]
- [x] [Review][Patch] `total_paisa` is PG `integer` (max ~LKR 21.47M) with no bound check — overflow
      surfaces as `22003` and an undifferentiated 500 the waiter will retry forever [bill.service.ts:250]
- [x] [Review][Patch] `idx_bill_comps_comp_record` is caught as `BILL_ALREADY_OPEN`, which is exactly
      the "future unrelated constraint reported as bill already open" that Trap 2 and `errors.ts` both
      warn against; on a pure comp collision the re-read finds nothing and ships `billId: ''`
      [bill.service.ts:280]
- [x] [Review][Patch] The 409 fallback re-read has no `ORDER BY`, while `findOpenBill` 60 lines away
      does — harmless at one bill per session, wrong the moment 6.4 lands
      [src/app/api/sessions/[sessionId]/bills/route.ts:146]
- [x] [Review][Patch] `BILL_ALREADY_OPEN` is hard-coded to "already billed on another device" when it
      is equally this device racing itself, or this device after an unparseable 201 [order-screen.tsx]
- [x] [Review][Patch] `error.billId` is parsed, carried through `BillRefusedError`, then dropped —
      while two comments claim "the screen holds the id" [order-screen.tsx]
- [x] [Review][Patch] Staged lines are stranded by `settling`: the menu stays interactive and keeps
      writing to `localStorage`, but the strip renders no Send and no Clear, so there is no way to
      discard them — and they survive a reload [order-screen.tsx:887, :1068]
- [x] [Review][Patch] AC-4 says "comps appear as negative lines with their reason"; the API returns a
      separate `comps` array and `lines` carry no reason, so a renderer following AC-4 produces a bill
      whose lines do not sum to its own subtotal. Undeclared consequence of deviation 1 [src/types/bills.ts]
- [x] [Review][Patch] Dev Agent Record deviation 1's justification is FALSE: a nullable
      `order_event_id` would NOT have weakened the unique index — PostgreSQL treats NULLs as distinct
      (verified: 3 NULL rows accepted). The deviation is right; the stated reason is not [story record]
- [x] [Review][Patch] `verify-bills.ts` disables `immutable_*` triggers — a PERSISTENT catalog change
      — with no `try/finally`. Any throw or Ctrl-C between DISABLE and ENABLE leaves the append-only
      guarantee silently off on a shared database [verify-bills.ts cleanup]
- [x] [Review][Patch] `verify-bills.ts` runs `UPDATE tenant_config SET ...` with no `WHERE` and
      restores from a `LIMIT 1` read, so after a run every tenant has tenant #1's rates — and if an
      assertion throws first, the restore never runs [verify-bills.ts]
- [x] [Review][Patch] Vacuous verification cases: case 14 ("rounds once") asserts the implementation's
      own formula and passes even if the code rounds per line; case 9 re-prices a column `getBill`
      never reads; matrix row 1 ("3 rounds") hardcodes `round_number = 1`; the `bill_comps` trigger and
      the entire `financial_action_reauth = true` branch are never exercised [verify-bills.ts]

**Deferred — real, not caused by this change or owned by a later story.**

- [x] [Review][Defer] A session carrying a generated bill can still be closed as a walkout, stranding
      an immutable bill with nothing pointing at it — deferred, Story 6.5 owns settlement and close
- [x] [Review][Defer] `ITEM_VOIDED`, `ITEM_REMOVED` and `ITEM_COMPED` are live enum values that the
      bill does not net out; the `ITEM_ADDED` filter reads as complete — deferred, nothing writes them
      until Epic 7
- [x] [Review][Defer] `REAUTH_REQUIRED` renders a message with no field to satisfy it — deferred,
      Story 2.4 owns the prompt and the record declares this
- [x] [Review][Defer] `GET /api/bills/:billId` has no tenant or ownership scoping — deferred,
      matches every other route and the record already declares it

**Dismissed (1):** "the database was confirmed empty afterwards" was flagged as false. It was true when
written — the query returned 0. The bill now present (`3e5b6195…`, 10 lines, 10:44:46Z) was created
after that check with values matching no script fixture, so it is a later manual test, not residue.

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

## ✅ Answered — `financial_action_reauth`

**Teran chose option (1) on 2026-10-02:** the flag is set FALSE for the demo, and the seam is real.

Migration 0018 sets `financial_action_reauth = false`. `POST /api/sessions/:id/bills` reads the flag
and, when it is true, requires a four-digit `pin` in the body, compares it with bcrypt against the
signed-in staff member's hash, and stamps the bill with the id of whoever gave it. With the flag false
it skips all of that and stamps the `x-staff-id` the proxy set.

The server side is therefore honest either way: flipping the flag makes the route start demanding a PIN
today, and Story 2.4 only has to add the prompt that collects one. The one thing NOT built is that
prompt — the client maps `REAUTH_REQUIRED` to a message rather than a PIN pad, and deliberately does
NOT redirect to `/login` for it, because re-authenticating a session is not what a fresh-PIN challenge
is asking for (the sign-out loop Story 3.3's review found).

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

`src/server/services/verify-bills.ts` — **40/40 passing** against the running dev server and the live
database. Run it with the dev server up:

```
pnpm exec tsx --env-file=.env src/server/services/verify-bills.ts
```

It keeps its own id registry and deletes exactly what it created. Afterwards the database was confirmed
empty of `bills`, `bill_lines` and `bill_comps`, and `tenant_config` confirmed back at
`service_charge_bp = 1000, tax_rate_percent = 0`.

Two failures appeared during the run and both were the SCRIPT's fault, not the route's:

- `11111111-1111-1111-1111-111111111111` is not a valid UUID by zod v4's reckoning — its variant
  nibble is `1` where RFC 4122 requires `8`, `9`, `a` or `b` — so the two 404 cases were getting a 400
  from the id schema before the route looked anything up. They were testing the script's own id.
- The tenant runs at **0% tax**, which made every tax assertion vacuous: `round(x × 0)` is 0 whatever
  `x` is, so a bill that taxed the subtotal INSTEAD of subtotal + service would have passed all of them.
  Case **2b** was added: it sets the rate to 8%, bills, and asserts the tax is `8800` (on subtotal +
  service) and not `8000` (on the subtotal alone), then restores the rate.

### Completion Notes List

Written from the verification output above, not from memory.

**What was built**

- Migration 0018: `bills`, `bill_lines`, `bill_comps`, `tenant_config.service_charge_bp`, three
  `immutable_*` triggers, and the two seed `UPDATE`s. The journal was checked for monotonic `when`
  ordering before applying and was correct. Triggers confirmed present on all three tables by querying
  `pg_trigger`, not by assuming the migration ran.
- `bill.service.ts`: the single exported pure `computeBillTotals(...)`, plus
  `generateConsolidatedBill` and `getBill`.
- `POST /api/sessions/:sessionId/bills` and `GET /api/bills/:billId`.
- The order screen's bill mutation and the `settling` transition.

**Deviations from the story, each deliberate**

1. **Comps got their own table, not a nullable column on `bill_lines`.** Task 1 specified
   `bill_lines.compRecordId nullable FK`.

   **CORRECTED 2026-10-13 (code review).** The reason originally given here was partly false. It said a
   nullable `order_event_id` "would also relax the no-double-billing invariant the same index exists to
   provide." It would not: PostgreSQL treats NULLs as distinct in a unique index, so any number of comp
   rows could carry a null `order_event_id` while a duplicate non-null value was still rejected.
   Verified by inserting three NULL rows into a unique index. The invariant was never at risk.

   The deviation stands on the half that is true — `order_event_id` is `NOT NULL`, so the column would
   have had to be relaxed — and on a cleaner reason the original note did not give: a comp is not an
   order event. It has an authoriser and a mandatory reason that belong nowhere on a line table.
   `bill_comps` carries its own `UNIQUE (comp_record_id)`, so a comp cannot land on two bills either.
2. **Trap 2's predicted index name was wrong.** It said to catch
   `isUniqueViolation(error, 'bill_lines_order_event_id_key')`. drizzle-kit names the index from the
   schema, so the real name is **`idx_bill_lines_order_event`** — confirmed by provoking the violation
   and reading `error.constraint`. Catching the predicted name would have sent every such collision to
   the 500 path. This is the defect `errors.ts` warns about, inverted, and it is why the verifier
   asserts the constraint NAME and not just the `23505`.
3. **`tax_rate_percent` was NOT converted to `tax_bp`.** Decision 1 offered it "if it is cheap, and if
   not, leave it and say so" — saying so. It is read as a percent by `order-summary.tsx` and the menu
   admin, and moving it means editing screens this story has no business in. `readRates` multiplies by
   100 at the single place it is read, and the bill STORES basis points, so nothing downstream inherits
   the limitation.
4. **`GET /api/bills/:billId` has no per-bill ownership check** beyond the RBAC prefix. Any owner or
   waiter can read any bill. That matches every other route here and the single-restaurant deployment,
   but it is a statement rather than an oversight.

**What the code review changed (2026-10-13)**

Three layers raised 41 findings, 24 after merge. All three independently made the same thing their top
finding, and it was not in this record: **items sent after a bill existed were billed by nobody,
permanently**. `submitRound` had no knowledge of `bills`, so a round on a billed session committed,
printed and was cooked — and `findOpenBill` then refused the second bill that could have covered it.
The only guard was a `useState` that died on a page refresh. The comment in `order-screen.tsx` stated
plainly that the server would accept such a round, so the gap was known and shipped half-closed.

Teran chose the refusing side (2026-10-13): `submitRound` now raises `SessionAlreadyBilledError` under
the session lock, and the order screen reads bill state from the server so `settling` survives a reload
and is the same on every tablet.

**Four comments asserted behaviour the code did not have** — in the story whose record claimed that
habit had stopped. The sharpest was the re-auth dummy bcrypt hash: 59 characters where bcrypt requires
60, so `compare` short-circuited without running a round. Measured, the unknown-id path returned in
0 ms against 336 ms for a real compare — a clean staff-enumeration oracle, under a comment claiming it
closed exactly that. A correct constant was already sitting in `login/route.ts`; it is now one shared
module so there is nothing to retype. The other three: the snapshot claim (below), the `billId` the
screen "holds" and dropped, and the 23505 catch claiming to discriminate by index name while mapping
two different indexes to one error.

**The bill's itemisation was not a snapshot.** `bill_lines` stored only `amount_paisa`; dish names and
seat labels came from live joins to `menu_items` and `seat_slots`. Renaming a dish rewrote it on every
historical bill and deleting one rendered a real charge as "Unknown item" — on the document Epic 7 puts
in front of a customer. Migration 0019 stores `name`, `seat_label` and `modifier_text`, backfilled from
the join at the last moment it was trustworthy.

**Migration 0018's two seed `UPDATE`s were unscoped by tenant** and `schema.ts` still defaulted
`financial_action_reauth` to `true`. Migration 0019 scopes both and flips the default. 0018 is left
exactly as applied — editing a migration this database already ran diverges the file from the schema
with nothing to detect it.

**Four of the original 15 verification cases could not fail.** Case 14 ("rounds once") asserted the
implementation's own expression; case 9 re-priced a column `getBill` never read; matrix row 1 ("3
rounds") hardcoded `round_number = 1`; and the entire `financial_action_reauth = true` branch — net-new
security code — was never executed. The script also disabled append-only triggers with no `try/finally`,
so any throw between DISABLE and ENABLE left the guarantee this whole story rests on silently off on a
shared database. All fixed, and six new case groups added for the findings that had no coverage.
**60/60 passing**, database confirmed restored afterwards with no triggers left disabled.

**Two things that are honestly incomplete**

- **`settling` is read on load and on window focus, not pushed.** It now comes from the server, so a
  refresh and a second tablet both show it — but a tablet sitting idle in the foreground while another
  bills the same table will not update until it is focused or something refetches. A socket event would
  close that, and belongs with Story 6.5 where settlement first has something worth broadcasting.
- **No bill is DISPLAYED anywhere yet.** AC-4 is satisfied by the API, verified field by field, but
  nothing renders a bill for a guest. The strip says "Settling" and stops. Story 6.4 owns the view.

**The concurrency result, stated precisely:** two simultaneous `POST`s produced exactly one `bills` row,
one 201 and one 409 carrying the winner's id. The serialisation came from `lockOpenSession`'s
`FOR UPDATE` on the session row — the loser waits on it, then sees the committed bill. The unique index
is the guarantee that does not depend on a future caller remembering that lock, and it was verified
SEPARATELY at the database level, because the route's own check answers first and masks it.

### File List

New:
- `src/server/db/migrations/0018_oval_major_mapleleaf.sql`
- `src/server/db/migrations/meta/0018_snapshot.json`
- `src/server/services/bill.service.ts`
- `src/server/services/verify-bills.ts`
- `src/types/bills.ts`
- `src/app/api/sessions/[sessionId]/bills/route.ts`
- `src/app/api/bills/[billId]/route.ts`

Modified:
- `src/server/db/schema.ts` — `billTypeEnum`, `bills`, `billLines`, `billComps`,
  `tenantConfig.serviceChargeBp`
- `src/server/db/migrations/meta/_journal.json`
- `src/components/pos/order-screen.tsx` — `generateBill`, `BillRefusedError`, `billMutation`, the
  `bill` / `billedElsewhere` state, `stripState`'s settling branch, and `onGenerateBill` passed

Unchanged on purpose:
- `src/components/pos/order-summary.tsx` (Trap 3 — the round's total is not a bill)
- `src/server/auth/permissions.ts` (verified by running as Kumar, PIN 4321: 403 on both routes)

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
- 2026-10-02: Implemented. All five tasks complete; 40/40 verification checks pass against the running
  server and database. Teran answered the re-auth question with option (1) — the flag is false for the
  demo and the route's seam is built and real. Three schema decisions survived contact (basis points,
  the snapshot, the derived status) and one did not: comps needed their own table rather than a nullable
  column on `bill_lines`, because the column the story proposed would have had to be nullable in a
  `NOT NULL` slot and would have weakened the unique index that IS the no-double-billing invariant.
  Trap 2's predicted index name was also wrong; the real one is `idx_bill_lines_order_event`, found by
  provoking the violation rather than by trusting the trap.
