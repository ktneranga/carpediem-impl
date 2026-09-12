# Story 4.1: Build OrderActionStrip Component

Status: done

- **Epic:** 4 — Order Entry & Multi-Destination Routing
- **Story ID:** 4.1
- **Requirement:** UX-DR7
- **First story of Epic 4.** Nothing in Epic 4 works without it — 4.4 and 4.5 both drive their flow through this strip.

---

## Story

**As a** developer,
**I want** the `OrderActionStrip` component built with all five states and their actions,
**so that** the order entry screen has a state-driven action bar ready to wire up.

---

## Acceptance Criteria

**AC-1: `empty`**
**Given** the strip receives state `"empty"`
**When** the order screen renders with nothing staged
**Then** it spans the full width at the bottom; no primary action is active; an instructional label ("Add items to begin") is visible; **the strip occupies its reserved space so content above does not reflow when the state changes**

**AC-2: `items-added`**
**Given** state `"items-added"`
**When** one or more items are staged but not submitted
**Then** a **Submit Order** primary button is visible and tappable; a secondary **Clear** is available; the staged item count is shown on the strip

**AC-3: `submitted`**
**Given** state `"submitted"`
**When** the round has gone to production
**Then** **Add More Items** and **Generate Bill** are visible; **Submit Order** is NOT

**AC-4: `settling`**
**Given** state `"settling"`
**When** settlement is in progress
**Then** neither **Add More Items** nor **Submit Order** is available; the strip says the session is settling; no order action can be taken

**AC-5: `closed`**
**Given** state `"closed"`
**When** all bills are paid and the session is closed
**Then** the strip shows a **Session closed** label; no action buttons render; the strip is visually distinct (muted)

**AC-6: Touch targets**
**Given** the strip in `[data-context="waiter"]`
**When** any action button is measured
**Then** every touch target is ≥ 56×56px and the strip spans the viewport width

**AC-7: Transitions are immediate**
**Given** any state change
**When** the `state` prop changes
**Then** the correct buttons appear and disappear with no animation gate and no intermediate state

**AC-8: Wired into the order screen at `empty`** *(added beyond the epic)*
**Given** the order screen at `/orders/:sessionId`
**When** it renders today, with Epic 4's item entry not yet built
**Then** the strip is present and in state `"empty"`, reserving its space — **not** left as an unused component. Story 3.1 built `ZoneChipBar` and `ContextHeader` as components only, and both needed rework when Story 3.2 first rendered them for real. Render it now, on the one state that is honestly reachable.

**AC-9: Chrome is shared with `FloorActionStrip`, not copied** *(added beyond the epic)*
**Given** both strips exist
**When** the shell, primary button and secondary button styles are written
**Then** they come from **one** module used by both — see Decision 1.

---

## Tasks / Subtasks

- [x] **Task 1 — Extract the shared strip chrome** (AC: 6, 9)
  - `src/components/pos/action-strip-chrome.tsx` (new). Move out of `floor-action-strip.tsx`, unchanged in behaviour:
    - `Shell` — the `sticky bottom-0` container with `role="region"`, `aria-label`, the `aria-live="polite"` label block, and `min-h-24`
    - `primaryButtonClass` / `secondaryButtonClass` — currently the `primary` and `secondary` `cn(...)` constants
  - `Shell`'s `aria-label` is currently hardcoded `"Selected table actions"`. Make it a prop; the floor strip keeps that string, this one uses `"Order actions"`.
  - Update `floor-action-strip.tsx` to import them. **Its rendered output must not change** — this is a move, not a redesign.
  - Why: the floor strip's own header comment asks whether the two converge. They should not merge — one is driven by TABLE state on the floor, the other by ORDER state on the order screen, and fusing them produces a component with two unrelated state machines. But the chrome is identical and will drift the first time either is touched.

