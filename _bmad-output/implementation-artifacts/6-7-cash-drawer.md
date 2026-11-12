# Story 6.7: Cash Drawer

Status: in-progress

- **Epic:** 6 — Bill Settlement & Payment Recording
- **Requirement:** FR72 (also NFR-I2, NFR-D1)
- **Go-live:** yes, directly after 6.6. Both use the receipt printer.
- **Hardware:** the drawer is plugged into the XP-Q80B's **DK** (RJ11) port, not into the PC. The printer opens
  it when it receives an ESC/POS kick. Teran has the drawer; connect it before the physical test.

## Story

As an owner,
I want the cash drawer to open only for a cash payment or a reason someone has recorded,
so that every opening of the drawer can be accounted for.

## Acceptance Criteria

1. **Cash payment opens it.** A payment with a cash tender (Cash, or the cash part of Cash + card) queues one
   drawer-kick job to the `cashier` printer in the same transaction as the payment. A card-only payment queues
   none.
2. **Never costs the payment.** The kick is queued inside a savepoint, like the auto-receipt (6.6). If queuing it
   fails, the payment is still recorded and the response says `drawerJobId: null`.
3. **Kick before receipt.** When the payment also settles the bill, the kick job is queued before the receipt
   job, so the drawer opens while the receipt prints. Both are on the `cashier` queue, which keeps order.
4. **Open drawer without a sale.** The owner can open the drawer with a reason: `Change`, `Float`, or `Other`
   plus a note. A waiter or kitchen user does not see the control, and the route refuses them (403).
5. **Every opening is recorded.** Each kick writes one row to a new append-only table, `cash_drawer_openings`:
   sale or no-sale, reason and note (no-sale), the cash payment row (sale), staff, time, and the print job.
   No role can edit or delete a row (NFR-D1).
6. **Ready for end of day.** A service function returns the no-sale openings for a business date, with staff
   name, reason, note and time, for Story 9.5 to show. 9.5 builds the screen; this story builds the data.
7. **Printer trouble.** A kick waits, retries and dead-letters like any print job (NFR-I2). The banner reads
   `The bill printer is not responding`, as for bills, because it is the same printer. A payment is never
   blocked or delayed by the drawer.
8. **Old jobs still print.** Tickets and receipts print byte-for-byte as before; a job with no `kind` is a ticket.
9. **No regressions.** `verify-receipt`, `verify-escpos`, `verify-queue`, `verify-bills`, `verify-options`,
   `verify-custom-charge`, `verify-order-number`, type-check and lint all pass.

## Tasks / Subtasks

- [x] **Task 1: Migration (AC 1, 4, 5)**
  - [x] `print_jobs.session_id` becomes nullable; add a CHECK that it is only null on a `cashier` job
        (a no-sale belongs to no order). Every existing row has one.
  - [x] New enums `cash_drawer_kind` (`sale`, `no_sale`) and `cash_drawer_reason` (`change`, `float`, `other`).
  - [x] New table `cash_drawer_openings`: `id`, `tenant_id`, `kind`, `reason` (null on sale), `note`,
        `payment_record_id` (FK, null on no-sale), `print_job_id` (FK), `staff_id` (FK), `created_at`
        (`clock_timestamp()` default). Index on `(tenant_id, created_at)`.
  - [x] CHECKs: `sale` ⇔ `payment_record_id IS NOT NULL AND reason IS NULL`; `no_sale` ⇔ `reason IS NOT NULL`;
        `reason = 'other'` ⇒ `note` has text; `note` at most 120 characters.
  - [x] Append-only: `CREATE TRIGGER immutable_cash_drawer_openings BEFORE UPDATE OR DELETE … EXECUTE FUNCTION
        prevent_immutable_table_mutation()` (the function from migration 0001).
  - [x] Declare the CHECKs in `schema.ts` with `check()` where Drizzle can, so `drizzle-kit generate` does not
        drop or re-emit them (6.6 review deferral). Hand-write only the trigger.
  - [x] `pnpm db:generate`, read the SQL, `pnpm db:migrate`. Number 0034.
