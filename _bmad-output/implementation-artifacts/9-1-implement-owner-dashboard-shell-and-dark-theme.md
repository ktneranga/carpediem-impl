# Story 9.1: Owner dashboard shell (Manage → Dashboard)

Status: review

<!-- Brought forward 2026-11-13 (Teran): 9.1–9.3 now, 9.4+ later. Testing in the final round (launch rush). -->

## Story

As the owner,
I want a Dashboard as the first section of Manage,
so that the day's picture is the first thing I see — at the counter or from home.

## Decisions (Teran, 2026-11-13 — replace the epic's wording)

- **Lives in Manage → Dashboard**, behind both gates (owner + Manage password), not a separate dark `/owner`
  page. Light theme like the rest of Manage; the epic's `data-context="owner"` / neutral-900 dark theme is dropped.
- **Owner only.** There is no manager role (10.0 Trap 1); the `/manage` + `/api/manage` policies already cover it.
- **"Today" = today's business date** (`business_date_at(tenant, now())`), everywhere on the dashboard.

## Acceptance Criteria

1. `MANAGE_SECTIONS` gains **Dashboard** first (`/manage/dashboard`, story 9.1, "Today's takings as they come in,
   the cash check, and what needs attention."). `/manage` now opens on Dashboard for the owner (waiters still go to
   Sold out).
2. `src/app/manage/(area)/dashboard/page.tsx` → `src/components/manage/dashboard.tsx`: a header ("Dashboard",
   today's business date, a live dot "Live" once the socket is connected) and a chart-first layout — the revenue
   panel full width on top (9.2), then a responsive grid of cards: **Cash check**, **Needs attention** (long-open
   tables), **Sold out**, **Comps** (9.3). 1 column on a phone, 2 on a tablet, 3 on a laptop.
3. Each slot renders a skeleton at its final size until its data arrives; no layout shift when data replaces it
   (fixed min-heights per slot).
4. The panels are separate components in `src/components/manage/dashboard/` so 9.2 and 9.3 slot in without
   touching the shell.

## Tasks / Subtasks

- [x] Task 1 — Sections + `/manage` redirect (AC 1).
- [x] Task 2 — Shell, `PanelSkeleton`, `Panel` card frame, grid (AC 2–4).
- [x] Task 3 — `npx tsc --noEmit`, `npm run lint` clean.

## Dev Notes

- Pattern: other Manage screens (`end-of-day.tsx`, `floor-editor.tsx`), tokens only (`rounded-panel`, `bg-white`,
  `p-sp-4`, `text-fs-*`), 44px targets. `useSocketEvent` from `@/hooks/use-socket` (see `sold-out-board.tsx`).
- Files: UPDATE `src/app/manage/(area)/sections.tsx`, `src/app/manage/(area)/page.tsx`; NEW dashboard page,
  `src/components/manage/dashboard.tsx`, `src/components/manage/dashboard/panel.tsx`.
- [Source: epics.md Story 9.1; Story 10.0 Manage area]

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Completion Notes List

- Dashboard is the first Manage section; `/manage` opens on it for the owner (waiters still go to Sold out).
- Shell `dashboard.tsx`: header with a Live / Reconnecting dot (`useSocketStatus`, `open-edge` token), revenue slot
  full width (`min-h-80`), four cards in a 1/2/3-column grid (`min-h-56`), each a `Panel` with `PanelSkeleton`
  until 9.2 / 9.3 replace them. No dark theme (Manage, light — Teran 2026-11-13).
- `tsc` clean, lint clean. Not clicked through — final test round.

### File List

- src/app/manage/(area)/sections.tsx (updated)
- src/app/manage/(area)/page.tsx (updated)
- src/app/manage/(area)/dashboard/page.tsx (new)
- src/components/manage/dashboard.tsx (new)
- src/components/manage/dashboard/panel.tsx (new)
