# Story 6.6: Print the Customer Bill

Status: review

- **Epic:** 6 — Bill Settlement & Payment Recording
- **Requirement:** FR69 (also FR27, FR68, NFR-I1, NFR-I2)
- **Go-live:** yes. Second on the go-live order, after the 4.8 review; 6.7 (cash drawer) builds on this story.

## Story

As a cashier,
I want to print the bill the guest pays from, and a receipt once they have paid,
so that the guest can check it and keep it.

## Acceptance Criteria

The epic's criteria say "a generated bill". The code has moved since: a bill row is written at Settle
(Story 6.5), so a guest asking for the bill has no bill row yet. These criteria replace the epic's wording.

1. **Print before paying.** On the bill screen, an unpaid whole-table draft, an unpaid recorded bill, and each
   person's share in a split can each be printed. Printing writes NO `bills` row: the waiter can still go back
   and add a dessert.
2. **Queued, never direct.** Print inserts one `print_jobs` row and returns. The request never waits on the
   printer. Retries, backoff, dead-lettering and the printer banner are the same as tickets (NFR-I2).
3. **Contents.** The paper shows, in this order:
   restaurant name; `BILL` or `RECEIPT`; `#042`; table(s) or tab; date and time; each line with quantity, name,
   amount, options and note; comps if any; subtotal; service charge with its rate (when charged); tax with its
   rate (when charged); total; `Order 20261102-042` at the foot.
4. **Server prices it.** Every amount on the paper comes from the server: `priceBillable` for a draft or share,
   the stored `bills` and `bill_lines` for a recorded bill. Nothing the client sends is printed as money.
5. **Paid receipt.** A bill with payments prints as `RECEIPT` and adds each tender (cash, card), plus for cash
   the amount received and the change. A part-paid bill prints as `BILL` and shows `Paid` and `Still to pay`.
6. **Copy.** Printing a recorded bill that already has a live print job prints `COPY` under the title. A dead
   job does not count, because it never reached paper. Drafts never print `COPY`: each is a fresh pricing.
7. **Splits.** Each person's or seat's bill prints on its own paper, from its own button.
8. **Guest privacy.** Seat notes ("red shirt") and tab nicknames ("white shirt") never reach paper. See Trap 3.
9. **Closed or stale.** A closed order refuses with 409. A share whose units were billed elsewhere refuses with
   409 and the screen says to refresh. Neither queues a job.
10. **Printer trouble is visible.** The banner reads `The bill printer is not responding` / `The bill has not
    printed`, never "cashier" or "undefined".
11. **Old jobs still print.** A job stored before this story, with no `kind`, prints as a ticket, exactly as today.
12. **No regressions.** Kitchen tickets are byte-for-byte unchanged. `verify-escpos`, `verify-bills`,
    `verify-queue`, `verify-order-number`, type-check and lint all pass.

## Tasks / Subtasks

- [x] **Task 1: Migration (AC 1, 2, 5, 6)**
  - [x] New pg enum `print_destination`: `kitchen`, `pizza_kitchen`, `bar`, `cashier`. Change
        `print_jobs.destination` to it: `ALTER COLUMN destination TYPE print_destination USING destination::text::print_destination`.
        Do NOT add a value to `production_destination` (Trap 1).
  - [x] `print_jobs.round_id` becomes nullable (Trap 2).
  - [x] Add `print_jobs.bill_id uuid NULL` with a foreign key to `bills`, and an index on it.
  - [x] Add `payment_records.cash_received_paisa integer NULL`, plus a CHECK that it is null or at least `amount_paisa`.
  - [x] Add `tenant_config.receipt_header text NULL` and `receipt_footer text NULL`, printed when set (see Open Question 1).
  - [x] Update `schema.ts`, run `pnpm db:generate`, read the generated SQL, then `pnpm db:migrate`.
- [x] **Task 2: Types (AC 3, 11)**
  - [x] `src/types/tickets.ts`: add `PrintDestination = ProductionDestination | 'cashier'` and `ReceiptPayload`
        (`kind: 'receipt'`, everything the paper needs, copied in). `PrintPayload = TicketPayload | ReceiptPayload`.
        `TicketPayload` gets no new required field. A row with no `kind` is a ticket.
  - [x] `PrinterAlertPayload.destination` becomes `PrintDestination`.
  - [x] `print_jobs.ticket` is typed `PrintPayload` in `schema.ts`.
