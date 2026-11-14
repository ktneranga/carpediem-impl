# Story 7.5: Void a Sent Item

Status: ready-for-dev

<!-- Go-live. Added 2026-11-14 by sprint-change-proposal-2026-11-14.md. Next after 9-5, before 11-3 lite.
     Testing: verify scripts during dev; the screen-level pass is in the final round (launch rush). -->

## Story

As a waiter,
I want to void an item sent by mistake, with the owner's approval,
so that the guest is not charged and the kitchen stops making it.

## Decisions (Teran, 2026-11-14; change any before dev)

- **A void is an `ITEM_VOIDED` order event**, linked to the `ITEM_ADDED` line it voids. It is NOT a
  `comp_record` (overrides the 2026-11-04 note on 7.3). Voided units are simply never billable, so the
  guest's bill has no negative line. Comps stay in Story 7.3 (after launch).
- **Approval = owner-role PIN on the same tablet.** There is no manager role (`staff_role` is
  `waiter | owner | kitchen`). An owner who starts a void approves it themselves (no PIN asked). A waiter
  must get an owner-role PIN typed in. Both people are recorded. A trusted shift lead who needs to
  approve is given the owner role in Staff (10.2); Manage is still behind the owner password.
- **Reasons (fixed list):** "Entered by mistake", "Guest changed mind", "Kitchen can't make it",
  "Other" (+ a note, required for Other, max 120 chars).
- **Quantity:** 1 to the line's *unbilled, unvoided* units. A line of 3 can lose 1.
- **VOID ticket** to that item's station on the print queue: `VOID KOT #042`, the table, `1 × Fried Rice`.
  A custom charge (no menu item, no station) gets no ticket.
- **Cancel an unpaid bill** (same approval, reason required: "Wrong item on it", "Guest wants it split
  differently", "Other" + note). Only a bill with **no payments**. Its items become unbilled again; the
  waiter voids what's wrong and prints a new bill. A bill with any payment: refused (that's a refund).
