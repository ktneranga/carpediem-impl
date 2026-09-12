# Story 4.2: Implement Menu Browse & Search

Status: done

- **Epic:** 4 — Order Entry & Multi-Destination Routing
- **Story ID:** 4.2
- **Requirement:** FR7 (search or browse by item name or category), FR9 (production destination)
- **Blocks:** 4.4 (add item to order) and 4.5 (routing) both need `production_destination`, which **does not exist yet** — see Decision 1.

---

## Story

**As a** waiter,
**I want** to browse the menu by category and search by item name,
**so that** I can find any item quickly regardless of whether I know where it lives in the menu.

---

## Acceptance Criteria

**AC-1: The menu loads**
**Given** a waiter opens the menu on an active session
**When** it loads
**Then** every active category is shown with its items; load completes in under 1 second on the restaurant LAN

**AC-2: Browsing by category**
**Given** the menu is displayed
**When** a waiter taps a category
**Then** the list filters to that category; **no navigation occurs**, and dismissing the category returns to the full list — see Decision 3

**AC-3: Search filters instantly, client-side**
**Given** a waiter types a partial item name
**When** the input changes
**Then** the list shows only items whose name contains the string, case-insensitively; **no network request is made**; a matching item's category remains identifiable

**AC-4: Unavailable items are visible but inert**
**Given** an item with `is_available = false`
**When** it appears in browse or search
**Then** it is visibly marked unavailable (greyed, struck through, or both); its add control is disabled; tapping it does nothing

**AC-5: `GET /api/menu`**
**Given** the route is called
**When** it responds
**Then** it returns every active category and its items with `id`, `name`, `pricePaisa`, `available`, `productionDestination` and `portionCount`; under 300ms on the LAN; **camelCase**, never raw column names (`architecture.md:520`)

**AC-6: Live availability**
**Given** a `menu:item_updated` event arrives (an item 86'd by a manager)
**When** the client handles it
**Then** the affected item's availability updates and the menu re-renders with no page reload and no full refetch of unrelated data — **note the event name, see Decision 2**

**AC-7: The menu has data to browse** *(added beyond the epic)*
**Given** a developer runs `pnpm db:seed`
**When** the menu loads
**Then** there are realistic categories and items across all three production destinations, including at least one unavailable item — the database currently holds **0 categories and 0 items**, so without this nothing in this story can be verified at all

**AC-9: The menu is a card grid with images and icon category filters** *(added 2026-09-12, Teran)*
**Given** the menu is displayed
**When** a waiter looks at it
**Then** items render as **cards in a grid**, each showing a picture of the dish, its name, its price and an add control; category filters are **icon chips**, not text alone

**Given** an item with no photograph
**When** its card renders
**Then** a category-tinted tile with that category's icon takes the image's place — a designed fallback, never a broken image or an empty box

**Given** an unavailable item
**When** its card renders
**Then** the image is desaturated and an **Unavailable** badge sits over it; the add control stays disabled (AC-4 unchanged)

**AC-8: Kitchen staff cannot reach the menu API** *(added beyond the epic)*
**Given** a kitchen user calls `GET /api/menu`
**When** the proxy evaluates the policy
**Then** the request is refused — `/api/menu` matches **no policy today** and would default-allow. See Trap 2.

---

## Tasks / Subtasks

- [x] **Task 1 — Schema: the production destination** (AC: 5) — **do this first; 4.4 and 4.5 are blocked on it**
  - `src/server/db/schema.ts`:
    ```ts
    export const productionDestinationEnum = pgEnum('production_destination', [
      'kitchen', 'pizza_kitchen', 'bar',
    ])
    // menuItems:
    productionDestination: productionDestinationEnum('production_destination')
      .notNull().default('kitchen'),
    ```
  - **Also rename the TS key `pricePaysa` → `pricePaisa`.** The column is `price_paisa`; only the Drizzle property is misspelled, nothing reads it yet, and AC-5 puts this name in the API contract. Fix it before it spreads.
  - **Do NOT touch `stationTypeEnum`.** It is `['kitchen','bar']` and lacks `pizza_kitchen` — a real gap, but it belongs to station/printer configuration (Epics 5 and 10), not to item routing. Logged in `deferred-work.md` instead.
  - **⚠️ MIGRATION JOURNAL — this has now bitten three times (3.7, 3.8, 3.9).** After `pnpm db:generate`, open `meta/_journal.json` and confirm the new entry's `when` is **greater than `1789070000000`** (0008's hand-set value). `drizzle-kit migrate` orders by `when`, not filename, and **reports success while doing nothing** if the new entry sorts older. Bump it.

- [x] **Task 2 — Route policy before the route** (AC: 8) — **before Task 3**
  - `src/server/auth/permissions.ts` — add `{ prefix: '/api/menu', roles: ['owner', 'waiter'] }`.
  - Same reasoning as Story 3.9 Task 3: `findRoutePolicy` returns null for an unmatched prefix and `isRoleAllowed` reads null as *allow any authenticated role*. `/api/menu` matches nothing today.
  - Kitchen staff have no use for the ordering menu; they read tickets. If Epic 5's KDS ever needs item names it will have its own endpoint under `/api/kitchen`, which is already policed.
  - Verify as Kumar (4321, `kitchen`): `GET /api/menu` must 403.