- [x] **Task 3: Receipt builder (AC 3, 5, 6)**
  - [x] `buildReceipt(receipt: ReceiptPayload): Buffer` in `src/server/print/escpos.ts`, sharing `foldToAscii`,
        `wrapLine`, `printableName`, `calendarDate`, `clockTime` and the cut sequence.
  - [x] `buildPrintBytes(payload: PrintPayload)`: receipt goes to `buildReceipt`, anything else to `buildTicket`.
        Use it in `usb-transport.ts` and `escpos-transport.ts`.
  - [x] Add `'−': '-'` to `FOLD` (Trap 5). Right-align amounts by padding to `PAPER_COLUMNS` after folding.
  - [x] `renderTicketText` handles a receipt, so the null transport logs it readably.
  - [x] Keep `src/server/print/` free of `server-only`. `@/lib/format` and `@/lib/order-number` are safe to import.
- [x] **Task 4: Enqueue service (AC 1, 2, 4, 6, 8, 9)**
  - [x] New `src/server/services/receipt.service.ts` with `printBill(tx, { billId })` and
        `printDraft(tx, { sessionId, items? })`. Both run under `lockOpenSession`.
  - [x] Build the payload with `sanitizeTicketText` on every string, via a builder in `src/server/print/ticket.ts`.
  - [x] Table labels: read every attached table, labels sorted as `bill/page.tsx` does; a tab prints `Bar tab`
        and a counter order `COUNTER`.
  - [x] Copy: under the session lock, count this bill's jobs with `status <> 'dead'`.
- [x] **Task 5: Routes (AC 2, 9)**
  - [x] `POST /api/bills/[billId]/print` (RBAC inherited from the `/api/bills` prefix).
  - [x] `POST /api/sessions/[sessionId]/bill-print`, body `{ items?: { eventId, quantity }[] }`, validated with zod.
        RBAC is inherited too: `permissions.ts` already gives `/api/sessions` to owner and waiter.
  - [x] Return `202 { success: true, data: { jobId } }`. Map `SessionAlreadyClosedError` and `ItemsNotBillableError`
        to 409; `UnpricedItemError` and `CompsExceedOrderError` to 422.
- [x] **Task 6: Record cash received (AC 5)**
  - [x] The payments route accepts optional `cashReceivedPaisa`, refused unless a cash tender exists and it is at
        least the cash amount. `recordPayments` stores it on the cash row and still caps tenders at the bill.
  - [x] `PaymentDialog` sends what the pad holds as `received`. Its `onPay` signature grows.
  - [x] `loadSessionPayments` returns it for the receipt.
- [x] **Task 7: Bill screen (AC 1, 7, 9, 10)**
  - [x] Add a `Print bill` button to `TotalsCard` and `ColumnFooter`, above Settle, secondary style (white with a
        slate border, `h-touch-waiter`). This is an everyday action, so it gets a real button, not an icon.
  - [x] Add `Print receipt` to each chip in the Paid list, restyled as a compact button of at least
        `touch-standard` height. Keep the `{label} · {total}` text.
  - [x] Hide Print on a draft while `draftError` is set: the screen cannot say what is owed.
  - [x] Show `Sending…` while the request runs, disable the button (a double tap would print twice), then `Sent to
        printer` for about two seconds. Refusals use the existing `notice` line.
  - [x] Delete `PRINT RECEIPT` from the "Not drawn yet" comment on `PaymentDialog`.
- [x] **Task 8: Printer banner (AC 10)**
  - [x] `printer-alert-banner.tsx`: `station()` maps `cashier` to `bill`.
- [x] **Task 9: Verify (AC all)**
  - [x] New `src/server/print/verify-receipt.ts`, covering the Testing table below.
  - [x] Extend `verify-escpos.ts`: a stored job with no `kind` prints the same bytes as before.
  - [x] Run all the regression scripts in AC 12. `verify-queue` needs the dev server stopped.

## Dev Notes

### Decisions already taken

| Decision | Why |
|---|---|
| Print from the draft, write no bill | Story 6.5's rule: opening or reading a bill changes nothing. Writing a bill to print it would lock the units and stop the waiter adding a dessert. |
| Printing is manual, never automatic on Settle | Teran: do not waste the roll. Many guests do not want a receipt. |
| One queue, a new `cashier` destination | The bill must not wait behind a stuck kitchen ticket, and head-of-line order works unchanged. 6.7's drawer kick uses the same destination. |
| `COPY` only for recorded bills | A draft has no identity and may have changed since the last print. |
| Tenders stay capped at the bill | Story 6.5: "change is the screen's arithmetic, not the restaurant's revenue". `cash_received_paisa` is a note on the row, never revenue. |

