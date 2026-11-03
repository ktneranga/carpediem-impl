# Story 4.9: Implement Custom Charge

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the owner,
I want to add a line with a name and a price I type — "Corkage", "Broken glass", "4 shots, guest request" — to a table or a bar tab,
so that charges the menu cannot express still reach the bill, with a record of who added them and for how much.

## Acceptance Criteria

1. **Who may.** Only staff allowed to add custom charges can. Until Story 10.6
   that is the **owner role**, decided by ONE server function
   (`canAddCustomCharge(role)` in `src/server/auth/permissions.ts`) that 10.6 will
   replace with a per-user permission check. A waiter never sees the control, and
   a waiter's request carrying a custom line is refused with **403
   `CUSTOM_CHARGE_NOT_ALLOWED`** before anything is written.

2. **Where.** On the order screen of a table AND of a bar tab, the bar's **More**
   menu shows **"Add custom charge"** for allowed staff only. It opens a sheet
   with: **Name** (required, trimmed, 1–60 characters), **Price** in LKR (required,
   whole or with cents; > 0; at most LKR 100,000), and a **quantity** stepper
   (1–99, like a dish). Add is disabled until name and price are valid. The sheet
   shows the line total live.

3. **Staged like a dish.** Adding stages a line on the selected seat in the current
   round. It shows the typed name, a small "Custom" tag, and its price; it can be
   removed or its quantity changed like any line. It survives a reload (same
   localStorage round). It is never merged with a menu dish, and two custom lines
   merge only if name, price and seat are identical.

4. **Sent with the round.** Send carries custom lines in the same request as dishes.
   The wire line is `{ customName, pricePaisa, quantity, seatSlotId }` — no
   `menuItemId`, no options, no note. Same idempotency (`submissionId`), same
   bill and seat guards (`SESSION_ALREADY_BILLED`, `SEAT_ALREADY_BILLED`,
   `SEAT_NOT_FOUND`) as dishes.

5. **The typed price IS the value.** Unlike a dish (Story 4.5, where the quote is a
   check against the menu), a custom line's `pricePaisa` is what is charged. The
   server validates it: integer, 1 … 10,000,000 paisa. The name is trimmed and
   sanitised (no control characters), 1–60 characters.

6. **Recorded and audited.** Each custom line is ONE `order_events` row:
   `event_type = 'ITEM_ADDED'`, `menu_item_id = NULL`, new column
   `custom_name` = the name, `unit_price_paisa` = the price, `quantity`,
   `seat_slot_id`, `staff_id` (who), `created_at` (when), `round_number`. That row
   IS the audit record (append-only, immutable trigger). A database CHECK makes
   every `ITEM_ADDED` row name exactly one of `menu_item_id` / `custom_name`.

7. **No ticket.** A custom line prints on no kitchen, pizza or bar ticket. A round
   holding ONLY custom lines commits with **no** `print_jobs` rows and announces no
   tickets; a mixed round prints its dishes as before.

8. **Billed like any line.** The bill screen, a consolidated bill, a seat bill and a
   split all treat a custom line as an ordinary line: its name is the custom name,
   its station chip is empty, it can be moved in a split, and `bill_lines.name`
   snapshots the custom name. Service charge and tax apply as to any line.

9. **Shown everywhere a line is.** Round history shows it with its name (never
   "Item no longer on the menu"). Item counts, "unbilled items" and the walkout
   rule count it: a table with an unpaid custom charge is a walkout, not an empty
   table.

10. **Verified.** New `src/server/services/verify-custom-charge.ts` passes (matrix in
    Dev Notes); `verify-options.ts`, `verify-bills.ts`, `verify-escpos.ts` still
    pass; `pnpm exec tsc --noEmit` and `pnpm lint` are clean (one pre-existing
    warning in `src/server/socket/index.ts`).

## Tasks / Subtasks