- [x] **Task 3 — `GET /api/menu`** (AC: 1, 5)
  - `src/app/api/menu/route.ts`. Single-tenant (NFR-SC1), same `tenants` lookup as `/api/tables`.
  - Active categories only (`menu_categories.is_active`), ordered by `display_order` then `name`; items ordered the same way within each category.
  - Shape — **camelCase, and `available`, not `isAvailable`**, because AC-5 names the field:
    ```ts
    export type MenuItemRow = {
      id: string; name: string; pricePaisa: number
      available: boolean
      productionDestination: 'kitchen' | 'pizza_kitchen' | 'bar'
      portionCount: number | null
    }
    export type MenuCategoryRow = { id: string; name: string; items: MenuItemRow[] }
    ```
  - One query with a join, assembled in JS. Two round trips would be fine at this size, but `/api/tables` established the pattern and the item count is bounded by a single restaurant's menu.
  - **No item-level filtering by availability.** AC-4 requires unavailable items to be *visible*; filtering them out server-side would make an 86'd item vanish rather than grey out, and a waiter needs to see that it exists in order to tell the guest.

- [x] **Task 4 — The socket event** (AC: 6)
  - `src/server/socket/events.ts` — add `emitMenuItemUpdated({ itemId, available, portionCount })` emitting **`menu:item_updated`**. See Decision 2 for why not `menu:itemUpdated`.
  - Nothing emits it in this story — Epic 8 (`8-2`, `8-3`) and Epic 10 do. Build the listener now; the emitter's absence is why AC-6 must be verified by emitting by hand, and the Dev Agent Record must say so.
  - **Amend `epics.md`** in all six places where `menu:itemUpdated` appears (lines ~1305, ~1901, ~1931, ~1961, ~1965 and one more), so Epic 8 cannot implement the other spelling. This is the same correction made for `table:statusChanged` on 2026-08-21.

- [x] **Task 5 — The menu UI** (AC: 1, 2, 3, 4)
  - `src/components/pos/menu-browser.tsx`. `'use client'`, `useQuery` on `['menu']`.
  - **Search bar persistent at the top**, category chips beneath it (Decision 3). Search is the primary path; `ux-design-specification.md:307` — "type 2–3 characters, item appears instantly".
  - Filtering is `useMemo` over the fetched list. **Never refetch on keystroke** (AC-3).
  - Unavailable items render greyed with the add control `disabled` — not hidden, not removed from the DOM.
  - Reuse `ZoneChipBar`'s chip idiom visually but **do not reuse the component** — it is typed to `Zone` and carries open-counts and a Counter pill that mean nothing here. A sibling `menu-category-chips.tsx` is the honest move; extract shared chip chrome only if it is genuinely identical.
  - Render it on the order screen between the info card and the action strip, replacing the "Epic 4 placeholder" section.

- [x] **Task 6 — Seed a real menu** (AC: 7)
  - `src/server/db/seed.ts` — categories and items covering **all three** destinations, at least one `is_available: false`, and at least one with `portion_count` set (Epic 8 needs it).
  - Follow the existing seed's idempotent shape; re-running must not duplicate.
  - Without this the database has 0 categories and 0 items and **every AC in this story is unverifiable**.

- [x] **Task 8 — Images on menu items** (AC: 9)
  - `src/server/db/schema.ts` — `imageUrl: text('image_url')`, **nullable**. Migration 0010.
  - Check `meta/_journal.json` again: `when` must exceed 0009's `1789134001753`.
  - `GET /api/menu` returns `imageUrl` on every item. Seed leaves it **null** — there are no photographs of Carpe Diem's dishes, and inventing stock images would misrepresent the restaurant's own menu. The fallback is the design, not a placeholder for one.
  - **This reverses a documented UX decision.** `ux-design-specification.md:411` — *"No product images. Practical constraint for SaaS — restaurants configure their own menus and cannot be expected to photograph 100+ items."* Teran overrode it on 2026-09-12. The constraint is real, which is why the column is optional and the icon fallback is a first-class rendering rather than an error state: a restaurant that photographs nothing still gets a menu that looks deliberate.

- [x] **Task 9 — The card grid and icon chips** (AC: 9)
  - `src/lib/design.ts` — `menuCategoryIcon(name)`, same shape as the existing `zoneIcon`: a lowercase lookup with a sensible fallback. Lucide is already a dependency; add no packages.
  - `src/components/pos/menu-browser.tsx` — cards in a responsive grid, matching the floor grid's column steps (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`) so the two screens feel like one product.
  - Card: image or fallback tile on top, then name, then price and the add control. `next/image` is NOT used — these are arbitrary owner-supplied URLs and the remote-pattern allowlist would have to be configured per deployment; a plain `<img>` with `loading="lazy"` is the honest choice here.
  - Category chips gain their icon. Keep the text label — an icon alone is a guess, and the card's own design rules already say colour and shape never carry meaning without a word.
  - **No quantity stepper.** The reference design shows one; staging an item is Story 4.4. A stepper now is a control that does nothing, which this project has already shipped once as the dead "Switch user" button.
  - **No discount badges, no Veg/Non-Veg tags.** Both appear in the reference and neither has a requirement, a column, or an AC.

- [x] **Task 7 — Verify** (AC: all)
  - No test framework; manual, as every prior story. Matrix in Dev Notes.
  - The RBAC check is not optional — it is the only thing that catches Trap 2, and Trap 2 is silent.

---

### Review Findings

Code review 2026-09-12 — three parallel layers, every claim re-verified against the working tree. Findings for Story 4.1 are recorded in its own file; these are the menu's.

#### Patch