- **How a bill is cancelled — a one-way stamp on `bills`, not a separate table.** `bills` gets
  `cancelled_at`, `cancelled_by_staff_id`, `cancel_approved_by_staff_id`, `cancel_reason`. The
  `immutable_bills` trigger is replaced by one that allows exactly ONE update: those four columns going
  from NULL to set, every other column unchanged. Everything else (a second cancel, any other change,
  DELETE) still raises. Why not a `bill_cancellations` table (the proposal's wording): the partial unique
  index `idx_bills_seat_slot` must ignore cancelled bills so the seat can be billed again, and a partial
  index can only filter on its own table's columns. Bill lines are never touched.

## Acceptance Criteria

1. **Void from the order screen.** On an open order, each SENT line (round history) that still has
   unbilled, unvoided units shows a small Void action. It opens a sheet: quantity stepper (1..units left),
   reason chips, note (required for Other). Submit is disabled until valid.
2. **Approval.** If the signed-in staff is an owner, Submit voids directly. Otherwise the sheet asks for an
   owner PIN (reuse `PINPad`). Wrong PIN, or a non-owner's PIN → "That PIN can't approve voids", nothing
   written. 5 wrong PINs from the same requester → locked 5 minutes ("Too many wrong PINs. Try again in N
   minutes."). The PIN never appears in logs or error bodies.
3. **What is written.** One `ITEM_VOIDED` row in `order_events`: `session_id`, `staff_id` = requester,
   `approved_by_staff_id` = approver, `voids_event_id` = the `ITEM_ADDED` row, `quantity`, `menu_item_id`
   and `custom_name` copied from the line, `unit_price_paisa` copied, `notes` = reason (and note),
   `seat_slot_id` and `round_number` copied. The original row is never updated. Idempotent on a client
   `requestId` (a double tap writes one void).
4. **Never over-void.** A DB trigger on `order_events` insert of `ITEM_VOIDED` locks the original row
   (`FOR UPDATE`, as migration 0027 does) and refuses when voided + billed-on-live-bills + new > quantity
   (`check_violation`, constraint name `order_event_void_within_quantity`). The service checks first and
   maps the violation to "Only N left to void".
5. **Everything that counts items or money drops the voided units** (see "Every reader" below): the order
   screen's total and item count, the floor card's count and running total, the counter-sales list, the
   bill screen's unbilled items, bill generation, "is anything left to bill", auto-close, and the
   walkout/abandoned rule (an order whose every unit is voided counts as nothing ordered).
6. **VOID ticket.** In the same transaction as the void, a `print_jobs` row is queued for the line's
   station with a `TicketPayload` carrying `void: true`, printed as `VOID KOT #042` /
   `VOID  <date> <time>  (Round N)` / the table header / `1 × Fried Rice` with its options and seat. Then
   the print queue is woken after commit. No ticket for a custom charge or a line with no station.
7. **Cancel bill.** On the bill screen, an unpaid bill (no `payment_records` for it) has a small
   "Cancel bill" action (not a primary button). Same approval and lockout as a void, reason required.
   On success the bill is stamped (Decisions), the session's items it held are unbilled again, the screen
   returns to the order, and another bill can be generated, including for the same seat.
8. **Cancel refused when paid.** A bill with any payment → 409 "This bill has payments — it can't be
   cancelled." Already cancelled → 409 "This bill is already cancelled."
9. **A cancelled bill counts nowhere:** not in bill lookups (`findConsolidatedBill`, `findSeatBill`,
   `billedSeats`, `loadSessionBills`), not in billed units (bill generation, the quantity triggers,
   `hasUnbilledItems`, payment auto-close), not in `loadSales` / `loadTakings` / `loadInsights`, not as
   "Bill printed, not settled". A payment against a cancelled bill is refused.
10. **Dashboard.** "Unclosed & corrections" shows each void as `Voided: 1 × Fried Rice (Entered by
    mistake) · Nimal, approved by Teran`, and each cancelled bill as a new `cancelled` row ("Bill
    cancelled · LKR 4,500 · reason · by, approved by"). The void appears there without other changes to
    the panel (it already reads `ITEM_VOIDED`).
11. **Other tablets update.** After a void or a cancel, emit the same socket events a round/bill does
    (`table:status_changed`, `session:payment_changed`, and the counter-sales event for counter orders),
    after commit, so other tablets and the Dashboard refresh.
12. **Permissions.** Routes are under `/api/sessions/:id/...` and `/api/bills/:id/...` — already open to
    owner and waiter in `ROUTE_ROLES`. Kitchen role gets 403. A closed session → 409 "This order is
    closed."

## Tasks / Subtasks

- [ ] **T1 — Migration `0043_void_and_bill_cancel.sql`** (AC 3, 4, 7, 9)
  - [ ] `order_events`: add `voids_event_id uuid NULL REFERENCES order_events(id)`,
        `approved_by_staff_id uuid NULL REFERENCES staff(id)`, `request_id uuid NULL`; partial index on
        `voids_event_id` where not null; unique `(session_id, request_id)` where not null.
        Check: `event_type <> 'ITEM_VOIDED' OR (voids_event_id IS NOT NULL AND approved_by_staff_id IS NOT NULL AND quantity > 0)`.
  - [ ] `bills`: add the four `cancel*` columns (nullable). Check: all four NULL or all four set
        (`cancel_reason` non-empty).
  - [ ] Replace `immutable_bills` with a function allowing only the one-way cancel stamp (Decisions).
        Keep `immutable_bill_lines` / `immutable_bill_comps` as they are.
  - [ ] Recreate `idx_bills_seat_slot` as `UNIQUE (seat_slot_id) WHERE seat_slot_id IS NOT NULL AND cancelled_at IS NULL`.
  - [ ] Replace `bill_lines_within_event_quantity()` (0027): billed = bill_lines on bills with
        `cancelled_at IS NULL`; also add voided units of the event; keep `FOR UPDATE` on the event.
  - [ ] New trigger `order_event_void_within_quantity` (BEFORE INSERT on `order_events` when
        `ITEM_VOIDED`): lock the voided row, refuse over-void (AC 4); also refuse when `voids_event_id`
        is not an `ITEM_ADDED` of the same session.
  - [ ] Mirror the columns/indexes in `schema.ts` (`drizzle-kit generate` then hand-edit the SQL as
        earlier migrations do; keep the journal/snapshot consistent).
- [ ] **T2 — One definition of "units left"** (AC 5, 9). New `src/server/orders/units.ts`:
  - [ ] `billedUnits` SQL (bill_lines joined to `bills` with `cancelled_at IS NULL`) and `voidedUnits`
        SQL (sum of `ITEM_VOIDED.quantity` where `voids_event_id = order_events.id`), both correlated on
        `order_events.id`, plus `liveUnits = quantity − voidedUnits`.
  - [ ] Replace the inline billed-units copies: `bill.service.ts` (`collectBillable`, `hasUnbilledItems`),
        `payment.service.ts` (~line 290). Unbilled now means `quantity > billed + voided`.
  - [ ] `item-count.ts`: `dishCount` / `dishTotalPaisa` subtract voided units (callers still filter
        `ITEM_ADDED`). Update the comment in `app/orders/[sessionId]/page.tsx:139`.
  - [ ] `submitted-rounds.ts`: return `voidedQuantity` per line so round history can show "1 voided"
        and offer Void only while units are left.
- [ ] **T3 — `src/server/services/void.service.ts`** (AC 2, 3, 6, 7, 8)
  - [ ] Port from the 7.3 stash (reference only, do not `stash pop` — migrations collide):
        `git show "stash@{0}^3:src/server/services/comp.service.ts"` → `findApprover` (constant-time loop,
        `DUMMY_PIN_HASH`), the wrong-PIN lockout map, `resolveApproval`, the VOID ticket block and
        `findVoidRound`. Narrow the approver to `role = 'owner'` and active.
  - [ ] `voidItem(tx, { sessionId, orderEventId, quantity, reason, note, requestId, staffId, approverId })`:
        `lockOpenSession`, replay on `requestId`, check units left, insert, queue the ticket.
  - [ ] `cancelBill(tx, { billId, reason, note, staffId, approverId })`: lock the session, refuse paid /
        cancelled / closed, stamp.
- [ ] **T4 — VOID ticket printing** (AC 6). Port from the stash diff (`git diff "stash@{0}^1" "stash@{0}" -- src/server/print src/types/tickets.ts`):
      `TicketPayload.void?: true`, `buildVoidTicketPayload` in `ticket.ts`, the `VOID ` prefix and
      no SERVE WITH in `escpos.ts`. Add a case to `verify-escpos.ts`.
- [ ] **T5 — Routes** (AC 2, 8, 11, 12)
  - [ ] `POST /api/sessions/[sessionId]/voids` `{ orderEventId, quantity, reason, note?, approverPin?, requestId }` → 201.
  - [ ] `POST /api/bills/[billId]/cancel` `{ reason, note?, approverPin? }` → 200.
  - [ ] zod bodies; never echo the PIN; error codes `INVALID_PIN`, `PIN_LOCKED`, `NOT_ENOUGH_UNITS`,
        `BILL_HAS_PAYMENTS`, `BILL_CANCELLED`, `SESSION_CLOSED`. After commit: wake the print queue and emit
        the socket events (AC 11), same helpers as `orders/route.ts`.
- [ ] **T6 — Cancelled bills out of every reader** (AC 9) — see the list below. Prefer one Drizzle
      condition `liveBill = isNull(bills.cancelledAt)` and one SQL fragment for raw queries.
- [ ] **T7 — Order screen** (AC 1, 2): `round-history.tsx` — a small Void icon per sent line with units left
      (rare action → small icon by the line, not a strip button); "1 voided" note on the line.
      New `components/pos/void-sheet.tsx` (reason chips, stepper, note, then `PINPad` for a waiter).
      The stash's `comp-sheet.tsx` (`git show "stash@{0}^3:src/components/pos/comp-sheet.tsx"`) is the layout
      reference. Refresh the order after success.
- [ ] **T8 — Bill screen** (AC 7, 8): small "Cancel bill" action on an unpaid bill; same sheet pattern.
- [ ] **T9 — Dashboard** (AC 10): `insights.service.ts` corrections query → also select the approver and
      the void's quantity; add the `cancelled` audit kind (badge "Bill cancelled", warn) in
      `insight-panels.tsx` `BADGES`.
- [ ] **T10 — Verify script `src/server/services/verify-voids.ts`** (pattern: `verify-takings.ts`, throwaway
      tenant, local-only cleanup with guards disabled around deletes — add `bill_comps`, and re-enable).
      Cases: void 1 of 3 → 2 billable, bill total right; over-void refused by service AND by trigger
      (direct insert); waiter PIN refused; owner PIN accepted; owner self-approves; lockout after 5;
      replay with same `requestId` writes once; VOID job queued with `void: true`; custom charge → no job;
      cancel unpaid bill → items billable again, same seat billable again; cancel paid bill refused;
      second cancel refused; any other UPDATE on `bills` still raises; `loadSales` and `loadInsights`
      ignore the cancelled bill; dishCount drops; voids and cancel appear in `audit`.
- [ ] **T11 — Regression:** run `verify-bills`, `verify-takings`, `verify-insights`, `verify-dashboard`,
      `verify-custom-charge`, `verify-options`, `verify-escpos`; `npx tsc --noEmit`; `npx eslint` on touched files.

## Dev Notes

### Current state (read before changing)

- **Nothing writes `ITEM_REMOVED` / `ITEM_VOIDED` today.** Both are in `orderEventTypeEnum`
  ([schema.ts:30-36](../../src/server/db/schema.ts)). `order_events` has no link to another event and no
  approver column.
- **"Already billed" = a `bill_lines` row claims units of the event** (migration 0025, units). The rule is
  copied inline in `bill.service.ts` `collectBillable` (~254) and `hasUnbilledItems` (~971), and in
  `payment.service.ts` (~290). The DB guard is `bill_lines_within_event_quantity()` (0025, locked in 0027).
- **Bills are immutable** (`immutable_bills`, `immutable_bill_lines`, `immutable_bill_comps` in 0018,
  function `prevent_immutable_table_mutation()` in 0001). `bills` has no status; "open" = paid < total
  (`payment_records.bill_id`). Seat bills are unique per seat via `idx_bills_seat_slot` (0020).
- **Item counts** go through `dishCount` / `dishTotalPaisa` in `src/server/orders/item-count.ts`; callers
  filter `ITEM_ADDED` themselves.
- **PIN checking pattern:** `app/api/auth/login/route.ts` — compare against every active staff, no early
  exit, `DUMMY_PIN_HASH` when none, 4-digit zod, never echo the PIN.
- **Print queue:** jobs in `print_jobs`, `round_id` NOT NULL (a void job belongs to the round the dish went
  out in — the stash's `findVoidRound` handles pre-0014 rows with no round: record the void, no ticket, the
  sheet says "Tell the kitchen"). Wake with `wakePrintQueue()` after commit.
- **Dashboard** already lists `ITEM_REMOVED/ITEM_VOIDED/ITEM_COMPED` as corrections
  (`insights.service.ts`, "Corrections" query) — names come from `coalesce(e.custom_name, m.name)`, so copy
  `menu_item_id` and `custom_name` onto the void row.
- **Receipt "handed over" check** (`receipt.service.ts` ~208) already treats an `ITEM_VOIDED` after a bill
  print as making that print stale — good, keep it.

### Every reader to update (T2 / T6)

Unit counts (subtract voids): `app/api/sessions/route.ts` (~228), `app/api/sessions/[sessionId]/close/route.ts`
(~94), `app/api/sessions/[sessionId]/tables/route.ts` (~212), `app/api/tables/route.ts` (~164),
`app/api/tables/[tableId]/merge/route.ts` (~228), `.../unmerge/route.ts` (~137),
`.../sessions/close/route.ts` (~130), `app/orders/[sessionId]/page.tsx` (~144),
`server/orders/submitted-rounds.ts`, `server/services/order.service.ts` (~410 writes; ~374 round number —
leave), `takings.service.ts` / `insights.service.ts` ("has an ITEM_ADDED" order tests — an order with
everything voided still counts as an order; leave), `receipt.service.ts`.

Bills (exclude cancelled): `bill.service.ts` (`findConsolidatedBill`, `findSeatBill`, `billedSeats`,
`collectBillable`, `loadSessionBills`, `hasUnbilledItems`), `payment.service.ts` (refuse paying a cancelled
bill; auto-close), `receipt.service.ts` (no printing a cancelled bill), `takings.service.ts` (`loadSales`
bills/lines/comps, closed-unpaid owed), `insights.service.ts` (compare, buckets, top items, comp reasons,
unclosed "Bill printed", walkout owed), `app/api/sessions/[sessionId]/bills/route.ts`,
`app/api/sessions/[sessionId]/seats/[seatId]/bill/route.ts`, `components/pos/bill-screen.tsx`,
`components/pos/order-screen.tsx` (bill state reads).

### Guardrails

- **Append-only stays true.** No UPDATE/DELETE on `order_events`, `bill_lines`, `bill_comps`,
  `payment_records`. The only UPDATE anywhere is the one-way bill cancel stamp, enforced by the trigger.
- **One definition each** of billed units, voided units and live bill — the existing comments in
  `bill.service.ts` explain why (two copies drift). Don't add a fourth inline copy.
- **Lock order:** `lockOpenSession` first, then the event row (the triggers lock it too) — same as bill
  generation, so a void and a bill on the same line serialise.
- **Do not restore the stash.** It's based on migrations 0033–0034 (repo is at 0042) and carries comps,
  `comp_records.kind` and the `comp` permission, which are out of scope. Port the named pieces only.
- **UI weight:** Void and Cancel bill are rare actions → small icon/secondary control near the thing they
  change (Teran's rule), never a primary button in the action strip.
- **Money is integer paisa; no re-pricing** — the void copies `unit_price_paisa` from the line.

### Files

New: `src/server/db/migrations/0043_void_and_bill_cancel.sql`, `src/server/orders/units.ts`,
`src/server/services/void.service.ts`, `src/server/services/verify-voids.ts`,
`src/app/api/sessions/[sessionId]/voids/route.ts`, `src/app/api/bills/[billId]/cancel/route.ts`,
`src/components/pos/void-sheet.tsx`.
Changed: `schema.ts`, `item-count.ts`, `submitted-rounds.ts`, `bill.service.ts`, `payment.service.ts`,
`receipt.service.ts`, `takings.service.ts`, `insights.service.ts`, `print/ticket.ts`, `print/escpos.ts`,
`print/verify-escpos.ts`, `types/tickets.ts`, `round-history.tsx`, `order-screen.tsx`, `bill-screen.tsx`,
`dashboard/insight-panels.tsx`, the API routes listed above.

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-11-14.md]
- [Source: _bmad-output/planning-artifacts/epics.md#Story 7.5: Void a Sent Item (go-live)]
- [Source: _bmad-output/planning-artifacts/epics.md#Story 7.3] (2026-11-04 notes — VOID ticket wording, lockout)
- [Source: _bmad-output/planning-artifacts/prd.md] FR48 (append-only), go-live list item 2
- [Source: git stash@{0} "Story 7.3 comp/void - reverted 2026-11-06"] — `comp.service.ts`, `comp-sheet.tsx`,
  `ticket.ts`, `escpos.ts`, `types/tickets.ts`
- [Source: src/server/db/migrations/0018, 0020, 0025, 0027] — immutability, seat index, unit triggers

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