### Paper layout (48 columns)

```
                 Carpe Diem
              BILL  #042  (double)
                  Table 7
06 Nov 2026  7:42 PM
------------------------------------------------
1 x Butter Prawns                     LKR 2,450
2 x Mojito                            LKR 3,800
   - Extra shot x2
   - no ice
------------------------------------------------
Subtotal                              LKR 6,250
Service 10%                             LKR 625
Total                                 LKR 6,875   (bold)
------------------------------------------------
Cash                                  LKR 6,875
Received                              LKR 7,000
Change                                  LKR 125
------------------------------------------------
Order 20261102-042
```

The title reads `RECEIPT` once fully paid; `COPY` sits on its own centred line beneath. `receipt_header`
prints under the restaurant name and `receipt_footer` above the order reference, when set. Show a percentage
with `percentLabel` logic from `bill-screen.tsx`; move it to `@/lib/format` rather than copying it.

### 🚨 Trap 1: the destination enum is shared with the menu

`print_jobs.destination` uses `production_destination`, the same enum as `menu_items`. Adding `cashier` to it would
let a dish be routed to "cashier". That is why the column gets its own enum. The worker's `NOT EXISTS` head-of-line
query compares destinations, so `NULL` is not an option either: `NULL = NULL` is never true, and two bills could
overtake each other.

### 🚨 Trap 2: `round_id` is NOT NULL

A bill has no round. Check nothing reads `round_id` assuming it is set: today only the insert in `order.service.ts`
and the verify scripts touch it.

### 🚨 Trap 3: two ways a nickname reaches the guest

Teran's decision of 2026-09-12: the seat note never appears on a guest-facing bill.
- `tableLabel` on the bill screen uses `tabName`, which includes the nickname. Do not reuse it. Read the session on
  the server and print `Bar tab`.
- `bills.person_label` and split-column names can be the seat NOTE: `bill/page.tsx` sets `name: seat.seatNote ??
  seat.seatLabel`. Print a person label only if it matches `/^Person \d+$/`, otherwise print `Split bill`. A seat
  bill prints `bill_lines.seat_label`, which is safe.
- `bill_lines.modifier_text` (the kitchen note) DOES print. FR69 asks for it.

### 🚨 Trap 4: the worker reads `job.ticket.tableLabels`

Alerts read this field, so `ReceiptPayload` must carry `tableLabels: string[]`. Keep `destination` on the payload too.

### 🚨 Trap 5: the true minus disappears

`lkrFromPaisa` and `deduction` use U+2212. `foldToAscii` has no entry for it and strips anything non-ASCII, so a
comp of `−LKR 500` would print as `LKR 500` and read as a charge. Add it to `FOLD`. Also, `lkrFromPaisa` loses the
sign when the rupee part is zero (`-50` gives `LKR 0.50`): format the absolute amount and prefix the sign.

### 🚨 Trap 6: receipts must stand alone

Copy everything at enqueue, as `TicketPayload`'s header explains. Never store ids and re-read at print time. Use
the database clock for the printed time, so a job printed late shows when it was requested.

### 🚨 Trap 7: the print worker cannot import `server-only`

`receipt.service.ts` lives in `src/server/services/` and may use it, but everything it hands the worker must be
plain data, and everything in `src/server/print/` must stay free of it. A mistake here fails at boot, not at build.

### 🚨 Trap 8: `payment_records` is append-only

Adding a column is fine; backfilling is not, and is not needed. Old rows have a null `cash_received_paisa`, and
the receipt then omits `Received` and `Change`.

### What must keep working

- `buildTicket` output is unchanged for every existing job shape.
- `claimNextJob` needs no change at all. If you find yourself editing it, stop: the enum already does the job.
- `recordPayments` still refuses tenders above the bill, and the existing payment request with no
  `cashReceivedPaisa` stays valid.
- The split columns' Settle and retry behaviour (`createBillFor`, `billId` on a payable) is unchanged.

### Out of scope

- Reprinting after the table is closed. `bill/page.tsx` redirects a closed order to the floor, so there is no
  screen. It belongs with past orders (Story 7.2). Log it in `deferred-work.md`.
