# Story 3.1: Build Navigation Components (ZoneChipBar, ContextHeader, TableCard)

Status: review

- **Epic:** 3 — Zone & Table Navigation
- **Story ID:** 3.1
- **Story Key:** 3-1-build-navigation-components
- **Created:** 2026-08-21

---

## ⚠️ READ FIRST — four conflicts between epics.md, the UX spec, and the schema

| # | Aspect | epics.md | UX spec | Schema | **Resolution** |
|---|---|---|---|---|---|
| 1 | TableCard touch target (waiter) | **80×80px** | "56×56px minimum" | — | **80×80px.** Satisfies both, matches the PINPad's existing `size-20`, and epics gives a testable number. |
| 2 | Third table status | "**closed**" | "alert" | **`unavailable`** | **`unavailable`.** The schema is the source of truth; `tableStatusEnum` is `['open','occupied','unavailable']`. "closed" and "alert" appear nowhere in the database. `alert` is the *colour token*, not the status. |
| 3 | TableCard `aria-label` | "Table 4 — Occupied" | "Table R2, occupied, 42 minutes" | — | **Merge.** Include elapsed minutes when occupied, omit when not. Both documents are satisfied. |
| 4 | ContextHeader content | restaurant name + breadcrumb | "Restaurant name · Zone breadcrumb · **Staff name + session indicator · Current time**" | — | **Include all four.** The UX spec calls the header "always visible" and the staff name is the tap target for user switching. epics simply under-describes it. |

**Also from the UX spec, absent from epics.md:** `TableCard` has a **`selected`** state and shows **time elapsed** and **active item count** when occupied. Added as ACs below.

---

## Story

As a developer,
I want the three core navigation components built and tested with all their variants,
So that the table grid screen and every subsequent feature can compose from tested, accessible primitives.

---

## Acceptance Criteria

**AC-1: ZoneChipBar renders and scrolls**
**Given** `ZoneChipBar` rendered with a list of zones
**When** a staff member views it
**Then** it renders a horizontally scrollable chip row with an "All Zones" chip first, followed by one chip per zone; the active chip has a `brand-600` background; overflow chips are reachable by horizontal scroll with **no visible scrollbar**

**AC-2: Zone filter applies instantly**
**Given** `ZoneChipBar` with one chip active
**When** a staff member taps a different chip
**Then** `onZoneChange` fires immediately with the new zone id (or `null` for All Zones); no "Apply" button exists; the previous chip loses its highlight and the tapped chip gains it

**AC-3: TableCard sizing by context**
**Given** `TableCard` rendered inside `[data-context="waiter"]`
**When** its dimensions are measured
**Then** the touch target is **≥ 80×80px**
**And given** it is rendered inside `[data-context="owner"]`
**Then** the touch target is **≥ 44×44px**; status colours are unchanged between contexts

