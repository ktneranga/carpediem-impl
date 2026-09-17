# Story 4.4: Implement Add Item to Order with Modifiers & Seat Assignment

Status: done

- **Epic:** 4 — Order Entry & Multi-Destination Routing
- **Story ID:** 4.4
- **Requirements:** FR7 (partial — the tap target), FR8, FR11, FR13
- **Depends on:** 4.1 (`OrderActionStrip`), 4.2 (`MenuBrowser`, which left an `onAdd` seam open for exactly this), 4.3 (`seat_slots` and the chip row)
- **Blocks:** 4.5 writes every staged item as an `order_event`. **Two columns it needs do not exist** — see Decision 1 and Decision 2.

---

## Story

**As a** waiter,
**I want** to add menu items to the current order round with optional modifiers and seat assignment,
**so that** the kitchen and bar receive exactly what each guest wants, attributed to the right seat.

---

## Acceptance Criteria

**AC-1: One tap stages an item**
**Given** a waiter taps an available menu item card
**When** the tap is registered
**Then** the item is staged in the current round against the **currently active seat**, and appears in the staged list immediately — **no sheet, no prompt, no confirmation**

**AC-2: Modifier entry is reachable in two taps**
**Given** a waiter wants to add "no ice" or "extra spicy"
**When** they use the card's modifier affordance
**Then** a bottom sheet opens (tap 1) and **Add to Order** commits (tap 2) — **2 taps total from the item list**, satisfying NFR-P6. The modifier text is stored on the staged item and shown in the staged list beside the item name

**AC-3: No modifier is the fast path and is never blocked**
**Given** a waiter stages an item without opening the sheet
**When** they add it
**Then** it is staged with an empty modifier field; nothing prompts, nothing blocks, and the staged list updates at once

**AC-4: Items land on the active seat**
**Given** the session has more than one seat
**When** a waiter stages an item
**Then** it is assigned to whichever seat chip is active; changing the active chip first sends **subsequent** items to the new seat and does not move items already staged

**AC-5: Removing a staged item writes nothing**
**Given** a waiter taps Remove on a staged item
**When** the action completes
**Then** it leaves the staged round and the list updates immediately. **No database write occurs for staged items** — they exist only on this device until submission

**AC-6: Add More Items opens a new round over read-only history**
**Given** a submitted round already exists on this session
**When** the waiter taps **Add More Items** on the `OrderActionStrip`
**Then** a new empty round opens; previously submitted items render **above** the staging area as read-only history grouped by round; the strip moves to `"items-added"` as soon as the first item is staged

**AC-7: A staged item on a vanished seat blocks submission**
**Given** an item is staged against a seat that no longer exists — removed here, or on the other tablet
**When** the waiter attempts to submit
**Then** submission is blocked with an inline error naming the seat, and **no order event is written**. The waiter can reassign the item to a live seat from the same screen

**AC-8: `order_events.round_number` exists** *(added beyond the epic — schema)*
**Given** the schema
**When** Story 4.5 writes an order event
**Then** there is a `round_number` column to write to, and this story's history view groups by it. See Decision 1 — it does not exist today, and four separate places already depend on it

**AC-9: Modifier text has its own column** *(added beyond the epic — schema)*
**Given** an `ITEM_ADDED` event carries "extra spicy" and a `TABLE_MERGED` event carries "B1 + B3"
**When** both are read back
**Then** they are in **different columns**. `notes` is already the audit description for session-level events; modifier text is item data. See Decision 2

**AC-10: An unavailable item cannot be staged** *(added beyond the epic — FR13)*
**Given** an item is marked unavailable, or is 86'd on another device while the menu is open
**When** the waiter taps it
**Then** it does not stage. An item that goes unavailable **after** it was staged is flagged in the staged list and blocks submission the same way AC-7 does — FR13 says the system prevents ordering unavailable items, and the epic only checks this at submission (4.5), which is one tap too late to be kind

**AC-11: The staged round survives a reload** *(added beyond the epic — see Trap 1)*
**Given** a waiter has staged six items and the tablet reloads, sleeps, or the browser is killed
**When** the order screen comes back
**Then** the staged round is still there. Staged items are **still not written to the database** (AC-5 holds) — they are restored from this device's own storage, scoped to this session

---

## Tasks / Subtasks

- [x] **Task 1 — Schema: rounds and modifier text** (AC: 8, 9) — **do this first; 4.5 is blocked on it**
  - `src/server/db/schema.ts`, `orderEvents`:
    ```ts
    /**
     * Which round of this session's ordering the item belongs to.
     *
     * 1 for the first submission, 2 for "Add More Items", and so on. Session-
     * level audit rows (SESSION_OPENED, TABLE_MERGED…) belong to no round and
     * leave it null.
     */
    roundNumber:  integer('round_number'),
    /** "no ice", "extra spicy". Item data — NOT `notes`, which is audit prose. */
    modifierText: text('modifier_text'),
    ```
  - Nullable, **not** `notNull().default(1)`. A default would silently put every existing audit row in "Round 1", and Epic 7's dispute timeline reads these rows — a merge event dated to a round that never contained it is a fabricated fact in an append-only table.
  - Index `(session_id, round_number)`: the history view groups by exactly that, and it is the query 4.5, Epic 5's KOT header and Epic 7's timeline all make.
  - **Write the derivation rule into the schema comment so 4.5 cannot invent a different one:** the next round is `max(round_number) + 1` for the session, derived **inside** the submit transaction under a `FOR UPDATE` on the session row. Two waiters submitting at once is AC-4 of Story 4.5 and it is the same race the seat labels had — 4.3's fix (`lockOpenSession`) is already exported and serialises it.
  - **⚠️ MIGRATION JOURNAL.** After `pnpm db:generate`, confirm the new `when` exceeds 0013's. It has silently skipped an out-of-order migration **three times** on this project. 4.3 also learned that `drizzle-kit generate` needs a TTY when a change is ambiguous — two additive columns are not, so this should generate clean.

