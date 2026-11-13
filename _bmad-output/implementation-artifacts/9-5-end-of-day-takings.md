# Story 9.5: End-of-day takings

Status: review

<!-- Go-live. Next after 10.2 in the launch order. Testing deferred to the final round (launch rush). -->

## Story

As the owner,
I want the day's takings at close — in Manage → End of day, and on paper,
so that I can count the drawer against them and see what is still open before I go home.

## Decisions (made while writing the story, 2026-11-13; change any before dev)

- **Which day an order belongs to = `order_sessions.business_date`** (set by the `assign_order_number` trigger
  from `opened_at` and `business_day_start_hour`). Its bills and payments count on that day even if paid after
  the turnover. No-sale openings use `business_date_at(tenant, created_at)` — already done in
  `listNoSaleOpenings` (Story 6.7). Today = `business_date_at(tenant, now())`.
- **"Orders" counts sessions of the day with at least one item ordered** (an `ITEM_ADDED` event). A table opened
  by mistake and closed empty is not an order.
- **Money comes from what was recorded, never re-priced:** `bills` (subtotal, service, tax, total), `bill_lines`,
  `bill_comps`, `payment_records`. Nothing is computed from menu prices.
- **Payments by method: cash, card, transfer** (the enum has all three; show transfer only when non-zero).
- **Extra line not in the epic: "Closed unpaid"** — count and billed-but-unpaid amount of orders closed as
  `walkout` or `abandoned` (`SESSION_CLOSED.notes`). Without it, billed total minus paid has no explanation.
- **Behind both Manage gates** (owner + password), under `/api/manage/end-of-day`. Waiters don't see it.
- **Read-only.** Nothing is "closed" or locked; Print can be pressed any number of times.

## Acceptance Criteria

1. **Screen.** Manage → End of day (replacing `ComingSoon`) shows, for one business date:
   - **Orders** (count, AC rules above), **Items** (sum of `bill_lines.amount_paisa`), **Comps** (sum of
     `bill_comps.amount_paisa`, negative; 0 until Story 7.3), **Subtotal** (sum `bills.subtotal_paisa`),
     **Service charge**, **Tax**, **Total billed** (sum `bills.total_paisa`);
   - **Paid**: Cash, Card, Transfer (if any), and **Total paid**;
   - **Closed unpaid**: count and amount (decision above), only when non-zero;
   - **Still open**: count, then the list (AC 2);
   - **No-sale drawer openings**: count, then each with time, staff name, reason (`Change` / `Float` /
     the note for `other`) — from `listNoSaleOpenings`.
   All money as LKR with the existing money formatter; integers (paisa) end to end.
2. **Open orders listed** by order number `#042` (`src/lib/order-number.ts`), table labels (or "Bar tab" /
   "Counter" as the floor names them), opened time, and who opened it. Sorted by number. A note above the list:
   "These orders are not in the totals until they are paid." (Their bills, if any, ARE in Total billed — the
   unpaid part shows as the gap between billed and paid.)
3. **Date.** Default is today's business date. A date field (native `<input type="date">`) and ‹ / › day
   buttons choose another; `›` is disabled on today. The URL carries `?date=YYYY-MM-DD` so a reload keeps it.
   A future date or a malformed one → 422 `INVALID` "Choose a date up to today".
   A day with no orders shows zeros and "No orders on this day", not an error.
4. **Print.** A Print button queues one job to the receipt printer (`destination: 'cashier'`) with a new payload
   `kind: 'takings'` (self-contained, like `ReceiptPayload`): restaurant name, business date, printed-at time,
   who printed it, every figure of AC 1, the open orders (number + table), and the no-sale openings. Then
   `wakePrintQueue()`. The screen shows "Sent to the printer". Printer down → the job waits and retries like any
   other; the existing `printer:alert` names it "End of day" (via `tableLabels: ['End of day']`).
5. **API.** `GET /api/manage/end-of-day?date=` → `{ success, data: Takings }`;
   `POST /api/manage/end-of-day/print` `{ date }` → 202 `{ jobId }`. Tenant from the actor's staff row
   (`actorOf`). Under 1 s for a normal day (one query per figure group, no per-order loops).
6. **Correct on the hard cases** (verify script): a split bill (cash + card on one bill), a per-seat bill, two
   bills on one order, a partly paid open order, a walkout with a bill, an order opened before the turnover hour
   and paid after it (counts on the earlier day), a custom charge (Story 4.9, it is a bill line), another
   tenant's orders (never counted), and a day with nothing.

Out of scope: closing/locking a day, a counted-cash entry and over/short, charts (9.1–9.3), shift summary (9.4),
per-waiter takings, exporting.

## Tasks / Subtasks