- [x] [Review][Patch] **A `menu:item_updated` patch is silently dropped on an empty cache — the defect the table grid already fixed and documented** [`menu-browser.tsx`] — `if (!current) return current`. The grid's handler, 600 lines away, invalidates instead, with a comment calling the alternative *"a real lost update that left the card wrong until a reload"*. Two paths reach it: an event before the first fetch resolves, and an event during a refetch, after which the in-flight response overwrites the patch. Either way an 86'd item stays orderable on that tablet — the exact silent failure Decision 2's naming correction exists to prevent.
- [x] [Review][Patch] **The listener writes `portionCount` from a payload the epic does not specify it carrying** [`menu-browser.tsx`, `epics.md`] — Epic 8 emits `{ itemId, available: false }` at `epics.md:1964` and `{ itemId, available: true }` at `:1968` — no `portionCount`. The patch writes `portionCount: payload.portionCount`, i.e. `undefined`, discarding the cached value on every receiving device. This is Story 3.8's `groupTableLabels` lesson in the other direction: Task 4 corrected the event's NAME but not its SHAPE. Fix both ends — guard the patch and amend those two epic payloads.
- [x] [Review][Patch] **The payload type is hand-copied instead of imported** [`menu-browser.tsx`] — `events.ts` exports `MenuItemUpdatedPayload`; the consumer declares its own. A second declaration means the compiler cannot notice when Epic 8 adds a field, which is the whole mechanism behind the finding above.
- [x] [Review][Patch] **Counter sales are told a table is being released** [`order-screen.tsx`] — The walkout heading and first clause were made label-agnostic; the sentence one line later still reads *"releases the table"*, and the buttons still read **Close table** / **Close table — walkout**. For FR64's order there is no table. This is the irreversible, money-recorded confirmation telling the waiter it will do something it cannot.
- [x] [Review][Patch] **`Zone: No table`** [`order-screen.tsx`] — The value was made null-safe, the label was not. The heading one section up says "Counter"; the same fact is spelled two ways on one screen. `tableLabel` gets the `?? 'Counter'` fallback before reaching `ContextHeader`; `zoneName` is passed through as raw null.
- [x] [Review][Patch] **Empty categories are dropped in the default view, contradicting the comment and the route's deliberate LEFT JOIN** [`menu-browser.tsx`] — `category.items.length > 0 || (!needle && activeCategoryId !== null)`. With no search and no chip — the default — an empty category evaluates `false || (true && false)` and vanishes. The comment says it should survive *"when simply browsing"*, which is exactly that state, and `/api/menu` pays for a LEFT JOIN and a null-row skip to preserve them. The condition should be `!needle` alone.
- [x] [Review][Patch] **Every menu failure is reported as a network problem, and failures after the first success are not reported at all** [`menu-browser.tsx`] — `fetchMenu` extracts the server's message; the render discards it for a fixed "Check the tablet is on the restaurant network." A 401 idle-out, a 403, and `NOT_PROVISIONED` all say check the Wi-Fi, and nothing routes an expired session to `/login`. The `&& !categories` guard then means no later failure surfaces at all: the menu goes stale silently.
- [x] [Review][Patch] **Sub-rupee prices display differently from what will be charged** [`menu-item-card.tsx`] — Nothing constrains `price_paisa` to whole rupees and `lkr()` rounds: `95050` renders **LKR 951** against an actual 950.50, in the price and again in the `aria-label`. `format.ts` names precisely this as an audit discrepancy. Either render the decimals or constrain the column.
- [x] [Review][Patch] **A broken image leaves a blank grey box with no fallback** [`menu-item-card.tsx`] — Owner-supplied arbitrary URLs, no `onError`, and `alt=""`, so a 404 renders nothing inside the aspect box. A whitespace-only `image_url` is truthy, so `src=" "` resolves to the current page and the browser tries to decode the HTML as an image. Fall back to the icon tile on error, and treat blank strings as absent.
- [x] [Review][Patch] **Search is silently scoped to the active category and the empty state blames the search term** [`menu-browser.tsx`] — The category filter runs before the search filter, so with a chip active the waiter sees `Nothing matches "prawn"` while Butter Prawns sits one chip away. The same string is wrong in the other direction: an entirely empty menu reports "No items in **this category**" when no category is selected.
- [x] [Review][Patch] **A stale `activeCategoryId` empties the menu with no visible filter** [`menu-browser.tsx`] — Filter to a category, then a refetch returns without it (the owner deactivated it, which `/api/menu` filters on). `visible` is empty, no chip renders `aria-pressed="true"`, and the waiter sees "No items in this category" with nothing indicating a filter is active. Reset when the id leaves `categories`.
- [x] [Review][Patch] **The search field scrolls out of view on a long menu** [`menu-browser.tsx`, `order-screen.tsx`] — Nothing is `sticky` and `<main>` does not scroll independently, so past about two grid rows the field the design calls *"the primary menu navigation path"* is off-screen. The file header claims it is "first and always visible".
- [x] [Review][Patch] **"Close table" is now buried beneath the entire menu** [`order-screen.tsx`] — The menu replaced a fixed-height placeholder in the same non-scrolling `<main>`, above the close section. At the PRD's own 100+ item figure the waiter scrolls past every dish to reach walkout. 4.1's comment reasoning about Close staying "in the body" predates the body becoming arbitrarily long.
- [x] [Review][Patch] **Every add control ships permanently disabled with an actionable label** [`menu-item-card.tsx`] — `onAdd` is never passed, so `disabled` is true for every item; the visible label still reads "Add to order" and the `aria-label` still promises `Add ${name}, ${price}`. `disabled` also removes them from the tab order, leaving the whole menu keyboard-inert. The card's own docstring invokes the dead "Switch user" control, and `action-strip-chrome.tsx` states the opposite doctrine — *"NO buttons at all, never disabled ones"*. Two files in one change disagree on the project's rule.
- [x] [Review][Patch] **`menuCategoryIcon` is resolved per ITEM rather than per category** [`menu-browser.tsx`] — `icon={menuCategoryIcon(category.name)}` inside the item map. Hoist it to the category loop. The prop's docstring also justifies the move by a lint rule that applies equally in the parent, and by "same instance", which comes from the lookup table being a module constant rather than from where it is called.
- [x] [Review][Patch] **A long search string is echoed verbatim into the empty state** [`menu-browser.tsx`] — `Nothing matches "${search.trim()}"` with no truncation.
- [x] [Review][Patch] **Task 5's `menu-category-chips.tsx` was never extracted, and the File List double-lists `menu-browser.tsx`** [spec] — The chips, `chipClass` and the "All items" chip are inline, about a third of the file. A Task instruction silently dropped rather than a recorded decision. The File List has `menu-browser.tsx` under both New and Modified.
- [x] [Review][Patch] **Line-number citations have drifted** [`menu-browser.tsx`, spec] — `ux:418` for "dismiss to return to full list" is at **:417**; the deferred table's `ux:415` for fuzzy alias matching is at **:414**.