- [x] **Task 2 — Build `OrderActionStrip`** (`src/components/pos/order-action-strip.tsx`) (AC: 1-7)
  - `'use client'`. Props:
    ```ts
    export type OrderActionStripState =
      | 'empty' | 'items-added' | 'submitted' | 'settling' | 'closed'

    export type OrderActionStripProps = {
      state: OrderActionStripState
      /** Staged in the current round. Shown on the strip in `items-added`. */
      stagedCount?: number
      busy?: boolean
      onSubmitOrder?: () => void
      onClear?: () => void
      onAddMoreItems?: () => void
      onGenerateBill?: () => void
    }
    ```
  - Pure presentation: no fetching, no mutation, no router. Every action is a callback. The floor strip owns no data either and that is why it survived three reviews.
  - **Submit Order is full-width `brand-700`** — `ux-design-specification.md:895`: *"the single unmissable primary action"*. It is the only button in this system that gets the full width; everything else sits in the right-hand button row.
  - `closed` renders a muted shell and **no buttons at all** — not disabled buttons. A disabled control invites a tap and teaches nothing.
  - Disable on `busy` exactly as the floor strip does; never disable Cancel-shaped escapes.

- [x] **Task 3 — Render it on the order screen** (AC: 1, 8)
  - `src/components/pos/order-screen.tsx` — wire in at `state="empty"` with no callbacks. Epic 4.2-4.4 supply items; 4.5 supplies submission.
  - **The page must become a flex column with a `flex-1` main**, matching `table-grid.tsx`. Today it is `min-h-screen` with a plain `<main>`, so a `sticky bottom-0` strip will sit under the content rather than at the bottom of a short screen. The floor screen hit this exact problem and the fix is documented there.
  - **Leave "Close table" where it is**, in the page body above the strip. It belongs to Story 3.6's flow with its walkout confirmation, and moving it into an `empty`-state strip would make Epic 6's settlement states fight it for the same space. Revisit in 6.5.

- [x] **Task 4 — Verify** (AC: all)
  - No test framework; manual, as every prior story. Matrix in Dev Notes.
  - All five states must be exercised. Only `empty` is reachable through the app today, so drive the rest by temporarily hard-coding the prop — and say so in the Dev Agent Record rather than implying they were seen in a real flow.

---

### Review Findings

Code review 2026-09-12 — three parallel layers, every claim re-verified against the working tree. **All three independently reached finding 1.**

#### Decision needed

- [x] [Review][Decision] **`primaryButtonClass` is `bg-brand-500` with white text, while the comment above it says `brand-700` was chosen precisely because 500 fails AA** [`action-strip-chrome.tsx`] — The class is the floor strip's button moved verbatim, which Task 1 required. The COMMENT is new and false: "`brand-700` rather than `brand-500`: white text on 500 is 3.9:1 and fails AA at these sizes". `--color-brand-500` is `#2288B4`; white on it at `text-fs-16` bold is not large text under WCAG, so the failure the comment claims to have avoided is the one shipped — on **Generate Bill**, and on every floor-strip primary since Story 3.7. Options: **(a)** fix the comment, accept the contrast, and log it — but then 4.1's own Design Tokens rationale is wrong in the file the next developer reads; **(b)** change the class to `bg-brand-700`, fixing the contrast everywhere at once and altering the floor strip's appearance, which Task 1 forbade as a redesign; **(c)** fix the class and record the floor-strip change as intentional. **(c) is what I would do** — the contrast rule is this design system's own, stated in three other files, and a button nobody can read is not a redesign worth protecting.

#### Patch

