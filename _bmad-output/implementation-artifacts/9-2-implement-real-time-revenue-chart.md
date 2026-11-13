# Story 9.2: Live revenue chart

Status: ready-for-dev

<!-- Brought forward 2026-11-13 (Teran). Testing in the final round (launch rush). -->

## Story

As the owner,
I want today's takings by hour beside yesterday's, updating as payments come in,
so that I can see how tonight is going against last night without running a report.

## Decisions (2026-11-13)

- **Revenue = money received** (`payment_records.amount_paisa`), bucketed by the HOUR of the payment in the
  tenant's time zone, for orders of the business date (`order_sessions.business_date`). Today = business date
  `business_date_at(tenant, now())`, yesterday = the one before.
- **Hours run from the turnover hour** (`tenants.business_day_start_hour`, default 4) for 24 hours, so a night's
  1 AM sits after 11 PM, not before 5 AM. The axis shows only the span that has data on either day (± one hour),
  at least the 6 hours around now.
- **Cumulative line chart** (running total through the day), Today vs Yesterday; bars per hour would be noisy at
  this size. Plus the headline: today's total so far, and vs yesterday at the same hour (+/- %).
- **Live:** refetch on the existing `session:payment_changed` broadcast (fires after every payment) — no new
  socket event.

## Acceptance Criteria

1. `GET /api/manage/dashboard/revenue` → `{ startHour, today: { businessDate, hours: number[24], totalPaisa },
   yesterday: { … } }` — `hours[i]` = paisa received in hour `(startHour + i) % 24`. Integers only. One grouped
   query. Under 300 ms.
2. Revenue panel (top, full width): headline "LKR 12,450" today so far, "vs LKR 10,200 by this time yesterday
   (+22%)" (hidden when yesterday had nothing by now); Recharts cumulative line chart, Today solid brand colour,
   Yesterday muted dashed, x-axis hour labels ("8 PM"), y-axis LKR compact, tooltip with both values.
3. A payment on any tablet updates the panel within 5 s (query invalidation on `session:payment_changed`, plus a
   60 s refetch as a fallback).
4. No payment yet today: Today is a flat zero line and the headline says "No payments yet today"; yesterday still
   draws.
5. Verify (`verify-revenue.ts`, own tenant): hours bucket correctly in the tenant zone, a 1 AM payment lands after
   11 PM, orders of other days/tenants excluded.

## Tasks / Subtasks

- [ ] Task 1 — `revenueByHour(db, tenantId)` in `src/server/services/dashboard.service.ts` + route.
- [ ] Task 2 — `src/components/manage/dashboard/revenue-panel.tsx` (load the `dataviz` skill first).
- [ ] Task 3 — Verify script; `tsc`, `lint`.

## Dev Notes

- Recharts 3 is a dependency already. Money: `lkrFromPaisa`, `lkrCompact` in `src/lib/format.ts`.
- `session:payment_changed`: `emitSessionPaymentChanged` (`payment-announce.ts`), broadcast to every socket.
- Day rule as Story 9.5 (`takings.service.ts`).
- [Source: epics.md Story 9.2, Epic 9 FR68 amendment]

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List