#### Deferred

- [x] [Review][Defer] **The seed never exercises the image path** — every card takes the fallback tile, so the `<img>`, its `loading="lazy"` and its `grayscale` unavailable treatment ship untested. The seed's own standard: "an unavailable rendering nobody has seen is an unavailable rendering nobody has tested."
- [x] [Review][Defer] **Search is not accent- or locale-normalised** — `toLowerCase()` with no `normalize('NFD')`, so "creme" never matches "Crème Brûlée"; `toLowerCase` rather than `toLocaleLowerCase` mishandles Turkish dotted-İ
- [x] [Review][Defer] **`toLowerCase()` is recomputed per item per keystroke** — negligible at 100 items, but it is the term that grows with menu size, in the interaction the design calls primary
- [x] [Review][Defer] **Duplicate category names render two indistinguishable chips** — `menu_categories` has no unique constraint on `(tenant_id, name)`
- [x] [Review][Defer] **`drinks`/`bar` map to a beer glyph** on a category seeded with King Coconut and Fresh Lime Soda
- [x] [Review][Defer] **No CHECK pairs `order_sessions.kind` with `table_id`** — already logged from Story 3.9's review; re-confirmed
- [x] [Review][Defer] **`seed.ts` keys a table's reason on `'reason' in tableSpec` rather than on `status === 'unavailable'`** — adding a reason to an open table passes TypeScript and fails migration 0006's CHECK at insert

**Dismissed as noise (2):** the `OPEN_SESSION_INDEX` rename concern — verified updated during Story 3.8 and confirmed by its concurrency test; and the missing trailing newline on migrations 0009/0010, which `drizzle-kit` generates.

---

## Dev Notes

### 🚨 Decision 1 — `production_destination` does not exist, and this story must add it

FR9 routes every item to Kitchen, Pizza Kitchen or Bar "based on item configuration". AC-5 requires `GET /api/menu` to return it. Story 4.5 branches on it (`epics.md:1397`). And:

```
menu_items columns: id, tenant_id, category_id, name, price_paisa,
                    portion_count, is_available, ticket_output_mode, display_order
```

There is **no destination column anywhere**. `ticket_output_mode` is `print | kds` — *how* a ticket comes out, not *where* it goes. `station_configs` exists but nothing links an item to a station.

So this is the same shape as merged tables and counter sale: an FR the schema cannot express. Unlike those, it needs no sprint change proposal — FR9 and Story 4.5 both already exist, and 4.2 is simply the first story to touch the gap. Add the column here.

**Known adjacent gap, deliberately not fixed here:** `stationTypeEnum` is `['kitchen','bar']` — no `pizza_kitchen`. That enum types *station configuration* (printers, KDS), not item routing, so Epic 5's ticket generation and Epic 10's station config will have to reconcile it. Logged in `deferred-work.md`.

### 🚨 Decision 2 — the event is `menu:item_updated`, and the epic must be corrected

`architecture.md:399` — *"Socket.io events — `domain:action`, past tense for broadcasts"* — and its canonical list is snake_case after the colon: `table:status_changed`, `inventory:depleted`. Every event in the codebase follows it, including `counter:changed` from Story 3.9.

`epics.md` writes **`menu:itemUpdated`** in six places. That is precisely the defect corrected on 2026-08-21, recorded in `src/server/socket/events.ts`:

> *"epics.md wrote `table:statusChanged` in seven places; that was corrected on 2026-08-21. A camelCase listener never fires, and nothing errors — real-time simply stops working silently."*

The danger here is sharper than a convention breach. **This story writes the listener; Epic 8 writes the emitter.** If they pick different spellings nothing errors, nothing logs, and an 86'd item silently fails to grey out on every other tablet — discovered, if ever, by a waiter selling something the kitchen has run out of. Task 4 corrects the epic text so the two cannot diverge.

### 🚨 Decision 3 — category chips, not section headers

The epic's AC-2 says *"taps a category header → the view scrolls to or expands that category's items; items in other categories remain accessible without navigating away."* The UX spec says something different and more specific:

> *"Horizontal scrollable category chips below the search bar. Tap to filter; dismiss to return to full list."* — `ux-design-specification.md:418`
> *"Search is the primary menu navigation path… browsing by category is the fallback, not the primary path"* — `:307`, `:91`

**Build the chips.** Three reasons: the UX spec is the design authority and is explicit that search leads; the floor screen already teaches this exact idiom with `ZoneChipBar`, so waiters have learned it; and a scrolling accordion of 100+ items is the thing the spec is arguing against.

AC-2's requirement is preserved on the reading that matters — **no navigation occurs**, and one tap restores the full list. AC-2 is restated above in those terms.

### 🚨 Trap 1 — there is no menu data at all

```
select count(*) from menu_categories;  ->  0
select count(*) from menu_items;       ->  0
```

Nothing in this story can be seen working until Task 6 seeds a menu. Do that early, not last — building the UI against an empty list is how you ship a component that has never rendered a row.

### 🚨 Trap 2 — `/api/menu` is default-allow until a policy exists

`findRoutePolicy` returns `null` for an unmatched prefix and `isRoleAllowed` treats null as *allow any authenticated role* — deliberate, so a new route surfaces as a missing policy rather than a confusing 403. `/api/menu` matches nothing today.

Nothing errors and nothing logs. The only signal is a kitchen user succeeding where they should not. **Task 2 before Task 3**, exactly as Story 3.9 did for `/api/sessions`.

### Explicitly out of scope — UX-spec features with no requirement

`ux-design-specification.md:420-426` promises three things that have **no FR and appear in no epic AC**:

| Promised | Status |
|---|---|
| **Quick Items** — 8 per-waiter pinned items | No FR, no AC, needs a per-staff table |
| **Recents strip** — last 5 items this waiter ordered | No FR, no AC, needs order history |
| **Fuzzy match on kitchen aliases** — "GF" → "Grilled Fish" | No FR, no AC, needs an alias column |

AC-3 specifies **case-insensitive substring matching**, which is what FR7 asks for and what this story builds. Do not build fuzzy matching; do not add an alias column. All three are logged in `deferred-work.md` — this is the same "in the mockups, in no document" pattern that produced counter sale, and they should reach the plan through a proposal rather than through a developer's initiative.

### Current state of the files this story touches

| File | Today | This story |
|---|---|---|
| `src/server/db/schema.ts` | `menuItems` has no destination; `pricePaysa` misspelled | Add the enum + column; fix the TS key |
| `src/server/auth/permissions.ts` | No `/api/menu` policy | Add it, before the route exists |
| `src/server/socket/events.ts` | `emitTableStatusChanged`, `emitCounterSalesChanged` | Add `emitMenuItemUpdated` |
| `src/server/db/seed.ts` | No menu data | Categories and items |
| `src/components/pos/order-screen.tsx` | Info card, an "Epic 4 placeholder" section, close controls, `OrderActionStrip` at `empty` | Menu browser replaces the placeholder |
| `src/app/api/menu/route.ts` | — | NEW |
| `src/components/pos/menu-browser.tsx` | — | NEW |

**Preserve, do not regress:**

- The order screen is a **flex column with a `flex-1` main** (Story 4.1) so the action strip sits at the bottom. The menu goes inside `<main>`; it must scroll within it, not push the strip off-screen.
- The screen works for a **counter sale** with no table — `tableLabel` and `zoneName` are nullable and `displayLabel` falls back to `"Counter"`. The menu is identical either way.
- `ForbiddenError` stays distinct from `SessionExpiredError`. Conflating them caused an infinite sign-out loop for kitchen users.
- Socket payloads carry every field the client patches. Story 3.8's review found `groupTableLabels` missing from the payload while the client keyed on it — a merge that only worked on the device that made it. If the menu patches a field, the event must carry it.
- Money is **integer paisa** everywhere. `src/lib/format.ts` has `lkr()`; never hand-roll currency.

### Verification matrix

| Case | Expected |
|---|---|
| `GET /api/menu` as Nina (waiter) | 200, categories with items, camelCase, `< 300ms` |
| **`GET /api/menu` as Kumar (kitchen)** | **403** |
| Response field names | `pricePaisa`, `available`, `productionDestination`, `portionCount` |
| Every destination present in the seed | `kitchen`, `pizza_kitchen`, `bar` all appear |
| Search "gril" | matches "Grilled Fish" case-insensitively; **zero network requests** (check the Network panel) |
| Search with no match | empty state, not a blank screen |
| Tap a category chip, then dismiss | filters, then restores the full list; no navigation |
| Unavailable item | greyed/struck, add control `disabled`, tap does nothing |
| Emit `menu:item_updated` by hand | that item flips availability; no page reload |
| Emit `menu:itemUpdated` (camelCase) by hand | **nothing happens** — this is the trap, demonstrate it |
| Order screen for a counter sale | menu identical; strip still at the bottom |
| Long menu | scrolls inside `<main>`; the action strip stays put |

Seed accounts: **Nina 1234 `waiter`**, **Aruna 5678 `owner`**, **Kumar 4321 `kitchen`**.

### Project Structure Notes

- `architecture.md:520` — Drizzle returns snake_case; a mapping layer converts to camelCase before the Route Handler returns. **Raw DB column names never appear in responses.**
- API paths are plural nouns, kebab-case (`architecture.md:367`). `/api/menu` is the singular collective the epic names; keep it.
- Components: kebab-case files, PascalCase exports, in `src/components/pos/`.