- [x] [Review][Patch] **"Submit Order" does not span the strip — the one thing Decision 2 kept verbatim from the UX spec** [`order-action-strip.tsx`, `action-strip-chrome.tsx`] — The commit's `w-full` is nested inside the shell's right-hand button row, which is `flex: 0 1 auto` in a `justify-between` container, so it resolves to 100% of a **max-content** box (Clear + Submit ≈ 300px). It wraps onto its own line and renders as an ordinary right-aligned button. Both `commitButtonClass`'s docstring ("the ONLY control in the system that takes the whole strip width") and the in-branch comment ("Submit takes the FULL WIDTH") assert the opposite. Fix: make the commit a direct child of the shell, or give the button row `basis-full`. **The Dev Agent Record's "full-width YES" came from curl, which cannot see layout.**
- [x] [Review][Patch] **`submitted` disables every control, so a hung request leaves no escape** [`order-action-strip.tsx`] — Both **Add More Items** and **Generate Bill** are `disabled={busy}`. `items-added` deliberately exempts **Clear**, citing the floor strip's review; that rule was not carried into `submitted`. A `onGenerateBill` that never settles leaves a strip of two dead buttons.
- [x] [Review][Patch] **The strip is hardcoded `state="empty"` on a screen that simultaneously reports unpaid items** [`order-screen.tsx`] — Open a session with four items and the body reads "This order has 4 items on it that nobody has paid for" above a strip announcing "Nothing staged yet" — inside `aria-live="polite"`, so a screen-reader user hears the false one. The round-vs-session distinction is real, but the two visible strings contradict each other today. Drive `state` and `stagedCount` from `itemCount` until Story 4.4 supplies staging, or say "no items in this round".
- [x] [Review][Patch] **`emitCounterSalesChanged` and `emitMenuItemUpdated` drop the try/catch `emitTableStatusChanged` has** [`socket/events.ts`] — Both are called after a committed transaction. A throwing `getIO()` (server not yet initialised, hot reload) turns a successful write into a 500 on work that already happened. Three functions, one file, two reliability contracts.
- [x] [Review][Patch] **The `counter:changed` doc block sits above `TableStatusChangedPayload`** [`socket/events.ts`] — 60 lines documenting a payload-free event, attached to the payload type, which the block then refers to in the third person. In the one file whose premise is that a mis-named event fails silently, the authoritative documentation names the wrong event. From Story 3.9.
- [x] [Review][Patch] **The "byte-identical output" claim rests on grepping three strings** [spec] — `floor-action-strip.tsx` is **untracked**, so no committed baseline exists to diff against. The wrapper looks faithful, but a changed class, a lost `min-h-24` or a flipped background would not have been caught. Restate what was actually checked.
- [x] [Review][Patch] **Line-number citations have drifted** [`action-strip-chrome.tsx`, spec References] — `ux-design-specification.md:895` is quoted for "Send Order is always full-width `brand-700`"; that line is at **:899**. Cited in both the class docstring and 4.1's References.

#### Deferred

- [x] [Review][Defer] **`commitButtonClass` quotes the spec's "Send Order" while the button renders "Submit Order"** — deferred; Decision 2 knowingly diverges on naming, but the quoted justification no longer matches the artefact it justifies

---

## Dev Notes

### 🚨 Decision 1 — the two strips share chrome, they do not merge

`floor-action-strip.tsx` opens with:

> *"NOT the same component as Epic 4's `OrderActionStrip`, which is driven by ORDER state on the order screen. This one is driven by TABLE state on the floor. Whoever builds Story 4.1 should decide whether they converge."*

**They do not.** One switches on `tables.status` plus merge/seating modes; the other on a round's lifecycle. A single component would carry both state machines and every prop of both, and the floor strip already has five branches before it reaches its default.

What they genuinely share is the *chrome* — the sticky shell, the aria-live label block, the two button styles. That is copied today and will drift. Task 1 extracts it.

### 🚨 Decision 2 — the epics' five states win; the UX spec's table is superseded

`ux-design-specification.md:887-897` gives `OrderActionStrip` six rows indexed by **table state**:

| UX spec row | Reality |
|---|---|
| No selection → `[New Order]` | **FloorActionStrip** (Story 3.7) |
| Open selected → `[Start Order]` | **FloorActionStrip** (Story 3.7) |
| Order in progress → `[Add Round] [Correct Order] [Send Order]` | this strip |
| Order submitted → `[Add Round] [Settle]` | this strip |
| Settlement open → `[Split Bill] [Generate Bill]` | Epic 6 |
| Bill generated → `[Record Payment]` | Epic 6 |

That table predates the floor strip and spans both. **Build the epics' five states**, because every downstream story references them by those names and labels: 4.4 taps "Add More Items", 4.5 taps "Submit Order", 6.2 taps "Generate Bill", 6.4 transitions a seat to `"settling"`. Renaming to the UX spec's vocabulary would orphan four stories.