- [x] **Task 2 — The staged round: one client-side model** (AC: 1, 3, 4, 5, 11)
  - `src/components/pos/use-staged-round.ts` — a hook owning the staged array, because `order-screen.tsx` is already carrying seats, three mutations, an editor and the close flow, and staging is the biggest thing yet to land in it.
  - A staged line is `{ lineId, menuItemId, name, pricePaisa, quantity, modifierText, seatSlotId, productionDestination }`. **Denormalise the name and price onto the line**: the staged list must render correctly even if the menu refetches and the item is 86'd underneath it, and 4.5 needs `unit_price_paisa` at submission — reading it back from a menu that has since changed would write the wrong number into an append-only table.
  - `lineId` is a client-generated `crypto.randomUUID()`, never the menu item id. Two "Grilled Fish" on different seats — or the same seat with different modifiers — are different lines.
  - **Adding never merges lines.** Tapping the same item twice gives two lines, each removable. Quantity is for "3 × Lion Lager" typed deliberately in the sheet, not an accumulator that makes a mis-tap hard to undo.
  - **AC-11 persistence:** mirror the array to `localStorage` under `cdrms:staged:<sessionId>`. Restore on mount, and **clear it on successful submission** (4.5 will call the clear). Wrap every read and write in try/catch — a tablet in private mode or with storage full must degrade to in-memory, not crash the order screen.
  - Restoring is **not** an effect that sets state: seed `useState` with a lazy initialiser (`useState(() => readStaged(sessionId))`). The React Compiler lint has rejected `setState`-in-effect twice on this project, and 4.3's review flagged a third.

- [x] **Task 3 — The tap path and the modifier sheet** (AC: 1, 2, 3, 10)
  - `MenuBrowser` currently takes **no props** and renders `MenuItemCard` with **no `onAdd`** — 4.2 left the seam open and commented it ("Until Story 4.4 passes `onAdd` there is no control"). Thread `onAdd` and `onOpenModifiers` through `MenuBrowser` to the card. Do not reach around it.
  - **Card body tap = stage immediately** (AC-1, one tap). A **separate small affordance** on the card opens the sheet (AC-2, two taps).
  - This resolves a real conflict: `ux:427` says "tapping an item with modifiers opens a bottom sheet", but **no item has modifiers** — there is no modifier table and this story is not adding one (Decision 3). If every tap opened a sheet, the no-modifier path would cost two taps and AC-3's "nothing blocks the flow" would be false. One tap adds; the affordance is the way in for the minority case.
  - `src/components/pos/modifier-sheet.tsx` — bottom sheet, not a page (`ux:309`, "no context break"). Free-text modifier input, a quantity stepper (`ux:427`, "always visible"), the item name and the target seat stated on it, and **Add to Order** as the full-width commit. Reuse `commitButtonClass` from `action-strip-chrome.tsx`.
  - The sheet is a `<dialog>` or a focus-trapped overlay — **it must be dismissible without adding**, and Escape must not stage an item.
  - **AC-10:** an unavailable card does not stage and does not open the sheet. The card already renders the badge, the grayscale and the line-through; it just must not become tappable when `available` is false. **Do not render a disabled button** — 4.2's review established that a disabled control invites a tap and teaches nothing, and that `disabled` on every card made the whole menu keyboard-inert.

- [x] **Task 4 — The staged list and the round history** (AC: 2, 4, 5, 6, 7, 10)
  - `src/components/pos/staged-round-list.tsx` — the current round, grouped by seat, each line showing name, quantity, modifier text and price, with a Remove control per line.
  - Grouped **by seat**, in the seat row's own order, so the list reads the way the table looks. A seat with nothing staged does not appear.
  - `src/components/pos/round-history.tsx` — submitted rounds above the staging area, **read-only**, headed `Round 1`, `Round 2`. No Remove, no edit: those rows are in an append-only table and Epic 7 owns corrections.
  - History comes from a new `GET /api/sessions/:sessionId/orders` returning submitted items grouped by round. Seed it from the page's server query the way 4.3 did with seats — the same `initialData` + `staleTime` shape, so the first paint has the history and a refetch can update it.
  - **AC-7 and AC-10 flags:** a staged line whose `seatSlotId` is no longer in the live seat list, or whose item has gone unavailable, renders with an inline error and a way to fix it — reassign to a live seat, or remove. 4.3's review turned on `refetchOnWindowFocus` for seats, so a seat **can now disappear under a staged line** while the screen is open. This is not theoretical.
  - Compute both flags as **derived values** from the staged array and the live seats/menu queries. Not state, not an effect.

- [x] **Task 5 — Wire the strip and the rounds** (AC: 1, 6)
  - `OrderActionStrip` already takes `state`, `stagedCount`, `onSubmitOrder`, `onClear`, `onAddMoreItems`. It is **pure presentation and must stay that way** — it survived three reviews intact because it owns no data. Pass real values; do not move logic into it.
  - `state` becomes: `stagedCount > 0` → `'items-added'`; no staged items and no submitted rounds → `'empty'`; no staged items **with** submitted rounds → `'submitted'`. `order-screen.tsx` currently hardcodes `itemCount > 0 ? 'items-added' : 'empty'` and passes no `stagedCount` — both are placeholders left by 4.1 with a comment saying so.
  - `onAddMoreItems` opens an empty staging area under the existing history. It writes nothing: the round number is only decided at submission (Task 1), so "opening round 2" is purely a client-side state change.
  - `onClear` empties the staged round — and must clear the `localStorage` mirror with it.
  - `onSubmitOrder` stays **unwired** in this story. 4.5 owns the write. Leave the callback undefined rather than passing a no-op, so the strip renders honestly.

- [x] **Task 6 — Verify** (AC: all)
  - No test framework; manual, as every prior story. Matrix in Dev Notes.
  - **The stale-seat test is not optional** (AC-7) — it is now reachable in normal use, and it is the only guard standing between a staged item and a foreign-key violation at submission.


### Review Findings (code review, 2026-09-16)

Three layers: Blind Hunter (diff only), Edge Case Hunter (diff + project), Acceptance Auditor (diff + spec + tokens). Scope: Story 4.4 plus both redesign passes, 19 files.

**Decisions needed**

- [x] [Review][Decision] **RESOLVED — count the selected seat only (Teran, 2026-09-16), applied.** Teran's reason: when one table orders separately, a whole-round count is confusing. Original finding: **The card badge and "Add another" count the whole round, not the selected seat** — `stagedCountByItem` sums every seat. At a table of six with Seat 4 selected, the fish shows "3 · Add another" because seats 1–3 ordered it, and the waiter reasonably reads that as "already down for this person" — while the header says SEAT 4 SELECTED. Options: (a) count for the selected seat only, which makes the duplicate-tap guard true for the person being served; (b) keep the round total, which matches the mockup's intent of "this dish is in the round". [`order-screen.tsx` `stagedCountByItem`, `menu-item-card.tsx`]