- Cash drawer (6.7), end-of-day print (9.5), receipt logo image, Sinhala or Tamil on paper (printer is ASCII only;
  those names print `[name not printable]`, as tickets do).
- 10.0's settings screen for header and footer. Until then, set them with SQL.

### Project Structure Notes

| File | Change |
|---|---|
| `src/server/db/schema.ts`, new migration | Task 1 |
| `src/types/tickets.ts`, `src/types/bills.ts` | Task 2 |
| `src/server/print/escpos.ts`, `ticket.ts`, `transport.ts`, `usb-transport.ts`, `escpos-transport.ts`, `worker.ts` (types only) | Tasks 2, 3 |
| `src/server/services/receipt.service.ts` (new), `payment.service.ts` | Tasks 4, 6 |
| `src/app/api/bills/[billId]/print/route.ts` (new), `src/app/api/sessions/[sessionId]/bill-print/route.ts` (new), `src/app/api/bills/[billId]/payments/route.ts` | Tasks 5, 6 |
| `src/components/pos/bill-screen.tsx`, `printer-alert-banner.tsx` | Tasks 6, 7, 8 |
| `src/server/print/verify-receipt.ts` (new), `verify-escpos.ts` | Task 9 |

**7.3 stash:** `git stash` holds "Story 7.3 comp/void - reverted 2026-11-06", with its own migrations 0033 and 0034
and edits to `bill.service.ts` and `bill-screen.tsx`. This story's migration takes number 0033, so a later
`git stash pop` will collide and 7.3's migrations must be regenerated. Do not pop or edit the stash here.

### Testing

The project has no test framework by decision; each story adds a `verify-*.ts` script.

| # | Case | Expected |
|---|---|---|
| 1 | Print a draft | one `cashier` job, `bill_id` null, `round_id` null; no `bills` row written |
| 2 | Print a person's share with a part quantity | amounts match what Settle then records for that share |
| 3 | Share asks for more units than remain | 409, no job |
| 4 | Recorded bill printed twice | second payload has `copy: true` |
| 5 | First job dead, printed again | not a copy |
| 6 | Cash paid 6,875, received 7,000 | receipt shows Received and Change 125; row stores 700000; bill total unchanged |
| 7 | Split tender, cash + card | both tenders print; change only from the cash part |
| 8 | Older cash payment (null received) | no Received or Change lines, no crash |
| 9 | Tab with nickname | paper has `Bar tab`, nickname absent from the whole payload |
| 10 | Person label holding a seat note | paper has `Split bill`, note absent from the whole payload |
| 11 | Dish name with `\x1b`, `×`, and a Sinhala name | no control bytes; fits 48 columns; marker printed |
| 12 | Long name beside an amount | wraps under the name; amount stays right-aligned; no line above 48 |
| 13 | Closed session | 409, no job |
| 14 | Job with no `kind` | same bytes as `buildTicket` |
| 15 | Worker drains a receipt through a fake transport | `printed`; a failing transport retries, then alerts with `cashier` |
| 16 | Stuck `kitchen` job | a `cashier` job is still claimed |

Then print one real bill and one receipt on the XP-80C, and check layout and cut by eye.

### References

- [Source: _bmad-output/planning-artifacts/prd.md FR69, FR27, FR68, NFR-I1, NFR-I2]
- [Source: _bmad-output/planning-artifacts/epics.md Story 6.6, Story 6.7, Story 5.2 amendment]
- [Source: _bmad-output/planning-artifacts/architecture.md "Bill printing (FR69)", "Print Queue"]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-11-04.md]
- [Source: _bmad-output/implementation-artifacts/5-2-implement-escpos-ticket-generation-and-tcp-printing.md Traps 1, 4, 5, 6]
- [Source: src/app/orders/[sessionId]/bill/page.tsx, nothing written by opening it; nickname comment]
- [Source: src/types/bills.ts, seat note rule, Teran 2026-09-12]
- [Source: src/server/services/payment.service.ts, "Never past the total"]

### Previous work worth knowing

- 6.5's story file is not in `implementation-artifacts`; its decisions are in comments in `bill-screen.tsx`,
  `bill/page.tsx` and `payment.service.ts`. Read those first.
- Recent commits add optional payload fields rather than required ones (`49d1806`, `b56487d`, `8d7a605`). Follow
  that pattern for tickets.