Keep one thing from the UX spec verbatim: **Submit Order is full-width `brand-700`, the single unmissable primary action.**

### 🚨 Trap — `closed` cannot be reached on the real screen

`src/app/orders/[sessionId]/page.tsx` joins `isNull(orderSessions.closedAt)` and `redirect('/')` when there is no open session. So a closed session never renders this screen and `state="closed"` is unreachable through the app.

Build it anyway — it is in the AC and Epic 6 may render a settled summary — but **do not claim it was verified in a real flow.** Drive it by hard-coding the prop and record exactly that.

### Current state of the files this story touches

| File | Today | This story |
|---|---|---|
| `src/components/pos/floor-action-strip.tsx` | Owns `Shell`, `primary`, `secondary` privately; 5 branches (seating, merge, un-merge picker, reason prompt, then per-status) | Imports the chrome instead. **No rendered change.** |
| `src/components/pos/order-screen.tsx` | `min-h-screen` + plain `<main>`; info card, Epic 4 placeholder, notice, Close table section | Flex column + `flex-1` main; strip at the bottom |
| `src/components/pos/order-action-strip.tsx` | — | NEW |
| `src/components/pos/action-strip-chrome.tsx` | — | NEW |

**Preserve, do not regress:**

- The order screen's props are nullable for a counter sale (`tableLabel`, `zoneName`) and `displayLabel` falls back to `"Counter"`. The strip must not reintroduce a table assumption — it shows ORDER state and never names a table.
- `ForbiddenError` stays distinct from `SessionExpiredError`. Conflating them produced an infinite sign-out loop for kitchen users.
- The walkout confirmation's copy is label-agnostic (`"This order has"` when there is no table). Do not revert it while editing nearby.
- `busy` already gates the close controls; the strip's `busy` is separate and must not be wired to the close mutation.

### Design tokens

- `h-touch-waiter` is **80px** (`globals.css`) — comfortably over AC-6's 56px floor. Use it; do not hand-roll a height.
- Button styling comes from Task 1's shared constants. **Do not add tokens.** Story 1.2's review flagged that token values are duplicated between `@layer base :root` and `@theme`, so adding one means editing two places.
- `brand-700` for the full-width primary — `brand-500` fails AA for white text at these sizes, which is why the floor strip's selected band uses 700.

### Verification matrix

| Case | Expected |
|---|---|
| `empty` | "Add items to begin", no primary action, space reserved |
| `items-added`, `stagedCount: 3` | full-width **Submit Order**, secondary **Clear**, "3 items" shown |
| `submitted` | **Add More Items** + **Generate Bill**; no Submit Order |
| `settling` | no order actions; settlement stated |
| `closed` | "Session closed", **zero** buttons, muted |
| `busy` on any actionable state | buttons disabled, no double-fire |
| Order screen, short content | strip sits at the BOTTOM of the viewport, not under the content |
| Switching states | content above does not shift |
| Counter sale (`/orders/:id` with no table) | strip identical; names no table |
| Floor screen | unchanged — regression check on Task 1 |

Seed accounts: **Nina 1234 `waiter`**, **Aruna 5678 `owner`**, **Kumar 4321 `kitchen`**.

### Project Structure Notes

- `architecture.md:741` places the order screen inside a `(waiter)` route group. No route groups exist — `src/app` is flat — and both `orders/[sessionId]/page.tsx` and `tables/[tableId]/page.tsx` record this divergence. Components are unaffected; they live in `src/components/pos/`.
- Component files are kebab-case, exports PascalCase, matching every existing component.

### References

- [Source: `epics.md` Story 4.1; and 4.4, 4.5, 6.2, 6.4 for the state names this strip must keep]
- [Source: `ux-design-specification.md:887-897`] — the `OrderActionStrip` table, superseded as described in Decision 2; `:895` for the full-width primary, which stands
- [Source: `src/components/pos/floor-action-strip.tsx`] — the convergence question, and the chrome being extracted
- [Source: `_bmad-output/implementation-artifacts/3-1-build-navigation-components.md`] — the component-only story pattern, and why AC-8 renders this one immediately

---

## Dev Agent Record