- [x] **Task 1 — Service** `src/server/services/takings.service.ts`:
  - [x] `todayBusinessDate(executor, tenantId)` → `select business_date_at(tenant, now())::text`.
  - [x] `checkTakingsDate(executor, tenantId, date)` → `MenuRuleError` unless `/^\d{4}-\d{2}-\d{2}$/`, a real date,
        and `<=` today.
  - [x] `loadTakings(executor, { tenantId, businessDate })` → `Takings` (type exported for the screen). Grouped
        queries over `order_sessions` (filtered `tenant_id` + `business_date`) joined to `bills`,
        `bill_lines`, `bill_comps`, `payment_records`, `order_events`. Use `coalesce(sum(…),0)::int`.
        Careful: join bills→lines and bills→payments in SEPARATE queries (or subqueries) — one join of both
        multiplies rows and double-counts.
  - [x] Open orders: sessions with `closed_at is null`, with table labels from `order_session_tables` (not
        released) → `tables.label`, `kind`, `tab_label` is staff-only but this is an owner screen: show
        "Tab · white shirt" style as the floor does; check how the floor/receipt names counter and tab orders and
        reuse that helper rather than re-inventing.
  - [x] Closed unpaid: sessions closed with a `SESSION_CLOSED` event whose `notes in ('walkout','abandoned')`,
        billed total minus paid for them.
  - [x] No-sale: `listNoSaleOpenings` (reuse, don't copy).
- [x] **Task 2 — Print payload**:
  - [x] `src/types/tickets.ts`: `TakingsPayload` (`kind: 'takings'`, `destination: 'cashier'`, `tableLabels`,
        `timeZone?`, every figure, `openOrders`, `noSales`), add to `PrintPayload`, `isTakingsPayload`.
        Neutral types only (the worker imports this file).
  - [x] `src/server/print/escpos.ts`: `buildTakings(payload)` using the receipt helpers (`emit`, `amountLines`,
        `receiptMoney`, `calendarDate`, `clockTime`, `foldToAscii`, divider); `buildPrintBytes` dispatches it.
        Defensive like `buildReceipt` (a field missing from an old job never throws).
  - [x] `printTakings(tx, { tenantId, staffId, businessDate })` in the service: builds the payload from
        `loadTakings` + tenant name/timezone + staff name, inserts `print_jobs` (`session_id` null, `bill_id` null,
        `round_id` null). Check `print_jobs` columns allow null session (the no-sale kick already does).
- [x] **Task 3 — Routes**: `src/app/api/manage/end-of-day/route.ts` (GET) and
      `src/app/api/manage/end-of-day/print/route.ts` (POST, `wakePrintQueue()` after commit). Pattern:
      `src/app/api/manage/floor/route.ts` (GET) and `menu-admin/route.ts` helpers (`actorOf`, `menuFail`,
      `readBody`). `MenuRuleError` → 422 `INVALID`.
- [x] **Task 4 — Screen** `src/app/manage/(area)/end-of-day/page.tsx` → `src/components/manage/end-of-day.tsx`
      (client, React Query key `['manage-takings', date]`). Laptop-first, usable on a tablet: figures in a
      two-column card (label left, amount right, tabular numbers), Paid in its own card, open orders and no-sales
      as lists below. Print = `primary` button top right; date controls beside the title. Reuse `call`, `primary`,
      `secondary`, `icon`, `input` from `manage-ui.tsx`. Existing tokens only. 44px targets.
- [x] **Task 5 — Sections text**: `MANAGE_SECTIONS` End of day: "The day's takings by payment method, what is
      still open, and drawer openings." Also Staff (10.2 follow-up): "Add staff, set their jobs and PINs, and
      deactivate someone who has left."
- [x] **Task 6 — Verify** `src/server/services/verify-takings.ts`
      (`npx tsx --conditions=react-server --env-file=.env …`), on its own `ZZ Takings verify` tenant (pattern:
      `verify-staff-admin.ts`), inserting sessions / events / bills / lines / payments directly with known
      amounts, then asserting every figure of AC 1 for each case of AC 6, plus: the payload builds and
      `buildTakings` returns bytes containing the totals; future date → `MenuRuleError`.
      Cleanup on a local database only, guards (append-only triggers on `order_events`, `payment_records`, …)
      disabled only around the delete — copy the list from `verify-floor-admin.ts` / check migration 0001 for the
      trigger names. Never touches real tenants.
  - [x] `npx tsc --noEmit`, `npm run lint` clean.

## Dev Notes

### Current state (read before changing)

- `order_sessions`: `business_date` + `daily_number` assigned by trigger (migration 0032/0036); `closed_at` null =
  open; `kind` table/counter; `tab_label` for bar tabs (4.6). Close reason lives in the `SESSION_CLOSED`
  order event's `notes` (`abandoned` | `walkout` | `settled`, `table-session.service.ts`).
- `bills` (6.2–6.4): `subtotal_paisa`, `service_charge_paisa`, `tax_paisa`, `total_paisa`; one order can have
  several bills (seat, split, consolidated). `bill_comps.amount_paisa` is negative; nothing writes it before 7.3
  (stashed). `payment_records.amount_paisa` is the amount APPLIED (change excluded); a split tender is two rows.
  `payment_records` and `order_events` are append-only (no UPDATE, triggers refuse DELETE).
- `listNoSaleOpenings(executor, { tenantId, businessDate })` in `cash-drawer.service.ts` was written for this
  story — use it.
- Receipt printing: `receipt.service.ts` `enqueue` → `print_jobs` (`destination 'cashier'`); worker renders by
  `buildPrintBytes` in `escpos.ts` (ticket / receipt / drawer kick). `wakePrintQueue` from
  `src/server/print/wake.ts` after commit (see `src/app/api/cash-drawer/open/route.ts`).
- Order number display: `src/lib/order-number.ts` (`#042`, and `20261102-042` for cross-day).
- Manage gate: `/api/manage` prefix is owner-only + Manage password (proxy, `manage-gate.ts`). Nothing to add to
  `permissions.ts`.

### Guardrails

- Integer paisa only; no floats, no client-side arithmetic beyond formatting.
- Never trust a tenant or a date from the client without checking (`actorOf`, `checkTakingsDate`).
- Old print jobs keep printing: adding `kind: 'takings'` must not change how a job with no `kind` (ticket),
  `receipt` or `drawer` renders.
- No semicolons; don't run prettier. No ref reads during render (React Compiler lint).
- Owner-facing, so the tab nickname may show on screen — but it is never printed on a GUEST's paper; the takings
  slip is the owner's, so it may print it. Keep it out if unsure.

### Files

- NEW: `src/server/services/takings.service.ts`, `src/server/services/verify-takings.ts`,
  `src/app/api/manage/end-of-day/route.ts`, `src/app/api/manage/end-of-day/print/route.ts`,
  `src/components/manage/end-of-day.tsx`.
- UPDATE: `src/types/tickets.ts`, `src/server/print/escpos.ts`, `src/app/manage/(area)/end-of-day/page.tsx`,
  `src/app/manage/(area)/sections.tsx`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Story 9.5 (added 2026-11-04), Story 6.7 no-sale note, Epic 9 FR68 amendment]