- [x] **Task 2: Kick bytes (AC 1, 8)**
  - [x] `src/types/tickets.ts`: `DrawerKickPayload` = `{ kind: 'drawer'; destination: 'cashier';
        tableLabels: string[]; opening: 'sale' | 'no_sale' }`. `tableLabels` is `['Cash drawer']`: the worker
        reads it for alerts (6.6 Trap 4). Add it to `PrintPayload`, with an `isDrawerKickPayload` guard.
  - [x] `src/server/print/escpos.ts`: `buildDrawerKick()` returns `ESC @` then `ESC p m 25 250`
        (`1B 40 1B 70 m 19 FA`: 50 ms on, 500 ms off). `m` is `0` (pin 2) by default, `1` (pin 5) when
        `CASH_DRAWER_PIN=5`, read at delivery time like the printer env vars. No cut, no feed.
  - [x] `buildPrintBytes` dispatches `drawer` → `buildDrawerKick`; `renderTicketText` logs `CASH DRAWER (sale)`.
- [x] **Task 3: Service (AC 1, 2, 3, 4, 5, 6)**
  - [x] New `src/server/services/cash-drawer.service.ts`:
    - `kickForCashPayment(tx, { paymentRecordId, staffId, tenantId, sessionId })` inserts the job, then the
      opening row with `kind = 'sale'`.
    - `openWithoutSale(tx, { tenantId, staffId, reason, note })` inserts the job (`session_id` null), then
      the row with `kind = 'no_sale'`.
    - `listNoSaleOpenings(executor, { tenantId, businessDate })` returns the openings between the business
      day's start and end. Reuse the business-day boundary that migration 0032 uses (tenant timezone,
      `business_day_start_hour`); do not write a second definition of "a day".
  - [x] `recordPayments` returns the id of the cash row it inserted, or null.
- [x] **Task 4: Payments route (AC 1, 2, 3)**
  - [x] In `src/app/api/bills/[billId]/payments/route.ts`, after `recordPayments` and BEFORE the auto-receipt,
        call `kickForCashPayment` in its own savepoint when a cash row was inserted. Log and continue on
        failure. Return `drawerJobId`.
- [x] **Task 5: No-sale route (AC 4)**
  - [x] `POST /api/cash-drawer/open`, body `{ reason: 'change' | 'float' | 'other', note?: string }` (zod; `other`
        requires a note; note trimmed, at most 120). Returns `202 { jobId }`.
  - [x] RBAC: add `{ prefix: '/api/cash-drawer', roles: ['owner'] }` to `ROUTE_ROLES` BEFORE the route exists,
        as the file's own comments require (an unmatched prefix is default-allow). Add
        `canOpenCashDrawer(role)` beside `canAddCustomCharge`, so Story 10.6 can grant it per person.
- [x] **Task 6: Open drawer control (AC 4)**
  - [x] A small icon button in `FloorHeader`, left of the staff badge, owner only (`canOpenCashDrawer`). Icon only
        with `aria-label="Open cash drawer"` and a 44px target. It is a rare, owner-only action, so it stays
        small and out of the waiter's way.
  - [x] Tapping opens a small dialog: three reason chips (Change, Float, Other); a note field that appears for
        Other and is required there; `Cancel` and `Open drawer`. Disabled while sending. On success, close the
        dialog and show the floor's existing notice: `Drawer opening — recorded`. On refusal, show the
        server's message in the dialog.
- [ ] **Task 7: Verify (AC all)**
  - [x] New `src/server/print/verify-drawer.ts`, with the same local-database guard and trigger handling as
        `verify-receipt.ts`. Cover the Testing table below.
  - [ ] Run every regression script in AC 9.
  - [ ] Physical test: connect the drawer to the DK port, take a cash payment, then do a no-sale with Change.
        The drawer must open both times and stay shut for a card payment.

## Dev Notes

### Decisions already taken

