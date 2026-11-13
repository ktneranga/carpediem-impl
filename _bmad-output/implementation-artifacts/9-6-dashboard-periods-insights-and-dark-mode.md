# Story 9.6: Dashboard periods, insights and dark mode

Status: review

<!-- Added 2026-11-13 (Teran): rework of 9.1–9.3 from the Carpe Diem dashboard mock-up. Testing in the final round. -->

## Story

As the owner,
I want the dashboard to show today, yesterday, this week or this month — revenue by hour or day with its peak,
recorded revenue against the same span before, cash gap, covers, comps, payment split, top items, comps by reason,
and unclosed orders and corrections — in light or dark,
so that I can read the business at a glance on the laptop or my phone after service.

## Decisions (2026-11-13)

- **Periods:** Today, Yesterday, Week (Monday → today), Month (1st → today), by business date. Compared with the
  same span before (same weekday last week for a day; last week; last month); a span still running is cut at the
  same moment (`created_at < now() − shift`).
- **Recorded revenue** = billed (`bills.total_paisa`); **settled** = paid (payment split). Hourly buckets by bill
  time in the tenant's zone; at least 12 hours shown.
- **Cash gap** = Σ (latest count − cash taken) over counted days; Today keeps Count / Recount (sheet).
- **Covers** = `cover_count` of orders with items; average in whole rupees.
- **Comps by reason** with the approver; **corrections** = removed / voided / comped lines. Both fill once Story
  7.3 writes them. **Unclosed** = open orders (bill printed and not settled, or still open); walkouts and closed
  unpaid listed too.
- **Today only:** Needs attention and Not available cards stay.
- **Light / dark:** follows the device; a small toggle pins Light or Dark (per browser, localStorage). Dark uses the
  design system's night tokens; the whole Manage area (nav included) follows while the dashboard is open.
- The 9.2 cumulative line chart (`revenue-panel.tsx`, `/api/manage/dashboard/revenue`, `revenueByHour`,
  `verify-revenue.ts`) is replaced and removed.

## Tasks / Subtasks

- [x] `insights.service.ts` (`loadInsights`, `checkPeriod`), `GET /api/manage/dashboard/insights?period=`.
- [x] Panels: revenue bars with peak (emphasis form), stat tiles, payment split donut (validated categorical
      palette, light and dark), top items, comps by reason, unclosed & corrections; theme hook and toggle.
- [x] Manage layout and nav dark styles; phone order chart → tiles → split.
- [x] `verify-insights.ts` 18/18; regression dashboard 17/17, takings 22/22, staff 39/39; tsc, lint clean.
- [x] Rendered in headless Chrome, light and dark, phone and laptop; fixed peak label, bar width, legend wrap,
      dark nav from the screenshots.

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Completion Notes List

- Dataviz: hourly bars = emphasis (base blue, peak orange, only the peak labelled); payment split = categorical
  blue / aqua / orange, `validate_palette.js` PASS light (#fff) and dark (#1E293B), all pairs; legend carries name,
  amount and share; 2px surface gaps. sr-only tables for the charts.
- Known: comps and corrections stay empty until Story 7.3 (after launch).

### File List

- src/server/services/insights.service.ts (new)
- src/server/services/verify-insights.ts (new)
- src/app/api/manage/dashboard/insights/route.ts (new)
- src/components/manage/dashboard/insight-panels.tsx (new)
- src/components/manage/dashboard/theme.ts (new)
- src/components/manage/dashboard.tsx (updated)
- src/components/manage/dashboard/panel.tsx (updated)
- src/components/manage/dashboard/summary-cards.tsx (updated)
- src/server/services/dashboard.service.ts (updated)
- src/app/manage/(area)/layout.tsx (updated)
- src/app/manage/(area)/manage-nav.tsx (updated)
- src/components/manage/dashboard/revenue-panel.tsx (deleted)
- src/app/api/manage/dashboard/revenue/route.ts (deleted)
- src/server/services/verify-revenue.ts (deleted)