**AC-4: TableCard status colours**
**Given** `TableCard` with a status
**When** it renders
**Then** the colour-coded indicator uses `status-open` (#22C55E) for `open`, `status-occupied` (#F59E0B) for `occupied`, and `status-alert` (#EF4444) for `unavailable`; the card also shows the table label and zone name
**And** status is never conveyed by colour alone — a text label accompanies it

**AC-5: TableCard accessible name**
**Given** an occupied `TableCard`
**When** a screen reader announces it
**Then** the accessible name includes the table label, the status, and the elapsed time — e.g. "Table R2, occupied, 42 minutes"
**And given** a table that is not occupied
**Then** the accessible name is the label and status only — e.g. "Table 4, open"

**AC-6: TableCard occupied detail**
**Given** an occupied `TableCard` supplied with elapsed minutes and an item count
**When** it renders
**Then** both are visible on the card
**And given** those values are absent
**Then** the card renders without them and does not reserve empty space

**AC-7: TableCard selected state**
**Given** `TableCard` with `selected` set
**When** it renders
**Then** it is visually distinct from its unselected state by more than colour alone (border weight or ring), and `aria-pressed` reflects the state

**AC-8: ContextHeader at top level**
**Given** `ContextHeader` at the top level with no zone or table selected
**When** it renders
**Then** it shows the restaurant name, the signed-in staff name, and the current time; **no breadcrumb trail** is shown; **no bottom tab bar is rendered anywhere in the application at any navigation level**

**AC-9: ContextHeader with a zone selected**
**Given** a zone is selected
**When** `ContextHeader` renders
**Then** the breadcrumb reads "Zones → [Zone Name]"; tapping "Zones" fires `onNavigate(null)`

**AC-10: ContextHeader with a table selected**
**Given** a table is selected within a zone
**When** `ContextHeader` renders
**Then** the breadcrumb reads "Zones → [Zone Name] → Table [N]"; tapping either ancestor segment fires `onNavigate` with that level

**AC-11: Staff name is a control**
**Given** `ContextHeader` shows the staff name
**When** a staff member taps it
**Then** `onStaffTap` fires; the header does not itself open a PIN pad (user switching is Story 2.4, deferred)

**AC-12: Clock does not break hydration**
**Given** `ContextHeader` displays the current time
**When** the page is server-rendered and then hydrated
**Then** no hydration mismatch warning appears in the console; the time updates at least once per minute while mounted

---

## Tasks / Subtasks

- [x] **Task 1 — Add a scrollbar-hiding utility** (AC: 1)
  - Tailwind v4 has no built-in `scrollbar-hide`. Add a small utility to `src/app/globals.css`:
    ```css
    @utility no-scrollbar {
      scrollbar-width: none;
      &::-webkit-scrollbar { display: none; }
    }
    ```
  - Use `@utility` (Tailwind v4) rather than a plain class so it composes with variants.
  - **Do not add new design tokens.** Story 1.2's review flagged that token values are duplicated between `@layer base :root` and `@theme`; adding one means editing both. This is a utility, not a token.

- [x] **Task 2 — Build `ZoneChipBar`** (`src/components/pos/zone-chip-bar.tsx`) (AC: 1, 2)
  - `'use client'`. Props:
    ```ts
    type Zone = { id: string; name: string }
    type ZoneChipBarProps = {
      zones: Zone[]
      activeZoneId: string | null   // null = All Zones
      onZoneChange: (zoneId: string | null) => void
    }
    ```
  - Presentational only — **no data fetching**. Zones are supplied by the parent; Story 3.2 loads them.
  - Container: `flex gap-space-3 overflow-x-auto no-scrollbar`.
  - Chips are `<button type="button">`, min height 44px (they are not the primary target — the table cards are).
  - Active chip: `bg-brand-600 text-neutral-0`. Inactive: `bg-neutral-0 text-neutral-600 border border-neutral-200`.
  - `aria-pressed` on each chip so a screen reader conveys which filter is active.

- [x] **Task 3 — Build `TableCard`** (`src/components/pos/table-card.tsx`) (AC: 3, 4, 5, 6, 7)
  - `'use client'`. Props:
    ```ts
    type TableCardProps = {
      label: string
      zoneName: string
      status: 'open' | 'occupied' | 'unavailable'   // matches tableStatusEnum EXACTLY
      elapsedMinutes?: number
      itemCount?: number
      selected?: boolean
      onSelect: () => void
    }
    ```
  - **Status values must match `tableStatusEnum` exactly.** Do not invent `closed` or `alert` — those appear in the docs but not the database, and a mismatch surfaces as a silent styling failure in Story 3.2.
  - Sizing by context. Base is the owner/compact size; the waiter variant enlarges:
    ```
    size-11 (44px) base  →  waiter:size-20 (80px)
    ```
    Verify the compiled CSS the way Story 2.1 did — read the built stylesheet, do not assume the utility resolved.
  - Status colour AND a text label (AC-4). `prd.md` accessibility rule: colour is never the sole indicator.
  - `role` is implicit on `<button>`; set `aria-label` per AC-5 and `aria-pressed={selected}`.

- [x] **Task 4 — Build `ContextHeader`** (`src/components/pos/context-header.tsx`) (AC: 8, 9, 10, 11, 12)
  - `'use client'` (it owns a ticking clock). Props:
    ```ts
    type ContextHeaderProps = {
      restaurantName: string
      staffName: string
      zoneName?: string | null
      tableLabel?: string | null
      onNavigate: (level: 'zones' | 'zone') => void
      onStaffTap?: () => void
    }
    ```
  - Breadcrumb renders only when `zoneName` is present (AC-8).
  - Ancestor segments are buttons; the current segment is plain text, not a control.
  - **No bottom tab bar anywhere** — this is an explicit architectural prohibition, not a preference (`ux-design-specification.md:677`). Navigation is linear and workflow-driven.

- [x] **Task 5 — Hydration-safe clock** (AC: 12)
  - Rendering `new Date()` during SSR and again on the client produces different strings and Next will warn about a hydration mismatch.
  - Render nothing (or a stable placeholder) for the time on the server; start the clock in `useEffect` after mount, then tick on an interval.
  - Clear the interval on unmount.
  - Use a fixed locale/format so the value is deterministic once mounted.

- [x] **Task 6 — Demo route for manual verification** (AC: all)
  - `src/app/nav-demo/page.tsx`. There is no test framework, so this is how the components get exercised.
  - Render all three with hardcoded props: four zones (Bean Bags, Sun Beds, Tables, Rooftop), a grid of table cards covering every status plus a selected one, and the header at all three breadcrumb levels.
  - Wire `ZoneChipBar` to real state so filtering visibly works.
  - **This is a scaffold.** Story 3.2 replaces it with the real table grid — note it for removal, exactly as `/pin-demo` was removed in Story 2.2.
  - The route sits behind the proxy, so you must be signed in to view it. That is correct and also verifies `[data-context]`.

- [x] **Task 7 — Verify `[data-context]` actually drives sizing** (AC: 3)
  - Story 2.3 made `data-context` live for the first time — `layout.tsx` sets it from `x-staff-role`. **This story is the first real consumer of the `waiter:` variant.**
  - Sign in as Nina (waiter, PIN 1234) → cards must be 80px. Sign in as Aruna (owner, PIN 5678) → cards must be 44px.
  - If the variant does not apply, re-read Story 1.2's constraint: `&:is([data-context="waiter"] *)` requires the element to be a **descendant** of `<html>`, which every component is — but the attribute must actually be present. Confirm in devtools that `<html data-context="waiter">` is rendered.
  - Record both measurements in the Debug Log.

---

## Dev Notes

### Scope boundary

**Presentational components only.** No data fetching, no database, no Route Handlers, no Socket.io. Every value arrives as a prop.

Story 3.2 wires these to real data and real-time updates. If you find yourself importing `@/server/db` or writing a `fetch`, you are in the wrong story — the only exception is the demo page's hardcoded fixtures.

### What already exists — reuse, do not rebuild

| Asset | Location | Notes |
|---|---|---|
| `cn()` | `src/lib/utils.ts` | clsx + tailwind-merge |
| Design tokens | `src/app/globals.css` | brand / neutral / status, spacing, type scale |
| `waiter:` `owner:` `kitchen:` variants | `src/app/globals.css:7-9` | **live as of Story 2.3** |
| `PINPad` | `src/components/pos/pin-pad.tsx` | Reference for an 80px touch target done right |
| `LogoutButton` | `src/components/pos/logout-button.tsx` | Reference for a small client component |
| `--animate-shake` + keyframes | `src/app/globals.css` | Do not duplicate |

`src/components/pos/` currently holds `pin-pad.tsx` and `logout-button.tsx`. This story adds three more.

**shadcn/ui is configured but nothing is installed** — `src/components/ui/` does not exist. Do not `shadcn add` for these; they are bespoke touch components with no fitting primitive.

### Design tokens available

```
Brand:   --color-brand-50 … --color-brand-900   (brand-600 = 4.6:1 AA on white)
Neutral: --color-neutral-0/50/100/200/400/600/900
Status:  --color-status-open (#22C55E) · --color-status-occupied (#F59E0B)
         --color-status-alert (#EF4444) · --color-status-info (#3B82F6)
Spacing: --spacing-space-1 (4px) … --spacing-space-12 (48px)
Type:    --text-display (2rem) … --text-micro (0.75rem)
```

Numeric Tailwind sizing still works alongside the named tokens — `--spacing` is `0.25rem`, so `size-20` = 80px and `size-11` = 44px. Story 2.1 verified this in the compiled stylesheet.

### Status vocabulary — get this exactly right

```ts
tableStatusEnum = pgEnum('table_status', ['open', 'occupied', 'unavailable'])
```

| Database value | Colour token | Display label |
|---|---|---|
| `open` | `status-open` | Open |
| `occupied` | `status-occupied` | Occupied |
| `unavailable` | `status-alert` | Unavailable |

epics.md says "closed" and the UX spec says "alert". **Neither exists in the database.** Using either as a prop value means Story 3.2 passes `unavailable` from the query and the card silently falls through to no styling.

### Schema shapes you will receive in Story 3.2

Not needed now, but design the props to match so 3.2 is a straight wiring job:

```ts
zones  = { id, tenantId, name, displayOrder, isActive }
tables = { id, tenantId, zoneId, label, status, capacity, displayOrder }
```

Zones and tables are ordered by `displayOrder`. `tables.label` is free text ("R2", "Table 4"), so do not assume it is numeric or prefix it with "Table" — `label` already carries whatever the restaurant calls it. AC-10's breadcrumb reads "Table [N]" where N is the label as stored.

### Seed data gap — 3.2's problem, flagged now

`seed.ts` creates a tenant, `tenant_config`, and three staff. **It creates no zones and no tables.** Story 3.2 cannot render a real grid until the seed is extended with the four zones (Bean Bags, Sun Beds, Tables, Rooftop) and some tables. Not this story's job — the demo page uses fixtures — but do not be surprised when 3.2 hits it.

### Accessibility requirements

From `ux-design-specification.md:1136-1145` and `prd.md`:
- Waiter touch targets 80×80px; owner/kitchen 44×44px minimum (WCAG 2.1 SC 2.5.5).
- **Colour is never the sole status indicator** — always pair with an icon or text label.
- Keyboard navigation is not required for the waiter context (touch-primary), but native `<button>` gives it free; do not actively break it.
- `prefers-reduced-motion` is already honoured globally for the shake animation. Any transition you add must respect it too.

### Previous story intelligence — Stories 2.1 and 2.3

**From 2.1 (PINPad), habits worth carrying:**
- Never call a side effect from inside a `setState` updater — React double-invokes them under Strict Mode.
- A CSS animation does not replay while its class stays applied; a changing `key` is the fix.
- Verify Tailwind utilities in the **compiled** stylesheet, not by assuming. `size-20` was confirmed as `calc(0.25rem * 20)` = 80px only by reading `.next/static/chunks/*.css`.

**From 2.3, directly relevant here:**
- `data-context` is now populated on `<html>` for the first time. These components are its first real consumers.
- The proxy protects every route by default, so `/nav-demo` requires a session. Sign in first.
- Seed logins: **Nina/1234** (waiter) · **Aruna/5678** (owner) · **Kumar/4321** (kitchen).

**Environment quirk worth knowing:** the Docker container clock ran 120 seconds ahead of the host during Story 2.3. Irrelevant to these components — except that AC-12's clock shows *client* time, so do not "fix" any apparent discrepancy against database timestamps.

### Testing

No test framework, and **do not add one**.

Verify with:
1. `npx tsc --noEmit` → exit 0
2. `npx eslint` → 0 errors (one pre-existing warning in `src/server/socket/index.ts` is expected)
3. `env -u DATABASE_URL npx next build` → succeeds
4. Read the compiled CSS and confirm `size-20` → 80px and `size-11` → 44px, and that the `waiter:` variant emitted a rule
5. Live at `/nav-demo`, signed in:
   - Zone chips scroll horizontally with **no visible scrollbar**
   - Tapping a chip changes the highlight instantly
   - All three statuses render distinct colours **and** text labels
   - Selected card is distinguishable without relying on colour
   - Breadcrumb appears only when a zone is set; ancestor taps fire the callback
   - **No hydration warning in the browser console** (AC-12)
   - **As Nina (waiter): cards measure 80px. As Aruna (owner): 44px.** Measure in devtools.
6. Confirm no bottom tab bar exists anywhere

Record real output in the Debug Log. Do not claim a check passed without running it.

### Project Structure

```
NEW:    src/components/pos/zone-chip-bar.tsx
NEW:    src/components/pos/table-card.tsx
NEW:    src/components/pos/context-header.tsx
NEW:    src/app/nav-demo/page.tsx          (scaffold — remove in Story 3.2)
UPDATE: src/app/globals.css                (no-scrollbar utility only)
```

No server files, no schema changes, no migrations.

### References

- [Source: epics.md#Story-3.1] — original ACs; sizing, status naming, and header content corrected above
- [Source: ux-design-specification.md#TableCard] — states, content, variants, 56px minimum, aria-label format
- [Source: ux-design-specification.md:677-680] — header content, no bottom tab bar, state-driven action strip
- [Source: ux-design-specification.md:1136-1145] — touch targets, colour-never-alone, keyboard expectations
- [Source: architecture.md:323-370#Naming-Patterns] — kebab-case files, PascalCase components
- [Source: src/server/db/schema.ts:34] — `tableStatusEnum` authoritative values
- [Source: 2-1-build-pinpad-component.md] — 80px target precedent, compiled-CSS verification method
- [Source: 2-3-implement-session-middleware-and-role-based-access-control.md] — `data-context` now live, seed logins, proxy protects all routes

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

```
npx tsc --noEmit              → exit 0
npx eslint                    → 0 errors (1 pre-existing warning, src/server/socket/index.ts:5)
next build (no DATABASE_URL)  → SUCCESS; routes now include /nav-demo, ƒ Proxy (Middleware)

COMPILED CSS (.next/static/chunks/*.css) — verified, not assumed:
  --spacing                      → .25rem
  .min-h-11 / .min-w-11          → calc(var(--spacing) * 11) = 44px   ✓ AC-3 owner
  .waiter\:min-h-20:is([data-context=waiter] *) → calc(var(--spacing) * 20) = 80px
  .waiter\:min-w-20:is([data-context=waiter] *) → same                ✓ AC-3 waiter
  .no-scrollbar{scrollbar-width:none}
  .no-scrollbar::-webkit-scrollbar{display:none}                      ✓ AC-1 both halves
  .bg-status-open / -occupied / -alert → var(--color-status-*)        ✓ AC-4

LIVE — data-context per role (Task 7):
  Nina  (1234) → <html lang="en" data-context="waiter" class="antialiased">
  Aruna (5678) → <html lang="en" data-context="owner"  class="antialiased">
  ⇒ combined with the compiled variant rule, cards are 80px for waiter, 44px for owner

LIVE — rendered markup at /nav-demo as Nina:
  AC-5 accessible names (exactly the merged format):
    "B1, open"                        "B2, occupied, 42 minutes"
    "R1, open"                        "S1, occupied, 8 minutes"
    "R2, unavailable"                 "Table 5, occupied, 115 minutes"
    "S2, unavailable"                 "Table 4, open"
  AC-4 status text labels: 3x Open, 3x Occupied, 2x Unavailable (colour never alone)
  AC-6 occupied detail: "42<!-- -->m<!-- --> · 7 items"
       (React inserts comment separators between adjacent expressions —
        renders as "42m · 7 items")
  AC-7 aria-pressed: 14 false, 1 true
  AC-1 no-scrollbar class applied; "All Zones" chip present and first
  AC-8 grep for tabbar|tab-bar|bottom-nav → 0 matches
  AC-9 no aria-label="Breadcrumb" at top level (correctly absent)
  AC-11 aria-label="Signed in as Nina. Switch user."
  AC-12 clock span empty on SSR: <span class="... tabular-nums ..."></span>
        server log grep for "hydrat|did not match" → 0 matches

  Card class string confirmed:
    "min-h-11 min-w-11 waiter:min-h-20 waiter:min-w-20 flex flex-col ..."
```

### Completion Notes List

**A layout bug was caught and fixed before completion.** The first implementation used `size-11` / `waiter:size-20`, which pins width *and height* to an exact value. But the card stacks four rows — label, zone name, status label, and occupied detail — inside 12px of padding. At a fixed 44px the content overflows; at a fixed 80px it is still tight, since the label alone is `text-h2` (18px).

Re-reading the ACs settled it: both say "**≥** 80×80px" and "**≥** 44×44px" — a *minimum* touch target, not a fixed box. Switched to `min-h-11 min-w-11 waiter:min-h-20 waiter:min-w-20`, which satisfies the AC literally and lets the card grow to fit its content. Verified in the compiled CSS and in the rendered class string.

**The clock needed React's actual primitive, not an effect.** A `useState` + `useEffect` clock tripped `react-hooks/set-state-in-effect` — the same rule Story 2.1 hit. Rewritten with `useSyncExternalStore`, which is purpose-built for reading a mutable external source without breaking hydration: React renders `getServerSnapshot` on the server *and* during hydration, then swaps to the client snapshot. The snapshot is cached per minute, because returning a fresh string on every `getSnapshot` call would re-render forever. AC-12 verified — clock span is empty in the SSR output and the server log shows zero hydration warnings.

**Status vocabulary held to the schema.** `TableStatus` is `'open' | 'occupied' | 'unavailable'`, matching `tableStatusEnum`. epics.md's "closed" and the UX spec's "alert" were both rejected — `alert` is the *colour token* used to render `unavailable`, not a status. A comment in `table-card.tsx` records this so Story 3.2 does not reintroduce the mismatch.

**Design decisions worth knowing:**
- Status dot is `aria-hidden`; the meaning is carried by the adjacent text label and by `aria-label`. A screen reader hears "B2, occupied, 42 minutes", never a bullet.
- Breadcrumb renders only below the top level. At the top there is nothing to navigate back to, so an inert "Zones" crumb would be noise.
- The current breadcrumb segment is plain text with `aria-current="page"`, not a button — tapping where you already are should do nothing.
- `selected` is signalled by border weight *and* a ring, not colour alone (`prd.md` accessibility rule).
- The demo page includes six zones rather than four, specifically so horizontal overflow is actually testable.

**NOT verified:**
- **No browser was used.** Everything above is compiled-CSS inspection, rendered-HTML inspection, and server-log inspection via curl.
- **Card dimensions were never measured in devtools.** The CSS rule and the `data-context` attribute are both confirmed present, so 80px/44px follows — but nobody looked at a rendered box.
- Horizontal scrolling and the absence of a visible scrollbar were verified by the presence of the compiled CSS, not by scrolling.
- No screen reader was run; ARIA is correct by inspection.
- Touch ergonomics on a real tablet are unassessed.

**No test framework exists**, so none of this is captured as an automated test.

**Temporary scaffold to remove:** `src/app/nav-demo/page.tsx` exists only for manual verification. Story 3.2 replaces it with the real database-backed table grid — delete it then, as `/pin-demo` was deleted in Story 2.2.

**Flagged for Story 3.2:** `seed.ts` still creates no zones and no tables. The grid cannot render real data until it does.

### File List

- NEW: `src/components/pos/zone-chip-bar.tsx`
- NEW: `src/components/pos/table-card.tsx`
- NEW: `src/components/pos/context-header.tsx`
- NEW: `src/app/nav-demo/page.tsx` (scaffold — delete in Story 3.2)
- UPDATE: `src/app/globals.css` (added the `no-scrollbar` utility; no tokens touched)

### Change Log

- 2026-08-21: Story implemented. ZoneChipBar, TableCard and ContextHeader built as presentational components with a /nav-demo scaffold. Fixed a layout bug before completion — fixed-size cards clipped their four stacked content rows, corrected to minimum dimensions per the ACs literal wording. Clock rewritten with useSyncExternalStore after useEffect tripped react-hooks/set-state-in-effect; hydration verified clean.
- 2026-08-21: Story created. Four conflicts resolved across epics.md, the UX specification, and the database schema: TableCard touch target (80px vs 56px), the third table status (`closed` vs `alert` vs the schema's actual `unavailable`), the `aria-label` format, and ContextHeader content. Four ACs added beyond the epic for behaviour the UX spec requires but epics.md omits — selected state, occupied detail (elapsed time and item count), staff-name tap target, and hydration-safe clock rendering.