- No new dependency is needed. ESC/POS here is hand-built, so no library research applies.

## Open Questions (for Teran)

1. **What goes on the bill besides the restaurant name?** Address, phone, thank-you line, tax number. The story adds
   free-text header and footer fields, so the answer is data, not code. If a tax number is legally required on the
   bill, confirm the wording with the restaurant's accountant.
2. **Is `BILL` / `RECEIPT` the right wording?** Easy to change later.

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Debug Log References

- `verify-escpos` and `verify-queue` cast to `::production_destination` when seeding jobs; after the enum
  change that cast no longer matches the column. Both now cast to `::print_destination`.
- `verify-queue`'s "PRINTER_IP set → a real transport" case fails whenever `.env` sets `PRINTER_USB_NAME`
  (USB wins since `49d1806`). Not caused by this story: it passes 24/24 with the variable unset. Logged in
  `deferred-work.md`.
- The React Compiler lint refused a timer held in a ref inside the bill screen; replaced with an effect keyed on
  the printed state.
- Every route test ran against a dev server started with `PRINTER_USB_NAME` empty, so no test bill reached the
  real XP-80C.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- **Queue:** new `print_destination` enum with `cashier`; `print_jobs.round_id` nullable; `print_jobs.bill_id`
  for COPY. Migration `0033_naive_ego` also adds two hand-written CHECKs: a job has a round exactly when it is
  not a bill, and `cash_received_paisa` is only on a cash tender and never below it. The worker's claim query is
  unchanged.