- [Source: src/server/db/schema.ts — order_sessions, bills, bill_lines, bill_comps, payment_records, cash_drawer_openings, print_jobs]
- [Source: src/server/services/cash-drawer.service.ts — listNoSaleOpenings]
- [Source: src/server/services/receipt.service.ts, src/server/print/escpos.ts — receipt queueing and rendering]
- [Source: src/server/services/payment.service.ts — isFullyPaid, close reasons]

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Debug Log References

### Completion Notes List

- Story created 2026-11-13: context analysis complete — developer guide written.
- Service `takings.service.ts`: `todayBusinessDate`, `checkTakingsDate`, `loadTakings` (one grouped query per
  figure group, bills→lines and bills→payments never joined together), `printTakings`. `loadTakings` takes the
  pool, not a transaction — its reads run in parallel and a transaction's single connection can't (pg warned);
  printing reads through the pool, only the job insert is in the transaction.
- "Closed unpaid" also requires at least one item, so a table opened by mistake and closed empty is not counted.
- Open bar tabs show as "Bar tab (white shirt)" — owner's screen and slip only, never a guest's paper.
- Print: `TakingsPayload` (`kind: 'takings'`, `tableLabels: ['End of day']`) in `src/types/tickets.ts`,
  `buildTakings` in `escpos.ts` (defensive, an empty payload still prints), dispatched by `buildPrintBytes`;
  text form added to the fake transport's `renderTicketText`. Existing `verify-escpos.ts` 54/54.
- Routes `GET /api/manage/end-of-day?date=` (returns `{ today, takings }`) and `POST …/print` (202, wakes the queue).
- Screen `end-of-day.tsx`: ‹ date › controls (› stops at today), `?date=` kept in the URL, Sales / Paid cards,
  Still open and No-sale lists, Print with "Sent to the printer".
- Sections text updated for End of day and Staff ("jobs and PINs").
- Verify `verify-takings.ts` 22/22: split tender, two bills on one order, partly paid open order, walkout,
  after-midnight order (counts on the earlier day), custom charge, comp, bar tab, empty abandoned table, no-sale,
  other tenant never counted, empty day, bad dates refused, print job + slip bytes. Cleans up (incl. strays).
- `npx tsc --noEmit` clean; `npm run lint` 0 errors (1 pre-existing warning).
- UI not clicked through in a browser; the slip not printed on the real printer — final test round.

### File List

- src/server/services/takings.service.ts (new)
- src/server/services/verify-takings.ts (new)
- src/app/api/manage/end-of-day/route.ts (new)
- src/app/api/manage/end-of-day/print/route.ts (new)
- src/components/manage/end-of-day.tsx (new)
- src/app/manage/(area)/end-of-day/page.tsx (updated)
- src/app/manage/(area)/sections.tsx (updated)
- src/types/tickets.ts (updated)
- src/server/print/escpos.ts (updated)
- src/server/print/transport.ts (updated)

### Change Log

- 2026-11-13: Story 9.5 implemented — End of day screen, API and printed slip. Status → review.
