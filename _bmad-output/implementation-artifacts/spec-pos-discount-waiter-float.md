---
title: 'Discount, service waiver, waiter on the order, ticket copies, cash in/out'
type: 'feature'
created: '2026-11-16'
status: 'in-review'
baseline_commit: 'cdb34e8'
context: []
---

## Intent

**Problem:** The owner needs five things before go-live:
1. A discount for customers, set by default in Settings and changed per order for special customers.
2. Turning off the service charge for special customers.
3. Two copies of each KOT/BOT, for managing the pass.
4. Recording which waiter looks after each table.
5. Recording the morning float, and cash put in or taken out, so the end-of-day count can be compared.

**Approach (Teran, 2026-11-16):**
- **Discount:** `tenant_config.default_discount_bp` is set in Settings → Money. Each order has its own `order_sessions.discount_bp`, where null means "use the default". It is changed from the bill screen's header chip ("10% off · No service").
- **Service waiver:** `order_sessions.service_charge_waived` is set in the same dialog as the discount.
- **Ticket copies:** `kitchen_ticket_copies` and `bar_ticket_copies` (1–3) in Settings → Kitchen & bar tickets. Each extra copy is its own print job and prints "COPY 2/2" under the header.
- **Waiter:** `order_sessions.served_by_staff_id`, where null means whoever opened the order. A searchable dropdown in the order screen HEADER (Teran: keep the order column free) lists active owners and waiters. The waiter is printed as "Waiter: …" on the KOT/BOT and as "Served by: …" on the bill.
- **Cash in/out — FINAL (Teran, 2026-11-16): the dialog offers only + Float (any cash in), − Cash drop (any cash out, expense named in the note, owner only) and Change. Pay in, Paid out and Other are no longer offered; the server and reports still read them. History of the design:**
  (Teran's design; Pay in and Paid out dropped from the dialog 2026-11-16 — recorded as Other, which now takes an optional amount with Into / Out of drawer; Out is owner-only; migration 0047):** the drawer dialog gets amounts. **+ Float**, **+ Pay in**, **− Paid out**, **− Cash drop** (both outs need a note), plus Change and Other, which move no money. The amount is stored signed in `cash_drawer_openings.amount_paisa`. The floor asks for the opening float until one is recorded for the business day. "Not now" hides the prompt for the rest of the day in that tab.

## Moved to the order screen (Teran, 2026-11-16)

Discount and service charge are SEPARATE controls in the order column's totals: a Discount row with a pencil icon (opens `DiscountDialog`) and an on/off switch on the Service row. `PATCH /pricing` takes either field alone. The bill screen only shows a "10% off · No service" chip when one applies; it has no editor.

## Rules

- **Bill maths:** discount = subtotal × discount%. Service is charged on (subtotal − discount), and tax on (subtotal − discount + service). Each is rounded once.
  total = subtotal − discount + service + tax.
- A waived bill stores the service rate it *would* have used, with `service_charge_paisa = 0`. `service_waived_paisa` records what was given up. The bill prints "Service charge: waived".
- The discount and waiver apply to bills written after they are set. Recorded bills keep their prices.
- **Who may do what:**
  - Discount and waiver: owner, or the new `give_discount` permission (Manage → Staff).
  - The waiter on an order can be changed by any owner or waiter.
  - Float and pay-in: any owner or waiter.
  - Change and Other: the existing `open_cash_drawer` permission.
  - Paid out and cash drop: owner only.
- **End of day:** should be in drawer = cash taken + float + pay in − paid out − cash drop. The cash count is now the **whole drawer, float included**, and gap = counted − should be. Days with no float recorded behave exactly as before.
- **Sales:** the Sales panel and the printed slip show Discounts and Service charge waived.

## Supersedes

`deferred-work.md` (2026-10-02, Service charge) said "no per-session override; waiving is an audited comp". Teran reversed this on 2026-11-16. The waiver is now a per-order switch. It is gated by permission, and who set it is stored in `order_sessions.pricing_changed_by_staff_id`.

## Owner password change (Teran, 2026-11-16)

Manage → Settings → **Owner password** card (owner only; its own button, not the settings Save). `PUT /api/manage/password` `{ current, next }` checks the current password through the unlock lockout (5 wrong → 5 min), stores the new bcrypt hash, and ends every OTHER device's Manage session. A forgotten password is still cleared on the server with `pnpm manage:reset-password`.

## Cash drawer card on the dashboard (Teran, 2026-11-16)

One card, `cash-drawer-card.tsx`, replaces the Cash gap tile and the no-sale list. A single day reads top to bottom: float (time, who) → cash sales → cash drops (time, who, note) → should be in drawer → counted (time, who) → Balanced / Short / Over, then card & transfer and total revenue apart. Amber "No float recorded" when there is none; Count / Recount on Today. Week and month: a row per day (Float · Cash sales · Cash out · Should be · Counted · Gap). Data: `Insights.cash.byDay` in `insights.service.ts`.

## Code map

- Migration `0046_pos_discount_waiter_float.sql`. The new `cash_drawer_reason` values are checked as text, because a migration cannot use enum values it adds itself.
- Pricing: `computeBillTotals` / `priceBillable` in `src/server/services/bill.service.ts`. The client copy is `priceShare` in `src/components/pos/bill-screen.tsx`, and the order-column preview is `src/components/pos/order-summary.tsx`.
- Routes: `PATCH /api/sessions/:id/pricing`, `PATCH /api/sessions/:id/served-by`, and the extended `POST /api/cash-drawer/open`.
- UI:
  - `src/components/pos/waiter-picker.tsx` (in `order-header.tsx`)
  - `PricingChip` / `PricingDialog` in `bill-screen.tsx`
  - `cash-drawer-button.tsx` (with `OpeningFloatPrompt`)
  - Settings editor
- Printing: `withCopies` in `src/server/print/ticket.ts`; ticket, receipt and takings layouts in `src/server/print/escpos.ts`.
- End of day: `src/server/services/takings.service.ts`, the expected-cash query in `src/server/services/insights.service.ts`, and the dashboard panels.

## Verification

- `tsc` and `eslint` are clean.
- These verify scripts pass: verify-bills (119), verify-settings (28, with new checks), verify-takings (22), verify-permissions (28), verify-staff-admin (39), verify-receipt (81), verify-drawer (39), verify-escpos (58), verify-dashboard (17).
- verify-insights fails 2 of 24 (week view) on the baseline commit too. That failure was not introduced here.
- Still to do: Teran's hands-on test round on the tablet and the printer.