| Decision | Why |
|---|---|
| A separate kick job, not bytes inside the receipt | Most cash payments are not the bill's last (split, part cash), so there is often no receipt. One kind of job, every time. |
| Kick is queued before the receipt | The drawer opens while the receipt prints; on one queue the order is kept by `created_at` (6.6's head-of-line rule). |
| Owner only | The roles are `waiter`, `owner`, `kitchen`. There is no manager role; the epic's "owner or manager" is the owner today. `canOpenCashDrawer` is where 10.6 widens it. |
| Icon in the floor header | A no-sale is not about any table, so it does not belong in a table's bar. Rare and owner-only, so small (Teran's UI rule). |
| Record sale openings too | 9.5 only counts no-sales, but a complete log of every opening is what lets the owner audit the drawer. |

### 🚨 Trap 1: `print_jobs.session_id` is NOT NULL

A no-sale has no order. Make it nullable, but only for `cashier` jobs, so a kitchen ticket without a session is
still impossible. Check everything that reads `session_id`: the verify scripts' cleanups delete by session, so
also delete this run's own no-sale jobs by id.

### 🚨 Trap 2: the kick must never undo a payment

Use the savepoint pattern from the auto-receipt in the same route (`tx.transaction(...).catch(...)`). A failure
inside a savepoint without it aborts the whole transaction, and the guest's payment with it.

### 🚨 Trap 3: a late kick opens the drawer late

The queue retries for about 83 seconds. If the printer was off, the drawer can spring open a minute after the
payment, which is surprising but harmless. Do NOT add a second retry layer or shorten the ladder for kicks;
note it in the completion notes so staff can be told.

### 🚨 Trap 4: stale-claim recovery may kick twice

The worker retries a job it cannot prove was delivered (`recoverStaleClaims`). For a drawer that means opening
twice, which is acceptable, the same trade the queue makes for tickets. Never count "kicks delivered" as
openings: the audit row is written when the kick is requested, which is the fact that matters.

### 🚨 Trap 5: the 7.3 stash

`git stash` holds 7.3 with its own migrations 0033 and 0034. 6.6 already took 0033; this story takes 0034. When
7.3 comes back, both of its migrations must be regenerated. Do not pop or edit the stash here.

### What must keep working

- `claimNextJob` and `buildTicket`/`buildReceipt` are unchanged.
- The auto-receipt and its COPY rules from 6.6 are unchanged; the kick is a separate job with no `bill_id`.
- The existing payment request with no cash tender behaves exactly as before.

### Out of scope

- The end-of-day screen (9.5) and any drawer count reconciliation.
- Detecting whether the drawer is actually open or shut (`DLE EOT` status): not supported over USB spooling.
- A no-sale from the bill screen or for waiters. 10.6 can grant `canOpenCashDrawer` per person later.

### Project Structure Notes

| File | Change |
|---|---|
| `src/server/db/schema.ts`, migration 0034 | Task 1 |
| `src/types/tickets.ts` | Task 2 |
| `src/server/print/escpos.ts`, `transport.ts` | Task 2 |
| `src/server/services/cash-drawer.service.ts` (new), `payment.service.ts` | Task 3 |
| `src/app/api/bills/[billId]/payments/route.ts` | Task 4 |
| `src/app/api/cash-drawer/open/route.ts` (new), `src/server/auth/permissions.ts` | Task 5 |
| `src/components/pos/floor-header.tsx`, `table-grid.tsx` (role and notice) | Task 6 |
| `src/server/print/verify-drawer.ts` (new) | Task 7 |

### Testing

The project has no test framework by decision; each story adds a `verify-*.ts` script.

| # | Case | Expected |
|---|---|---|
| 1 | Kick bytes | `1B 40 1B 70 00 19 FA`; with `CASH_DRAWER_PIN=5`, `1B 40 1B 70 01 19 FA` |
| 2 | Cash payment | one `cashier` kick job, one `sale` row pointing at the cash payment row |
| 3 | Card-only payment | no kick, no row |
| 4 | Cash + card | one kick, one row, pointing at the cash row |
| 5 | Cash payment that settles the bill | kick job created before the receipt job |
| 6 | Owner no-sale, Change | 202; job with null session; `no_sale` row with reason |
| 7 | Other with no note | 400; nothing written |
| 8 | Waiter no-sale | 403; nothing written |
| 9 | UPDATE or DELETE a row | refused by the trigger |
| 10 | `listNoSaleOpenings` for a business date | only that day's no-sales, with staff name, reason, note |
| 11 | Worker drains kick then receipt | delivered in that order; a failing kick dead-letters with a `cashier` alert |
| 12 | Kick queuing fails (forced) | payment recorded, `drawerJobId: null` |
| 13 | Stored ticket and receipt jobs | same bytes as before |