### References

- [Source: `epics.md` Story 4.2; 4.4 and 4.5 for what depends on `production_destination`; 8-2/8-3 for the `menu:item_updated` emitters]
- [Source: `prd.md` FR7, FR9]
- [Source: `architecture.md:399-415`] — the canonical Socket.io event list and naming rule
- [Source: `architecture.md:520`] — camelCase API responses
- [Source: `ux-design-specification.md:409-426`] — search-first item entry, category chips, and the three out-of-scope features
- [Source: `src/server/socket/events.ts`] — the 2026-08-21 camelCase correction this story repeats
- [Source: `_bmad-output/implementation-artifacts/3-9-implement-counter-sale.md`] — the policy-before-route pattern and the migration journal trap

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

Verified with curl, psql, `drizzle-kit`, `tsc`, `eslint` and `next build`. The item list is client-rendered — see the gap at the end.

**Schema.** Migration `0009_milky_rocket_racer` added the `production_destination` enum and column. The journal trap did **not** fire this time — the real clock has finally passed 0008's hand-set `1789070000000` — but it was checked before applying rather than assumed:

```
0008 when: 1789070000000
0009 when: 1789134001753   ORDERED OK
```

`pricePaysa` → `pricePaisa` at the same time. The column was always `price_paisa`; only the Drizzle key was misspelled, nothing read it, and AC-5 put the name into the API contract.

**AC-8 — RBAC, the silent trap.** Policy added before the route existed:

```
nina  (waiter)  GET /api/menu -> 200
aruna (owner)   GET /api/menu -> 200
kumar (kitchen) GET /api/menu -> 403
```

**AC-5 — the contract**, checked field by field rather than eyeballed:

```
4 categories, 13 items
item keys: available, id, name, portionCount, pricePaisa, productionDestination
destinations present: bar, kitchen, pizza_kitchen
unavailable items RETURNED (not filtered): ['Crab Curry']
snake_case leakage: none
```

That third line matters: nothing filters on `is_available`. An 86'd dish stays on the menu greyed out, because a waiter needs to see it exists in order to tell the guest it has run out — filtering server-side would read as "we never sold that".

**AC-1 — response time**, three runs: **38ms, 42ms, 28ms** against a 300ms budget.

**AC-7 — the seed.** The database held **0 categories and 0 items**, so nothing in this story was verifiable before it. Now:

```
Starters  3 items    Mains  4 items (1 unavailable)
Pizza     2 items    Drinks 4 items
kitchen 6 · pizza_kitchen 3 · bar 4
```

All three destinations are populated deliberately — Story 4.5 routes on them, and a seed with only `kitchen` items would let a broken router pass every test.

**AC-6 — the event name, which is the whole point of Decision 2.** The listener and the emitter are now the same string in the same repo:

```
src/server/socket/events.ts:121     getIO().emit('menu:item_updated', payload)
src/components/pos/menu-browser.tsx:68  useSocketEvent('menu:item_updated', ...)
```

and `epics.md` carries the snake_case spelling in all six places, with a note recording why. Epic 8 writes the emitter for real; it can no longer pick the other spelling.

**What the order screen serves.** The menu shell renders server-side and the items arrive from the client query, which is the expected shape:

```
aria-label="Menu"  ·  "Search the menu…"  ·  "Filter the menu by category"
"All items"        ·  "Loading the menu…"  ·  "Order actions" (the 4.1 strip)
```

**Not verified — the browser.** Everything that only exists after the client query resolves: the item rows themselves, the `LKR` prices, search filtering as you type, the category chips filtering and clearing, and the greyed/struck rendering of Crab Curry. The API behind all of it is verified above, and `tsc`, `eslint` and `next build` pass — but no one has watched a keystroke filter the list.

AC-6's runtime behaviour is also unexercised: nothing emits `menu:item_updated` until Epic 8, so the listener has been verified by name rather than by receipt.

**Card grid redesign — 2026-09-12 (Tasks 8-9).**

Rebuilt from a reference design Teran supplied: dish cards in a grid, icon category filters.

**This reverses a documented UX decision**, so it is recorded rather than quietly done. `ux-design-specification.md:411`: *"No product images. Practical constraint for SaaS — restaurants configure their own menus and cannot be expected to photograph 100+ items."* The constraint is still true, which shaped how it was built: `menu_items.image_url` is **nullable**, the seed leaves every item null, and the fallback — a category-tinted tile carrying that category's icon — is a first-class rendering rather than a placeholder for a missing one. A restaurant that photographs nothing gets a menu that looks deliberate; one that photographs its best dishes gets those, on the same card.

Migration 0010. The journal was checked before applying, again — `0010 when 1789143478009 > 0009 when 1789134001753`.

```
API contract now: available, id, imageUrl, name, portionCount, pricePaisa, productionDestination
photos: 0 of 13   (every card takes the fallback tile today)

photo path proved by setting one URL temporarily:
  Grilled Fish -> https://example.invalid/grilled-fish.jpg   then reverted to null
```

**Category icons resolve for every seeded category, and degrade for invented ones:**

```
Starters -> Salad        Mains  -> UtensilsCrossed
Pizza    -> Pizza        Drinks -> Beer
Beach Grill -> Utensils (fallback)
```

Keyed on the lowercased category NAME, because categories are owner-configured free text — there is no enum to switch on and there should not be, or a restaurant inventing "Beach Grill" would need a migration.

**Two things from the reference were deliberately not built:**