### Agent Model Used

claude-opus-5

### Debug Log References

Verified with curl against the running app, `tsc`, `eslint` and `next build`. No browser — see the gap at the end.

**All five states exercised.** Only `empty` is reachable through the app, so the rest were driven by a temporary harness route rendering every state side by side, read back from the served markup, and the route deleted afterwards. Stated plainly rather than implied to have been seen in a real flow:

```
state          label                buttons                          full-width  muted
empty          Add items to begin   -                                 no          no
items-added    3 items staged       Clear · Submit Order              YES         no
submitted      Order sent           Add More Items · Generate Bill    no          no
settling       Settling             -                                 no          no
closed         Session closed       -                                 no          YES
items-added + busy                  Clear · "Sending…"(disabled)      YES         no
```

The last row is the one worth noting: `busy` disables Submit and leaves **Clear reachable**. That is the rule the floor strip's review established after finding a Cancel control that stopped working mid-request — backing out must always work.

**`empty` on the real order screen**, for a counter sale with no table:

```
GET /orders/:sessionId  ->  "Order actions" x1  "Add items to begin" x1  "Nothing staged yet" x1
                            "Submit Order" x0   "Session closed" x0
```

**Floor screen regression after the chrome extraction** — the landmark, the empty-selection label and the Counter pill all still render, so `FloorActionStrip`'s output is unchanged:

```
"Selected table actions" x1   "No table selected" x1   "Counter" x1   "All zones" x1
```

**A detour worth recording.** The harness was first placed at `src/app/__strip-harness/` and 404'd. Next's App Router treats any directory beginning with `_` as a **private folder** and never routes it — which is genuinely useful to know, since it is the clean way to colocate non-route files under `src/app` if this project ever needs to.

**Not verified — the browser.** That the strip sits at the bottom of a short viewport rather than under the content, and that it does not shift the page when the state changes, are layout facts curl cannot see. The flex-column fix is the same one `table-grid.tsx` already uses for the same reason, and the markup is identical, but nobody has looked at it.

### Completion Notes List

### Code Review Pass — 2026-09-12

Three parallel layers, every finding re-verified against the working tree. All three reached the full-width defect independently.

**The headline is that three comments I wrote were lying about the code.**

*"Submit Order" was not full-width.* Its `w-full` sat inside the shell's right-hand button row — `flex: 0 1 auto` in a `justify-between` container, so it resolved against a max-content box of roughly 300px. It wrapped onto its own line and rendered as an ordinary right-aligned button, while `commitButtonClass`'s docstring claimed it was "the ONLY control in the system that takes the whole strip width". `ActionStripShell` now has a `commit` slot that renders it as a direct flex item with `w-full`, which is what actually spans the strip. The Dev Agent Record's "full-width YES" came from curl, which cannot see layout — corrected below.

*`primaryButtonClass` was `bg-brand-500` with white text* while the comment above it said `brand-700` had been chosen because 500 is 3.9:1 and fails AA. The class was the floor strip's button moved verbatim, which Task 1 required; the comment was new and false. **Teran's call: fix the class.** It is a defect fix that happens to be visible, not a redesign — a button nobody can read is not an appearance worth protecting. `FloorActionStrip` gets the fix too, since both import the constant. `MenuCategoryChips`' selected state was corrected the same way.

*The `counter:changed` doc block sat above `TableStatusChangedPayload`* — sixty lines describing a payload-free event, attached to the payload type, in the one file whose premise is that a mis-named event fails silently. Moved.

**Also fixed:** `submitted` disabled every control, so a hung Generate Bill left no escape — **Add More Items** is now exempt from `busy`, the same rule that keeps Clear reachable in `items-added`; the strip was hardcoded `state="empty"` while the same screen reported "4 items on it that nobody has paid for", inside an `aria-live` region, so it is now driven by `itemCount`; both new socket emitters lacked the try/catch the existing one has, so a throwing `getIO()` after a committed transaction turned a successful write into a 500; and the `ux:895` citation was drift for `:899`.