### References

- [Source: _bmad-output/planning-artifacts/prd.md FR72]
- [Source: _bmad-output/planning-artifacts/epics.md Story 6.7]
- [Source: _bmad-output/implementation-artifacts/6-6-print-the-customer-bill.md, auto-receipt savepoint, `cashier`
  destination, Traps 1, 4, 7]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md, 6.6 review: CHECKs in schema, 0033 lock note]
- [Source: src/server/db/migrations/0001_append_only_rules.sql, `prevent_immutable_table_mutation`]
- [Source: src/server/db/migrations/0032_dusty_freak.sql, the business-day boundary]
- [Source: src/server/auth/permissions.ts, `ROUTE_ROLES` and `canAddCustomCharge`]
- ESC/POS `ESC p m t1 t2` (generate pulse): pulse on t1 × 2 ms, off t2 × 2 ms; `m` 0 = pin 2, 1 = pin 5.

## Open Questions (for Teran)

1. **Are the reasons right?** Change, Float, Other + note. Easy to add more later.
2. **Owner only, for now?** There is no manager role. If a trusted waiter needs it before Story 10.6, say so.

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Migration is **0036** (`0036_thin_sugar_man.sql`), not 0034: the bill layout work (receipt QR, logo) took 0034
  and 0035 the same day. The CHECKs are declared in `schema.ts` with `check()`; only the trigger and SQL
  functions are hand-written.
- "Which business day" now has ONE definition: SQL function `business_date_at(tenant, ts)`. The order-number
  trigger (`assign_order_number`) was rewritten to call it, and `listNoSaleOpenings` filters with it.
- `kickForCashPayment` takes only the payment row id and staff id; tenant and order are read from the payment
  row, never trusted from the caller. A payment with two cash tenders opens the drawer once (the first).
- Both the payments route and the no-sale route call `wakePrintQueue()` after commit, so the drawer opens at
  once instead of on the queue's next 3-second tick. Optimisation only; the timer still guarantees delivery.
- The no-sale route asks `canOpenCashDrawer` itself as well as relying on `ROUTE_ROLES`, so the two cannot drift.
- `verify-receipt.ts` cleanup now deletes this run's `cash_drawer_openings` first (they reference its payments and
  jobs) — its cash payment opens the drawer since this story. No other verify script takes payments.
- Trap 3 for staff: if the printer was off, the drawer can open up to about a minute after the payment, when
  the queue's retry reaches it. Trap 4: a stale claim retried may open it twice. Both accepted; the audit row
  records the request, not the delivery.
- verify-drawer part 2: 34/34 (dev server running). Non-printing regressions: verify-receipt --paper-only 32/32,
  verify-order-number 15/15, type-check clean, lint 0 errors (1 pre-existing warning).

### File List

- src/server/db/schema.ts
- src/server/db/migrations/0036_thin_sugar_man.sql (new) and migrations/meta
- src/types/tickets.ts
- src/server/print/escpos.ts
- src/server/print/transport.ts
- src/server/services/cash-drawer.service.ts (new)
- src/server/services/payment.service.ts
- src/app/api/bills/[billId]/payments/route.ts
- src/app/api/cash-drawer/open/route.ts (new)
- src/server/auth/permissions.ts
- src/components/pos/cash-drawer-button.tsx (new)
- src/components/pos/floor-header.tsx
- src/components/pos/table-grid.tsx
- src/server/print/verify-drawer.ts (new)
- src/server/print/verify-receipt.ts

## Change Log

- 2026-11-12: Story created.
- 2026-11-12: Tasks 1-6 implemented; verify-drawer added (34/34). Remaining: printing regressions, worker part, physical test.