**Patches**

- [x] [Review][Patch] **The staged-round restore causes a hydration mismatch** — `useState(() => readStaged(sessionId))` returns `[]` on the server (no `window`) and the stored lines on the client's first render, so the staged list, seat counts, card badges, totals and bar all differ between server HTML and hydration. The hook's comment presents the lazy initialiser as the fix for "one frame of wrong UI"; it produces a hydration error instead. [`use-staged-round.ts`]
- [x] [Review][Patch] **The 86'd-while-staged flag never fires on the live event** — `queryClient.getQueryData(MENU_QUERY_KEY)` is an unsubscribed read. The socket handler updates the menu cache and re-renders `MenuBrowser`, not `OrderScreen`, so the staged line stays healthy-looking. On first paint the cache is usually empty, so the check is inert exactly when the screen opens. The comment above the loop claims the opposite. (AC-10) [`order-screen.tsx`]
- [x] [Review][Patch] **A staged dish that was deleted from the menu is never flagged** — only `known && !known.available` sets a problem; a missing item is treated as "no knowledge", yet it hits the same foreign key at submission that the seat check exists to prevent. [`order-screen.tsx` `stagedProblems`]
- [x] [Review][Patch] **Every staged-round mutator reads `lines` from the render closure** — `commit([...lines, …])` instead of a functional update, so two handlers in one batch lose one of the writes, and the mirror persists the loss. [`use-staged-round.ts`]
- [x] [Review][Patch] **`crypto.randomUUID()` does not exist outside a secure context** — a tablet on `http://192.168.x.x` throws on every Add tap and stages nothing. [`use-staged-round.ts:148`]
- [x] [Review][Patch] **The staged round follows the component, not the session** — `OrderScreen` has no `key`, so a direct route change between two sessions keeps table A's lines on table B, and the next commit writes them under B's key; the seat-gone repair then offers to move A's items onto B's seats. [`orders/[sessionId]/page.tsx`]
- [x] [Review][Patch] **A session closed elsewhere reaches the QUERY path and shows as "Could not refresh the seats"** — `seatRequest` is also the seats and orders `queryFn`, and focus refetch is on. The terminal `SessionGoneError` handling exists only on the mutation path, which is the exact defect its own comment says was fixed. The orders query's errors are not surfaced at all. [`order-screen.tsx`]
- [x] [Review][Patch] **AC-7's inline error cannot name the seat** — the line carries only `seatSlotId`, so a vanished seat renders as "Seat removed" with an unnamed error. Trap 2's own scenario ("Seat 3 (red shirt)") is the one it fails. Capture the seat's label on the line at stage time, as the price is. [`use-staged-round.ts`, `staged-round-list.tsx`]
- [x] [Review][Patch] **The modifier sheet's seat can change under it** — it reads `activeSeat` live, so a focus refetch that removes the selected seat renames the open sheet to another guest and stages the dish onto them. Capture the seat when the sheet opens; close it if that seat disappears. [`order-screen.tsx`]
- [x] [Review][Patch] **"Opts" is a dead control when there is no active seat** — `setSheetItem` runs but the sheet renders only with `activeSeat`; `Add` shows a notice in the same state, `Opts` does nothing. [`order-screen.tsx`]
- [x] [Review][Patch] **`addingMore` is a one-way latch** — set by Add More Items and never cleared, so the strip can never return to `submitted` (and so never offer Add More Items again) without a reload. The strip comment also describes three facts where the code uses four. [`order-screen.tsx`]
- [x] [Review][Patch] **The modifier sheet is not a `<dialog>` and not focus-trapped** — `aria-modal` with nothing behind it made inert, Tab walks into the menu, Escape stops working once focus leaves, focus is not restored, and a drag that starts in the note field and ends on the scrim cancels the sheet. Task 3 required one or the other. [`modifier-sheet.tsx`]
- [x] [Review][Patch] **The redesign dropped controls below the system's 56px touch floor** — `globals.css` calls the touch tokens non-negotiable and the strip chrome names 56px as the floor for every waiter control. Now: chips 48px, header back 48px, stepper 44px, and nine note/close/walkout/reassign buttons at 48px — while the sheet kept the tokens. Use the tokens. [`menu-category-chips.tsx`, `order-header.tsx`, `staged-round-list.tsx`, `order-screen.tsx`, `menu-item-card.tsx`]
- [x] [Review][Patch] **`text-slate-400` fails AA for load-bearing text** — 2.56:1 on white, 2.34:1 on `slate-100`. Used for an unavailable dish's name and price, the "Unavailable" footer word (which replaced a 6.54:1 red band and is the ONLY text carrying the state), the chip counts, the seat counts and the history's modifier text. `text-white/70` on `brand-700` is 3.85:1. [`menu-item-card.tsx`, `menu-category-chips.tsx`, `seat-selector.tsx`, `round-history.tsx`]
- [x] [Review][Patch] **Four more comments describe what the code does not do** — (a) the seats query defers a socket event "to Story 4.4", which is this story; (b) the strip comment lists three facts, the code uses four; (c) the card header says the eyebrow is "Kitchen blue" when kitchen ink is `brand-700`; (d) `pr-sp-6` (32px) is said to keep the name clear of a badge that occupies 44px. [`order-screen.tsx`, `menu-item-card.tsx`]
- [x] [Review][Patch] **The File List omits 7 of 19 files** — `globals.css`, `design.ts`, `order-header.tsx`, `order-summary.tsx`, `seat-selector.tsx`, `menu-category-chips.tsx`, and the deleted `seat-chip-row.tsx`. The verification table's "eslint clean" was `--quiet`, which hides warnings. [this file]
- [x] [Review][Patch] **`readStaged`'s type guard asserts a shape it does not check** — `productionDestination` is never validated, and `quantity`/`pricePaisa` accept `NaN`, `0`, negatives and fractions, so corrupt storage renders "LKR NaN" or a bar that names the wrong kitchens. [`use-staged-round.ts`]
- [x] [Review][Patch] **A failed mirror write leaves a stale round to be restored** — when `setItem` throws, the previous value stays in storage and a reload restores it as if it were the whole round. Remove the key when a write fails. [`use-staged-round.ts`]
- [x] [Review][Patch] **A closed session's mirror is never removed** — `clear()` is the only remover and the close flow never calls it, so every closed table leaves a `cdrms:staged:<uuid>` behind on a shared tablet. [`order-screen.tsx`]
- [x] [Review][Patch] **Clear destroys a whole round with one tap** — nothing is in the database, so nothing can bring it back. Confirm first. [`order-screen.tsx`]
- [x] [Review][Patch] **A tall seat section can squeeze the round to nothing** — it is `shrink-0`; eight seats plus the note editor and removal confirmation push the staged list to zero height and the total off-screen. Cap it and let it scroll. [`order-screen.tsx`]
- [x] [Review][Patch] **Pre-0014 rows sort after round 1** — `ORDER BY round_number` puts NULLs last while the code buckets them into round 1, so older items appear at the end of the round. Order by `coalesce(round_number, 1)`. [`orders/route.ts`, `page.tsx`]
- [x] [Review][Patch] **"The compiler says so if they drift" is false** — sharing the row TYPE does not share the grouping, the NULL bucketing or the fallback name, which are duplicated in the page and the route. Extract one function. [`page.tsx`, `orders/route.ts`]
- [x] [Review][Patch] **`GET .../orders` answers 200 `[]` for a session that does not exist** — indistinguishable from "no items". Return 404. [`orders/route.ts`]
- [x] [Review][Patch] **Two hydration hazards in rendered times and three dead props** — `clockTime(sentAt)` formats in the server's timezone during SSR; `restaurantName`, `capacity` and `coverCount` are unused since the facts card went, which also dropped covers from the screen entirely. Put covers back in the header line. [`round-history.tsx`, `order-screen.tsx`, `page.tsx`]
- [x] [Review][Patch] **Small accessibility gaps** — the count badge is an `aria-label` on a bare `<span>`, which is not reliably exposed; the lower-bound `+` is explained only by a `title` tooltip, invisible on touch and to screen readers. [`menu-item-card.tsx`, `round-history.tsx`]
- [x] [Review][Patch] **Chip counts include 86'd dishes** — "PIZZA 2" when both pizzas are off gives the opposite signal the count exists for. Count what is orderable. [`menu-browser.tsx`]
- [x] [Review][Patch] **Standalone `MenuItemCard` labels available dishes "Unavailable"** — the footer branch is `canOrder` (available AND handler), not `item.available`. [`menu-item-card.tsx`]
- [x] [Review][Patch] **Token and lint tidy-ups** — `rounded-full` where the token is `rounded-pill`; an unnecessary `jsx-a11y/no-autofocus` disable. [`menu-category-chips.tsx`, `modifier-sheet.tsx`]