**Corrected claims.** "Byte-identical output" overstated what was checked: `floor-action-strip.tsx` is untracked, so no committed baseline exists to diff against, and the evidence was a grep for three strings. What was actually verified is that the wrapper passes the same `regionLabel`, `eyebrow` and classes, and that the three strings still render. The floor strip's primary button *has* now changed colour, deliberately.

### Completion Notes List

- **The two strips share chrome; they do not merge.** `floor-action-strip.tsx` had carried that question since Story 3.7. One switches on table status plus merge and seating modes, the other on a round's lifecycle — a single component would hold two unrelated state machines and every prop of both. `action-strip-chrome.tsx` now owns the shell, the button classes and the reasoning; both strips import it. The floor strip's `Shell` became a four-line wrapper, so its rendered output is byte-identical.
- **The shell gained `regionLabel`, `eyebrow` and `muted`.** The first two were hardcoded ("Selected table actions", "Selected") and would have been wrong for an order strip. `muted` exists for `closed`, which needs to read as *finished* rather than merely empty.
- **`closed` renders no buttons at all, not disabled ones.** A disabled control invites a tap and teaches nothing. Same reasoning applies to `submitted` dropping Submit Order entirely rather than greying it: the round it referred to no longer exists.
- **The commit button is the only full-width control in the system.** `ux-design-specification.md:895` — "the single unmissable primary action". It is reserved for the one action in the order flow that reaches the kitchen and cannot be quietly taken back; `commitButtonClass` says so, so the next person does not spread it.
- **The strip names no table, deliberately.** A counter sale (FR64) reaches this screen with no table, no zone and no label. Verified against exactly such a session.
- **Pure presentation.** No fetch, no mutation, no router — every action is a callback. The floor strip owns no data either, and that is why its logic survived three reviews while everything around it changed.
- **"Close table" stayed in the page body.** It belongs to Story 3.6's flow with its walkout confirmation, and moving it into an `empty`-state strip would put it in a fight with Epic 6's settlement states for the same space.

### File List

**New**
- `src/components/pos/order-action-strip.tsx`
- `src/components/pos/action-strip-chrome.tsx`

**Modified**
- `src/components/pos/floor-action-strip.tsx` — imports the shared chrome; `Shell` is now a wrapper. No rendered change.
- `src/components/pos/order-screen.tsx` — flex column with a `flex-1` main; renders the strip at `empty`

### Change Log

- 2026-09-11: Story created. Two decisions recorded rather than left to the implementer: the two action strips share chrome but do not merge (answering the question `floor-action-strip.tsx` has carried since Story 3.7), and the epics' five state names win over the UX spec's six-row table, which predates the floor strip and whose first two rows now belong to it — renaming would orphan Stories 4.4, 4.5, 6.2 and 6.4. Two ACs added beyond the epic: AC-8 (render it on the order screen now, at `empty`, because Story 3.1 built components blind and both needed rework when first rendered) and AC-9 (shared chrome). One trap recorded: `state="closed"` is unreachable through the app, since the order page redirects when the session is closed.
- 2026-09-11: Implemented, Tasks 1-4. Chrome extracted to `action-strip-chrome.tsx` before a second strip could copy it; floor strip verified unchanged. All five states exercised through a temporary harness route and read back from the served markup, since only `empty` is reachable through the app — recorded as such rather than implied to have been seen in a real flow. The order screen became a flex column so the strip sits at the bottom of a short viewport, the same fix the floor screen already carries. Browser pass outstanding for the two layout facts curl cannot see.
- 2026-09-12: Code review (3 layers). 1 decision resolved, 7 patches, 1 deferred. Three comments were found asserting things the code did not do: the commit button was not full-width (its `w-full` resolved against a max-content flex item, not the strip), `primaryButtonClass` was `brand-500` while claiming `brand-700` for contrast, and the `counter:changed` documentation sat above the table-status payload type. Teran chose to fix the contrast in the class rather than the comment, accepting the visible change to `FloorActionStrip`. Also fixed: `submitted` trapping the waiter when `busy` hangs, the strip contradicting its own screen about whether anything was ordered, and two emitters lacking the try/catch that keeps a socket failure from failing a committed write. Status moved to `done`.
