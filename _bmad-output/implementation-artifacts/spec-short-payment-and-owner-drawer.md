---
title: 'Short payment with a note; drawer icon owner only'
type: 'feature'
created: '2026-11-21'
status: 'done'
baseline_commit: '92fa16ca607c1fca871626e5465b3cc2b0a46938'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** On the Settle dialog, cash below the bill switches the method to Cash + card, and card/transfer always charge the full amount, so a guest who pays less cannot be recorded. Separately, waiters can open the cash drawer from the floor icon (float, change).

**Approach:** Keep the chosen method (cash, card, transfer) and let the cashier record a lesser amount with a mandatory note. The bill closes as settled, the rest is written off as a "short" stored on the bill with the note, who and when, and it shows in red in Orders and Audit. The floor drawer icon and `/api/cash-drawer/open` become owner only; cash payments still kick the drawer by themselves.

## Boundaries & Constraints

**Always:** Anyone who can take payment may record a short — no owner step; the record names who did it. The note is required (trimmed, 1–120 chars), checked on the screen, the route and the database. Takings, drawer and insights keep counting only `payment_records` — a short is never revenue. Integer paisa everywhere. A short closes the bill: `isFullyPaid`, `recordPayments` outstanding, the bill screen and the orders list treat `paid + short` as covering the total.

**Ask First:** Any change to how takings / day close / drawer expected cash are calculated.

**Never:** Short on Pay together (combined bill) — it stays full-payment only and its dialog offers no short. Short on Cash + card. A `payment_records` row or new payment method for the short. Changing the automatic drawer kick on cash payments.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cash short | Due 1,000; Cash; received 800; note "guest had no more" | Payment cash 800 recorded; bill short 200 + note; bill settled; drawer kicks; receipt prints | N/A |
| Cash, no note | Due 1,000; received 800; note empty | Action button disabled, says "Add a note for the 200 short" | Route also refuses: 400 `SHORT_NOTE_REQUIRED` |
| Card short | Due 1,000; Card; "Less than the bill" → 900 + note | Card 900 recorded; short 100; settled | N/A |
| Full or over | Received ≥ due | As today: no note shown, change shown | N/A |
| Partial without note (old clients) | Tenders < outstanding, no `shortNote` | As today: part payment, bill stays owed | N/A |
| Short ≥ due or 0 | Amount entered 0 | Button disabled ("Enter amount") | Zod refuses non-positive |
| Drawer by waiter | Waiter POSTs `/api/cash-drawer/open` any reason | 403 | Icon hidden for waiters |

</frozen-after-approval>

## Code Map

- `src/server/db/schema.ts` -- `bills` table; add short columns + check
- `src/server/services/payment.service.ts` -- `recordPayments`, `isFullyPaid`, `loadSessionPayments`
- `src/app/api/bills/[billId]/payments/route.ts` -- body schema, errors
- `src/app/orders/[sessionId]/bill/page.tsx` -- builds `BillScreenBill` props
- `src/components/pos/bill-screen.tsx` -- `PaymentDialog` (~2457), `outstandingOf`, settled sums (~915-943, 1101, 2370)
- `src/server/services/pay-together.service.ts` -- outstanding SQL (~172) must subtract short
- `src/server/services/receipt.service.ts` -- outstanding check (~464); add "Short" line on receipt if trivial
- `src/server/services/orders-list.service.ts` + `src/components/manage/orders-view.tsx` -- row `shortPaisa`
- `src/server/services/audit.service.ts` -- new money entry for a short
- `src/app/api/cash-drawer/open/route.ts`, `src/server/auth/permissions.ts`, `src/components/pos/table-grid.tsx` -- owner-only drawer

## Tasks & Acceptance