- **Paper:** `buildReceipt` in `escpos.ts`: restaurant name and header lines, `BILL #042` / `RECEIPT #042`,
  `COPY`, tables or `Bar tab`, date and time, lines with right-aligned amounts, options and notes, comps,
  subtotal, service and tax with rates, a double-height Total, tenders with Received and Change, Paid and
  Still to pay on a part-paid bill, footer lines, `Order 20261102-042`, feed and cut. `buildPrintBytes`
  dispatches on `kind`; both transports use it. Kitchen tickets are byte-for-byte unchanged (checked against
  the previous commit's builder on four ticket shapes).
- **Sign fix:** `−` (U+2212) now folds to `-`, and `receiptMoney` keeps the sign below one rupee
  (`lkrFromPaisa(-50)` reads `LKR 0.50`).
- **Service:** `receipt.service.ts` with `printDraft` (priced by `priceBillable`, writes no bill) and `printBill`
  (from the stored bill, its payments, and COPY = a live job already exists). Both under `lockOpenSession`.
  An empty draft is refused rather than printed blank.
- **Privacy:** a tab prints `Bar tab`, never its nickname; a person or split label prints only as `Person N` or
  `Seat N`, otherwise `Split bill`, because split names can be seat notes. Verified the nickname and the seat
  note are absent from the whole stored payload.
- **Cash received:** optional `cashReceivedPaisa` on the payments route, stored on the cash row, refused (400)
  without a cash tender or below it. The payment dialog sends it in Cash mode only; Cash + card sends none.
- **Bill screen:** `Print bill` on the whole-table card, on unpaid recorded bills and on each person's column,
  above Settle and the same height; `Print receipt` on each paid bill. `Sending…`, then `Sent to printer` for
  two seconds; every print button is disabled while one is sending. Refusals use the existing notice line.
- **Banner:** `cashier` reads as "The bill printer is not responding" / "The bill has not printed".
- **Shared:** `percentFromBp` moved from `bill-screen.tsx` to `@/lib/format` so paper and screen word a rate the
  same way.
- **Verification:** `verify-receipt.ts` 54/54 (paper, routes) and 26/26 with `--worker` (dev server stopped);
  `verify-escpos` 54/54; `verify-queue` 24/24 with `PRINTER_USB_NAME` unset; `verify-bills` 119/119;
  `verify-options` 33/33; `verify-custom-charge` 22/22; `verify-order-number` 15/15; type-check clean; lint
  shows only the pre-existing warning in `src/server/socket/index.ts`. Bill page HTML checked: an open tab
  renders `Print bill`; a paid one renders `Print receipt`.
- **Receipt prints by itself (Teran, 2026-11-10, after the first build):** the payment that settles a bill
  queues its RECEIPT in the same transaction, inside a savepoint so a failed print never undoes the payment;
  the response carries `receiptJobId`. A part payment prints nothing. `Print receipt` on the Paid list now
  prints another, marked COPY. COPY counts only earlier jobs with the same title, so the bill printed before
  paying does not make the receipt a copy. This replaces the story's "never automatic on Settle" decision.
  `verify-receipt` 58/58, `verify-bills` 119/119.
- **Paid but still seated (Teran, 2026-11-10, added to this story):**
  - Each open order now has a payment state, `none` / `part` / `paid` (`sessionPaymentState`; `paid` is exactly
    `isFullyPaid`, the rule the close route enforces). `/api/tables` and `/api/sessions` return it.
  - New socket event `session:payment_changed`, keyed by session, emitted after a payment, after any bill is
    written (a LKR 0 bill is paid at once), and after a round (a paid table owes again). The grid patches only
    rows still showing that session; `table:status_changed` resets it to `none` when the session changes.
  - Table card: a green **✓ Paid** pill, or an amber **Part paid** pill, in place of the total. Nothing on the
    card closes a table (Teran: buttons on the card make it worse).
  - Bottom bar, only when the selected table or tab is paid: **Close table** / **Close tab** as the primary
    action, Open order as secondary, Bill & split hidden. Closes as `settled`; the server refuses (409) if
    anything is owed, shown as a notice.
  - Bill screen: "All paid. Close Table 5?" with Keep open / Close table after the payment that settles
    everything. Never automatic (review D1).
  - Print receipt on the Paid list shrunk to a 44px printer icon ("Print another receipt"), since the
    receipt now prints itself.
  - `verify-receipt` 66/66 (adds the floor states, the live event, a paid table owing again after one more
    drink, and the refused close); `--worker` 26/26; `verify-bills` 119/119; `verify-options` 33/33;
    `verify-custom-charge` 22/22; `verify-order-number` 15/15; `verify-escpos` 54/54; `verify-queue` 24/24.
- **Not done:** no bill has been printed on the real XP-80C, and the screen has not been tried in a browser.
  The printer banner's new wording was type-checked, not seen.

### File List

- `src/server/db/schema.ts` (modified)
- `src/server/db/migrations/0033_naive_ego.sql` (new)
- `src/server/db/migrations/meta/0033_snapshot.json` (new)
- `src/server/db/migrations/meta/_journal.json` (modified)
- `src/types/tickets.ts` (modified)
- `src/lib/format.ts` (modified)
- `src/server/print/escpos.ts` (modified)
- `src/server/print/ticket.ts` (modified)
- `src/server/print/transport.ts` (modified)
- `src/server/print/usb-transport.ts` (modified)
- `src/server/print/escpos-transport.ts` (modified)
- `src/server/print/worker.ts` (modified)
- `src/server/print/verify-receipt.ts` (new)
- `src/server/print/verify-escpos.ts` (modified)
- `src/server/print/verify-queue.ts` (modified)
- `src/server/services/receipt.service.ts` (new)
- `src/server/services/payment.service.ts` (modified)
- `src/app/api/bills/[billId]/print/route.ts` (new)
- `src/app/api/sessions/[sessionId]/bill-print/route.ts` (new)
- `src/app/api/bills/[billId]/payments/route.ts` (modified)
- `src/components/pos/bill-screen.tsx` (modified)
- `src/components/pos/printer-alert-banner.tsx` (modified)
- `src/types/tables.ts` (modified)
- `src/server/socket/events.ts` (modified)
- `src/app/api/tables/route.ts` (modified)
- `src/app/api/sessions/route.ts` (modified)
- `src/app/api/sessions/[sessionId]/orders/route.ts` (modified)
- `src/app/api/sessions/[sessionId]/bills/route.ts` (modified)
- `src/app/api/sessions/[sessionId]/seats/[seatId]/bill/route.ts` (modified)
- `src/components/pos/table-card.tsx` (modified)
- `src/components/pos/table-grid.tsx` (modified)
- `src/components/pos/floor-action-strip.tsx` (modified)
- `_bmad-output/implementation-artifacts/deferred-work.md` (modified)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified)

## Change Log

- 2026-11-06: Story created.
- 2026-11-10: Floor shows ✓ Paid / Part paid; Close table in the bottom bar when paid; close prompt after the final payment; smaller reprint icon (Teran).
- 2026-11-10: Receipt prints automatically when the payment settles the bill (Teran).
- 2026-11-10: Implemented: bill and receipt printing through the print queue, cash received recorded for the
  change, Print buttons on the bill screen. Status → review.