- [x] **Task 1 — Schema (AC: 6)**
  - [x] `schema.ts` `orderEvents`: `customName: text('custom_name')` with a doc comment
        (what, why nullable, that it is the audit's "what").
  - [x] `pnpm db:generate`, then APPEND to the generated SQL a CHECK:
        `CHECK (event_type <> 'ITEM_ADDED' OR ((menu_item_id IS NULL) <> (custom_name IS NULL)))`
        named `order_events_item_names_one_source`. Before migrating, confirm no
        existing `ITEM_ADDED` row has a NULL `menu_item_id`
        (`SELECT count(*) …`); if any do, add the constraint `NOT VALID` and say so.
  - [x] `pnpm db:migrate` on the dev database.

- [x] **Task 2 — Types and permission (AC: 1, 4, 5)**
  - [x] `types/orders.ts`: split `SubmitRoundLine` into `SubmitMenuLine` (today's
        shape) and `SubmitCustomLine` `{ customName: string; pricePaisa: number;
        quantity: number; seatSlotId: string }`; `SubmitRoundLine = SubmitMenuLine |
        SubmitCustomLine`. Constants `MAX_CUSTOM_NAME = 60`,
        `MAX_CUSTOM_CHARGE_PAISA = 10_000_000`. Error code
        `CUSTOM_CHARGE_NOT_ALLOWED`.
  - [x] `server/auth/permissions.ts`: `export function canAddCustomCharge(role:
        StaffRole): boolean { return role === 'owner' }` with a comment pointing at
        Story 10.6 (the ONE place to change).

- [x] **Task 3 — Send route (AC: 1, 4, 5)**
  - [x] Zod: `lines` items become `z.union([menuLine, customLine])`. `customLine`:
        `customName` string → trim → sanitise (reuse `sanitizeTicketText` from
        `src/server/print/ticket.ts`, or a shared helper) → length 1..60;
        `pricePaisa` int 1..`MAX_CUSTOM_CHARGE_PAISA`; `quantity` as dishes;
        `seatSlotId` uuid. Use `.strict()` on both so a body mixing the two shapes
        is a 400, not silently one of them.
  - [x] Before `submitRound`: if any line is custom and
        `!canAddCustomCharge(x-staff-role)` → 403 `CUSTOM_CHARGE_NOT_ALLOWED`
        (`fail(...)` helper). Keep the existing unique-violation ordering comment.

- [x] **Task 4 — `submitRound` (AC: 4, 5, 6, 7)**
  - [x] Item ids, the menu `FOR SHARE` read and `loadModifierGroups` use MENU lines
        only. Custom lines skip availability/options/price checks — their price is
        the value (comment why: Decision 2's "quote is a check" is about the menu).
  - [x] `priced` per line: menu → as today; custom → `{ unitPricePaisa:
        line.pricePaisa, options: [] }`.
  - [x] `eventRows`: custom → `menuItemId: null, customName: line.customName,
        modifierText: null, options: null`.
  - [x] `byDestination`: skip custom lines (no `itemsById` lookup for them — that
        `!` would throw).
  - [x] **Guard the print-job insert**: `tickets.length === 0` → no
        `tx.insert(printJobs)` (Drizzle throws on an empty `values([])`). The
        announcement's `byDestination` is then empty; check the route's emit loop
        and `wakePrintQueue()` are harmless with it.
  - [x] Keep: replay-before-lock, seat/bill guards for ALL lines (they look at
        `seatSlotId`), line-order error reporting, the Epic 8 placeholder after
        validation, emit only after commit.

- [x] **Task 5 — Readers (AC: 8, 9)**
  - [x] `submitted-rounds.ts`: select `orderEvents.customName`; `name:
        row.customName ?? row.itemName ?? MISSING_ITEM_NAME`.
  - [x] `bill.service.ts collectBillable`: select `customName`; everywhere the line
        name is formed (`buildBill` insert and return, ~line 743 and ~794) use
        `event.customName ?? event.itemName ?? 'Unknown item'`. `getBill` already
        reads the snapshotted `bill_lines.name` — no change.
  - [x] `bill/page.tsx` draft lines: same name rule (it maps `event.itemName`).
        Its station `innerJoin(menuItems)` stays (a custom line simply has no chip).
  - [x] Grep every `eq(orderEvents.eventType, 'ITEM_ADDED')` reader (list in Dev
        Notes) and confirm none assumes a non-null `menu_item_id`. Counting readers
        need no change.

- [x] **Task 6 — Staged round (AC: 3)**
  - [x] `use-staged-round.ts` `StagedLine`: add `customName?: string`; for a custom
        line `menuItemId = ''`, `optionIds = []`, `options = []`, `modifierText =
        ''`, and widen `productionDestination` to `… | null` (custom → null).
        `readStorage` accepts the new optional field (a line with `customName`
        must have a positive integer price) — tolerant read, NO storage-key bump.
  - [x] `addCustomLine({ name, pricePaisa, quantity, seatSlotId, seatLabel })`;
        merges only with an identical custom line (name, price, seat).
  - [x] Every consumer keyed by `menuItemId` skips custom lines: the staged count
        per item (cards' badges), the destination summary (no destination), and
        the stale checks in `order-screen.tsx` (~line 713 `menuItemsById.get(...)`
        would otherwise flag it "no longer available").

- [x] **Task 7 — UI (AC: 2, 3)**
  - [x] `orders/[sessionId]/page.tsx`: read `x-staff-role` (already reads
        `x-staff-id`), pass `canAddCustomCharge={canAddCustomCharge(role)}`.
  - [x] `order-action-strip.tsx`: a More-menu item "Add custom charge" when an
        `onAddCustomCharge` handler is given (pattern: `onCloseTable`, line ~112).
  - [x] New `components/pos/custom-charge-sheet.tsx`, modelled on
        `modifier-sheet.tsx` (`<dialog>` + `showModal`, focus the name field after
        `showModal`, Escape/close, 56px controls, `commitButtonClass`, quantity
        stepper). LKR input → paisa with `Math.round(lkr * 100)`; reject NaN, ≤ 0,
        > 100,000. Live total via `lkrFromPaisa`.
  - [x] `staged-round-list.tsx`: a custom line shows its name, a "Custom" tag
        (`text-slate-600`, not 400), price; no options; seat as others.
  - [x] Send body: custom lines → `{ customName, pricePaisa, quantity,
        seatSlotId }`. Handle 403 `CUSTOM_CHARGE_NOT_ALLOWED`: "Not sent — only
        the owner can add a custom charge." (role changed mid-shift).

- [x] **Task 8 — Verification (AC: 10)**
  - [x] `src/server/services/verify-custom-charge.ts` on the `verify-options.ts`
        pattern (login owner `5678` AND waiter `1234`; `mine` registry; cleanup
        with triggers disabled in try/finally; deletes print_jobs/order_rounds/
        order_events/bills it made).
  - [x] Re-run `verify-options.ts`, `verify-bills.ts`, `verify-escpos.ts`; tsc;
        lint.

### Review Findings

- [x] [Review][Decision] A charge-only round takes a kitchen round number — a corkage between food rounds makes it Round 2, so the kitchen's tickets read Round 1 then Round 3. **Decided (Teran, 2026-11-03): keep it.** Charges are rare and usually come after the last food round; renumbering only printed rounds would make the paper disagree with the tablet's history; the order number (#042) ties tickets to an order.
- [x] [Review][Patch] (HIGH) "Only the owner can add a custom charge" never shows — `sendRound` throws `ForbiddenError` on any 403 before reading the code, so the sheet says "check the connection" and the staged send says "Your role cannot send orders" [src/components/pos/order-screen.tsx:270]
- [x] [Review][Patch] (MED) A retry after editing the price or name replays the FIRST charge — the send id is minted at open; if the first Add committed but the response was lost, the edited retry returns `replayed` and the sheet closes as if the new values were saved. Lock the fields after an uncertain failure (retry sends the same charge) [src/components/pos/order-screen.tsx:~800]
- [x] [Review][Patch] (MED) Cancel / Escape / backdrop still close the sheet while a save is in flight; reopening calls `chargeMutation.reset()` mid-flight (re-enables Add) and the first save's `onSuccess` then closes the new sheet — a double charge path [src/components/pos/custom-charge-sheet.tsx; order-screen.tsx openCustomCharge]
- [x] [Review][Patch] Wrong refusal wording in the sheet — `SEAT_ALREADY_BILLED` says the whole order is billed; `SEAT_NOT_FOUND` falls through to "A dish is on a seat…" [src/components/pos/order-screen.tsx:~840]
- [x] [Review][Patch] `SessionGoneError` in the sheet does not mark the order closed (`setClosedDuringSend`), so the screen stays live on a closed order [src/components/pos/order-screen.tsx:~847]
- [x] [Review][Patch] The + icon still shows on a fully billed order; the owner types a whole charge before being refused [src/components/pos/order-screen.tsx onAddCharge]
- [x] [Review][Patch] Price message says "from LKR 1" but LKR 0.01 is accepted (AC: > 0) — reword [src/components/pos/custom-charge-sheet.tsx:~72]
- [x] [Review][Patch] Legacy staged custom lines: `readStorage` does not check `MAX_CUSTOM_NAME` / `MAX_CUSTOM_CHARGE_PAISA`, so a bad stored line 400s the whole round with no line named [src/components/pos/use-staged-round.ts]
- [x] [Review][Patch] Verify case 9 passes on any non-2xx close (403/404/500); assert the walkout refusal code [src/server/services/verify-custom-charge.ts]
- [x] [Review][Patch] Stale "More menu" wording in comments (`orders/[sessionId]/page.tsx`, `OrderScreenProps.canAddCustomCharge`) and in this story's File List / Completion Notes (lists `order-action-strip.tsx`; omits `order-summary.tsx`, `round-history.tsx`)

## Dev Notes

### Decisions taken for this story (with reasons)

- **One event row, not a new table or event type.** `ITEM_ADDED` with
  `menu_item_id NULL` + `custom_name`. Every reader that bills, counts, closes or
  shows history already filters `ITEM_ADDED`; a new event type would have to be
  added to ~15 of them (missing one = an unbilled charge or a table closing over
  money owed). `menu_item_id` is already nullable.
- **The typed price is the value.** Decision 2 ("the quote is a CHECK") protects
  the MENU price from a tablet. A custom charge has no menu price; the owner IS
  the authority, and the permission gate is the protection.
- **Owner only, through one function.** Story 10.6 replaces `canAddCustomCharge`
  with a per-user permission lookup; nothing else changes.
- **No ticket.** Epic text: "prints on no kitchen ticket". Nobody makes a corkage.
- **Positive only.** A reduction is a comp (Epic 7), which has its own reasons and
  audit; a negative custom charge would be an unaudited discount.
- **Sent with the round, not written directly.** Reuses idempotency, the billed
  guards and the walkout rule; the line is visible in the staged list before it
  costs anyone anything.

### The path a custom line takes — files, current state, change, preserve

| File | Today | Change | Preserve |
|---|---|---|---|
| `src/server/db/schema.ts` `orderEvents` (~495) | `menuItemId` nullable; options jsonb (4.8) | + `customName` | append-only trigger; comments' style |
| `src/types/orders.ts` `SubmitRoundLine` (~98) | one shape | union | `optionIds?` default, quote doc |
| `src/app/api/sessions/[sessionId]/orders/route.ts` | zod line schema (~60), error mapping (~200–260) | union + 403 | unique-violation ordering comment; `OPTION_INVALID_MESSAGE` |
| `src/server/services/order.service.ts submitRound` | items FOR SHARE (~259), `loadModifierGroups`, `priced` map, `eventRows` (~380), `byDestination` (~397), print jobs insert (~467) | menu-only reads; custom branch; skip in tickets; guard empty insert | replay-before-lock; Epic 8 placeholder; jobs in same tx; emit after commit |
| `src/server/orders/submitted-rounds.ts` | `itemName ?? MISSING_ITEM_NAME` | custom name first | LEFT joins |
| `src/server/services/bill.service.ts` | `itemName ?? 'Unknown item'` (~743, ~794); select (~258) | custom name first | unit-billing trigger semantics; money untouched |
| `src/app/orders/[sessionId]/bill/page.tsx` | draft lines map `itemName` | custom name first | station chip join |
| `src/app/orders/[sessionId]/page.tsx` | reads `x-staff-id` (~56) | + role → prop | key by session |
| `src/components/pos/use-staged-round.ts` | `StagedLine` keyed by `menuItemId`, tolerant `readStorage` | + `customName`, `addCustomLine` | no prefix bump; functional updates; `newId()` |
| `src/components/pos/order-screen.tsx` | stale checks (~713), send body (~815), errors (~860–930), strip (~1766) | skip custom in checks; body; 403 | `stagedProblems` semantics |
| `src/components/pos/order-action-strip.tsx` | More menu items (~112) | + item | button absent when handler undefined |
| `src/components/pos/staged-round-list.tsx` | details array | custom tag | per-line Accept (4.8) |

`ITEM_ADDED` readers to confirm (none should need code changes beyond the three
name sites): `api/sessions/route.ts:226`, `sessions/[sessionId]/close/route.ts:94`,
`sessions/[sessionId]/orders/route.ts:397`, `sessions/[sessionId]/tables/route.ts:210`,
`api/tables/route.ts:153`, `tables/[tableId]/merge/route.ts:227`,
`tables/[tableId]/sessions/close/route.ts:130`, `tables/[tableId]/unmerge/route.ts:136`,
`orders/[sessionId]/page.tsx:138`, `submitted-rounds.ts:60`,
`bill.service.ts:281, 979`, `order.service.ts:353`.

### Traps (each one would ship a bug)

1. `tx.insert(printJobs).values([])` throws in Drizzle — a custom-only round
   would 500 after writing nothing useful. Guard it.
2. `itemsById.get(line.menuItemId)!` in `eventRows`/`byDestination` — a custom
   line has no item; the `!` turns into `undefined.productionDestination`.
3. `inArray(menuItems.id, [])` with only custom lines — skip the menu read (and
   `loadModifierGroups` already returns early on `[]`).
4. The order screen's stale check looks every staged line up in the menu; a custom
   line would be flagged "no longer available" and block Send.
5. `dishKey` on the bill screen groups by name + price + note + station: two
   different custom charges with the same name and price fold into one line —
   acceptable (they are the same charge); different prices stay separate.
6. Zod `z.union` without `.strict()` accepts `{ menuItemId, customName, … }` as a
   menu line and silently drops the name.
7. The role header is set by the proxy from the session — never trust a body
   field for it.

### Testing standards

No unit-test runner. `verify-*.ts` scripts, `pnpm exec tsx --env-file=.env <file>`
against `pnpm dev` (cold-restart it if routes look stale).

**`verify-custom-charge.ts` matrix:**
1. Owner sends a custom-only round → 201; one `ITEM_ADDED` row, `menu_item_id`
   NULL, `custom_name`, price, staff = owner; **no** `print_jobs` row.
2. Owner sends a mixed round (dish + custom) → 201; print job(s) carry the dish
   only.
3. Waiter sends a custom line → 403 `CUSTOM_CHARGE_NOT_ALLOWED`; nothing written.
4. Price 0, negative, 10,000,001, non-integer → 400; name empty / 61 chars /
   control chars only → 400.
5. A line with BOTH `menuItemId` and `customName` → 400.
6. Replay of #1's `submissionId` → 200 replayed, no new rows.
7. Consolidated bill includes it: `bill_lines.name` = custom name, amount =
   price × qty; totals include it.
8. Round history (`loadSubmittedRounds` via the orders GET) names it.
9. `hasUnbilledItems` true while it is unbilled (walkout rule).
10. The DB CHECK refuses an `ITEM_ADDED` row with neither or both name sources.
11. Seat guard: a custom line on a seat already billed → `SEAT_ALREADY_BILLED`.

### Project Structure Notes

- New: `src/components/pos/custom-charge-sheet.tsx`,
  `src/server/services/verify-custom-charge.ts`, one migration.
- Migrations by `pnpm db:generate`; extra SQL appended to the generated file (the
  0029/0030 pattern).
- Money: integer paisa; display via `src/lib/format.ts`.
- Comments record WHY and past bugs; update the ones this story falsifies (e.g.
  `submitRound`'s "every line is a dish" assumptions, `SubmitRoundLine` doc).

### Previous story intelligence (4.8)

- Shared rules live in `src/lib/*` and are imported by client and server — do not
  duplicate validation constants (use `MAX_CUSTOM_NAME` etc. from `types/orders.ts`).
- Staged storage: tolerant read, never bump the prefix (drops every unsent round
  at deploy).
- `lineIndex` on refusals names the line; keep it for custom lines too.
- Review found: messages must say what to fix; guard every `Array.isArray` on
  stored payloads; `size-touch-standard`/`min-h-touch-kitchen` targets; `slate-600`
  not `slate-400`.
- The sheet pattern: `modifier-sheet.tsx` (dialog, focus after `showModal`,
  `opensOnNoteRef` to avoid effect deps).

### Git intelligence

Recent: `d6cc2f7` (4.8 server review fixes), `6c9bd4c` (return-to after login),
`c89ed62`, `c7c76c5`, `3879b67` (4.8). `submitRound`, the orders route and
`bill.service.ts` were all touched by 4.8 — re-read them, line numbers above are
approximate.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 4.9]
- [Source: _bmad-output/planning-artifacts/epics.md#Story 10.6] (first permission: `custom_charge`)
- [Source: _bmad-output/planning-artifacts/prd.md FR66]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-10-31.md §4.1, §4.2]
- [Source: _bmad-output/implementation-artifacts/4-8-implement-priced-options.md]
- [Source: src/server/auth/permissions.ts] (role policy pattern)

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Debug Log References

- Pre-migration check: 0 `ITEM_ADDED` rows with NULL `menu_item_id`, so the CHECK was added VALID (not `NOT VALID`).
- `verify-custom-charge.ts`: 21/21 (all 11 matrix cases; case 11 first failed because the test used `type: 'seat'` on `/bills` — per-seat bills have their own endpoint; fixed in the test).
- Regression: `verify-options.ts` 33/33, `verify-bills.ts` 119/119, `verify-escpos.ts` 48/48.
- `pnpm exec tsc --noEmit` clean; `pnpm lint` 0 errors, 1 pre-existing warning (`src/server/socket/index.ts`).

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- A custom charge is one `ITEM_ADDED` row with `menu_item_id NULL` and the new `custom_name` (migration 0031, plus CHECK `order_events_item_names_one_source`). The row is the audit: staff, time, price.
- Wire: `SubmitRoundLine = SubmitMenuLine | SubmitCustomLine` (`isCustomLine`); the route parses `z.union` of two `.strict()` schemas; the custom name is sanitised (control characters) before being measured; price 1..10,000,000 paisa.
- Permission: `canAddCustomCharge(role)` in `src/server/auth/permissions.ts` (owner until Story 10.6); the route returns 403 `CUSTOM_CHARGE_NOT_ALLOWED` before writing; the order page passes the same answer to hide the + beside the total.
- `submitRound`: menu read and options only for menu lines (no read at all for a custom-only round); custom lines priced at their typed value; skipped in tickets; print-job insert guarded for an empty list.
- Readers: history and bill name a line `customName ?? itemName`; all other `ITEM_ADDED` readers only count and needed no change (checked each).
- Tablet: `StagedLine.customName` (tolerant read, no key bump), `addCustomLine`, `isCustomStaged`; custom lines skip the menu stale check and the card badges; a "Custom" tag on the staged row; new `CustomChargeSheet` (name, LKR price with cents, quantity, live total), opened from the + beside "Table total" (first shipped as a More-menu item, moved 2026-11-02); 403 shows "only the owner can add a custom charge".
- Not checked in a browser at first: the sheet and the More-menu item were type-checked and linted, not clicked through.

### File List

- src/server/db/schema.ts
- src/server/db/migrations/0031_common_power_pack.sql (new)
- src/server/db/migrations/meta/0031_snapshot.json (new)
- src/server/db/migrations/meta/_journal.json
- src/types/orders.ts
- src/server/auth/permissions.ts
- src/app/api/sessions/[sessionId]/orders/route.ts
- src/server/services/order.service.ts
- src/server/orders/submitted-rounds.ts
- src/server/services/bill.service.ts
- src/app/orders/[sessionId]/bill/page.tsx
- src/app/orders/[sessionId]/page.tsx
- src/components/pos/use-staged-round.ts
- src/components/pos/order-screen.tsx
- src/components/pos/order-summary.tsx
- src/components/pos/round-history.tsx
- src/components/pos/staged-round-list.tsx
- src/components/pos/custom-charge-sheet.tsx (new)
- src/server/services/verify-custom-charge.ts (new)

## Change Log

- 2026-11-01: Story 4.9 implemented — custom charges (owner only until 10.6): schema + CHECK, send route and service, readers, staged round, sheet and More-menu item, verification (21/21). Status → review.
- 2026-11-02: Placement changed (Teran): a "+ Custom charge" button in the order column above the totals (owner only) replaces the More-menu item. Add SAVES the charge immediately as its own small round (own send id, no staging, no Send, no ticket); errors stay in the sheet. History titles such a round "Custom charge · added <time>" (`SubmittedItemRow.custom`). Staging of custom lines removed; reading one already staged is kept. verify-custom-charge 22/22; owner sees the button, waiter does not (page render checked).
- 2026-11-02: The full-width button became a small + icon beside "Table total" (`OrderSummary.onAddCharge`, 44px target, labelled "Add custom charge") — rare and owner-only, so it takes no row (Teran).
- 2026-11-03: Code review — 1 decision (kept: charge-only rounds take a round number), 10 patches applied: 403 code reaches the screen, sheet locks after an uncertain save and cannot close mid-save, clearer seat refusals, closed-order handling, + hidden once billed, price wording, staged-read caps, strict walkout check, stale wording. verify-custom-charge 22/22; tsc and lint clean. Status → done.