**Deferred** (real, not for this story — also logged in `deferred-work.md`)

- [x] [Review][Defer] **Two tabs on one device overwrite each other's staged round** [`use-staged-round.ts`] — deferred, needs a `storage` listener and a merge rule
- [x] [Review][Defer] **Below `md` the columns do not scroll independently** [`order-screen.tsx`] — deferred, tablets are the target; phone layout is its own design question
- [x] [Review][Defer] **`display: contents` on the seat group may drop its role in some screen readers** [`seat-selector.tsx`] — deferred, pre-existing from 4.3
- [x] [Review][Defer] **No per-session authorisation on the orders GET** [`orders/route.ts`] — deferred, pre-existing across every `/api/sessions` route
- [x] [Review][Defer] **Old `cdrms:staged:*` keys are never pruned beyond close** [`use-staged-round.ts`] — deferred, close now clears its own key
- [x] [Review][Defer] **`menuCategoryIcon` is exported with no callers** [`src/lib/design.ts`] — deferred, kept deliberately for restoring the card photos

Dismissed (5): the tax rate arriving as a string (the column is `integer`); the deleted menu wrapper (MenuBrowser's own root still carries `min-h-0 flex-1`); the staged list being a flat list rather than grouped under seat headings (superseded by Teran's 2026-09-16 mockup, which shows a flat list with a seat label per line); the modifier rendering below rather than beside the name (same); `h-1.5`/`size-8`/`w-20` being "off-system" (Tailwind's default spacing is used for non-touch geometry throughout this codebase).

---

## Dev Notes

### 🚨 Decision 1 — `round_number` does not exist, and four things already depend on it

The column is absent from `order_events`. Every one of these is already written down as depending on it:

| Where | What it needs |
|---|---|
| **This story, AC-6** | history grouped by round, headed "Round 1", "Round 2" |
| `epics.md:1398` (Story 4.5) | every `order_event` row carries `round_number` |
| `ux:455` (Epic 5) | kitchen ticket header `Table 7 · Round 2` |
| `ux:101`, `ux:66` (Epic 7) | the dispute view — "Item ordered at 7:42pm · Round 2 · Assigned to you" |

This was logged in `deferred-work.md` during Story 4.3 as a known gap for whoever got here first. That is this story: 4.4 has to **read** rounds to render the history, even though 4.5 **writes** them. Same split as 4.3, which added `seat_slots` for 4.4 and 4.5 to use.

**Nullable, not defaulted.** `order_events` already holds session-level audit rows, and `notNull().default(1)` would stamp every one of them as belonging to round 1. Epic 7 renders these rows to a customer during a dispute. A merge event that claims to be part of a round nobody ordered in is a fabricated fact, and the table is append-only — it cannot be corrected afterwards.

### 🚨 Decision 2 — `notes` is already taken, so modifier text needs its own column

`epics.md:1398` calls the field `modifier_text`. Story 4.3's notes suggested `notes` might serve. **It cannot** — `notes` is in active use as the audit description for session-level events:

```ts
notes: additionalTableLabels.join(' + ')   // "B1 + B3"   (TABLE_MERGED)
notes: reason                              // "walkout"   (SESSION_CLOSED)
notes: tableLabel                          // "B2"        (TABLE_UNMERGED)
```

Putting "extra spicy" in that column means one column carries two unrelated meanings, discriminated only by `event_type`. Epic 7's timeline reads both kinds of row in one query and renders them side by side to a customer. Add `modifier_text` and leave `notes` alone.

### 🚨 Decision 3 — free text now; the structured modifiers in the UX spec are not this story

The UX spec describes something richer than the epic does:

- `ux:427` — "Modifier groups displayed as chip selectors (e.g., 'Spice: Mild / Medium / Hot'). Required modifiers highlighted first, optional below."
- `ux:59-60` — "Pre-set modifier shortcuts per item category… each waiter pins their own most-used modifiers."

**FR8 asks only for "modifiers or special instructions"**, the epic's AC gives free-text examples ("no ice", "extra spicy"), and **no modifier table exists anywhere in the schema**. Structured modifier groups need a `modifier_groups` / `modifier_options` model, a per-item association, and an admin surface to configure them — none of which has an FR or an epic AC.

This is the same shape as Quick Items and Recents, both logged during 4.2: **in the mockups, in no requirement document.** Build free text; log the structured model against Epic 10 (menu management) so it arrives as a decision rather than as a developer's initiative mid-story. Per-waiter modifier shortcuts additionally need per-staff storage, which does not exist either.

### 🚨 Trap 1 — "no database write" means a reload loses the round

AC-5 is explicit and correct: staged items must not touch the database. Submission is the commit point, and a half-written round in an append-only table is worse than no round.

But the consequence is that **the staged round lives only in React state on one device**. A tablet that sleeps, a browser that is killed, an accidental back-navigation, or Turbopack reloading in dev — and six items typed at a table of six are gone, with the waiter standing there.

Hence AC-11 and the `localStorage` mirror. It keeps AC-5 true (nothing reaches the database) while making the round survive the thing that will actually happen on a beach restaurant's shared tablet. Note the trade: `localStorage` is **per device**, so a round staged on tablet A is not recoverable on tablet B. That is the right scope — the round is not real until it is submitted, and two devices restoring the same staged round would produce a double order.

Wrap every storage access in try/catch. Private browsing and a full quota both throw, and neither is a reason for the order screen to fail to render.

### 🚨 Trap 2 — a seat can now vanish under a staged item

AC-7 existed in the epic, but before 4.3 it was hard to reach: the seat list only changed when *this* device changed it. Two things changed that:

1. Story 4.3 added seat **deletion**, and
2. its review turned on `refetchOnWindowFocus` for the seats query, so picking the tablet back up pulls the other device's removals.

So the sequence is now ordinary: waiter A stages three items on "Seat 3 (red shirt)", waiter B removes Seat 3 on the other tablet, waiter A returns to the tablet and the seat list refreshes underneath the staged lines.

If that reaches 4.5's insert, `order_events.seat_slot_id` has a foreign key to `seat_slots` — the database refuses it and the waiter gets a 500 with the whole round rejected. Catch it in the staged list, name the seat, and let them reassign.

Note the flags must be **derived** on every render from the live seats query, not computed once when the item was staged. The point is to notice a change that happens later.

### 🚨 Trap 3 — the price must be captured at stage time, not read at submit time

`unit_price_paisa` goes into an append-only row. If 4.5 reads the price from `menu_items` at submission, an owner who re-prices an item between staging and submitting changes what the guest is charged for something already ordered — and the audit row will claim the new price was the one quoted.

Denormalise `pricePaisa` onto the staged line (Task 2) and submit that. This is the same reasoning that puts `unit_price_paisa` on `order_events` at all rather than joining to the menu.

### Current state of the files this story touches

| File | Today | This story |
|---|---|---|
| `src/server/db/schema.ts` | `orderEvents` has `quantity`, `unitPricePaisa`, `notes`, `seatSlotId`; no round, no modifier column | `roundNumber`, `modifierText`, `(session_id, round_number)` index |
| `src/components/pos/menu-browser.tsx` | takes **no props**; renders `MenuItemCard` with no `onAdd` | threads `onAdd` and `onOpenModifiers` |
| `src/components/pos/menu-item-card.tsx` | `onAdd` optional; renders **no control** when absent; unavailable state already styled | body tap stages; modifier affordance added; unavailable stays untappable |
| `src/components/pos/order-action-strip.tsx` | pure presentation, five states, callbacks all optional | **unchanged** — receives real props |
| `src/components/pos/order-screen.tsx` | seats, three seat mutations, note editor, close flow; strip state **hardcoded** from `itemCount` | staged round, history, sheet; real strip state |
| `src/app/orders/[sessionId]/page.tsx` | loads session, tables, staff, config, item count, seats | also loads submitted rounds |
| `src/app/api/sessions/[sessionId]/orders/route.ts` | — | NEW — `GET` only. `POST` is Story 4.5 |
| `src/components/pos/use-staged-round.ts` | — | NEW |
| `src/components/pos/modifier-sheet.tsx` | — | NEW |
| `src/components/pos/staged-round-list.tsx` | — | NEW |
| `src/components/pos/round-history.tsx` | — | NEW |

**Preserve, do not regress:**

- **Only the menu grid scrolls.** The search field, the category chips and the seat row are all `shrink-0`; the grid is `min-h-0 flex-1 overflow-y-auto`. The staged list and the history are **more** vertical content on an already-full screen — decide deliberately where the scroll boundary goes, and do not let "Close table" end up below every dish again.
- **The counter sale path.** `tableLabel` and `zoneName` are null, the walkout copy branches on `tableLabel`, the info card reads "Type: Counter sale". Ordering must work identically with no table.
- **`brand-700` for active/primary, never `brand-500`** — white on 500 is 3.9:1 and fails AA.
- **`lkrFromPaisa()` for money**, not `lkr()`. Money is integer paisa everywhere.
- **The `OrderActionStrip` owns no data.** It has survived three reviews precisely because of that.
- **Derived values, not effects.** 4.2 and 4.3 both had `setState`-in-effect rejected by the React Compiler lint, and 4.3's review replaced a third instance.
- **A confident comment must match the code beneath it.** Four stories running, the code review has found comments asserting behaviour the code does not have — including two describing a defect as fixed while the same commit reintroduced it. Re-read every comment you write against the lines under it before ticking a task.

### Verification matrix

| Case | Expected |
|---|---|
| Tap an available item | staged instantly on the active seat, **one tap**, no sheet |
| Tap the modifier affordance → Add to Order | **2 taps total**; modifier text on the line and in the list |
| Escape / dismiss the sheet | nothing staged |
| Change the active seat, then stage | new items on the new seat; already-staged lines unmoved |
| Stage the same item twice | two separate removable lines, not a quantity of 2 |
| Remove a staged line | gone from the list; **zero database writes** (check `order_events` count before and after) |
| Reload the tablet mid-round | the staged round is still there (AC-11) |
| Reload with `localStorage` disabled | screen renders; round is lost; nothing throws |
| Tap an unavailable item | nothing stages, no sheet |
| 86 an item on another device while it is staged | the staged line flags; submission is blocked |
| Delete the active seat on the other tablet, refocus this one | the staged lines flag with the seat named; reassign works |
| Counter sale | the whole flow works with no table |
| Merged group B1 + B3 | one staged round for the session, seats shared |
| Kitchen user (Kumar 4321) → `GET .../orders` | **403**, inherited from `/api/sessions`. Verify; do not add a policy |
| `Add More Items` with one submitted round | empty staging area under a read-only "Round 1" |
| Strip state | `empty` → `items-added` on first stage → `submitted` after 4.5 lands |
| Long menu with a full staged round | only the intended region scrolls; the strip stays reachable |

Seed accounts: **Nina 1234 `waiter`**, **Aruna 5678 `owner`**, **Kumar 4321 `kitchen`**.

### Project Structure Notes

- API paths are plural nouns, kebab-case (`architecture.md:367`). `/api/sessions/:sessionId/orders` is the path `epics.md:1395` already names for 4.5's POST; this story adds the GET on the same path.
- Components: kebab-case files, PascalCase exports, in `src/components/pos/`. Hooks in `src/hooks/` — but `use-minute-tick.ts` is the only precedent and it is generic; a staging hook bound to this screen is better placed beside it in `src/components/pos/`. Note the divergence either way.
- `architecture.md` describes no staging model and no round concept, so nothing here contradicts it. It should gain both once this ships.
- RBAC is inherited from `{ prefix: '/api/sessions', roles: ['owner','waiter'] }`. **Verify as Kumar; do not add a policy.**

### References

- [Source: `epics.md` Story 4.4; `:1388-1398` for what 4.5 writes; `:1476` for Epic 5's `order:submitted`]
- [Source: `prd.md` FR7, FR8, FR11, FR13; NFR-P6 at `:515`]
- [Source: `ux-design-specification.md:417`] — the card and its modifier dot
- [Source: `ux-design-specification.md:425-427`] — the bottom sheet, chip groups, quantity stepper
- [Source: `ux-design-specification.md:448-455`] — Flow A, "Add Round", `Table 7 · Round 2`
- [Source: `ux-design-specification.md:59-60`] — per-user modifier shortcuts (deferred, Decision 3)
- [Source: `_bmad-output/implementation-artifacts/4-3-implement-seat-slot-management.md`] — the seat model, `lockOpenSession`, and the review findings this story must not repeat
- [Source: `deferred-work.md`] — `round_number` logged as a known gap during 4.3; Quick Items and Recents as the precedent for Decision 3

---

## Dev Agent Record

### Agent Model Used

claude-opus-5 (Claude Code)

### Debug Log References

- `pnpm db:generate` produced **0014** cleanly — two additive nullable columns and an index are unambiguous, so no TTY prompt (4.3 had to be split into two migrations to avoid one). Journal checked: `0012 …983513 → 0013 …336182 → 0014 …652460`, monotonic.
- `MENU_QUERY_KEY` was file-private in `menu-browser.tsx` and the order screen needs the same cache to tell whether a staged item has been 86'd. **Exported rather than re-declared** — two arrays that must stay equal but are written in two files is the exact coupling 4.3's review flagged on `SEAT_LABEL_INDEX`.
- Two defects found in my own code by re-reading the comments against the lines under them, before any review. Both are the class this project has now hit five stories running. See Completion Notes.
- Items within one round come back in `(created_at, id)` order. `created_at` is TRANSACTION time, so every item in a round submitted together ties and falls back to uuid order — **not** the order the waiter staged them. Stable, which is what matters for a list nobody drags, but Story 4.5 should know it cannot rely on insertion order for the kitchen ticket.

### Completion Notes List

**What shipped**

- `order_events.round_number` and `order_events.modifier_text`, both nullable, plus `idx_order_events_session_round`. The derivation rule for `round_number` (`max + 1`, inside the submit transaction, under `lockOpenSession`'s row lock) is written into the schema comment so 4.5 cannot invent a different one.
- `useStagedRound` — the whole staged round, client-only, mirrored to `localStorage` per session. No database write happens anywhere in this story.
- One tap on a card stages; a second small affordance opens `ModifierSheet` for a note and a quantity. Two taps total for a modifier, one for the common case.
- `StagedRoundList` grouped by seat, `RoundHistory` grouped by round, and a new `GET /api/sessions/:sessionId/orders`.
- The strip's state is now derived from three facts instead of read off the submitted-item count.

**Two defects found in my own code before review**

1. **The strip rendered a dead "Submit Order".** `order-action-strip.tsx` built its commit button unconditionally with `onClick={onSubmitOrder}`, and `disabled` only checked `busy || stagedCount === 0`. So leaving the handler undefined — which this story does, since 4.5 owns submission — produced a fully enabled button that silently did nothing on tap. My comment in `order-screen.tsx` claimed the opposite: that undefined "makes the strip render honestly" as against a no-op. Undefined *was* the no-op. The strip now renders no commit at all without a handler, which is what its own header has always said it should do.
2. **The round total contradicted its own comment.** `round-history.tsx` said "counting [a null price] as zero would understate a total the waiter may read out loud" directly above `(item.unitPricePaisa ?? 0)`, which counts it as zero. The total is now marked as a lower bound with a `+` when any line is unpriced, and the comment says what the code does.

Both are the same defect class the 4.3 review found four times. Finding them by re-reading my own comments against the code — before a reviewer did — is the practice that story's review recommended.

**Deliberate divergences**

- **The one-tap target is the existing "Add to order" button, not the card body.** The story said "card body tap stages". 4.2 had already shipped an 80px button on the card for exactly this, gated on `onAdd`. Using it keeps the keyboard and screen-reader semantics that a clickable `<article>` would throw away, and it is still one tap. The modifier affordance sits beside it.
- **`MenuBrowser` hands back the whole `MenuItemRow`, not an id.** The browser owns the menu query; a caller resolving ids against a list it does not own could find a different price from the card the waiter actually tapped.
- **`PATCH` was also given the session-open check** that 4.3's review added to POST and DELETE. Not in this story's tasks; it was one line and the inconsistency was the kind that review had just finished removing.
- **The history duplicates its shaping between the page and the GET route.** The page is a server component with direct database access, and routing its own process through HTTP would add a round trip to every page load. `SubmittedRoundRow` is imported from the route so the compiler complains if they drift.

**Verification results** (dev server, seeded data, Nina 1234 / Kumar 4321)

| Case | Result |
|---|---|
| Migration 0014 | ✅ applied; `modifier_text`, `round_number`, `idx_order_events_session_round` present; journal monotonic |
| Nothing backfilled | ✅ `select count(*) where round_number is not null` → 0 |
| `GET .../orders`, empty session | ✅ `200 []` |
| `GET .../orders`, two rounds | ✅ grouped correctly; Round 1 two items (LKR 2,400), Round 2 one (LKR 450) |
| Modifier text round-trips | ✅ "extra spicy" and "no ice" on the right lines |
| Seat label on history | ✅ per item |
| Price read from the EVENT, not the menu | ✅ `unit_price_paisa` selected from `order_events`; no join to `menu_items` for price |
| Item deleted from the menu | ✅ LEFT join — the row survives as "Item no longer on the menu" |
| Unpriced line | ✅ renders `—`; the round total shows `LKR 450 +` as a lower bound |
| Kumar (kitchen) → `GET .../orders` | ✅ **403**, inherited; no policy added |
| Unauthenticated | ✅ 401 |
| Server-rendered history | ✅ "Round 1 · sent 12:34 pm · LKR 2,400 · 2× Butter Prawns · Seat 2 …" in the first paint |
| Strip state with rounds sent, nothing staged | ✅ `submitted` — "Add More Items" rendered |
| `tsc --noEmit` / `eslint --quiet` | ✅ both clean |

**NOT verified — and this is the significant gap**

Everything above is API responses and server-rendered HTML. **The staging interactions have never run in a browser.** The menu is client-rendered, so `curl` sees only its loading state, and no browser automation is installed — adding Playwright would be a new dependency, which this workflow requires approval for.

Unverified by machine, therefore: **AC-1** (one-tap stage), **AC-2** (two-tap modifier), **AC-3** (no prompt blocks), **AC-4** (items land on the active seat), **AC-5** (remove writes nothing — the *no-write* half is structurally guaranteed, the UI half is not), **AC-7** (the seat-gone flag and its reassign buttons), **AC-10** (unavailable items untappable), **AC-11** (the round survives a reload). These compile and lint; they have not been used.

This is the fourth story in Epic 4 whose UI has never been seen. A browser pass over the whole epic is overdue and is worth more than another story.

### File List

- `src/server/db/schema.ts` — MODIFIED: `orderEvents.modifierText`, `orderEvents.roundNumber`, `idx_order_events_session_round`; `notes` documented as audit-only
- `src/server/db/migrations/0014_bent_viper.sql` — NEW
- `src/server/db/migrations/meta/_journal.json`, `meta/0014_snapshot.json` — MODIFIED / NEW
- `src/server/orders/submitted-rounds.ts` — NEW (review): the one history query and grouping, shared by the page and the route
- `src/app/api/sessions/[sessionId]/orders/route.ts` — NEW: `GET` (POST is 4.5); 404 for an unknown session
- `src/app/orders/[sessionId]/page.tsx` — MODIFIED: loads submitted rounds and the tax rate; keys the screen by session
- `src/app/globals.css` — MODIFIED: `--color-unsent-*` tokens
- `src/lib/design.ts` — MODIFIED: `ROUTES` gains `band`/`ink`/`short`; `routeForDestination()`; `zoneUsesSeats()`
- `src/components/pos/use-staged-round.ts` — NEW: external store over `localStorage`
- `src/components/pos/modifier-sheet.tsx` — NEW: native modal `<dialog>`
- `src/components/pos/staged-round-list.tsx` — NEW
- `src/components/pos/round-history.tsx` — NEW
- `src/components/pos/order-header.tsx` — NEW (redesign)
- `src/components/pos/order-summary.tsx` — NEW (redesign)
- `src/components/pos/seat-selector.tsx` — NEW (redesign), replaces `seat-chip-row.tsx`
- `src/components/pos/seat-chip-row.tsx` — DELETED (redesign)
- `src/components/pos/menu-item-card.tsx` — MODIFIED
- `src/components/pos/menu-browser.tsx` — MODIFIED: callbacks, staged counts, `menuQueryOptions`, orderable-only chip counts
- `src/components/pos/menu-category-chips.tsx` — MODIFIED: counts, tokens
- `src/components/pos/order-action-strip.tsx` — MODIFIED: no button without a handler; bar copy
- `src/components/pos/action-strip-chrome.tsx` — MODIFIED (review): eyebrow contrast (also affects the floor strip)
- `src/components/pos/order-screen.tsx` — MODIFIED
- `_bmad-output/implementation-artifacts/deferred-work.md` — MODIFIED

### Change Log

- 2026-09-16: **Compact unsent lines (Teran's request).** Each staged line went from about 110px to about 60px: the dish name on one line, then seat · note · line total on a small second line, with the stepper beside them. "NOT SENT" became one heading over the list ("NOT SENT · 3 items") instead of an eyebrow on every card; each row keeps the amber unsent tint. The stepper now uses the system's `touch-standard` token (44px, the WCAG target size) instead of the 56px floor the review set, a density trade Teran asked for. The seat-reassign buttons on a problem line keep 56px, because they are the only way out of a blocked round.

- 2026-09-16: **Fixed: seat buttons grew when the pencil was tapped (found by Teran, twice).** Opening the note editor made the height-capped seat section scroll; the scrollbar (about 15px on Windows) narrowed the auto-fill seat grid enough to drop a column, so every seat button widened. The first fix reserved the scrollbar's space permanently, which Teran caught made the buttons permanently wide instead. Reverted; the note editor now sits in its own uncapped block below the seat section, so tapping the pencil never adds a scrollbar and the grid keeps its columns. The seat section can still scroll with enough seats to fill it, which is a change made by adding a seat, not by editing one.
- 2026-09-16: **Seats only in the Tables zone (Teran's decision).** The seat section, the "SEAT 1 SELECTED" header line, the per-line seat labels, the seat names in the history and "For Seat 1" in the modifier sheet now appear only when the order's zone is named "Tables". Bean Bags, Sun Beds, Rooftop and counter sales hide them, and every dish goes to the order's automatic Seat 1, so attribution in `order_events` is unchanged. The seat section still appears if an order has no seat at all, so it can always be repaired. The rule is `zoneUsesSeats()` in `src/lib/design.ts`, keyed on the zone name like the zone icons. This reverses Story 4.3's Decision 2 for counter sales. Verified on the running server with one order of each kind.

- 2026-09-16: **Code review (3 layers) and remediation.** 36 findings: 1 decision (taken: badge counts the selected seat), 29 patches (all applied), 6 deferred, 5 dismissed. The staged round was rebuilt as an external store read through `useSyncExternalStore`, which closes four findings with one root cause: the lazy `useState` restore caused a hydration mismatch, mutators lost updates through stale closures, a session change kept the previous table's round, and two tabs silently overwrote each other (the `storage` event now keeps them in step). Other fixes: line ids no longer need a secure context (`crypto.randomUUID` threw on every Add over plain `http://`); the menu is now OBSERVED rather than read once, so a dish 86'd mid-round is flagged, and a deleted dish is flagged too; a session closed on another tablet is terminal on the query path as well as the mutation path; AC-7's error names the vanished seat from a label captured at stage time; the modifier sheet is a native modal `<dialog>` and captures its seat when opened; every waiter control meets the 56px touch token; `slate-400` is gone from meaningful text on this screen, including the bar's "NOT SENT" eyebrow (a shared chrome file, so the floor strip's eyebrow darkened too); the history query is one shared function, sorts pre-0014 rows correctly, and the route answers 404 for an unknown order; Clear asks before discarding more than one line; closing a table clears its mirror; covers are back in the header. Re-verified against the running server: history order with a NULL-round row, the 404, and the page render. `tsc` clean; `eslint` clean without `--quiet` apart from one pre-existing warning in `server/socket/index.ts`. **Still not exercised in a browser:** every tap on this screen, the dialog, the stepper, the store's reload and two-tab behaviour.

- 2026-09-16: **Same dish, same seat now merges (Teran's request, found in use).** Tapping a dish the selected seat already has raises that line's quantity instead of adding a second identical line. Only lines with the same dish, the same seat AND the same note merge. A different note, including a note versus no note, stays a separate line so the kitchen never loses an instruction. This reverses Task 2's "adding never merges lines"; the line's own minus button now undoes a mis-tap. With it, the review's one decision was taken: the card badge and "Add another" count the selected seat only.

- 2026-09-16: **Second pass, to the design system.** Item cards: `rounded-waiter` (the system's radius for menu cards, not the table card's `rounded-card`), destination eyebrow and staged top band in the `ROUTES` colours — Kitchen blue, Pizza orange, Bar violet — with Kitchen's *text* on `brand-700` because route blue is 4.00:1 on white and fails AA at 12px. `ROUTES` gained `band`/`ink`/`short` and a `routeForDestination()` map for the database's `pizza_kitchen`. Seats: an equal-width auto-fill grid of `rounded-waiter` buttons with a dashed grey "+ Seat"; the pencil badge is gone and editing is now a second tap on the already-selected seat. Layout: menu and order column in a 3 : 1 ratio (`flex-[3_3_0%]` / `flex-[1_1_0%]`, order column min 320px). **Found and fixed a token bug from the first pass:** `bg-brand-50` is not a token (the system's is `brand-050`), so the Add button and the active seat had rendered with no fill. Also replaced three off-system `slate-50`s with the system's `slate-100`. Every new utility confirmed present in the compiled CSS.

- 2026-09-16: **Order screen redesigned to Teran's mockup.** Two independently scrolling columns under a compact header: menu on the left (text-first cards with a destination eyebrow, a staged-count badge, `Add` / `Add another` and `Opts`; category chips with counts), the order on the right (seat cards with per-seat item counts, amber `NOT SENT` lines with an inline quantity stepper, a subtotal/total footer). New: `order-header.tsx`, `seat-selector.tsx` (replaces and deletes `seat-chip-row.tsx`), `order-summary.tsx`, `--color-unsent-*` tokens kept separate from the `occupied` table status. Hold, Bill & split and Send are in the mockup and deliberately absent — Teran's call: no dead buttons; Send is 4.5, billing Epic 6, Hold has no requirement. Fixing the bar found a second dead control: the strip's `submitted` state rendered an enabled "Generate Bill" with no handler. Now absent without one. Server render verified; the client-rendered menu and all tap interactions are still unseen in a browser.

- 2026-09-16: Implemented, Tasks 1–6. Migration 0014 adds `round_number` and `modifier_text`, both nullable and neither backfilled — the 14 pre-existing rows belong to no round, and a `DEFAULT 1` would have placed session-level audit rows inside a round that Epic 7 shows to a disputing customer, in a table whose trigger refuses UPDATE. Staging is entirely client-side per AC-5, with a per-device `localStorage` mirror so a tablet reload does not lose a round mid-service. Two defects found in my own code before review, both the "comment asserts what the code does not do" class this project has hit in five consecutive stories: the action strip rendered an enabled, dead "Submit Order" whenever no handler was passed (which is exactly what this story does), and the round total marked null prices as something it must not count while counting them as zero. Both fixed, with the corrected comments naming what they used to claim. The significant limitation is unchanged from 4.3: no browser has run any of this, so the eight ACs covering the tap path, the sheet, reassignment and reload survival are compiled and linted but unexercised.
- 2026-09-16: Story created. Two schema gaps found by reading `order_events` against the ACs, both blocking Story 4.5: **`round_number` does not exist** (AC-6's history, 4.5's insert, Epic 5's ticket header and Epic 7's dispute view all name it — logged as a known gap during 4.3 and now due), and **`modifier_text` has nowhere to go** because `notes` is already the audit description for merges, unmerges and close reasons. Four ACs added beyond the epic: AC-8 and AC-9 for those columns, AC-10 because FR13 says unavailable items cannot be ordered and the epic only checks at submission, AC-11 because "no database write for staged items" means a tablet reload loses the round. Three traps recorded: the reload-loses-everything consequence of client-only staging, a seat vanishing under a staged item (now ordinary, because 4.3's review turned on `refetchOnWindowFocus`), and capturing the price at stage time so a re-price cannot rewrite what a guest already ordered. One spec conflict resolved and logged rather than silently split: the UX spec's structured modifier groups and per-waiter shortcuts have no FR, no epic AC and no schema — free text ships, the structured model goes to Epic 10.
