# Story 9.3: Cash check, comps, sold out and long-open tables

Status: ready-for-dev

<!-- Brought forward 2026-11-13 (Teran). Testing in the final round (launch rush). -->

## Story

As the owner,
I want the cash check, comps, sold-out items and tables open too long on the dashboard,
so that I see what needs my attention without opening other screens.

## Decisions (Teran, 2026-11-13)

- **Cash check = Expected vs Counted.** Expected = cash payments of today's business date. The owner types the
  cash counted in the drawer, without the float. Gap = counted − expected: red with the amount when non-zero,
  green "Balanced" when zero, "Not counted yet" before a count. Counts are stored per business date in a new
  append-only `cash_counts` table (a recount adds a row; the latest counts), so past gaps stay on record. The
  End of day screen and slip show Counted and Gap for the date when a count exists.
- **"Shift" = today's business date** (no shifts exist yet; 9.4 later).
- **Comps:** `comp_records` of today's orders. Nothing writes comps until Story 7.3 (after launch), so the card
  shows "No comps today" for now — built so it fills in once 7.3 lands.
- **Sold out** ("inventory alerts"): active menu items with `is_available = false` — "Out of stock" when
  `portion_count = 0`, otherwise "Marked sold out". Live on `menu:item_updated` / `menu:changed`.
- **Long-open tables:** open orders older than `tenant_config.long_open_minutes` (new column, default 120;
  no UI yet — set in the database, a Manage setting later). Shows `#042`, table(s) or bar tab, zone, "2 h 15 min",
  who opened it. Refreshes every minute and on `table:status_changed`.

## Acceptance Criteria

1. Migration: `cash_counts` (id, tenant_id, business_date date, counted_paisa int ≥ 0, staff_id, created_at
   clock_timestamp; index tenant+date; `immutable_cash_counts` trigger refusing UPDATE/DELETE like the others) and
   `tenant_config.long_open_minutes integer not null default 120`.
2. `GET /api/manage/dashboard/summary` → `{ cash: { expectedPaisa, countedPaisa | null, gapPaisa | null,
   countedAt, countedBy }, comps: { totalPaisa, entries: [{ itemName, amountPaisa, reason, staffName, at }] },
   soldOut: [{ id, name, kind: 'depleted' | 'manual' }], longOpen: [{ dailyNumber, tables, zone, openedAt,
   minutesOpen, openedBy }] }`. All money integer paisa. Under 500 ms.
3. `POST /api/manage/dashboard/cash-count` `{ countedPaisa }` (whole rupees from the screen, ≥ 0, ≤ 10,000,000
   rupees) → appends a row for today's business date; 201.
4. Cards: **Cash check** (expected, counted entry with a numeric field + Save, gap/Balanced, "Counted 11:42 PM by
   Teran"; Recount), **Needs attention** (long-open list, empty: "No table open longer than 2 h"),
   **Sold out** (list, empty: "Everything is available"), **Comps** (list scrolls past 5, total row; empty "No comps
   today").
5. Live: cash expected and comps refetch on `session:payment_changed`; sold out on `menu:item_updated` /
   `menu:changed`; long-open on `table:status_changed` and every 60 s.
6. End of day (9.5): Takings gains `cashCount: { countedPaisa, gapPaisa } | null`; screen and slip show
   "Counted" and "Gap" (or "Balanced") under Cash.
7. Verify (`verify-dashboard.ts`, own tenant): expected cash, latest count wins, gap sign, recount history kept,
   UPDATE refused by the trigger, sold-out kinds, long-open threshold boundary, other tenant excluded.

## Tasks / Subtasks

- [ ] Task 1 — Schema + migration (+ trigger SQL appended by hand, like 0001).
- [ ] Task 2 — `dashboard.service.ts`: `loadSummary`, `recordCashCount`; `takings.service.ts` gets `cashCount`.
- [ ] Task 3 — Routes `summary` (GET), `cash-count` (POST).
- [ ] Task 4 — Panels in `src/components/manage/dashboard/`; End of day screen + slip lines.
- [ ] Task 5 — Verify script; `tsc`, `lint`; existing `verify-takings.ts` still passes.

## Dev Notes

- `cash_drawer_openings` / migration 0001 show the append-only trigger shape (`prevent_immutable_table_mutation`).
- Open-order place naming: `openOrderPlace` in `takings.service.ts` — reuse (export it).
- `comp_records.amount_paisa` (column named `amountPaysa` in Drizzle); item name from the event's
  `custom_name` or `menu_items.name`.
- [Source: epics.md Story 9.3 (FR50, FR51, FR52, FR60)]

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List