**Execution:**
- [x] `src/server/db/schema.ts` + migration `0052_bill_short_payment.sql` (drizzle-kit generate) -- add `short_paisa int not null default 0`, `short_note text`, `short_by_staff_id uuid → staff`, `short_at timestamptz`; check: `short_paisa >= 0` and (`short_paisa = 0` or note non-empty ≤120) -- the database guards the note too
- [x] `src/server/services/payment.service.ts` -- `recordPayments` takes optional `shortNote`; outstanding = total − paid − short; if tendered < outstanding and `shortNote` given, update the bill's short columns and return `settled: true`; `isFullyPaid` compares `paid + short_paisa >= total`; expose `shortPaisa` per bill for readers
- [x] `src/app/api/bills/[billId]/payments/route.ts` -- accept `shortNote` (trim, max 120); empty string after trim → 400 `SHORT_NOTE_REQUIRED`
- [x] `src/server/services/pay-together.service.ts`, `src/server/services/receipt.service.ts` -- subtract `short_paisa` in outstanding; receipt prints "Short  LKR x" when > 0
- [x] `src/app/orders/[sessionId]/bill/page.tsx` + `bill-screen.tsx` -- `BillScreenBill.shortPaisa`; every "paid vs total" sum uses paid + short; `PaymentDialog` gets `allowShort` (false for Pay together): Cash below due keeps Cash, shows a required note field and action "Record LKR 800 · LKR 200 short"; Card/Transfer get a small "Less than the bill?" link that reveals the pad ("Amount charged") and the note; remove the auto-switch to Cash + card; send `shortNote` in `onPay`
- [x] `src/server/services/orders-list.service.ts` + `orders-view.tsx` -- `shortPaisa` per order (sum over live bills); under the total show "Short LKR 200" in red (`text-red-700 night:text-red-400`), amount only
- [x] `src/server/services/audit.service.ts` -- one `money` entry per shorted bill at `short_at`: text "Short payment LKR 200", detail = the note, `amountPaisa: -short` (renders red)
- [x] Drawer: `route.ts` refuses any non-owner (403); `permissions.ts` `ROUTE_ROLES` `/api/cash-drawer` → `['owner']`; `table-grid.tsx` `canOpenDrawer={role === 'owner'}`; leave the opening-float prompt to owner only as well
- [x] `src/server/services/verify-*.ts` style check script for the matrix (cash short, no-note refusal, `isFullyPaid` after short, takings unchanged)

**Acceptance Criteria:**
- Given a bill shorted LKR 200, when the waiter opens the bill screen, then it shows paid and offers Close table, and closing as `settled` succeeds.
- Given that bill, when the day's takings are read, then only the LKR 800 actually received is counted.
- Given a waiter signed in, when they look at the floor header, then there is no drawer icon; a cash payment still opens the drawer.

## Design Notes

Short lives on `bills`, not `payment_records`, because every revenue reader (takings, drawer, insights, dashboard) sums `payment_records`; a fake payment row would have to be excluded in six places. The cost is that "paid enough?" checks must add `short_paisa` — they are listed in the Code Map.

## Verification

**Commands:**
- `npx tsc --noEmit` -- no errors
- `npm run lint` -- clean
- `npx drizzle-kit generate` -- produces only the 0052 migration

**Manual checks:**
- Settle LKR 1,000 with cash 800 + note → Orders row shows red "Short LKR 200"; Audit shows red −LKR 200 with the note.

## Suggested Review Order

**Recording the short**

- Entry point: tenders below what is owed plus a note write the rest off and settle
  [`payment.service.ts:179`](../../src/server/services/payment.service.ts#L179)

- "Fully paid" now counts the short, so Close table works
  [`payment.service.ts:238`](../../src/server/services/payment.service.ts#L238)

- Route refuses an empty or long note by name
  [`route.ts:109`](../../src/app/api/bills/%5BbillId%5D/payments/route.ts#L109)

**Database**

- Four short columns; all-or-none check with a 1–120 char note
  [`schema.ts:942`](../../src/server/db/schema.ts#L942)

- Immutable-bills trigger now also allows one short update
  [`0052_bill_short_payment.sql:16`](../../src/server/db/migrations/0052_bill_short_payment.sql#L16)

**Settle dialog**

- Short keeps the chosen method; Cash + card offer only on Pay together
  [`bill-screen.tsx:2538`](../../src/components/pos/bill-screen.tsx#L2538)

- Small link for card/transfer less than the bill
  [`bill-screen.tsx:2899`](../../src/components/pos/bill-screen.tsx#L2899)

- Required note field, red
  [`bill-screen.tsx:2909`](../../src/components/pos/bill-screen.tsx#L2909)

- One helper for "still owed" across the screen
  [`bill-screen.tsx:82`](../../src/components/pos/bill-screen.tsx#L82)

**Showing it**

- Orders: red "Short LKR x" under the total
  [`orders-view.tsx:201`](../../src/components/manage/orders-view.tsx#L201)

- Audit: negative money entry with the note as detail
  [`audit.service.ts:275`](../../src/server/services/audit.service.ts#L275)

- Receipt prints RECEIPT with a Short line, not "Still to pay"
  [`receipt.service.ts:252`](../../src/server/services/receipt.service.ts#L252)
  [`escpos.ts:635`](../../src/server/print/escpos.ts#L635)

- Pay together subtracts any short from what is owed
  [`pay-together.service.ts:172`](../../src/server/services/pay-together.service.ts#L172)

**Drawer owner only**

- Route refuses every non-owner
  [`route.ts:85`](../../src/app/api/cash-drawer/open/route.ts#L85)

- Icon only for the owner; cash payments still kick the drawer
  [`table-grid.tsx:1262`](../../src/components/pos/table-grid.tsx#L1262)

**Checks**

- 13 checks: settle, close, takings, orders, audit, card, no-note, DB guards
  [`verify-short-payment.ts:1`](../../src/server/services/verify-short-payment.ts#L1)