- **Quantity steppers.** Staging an item is Story 4.4. A stepper now is a control that does nothing — the dead "Switch user" button this project has already shipped once. The card's add control is present but disabled, and turns on the moment 4.4 passes `onAdd`.
- **Discount badges and Veg / Non-Veg tags.** No requirement, no column, no AC for either.

**Two implementation notes worth keeping:**

- The category icon is passed INTO the card as a prop rather than looked up inside it. That keeps the chip and every card beneath it on the same component instance — and resolving a component inside a component body is what the React Compiler lint rule refuses, correctly.
- A plain `<img>`, not `next/image`. These URLs are owner-supplied and arbitrary; `next/image` needs every host declared in `remotePatterns` at build time, which a per-restaurant deployment cannot know. The lint rule is disabled on that one line with the reason in the file header.

**Not verified — the browser.** The grid itself: card layout and column steps, the fallback tiles rendering, the desaturated image and Unavailable badge on Crab Curry, and the icons on the chips. All of it lives behind the client query. The API is verified above and `tsc`, `eslint` and `next build` are clean.

**Code Review Pass — 2026-09-12.**

Three layers, every finding verified against the source. 17 patches on this story.

**The one that matters most: the menu dropped socket patches on an empty cache.** `if (!current) return current` — while `table-grid.tsx`, six hundred lines away, invalidates instead, with a comment calling the alternative *"a real lost update that left the card wrong until a reload."* Two paths reach it: an event before the first fetch resolves, and an event during a refetch whose in-flight response then commits over the top. Either way an 86'd item stays orderable on that tablet — the exact silent failure Decision 2's naming correction exists to prevent. Now invalidates, and also invalidates when the event names an item the cache has never seen.

**The event's shape was never agreed, only its name.** Epic 8 emits `{ itemId, available }` at `epics.md:1964` and `:1968`; the listener wrote `portionCount: payload.portionCount` — `undefined` — erasing the cached count on every receiving device. Story 3.8's `groupTableLabels` lesson from the other direction. Fixed at both ends: the epic's payloads now carry `portionCount`, the patch guards with `?? item.portionCount`, and the payload type is **imported from the emitter** rather than hand-copied, so the compiler will notice next time.

**Money.** `lkr()` rounds, which is right for a bill total decided once — but a menu price is already exact, and nothing constrains `price_paisa` to whole rupees. An item priced 95050 displayed **LKR 951**. New `lkrFromPaisa()` renders the decimals when there are any:

```
95050 paisa -> LKR 950.50   (was LKR 951)
95000 paisa -> LKR 950
```

**Counter sales were still being told a table is released.** The heading and the first clause had been made label-agnostic; `"releases the table"` one line below and both **Close table** buttons had not. Verified on a live counter sale and a live table order:

```
counter sale : Type: Counter sale · "Close order" · no "releases the table"
table order  : Zone: <name>      · "Close table"
```

**Layout.** Only the grid scrolls now — the search field and chips are `shrink-0`. Two things were broken by the page growing with the menu: the field the design calls the primary navigation path scrolled off after about two rows, and "Close table" ended up beneath every dish on a 100+ item menu.

**No dead buttons.** Every card shipped a greyed 80px "Add to order" whose `aria-label` still promised the action, with `disabled` removing them all from the tab order — the whole menu keyboard-inert. `action-strip-chrome.tsx` states the opposite doctrine in the same changeset: *"NO buttons at all, never disabled ones."* Now there is no control until Story 4.4 passes `onAdd`, and an unavailable item gets a plain badge.

**Also fixed:** empty categories were dropped in the default view — the one place the comment said they survive, and the reason `/api/menu` pays for a LEFT JOIN; every failure reported as a network problem, with 401 now split out and the server's own wording surfaced, plus a stale-menu banner for failures after the first success (previously invisible); a stale category filter that emptied the menu with no chip pressed; empty-state messages that blamed the search term when a chip was narrowing it, and said "this category" when none was selected; a long search string echoed verbatim; a broken or whitespace image URL leaving a blank box, now falling back to the icon tile via `onError`; `menuCategoryIcon` resolved once per item instead of once per category; and Task 5's `menu-category-chips.tsx`, which was never extracted.

**Not verified — the browser.** Everything behind the client query still: the grid, the fallback tiles, the desaturated unavailable card, and the new scroll behaviour. The API and the served shell are verified above.

### Completion Notes List

- **`production_destination` did not exist.** FR9 routes to Kitchen / Pizza Kitchen / Bar, AC-5 requires the API to return it, Story 4.5 branches on it — and the column was simply absent. `ticket_output_mode` is `print | kds`, a different fact. Added as its own enum rather than reusing `station_type`, which types a station's printer configuration and still lacks `pizza_kitchen`; conflating them is how a pizza KOT ends up printing at the bar. The `station_type` gap is logged for Epic 5 and Epic 10 to reconcile.
- **The epic's event name was corrected in six places, not worked around.** Story 4.2 writes the listener and Epic 8 writes the emitter; two spellings would produce no error and no log, and an out-of-stock item that stays orderable on every tablet but one. Fixing the plan was cheaper than leaving a trap for whoever builds 8-2.
- **Category chips, not section headers.** The UX spec is explicit that search leads and browse is the fallback, the floor screen already teaches the chip idiom, and an accordion of 100+ items is what the spec argues against. AC-2's real requirement — no navigation, one tap back to the full list — is preserved and was restated in those terms when the story was written.
- **Filtering never touches the network.** The whole menu arrives once; every keystroke filters in memory via `useMemo`. A request per keystroke on a tablet while a guest waits is how staff learn to write orders on paper instead.
- **Unavailable items are disabled, not hidden**, at both layers — the API returns them and the UI greys and strikes them.
- **Every add button is disabled for now**, including available items. Staging is Story 4.4; a tappable button that does nothing is the dead "Switch user" control this project has already shipped once.
- **Search is substring, not fuzzy.** FR7 asks for name or category; AC-3 specifies case-insensitive substring. The UX spec's fuzzy matching against kitchen aliases needs a column that does not exist and has no requirement — logged rather than built, alongside Quick Items and the Recents strip.

### File List

**New**
- `src/components/pos/menu-item-card.tsx`
- `src/server/db/migrations/0010_gray_crusher_hogan.sql`
- `src/server/db/migrations/meta/0010_snapshot.json`
- `src/app/api/menu/route.ts`
- `src/components/pos/menu-browser.tsx`
- `src/server/db/migrations/0009_milky_rocket_racer.sql`
- `src/server/db/migrations/meta/0009_snapshot.json`

**Modified**
- `src/server/db/schema.ts` — `productionDestinationEnum`; `menu_items.production_destination`; `pricePaysa` → `pricePaisa`
- `src/server/db/migrations/meta/_journal.json` — 0009 entry
- `src/server/auth/permissions.ts` — `/api/menu` policy, added before the route
- `src/server/socket/events.ts` — `emitMenuItemUpdated` / `menu:item_updated`
- `src/server/db/seed.ts` — `SEED_MENU`: 4 categories, 13 items, all three destinations, one unavailable
- `src/components/pos/order-screen.tsx` — the menu replaces the Epic 4 placeholder
- `src/lib/design.ts` — `menuCategoryIcon()`, same shape as `zoneIcon`
- `src/components/pos/menu-browser.tsx` — card grid; socket, filtering and error handling corrected in review
- `src/components/pos/menu-category-chips.tsx` — **NEW**, Task 5's sibling component
- `src/lib/format.ts` — `lkrFromPaisa()`
- `_bmad-output/planning-artifacts/epics.md` — `menu:itemUpdated` → `menu:item_updated` in six places, with a note

### Change Log

- 2026-09-11: Story created. Three decisions recorded: `production_destination` does not exist in the schema and this story must add it (FR9 and Story 4.5 both depend on it, and `ticket_output_mode` is a different concept); the socket event is `menu:item_updated`, not the epic's `menu:itemUpdated`, with the epic corrected in all six places so Epic 8's emitter cannot diverge from this story's listener; and the UX spec's category chips win over the epic's section headers, with AC-2 restated in terms of the requirement it actually protects. Two ACs added beyond the epic: AC-7 (seed a menu — the database holds zero categories and zero items, so nothing here is otherwise verifiable) and AC-8 (`/api/menu` is default-allow until policed). Three UX-spec features — Quick Items, Recents and fuzzy alias matching — recorded as explicitly out of scope, having no FR and no AC.
- 2026-09-11: Implemented, Tasks 1-7. Added the `production_destination` enum and column that FR9 requires and the schema lacked, unblocking Stories 4.4 and 4.5. Corrected `menu:itemUpdated` to `menu:item_updated` in the codebase and in all six places in epics.md, so Epic 8's emitter cannot diverge from this story's listener — the same correction made for `table:statusChanged` on 2026-08-21. Seeded a real menu; the database previously held zero categories and zero items, making every AC unverifiable. `/api/menu` verified at 28-42ms with the exact contract AC-5 names, unavailable items included, and kitchen staff refused. Browser pass outstanding for everything that renders after the client query resolves.
- 2026-09-12: AC-9 added and the menu redesigned at Teran's request — card grid with dish images and icon category filters, from a reference design he supplied. This **reverses `ux-design-specification.md:411`**, which ruled product images out as a SaaS constraint; the constraint is respected by making the column optional and the category-icon tile a designed fallback rather than an error state, so a restaurant that photographs nothing still gets a coherent menu. Two elements of the reference were deliberately not built: quantity steppers (staging is Story 4.4, and a stepper now would be a dead control) and discount / Veg-Non-Veg badges (no requirement, no column, no AC). Status returned to `in-progress`.
- 2026-09-12: Menu rebuilt as a card grid with dish images and icon category filters (Tasks 8-9), from Teran's reference design. Migration 0010 adds a nullable `image_url`; the seed leaves it null and the category-icon tile is the designed fallback, which is how the redesign coexists with `ux:411`'s reasoning that most restaurants will never photograph their menu. Both rendering paths verified through the API. Quantity steppers and discount / Veg badges from the reference were deliberately not built — the first belongs to Story 4.4, the others have no requirement. Status returned to `review`.
- 2026-09-12: Code review (3 layers). 17 patches, 7 deferred. The menu dropped socket patches on an empty cache — the defect `table-grid.tsx` already fixed and documents — and wrote `portionCount: undefined` from a payload the epic never specified carrying it, so Task 4's name correction was extended to the shape at both ends. Menu prices now render sub-rupee amounts honestly rather than rounding 950.50 up to 951. Counter sales no longer claim a table is released. The grid scrolls inside itself so the search field stays put and Close table stays reachable. Dead disabled add buttons removed entirely, per the doctrine the same changeset states. Task 5's `menu-category-chips.tsx` extracted as originally specified. Status moved to `done`.
