# Story 4.8: Implement Priced Options

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a bartender,
I want to add a Mojito as "double shot" or "no alcohol" and see the price change,
so that the bill is right without arithmetic.

**Source:** Story 4.8 in `_bmad-output/planning-artifacts/epics.md` (added 2026-10-31,
sprint-change-proposal-2026-10-31.md §4.1); FR65 in `prd.md`. Supersedes the
"structured modifier groups" deferral in `deferred-work.md` (logged against Epic 10)
and the free-text-only decision recorded in `modifier-sheet.tsx` and `schema.ts`.

Teran's worked example (2026-10-30): a cocktail is LKR 2,500; a double shot makes
it LKR 3,500; "without alcohol" makes it LKR 1,500. A mocktail is LKR 1,500; one
alcohol shot is LKR 1,000.

## Acceptance Criteria

1. **Options per item.** A menu item can have modifier groups. Each group has a
   name, a selection rule (`single` = pick at most one, `multi` = pick any),
   `required` (true/false), a display order, and options. Each option has a name,
   a price change in integer paisa (`price_delta_paisa`, may be negative or 0), an
   availability flag, a display order and an `is_default` flag. Groups belong to ONE
   item (not shared across items) in this story.

2. **Price rule — one function, everywhere.** A line's unit price is
   `max(0, item.price_paisa + Σ chosen option.price_delta_paisa)`. It is computed by
   ONE pure helper imported by the sheet, the staged round, the stale-price check and
   the server. A line never prices below zero.

3. **The menu carries the options.** `GET /api/menu` returns each item's
   `modifierGroups` (with their options, unavailable ones included and flagged, as
   unavailable items already are). Items with no groups return `[]`.

4. **One tap still works.** Tapping a dish card adds it with each required group's
   DEFAULT option preselected (e.g. Mojito → "Single"). If a required group has no
   default, the tap opens the options sheet instead. Items with no groups behave
   exactly as today.

5. **The options sheet.** The existing sheet (`modifier-sheet.tsx`) shows each group as
   a row of chips — required groups first and marked, optional below — with each
   option's price change shown as "+LKR 1,000" / "−LKR 1,000" (true minus sign) and
   nothing for a 0 change. Single groups behave as radios (tapping the chosen chip of a
   required group keeps it; of an optional group clears it); multi groups toggle.
   Unavailable options are shown disabled. The sheet shows the live unit price and the
   line total (`unit × quantity`) as choices change. "Add to Order" is disabled until
   every required group has a choice. The quantity stepper and free-text note stay.

6. **A dot on cards with options.** A menu card whose item has any modifier group
   shows a small indicator (per `ux-design-specification.md` §Menu Browse:
   "modifier dot (if modifiers available)").

7. **Staged lines carry options.** A staged line records the chosen option ids and a
   display snapshot of them (names, deltas) and its computed unit price. Two lines are
   the SAME line (and merge on re-tap) only if item, seat, note AND option set match. A
   staged round saved before this story still loads (missing options = none).

8. **Server is the authority.** `POST /api/sessions/:id/orders` accepts
   `optionIds: string[]` per line (optional, default `[]`, so older clients and stored
   rounds still work). Under the same transaction and `FOR SHARE` locks as the item
   check, the server refuses the WHOLE round if, for any line: an option id is unknown,
   belongs to a different item, or is unavailable; a single group has more than one
   choice; a required group has none; or an id repeats → **422 `OPTION_INVALID`** with
   `{ itemId, optionId?, groupId?, lineIndex, reason }`. Then it computes the unit
   price with the shared helper and refuses a mismatching quote → **409
   `PRICE_CHANGED`** now carrying `{ itemId, lineIndex, currentPricePaisa }` where
   `currentPricePaisa` is the computed UNIT price.

9. **Frozen at send.** The order event stores the computed unit price in
   `unit_price_paisa` (unchanged column, now base + deltas) and a snapshot of the chosen
   options (`order_events.options`, jsonb, nullable: `[{ optionId, group, name,
   priceDeltaPaisa }]`), copied at send and never re-read from the menu. Editing or
   retiring an option later never changes a sent line, a ticket or a bill.

10. **On the ticket.** Each item's chosen options print under it on the kitchen/bar
    ticket ("- Double shot", "- No ice"), before the free-text note, folded to ASCII,
    sanitised, wrapped to the 48-column paper. A print job queued BEFORE this deploy
    (no options field) still prints.

11. **On the order history and the bill.** The round history, the bill screen (whole
    view, split cards, settle) and stored bills show the options. `bill_lines` snapshots
    them (`bill_lines.option_text`), like the name and the note. Lines that differ only
    by options do NOT merge on the bill screen (`dishKey` includes them).

12. **Stale checks still guard the send.** The order screen flags a staged line before
    send when its option is gone or unavailable (new problem `option-unavailable`), or
    when the live computed unit price differs from the staged one (`price-changed`,
    carrying the new UNIT price). "Accept new price" updates THAT line only (per line,
    not per dish). A `PRICE_CHANGED` / `OPTION_INVALID` refusal names the right line.

13. **Sample options seeded.** Fresh installs (`seed.ts`) and existing databases
    (`seed-bar-menu.ts`, idempotent, adding groups to items that already exist) get:
    Mojito, Piña Colada, Long Island Iced Tea → "Alcohol" (single, required, default
    Single): No alcohol −LKR 1,000 / Single LKR 0 / Double shot +LKR 1,000; and "Ice"
    (multi, optional): No ice. Whisky shots → "Measure" (single, required, default
    Single): Single / Double (+ the shot's own price). Cappuccino, Iced Coffee →
    "Extras" (multi, optional): Extra shot +LKR 200, Oat milk +LKR 250.

14. **Verified.** A new `src/server/services/verify-options.ts` passes against the
    running dev server (matrix in Dev Notes), `verify-escpos.ts` gains an options case,
    `verify-bills.ts` still passes, and `pnpm exec tsc --noEmit` and `pnpm lint` are
    clean.

## Tasks / Subtasks

- [ ] **Task 1 — Schema and migration (AC: 1, 9, 11)**
  - [ ] `pgEnum('modifier_selection', ['single', 'multi'])`.
  - [ ] `modifier_groups`: id, tenantId (→ tenants, indexed), menuItemId (→ menu_items,
        indexed), name, selection, isRequired (default false), displayOrder (default 0),
        isActive (default true). MUTABLE config table — no append-only trigger.
  - [ ] `modifier_options`: id, tenantId (indexed), groupId (→ modifier_groups,
        indexed), name, priceDeltaPaisa `integer notNull default 0`, isDefault (default
        false), isAvailable (default true), displayOrder (default 0).
  - [ ] `order_events.options jsonb` nullable (`$type<OrderEventOption[]>`) — NO FKs in
        it; NULL means none. `bill_lines.option_text text` nullable.
  - [ ] `pnpm db:generate` → migration 0028 (generated name is fine). `ADD COLUMN` on
        the append-only tables is DDL and is NOT blocked; do NOT backfill (NULL = none).
  - [ ] Update the doc block on `orderEvents.modifierText` (schema.ts ~459-468) — it
        says no modifier model exists; it does now.
  - [ ] `pnpm db:migrate`.

- [ ] **Task 2 — The shared price helper (AC: 2, 8)**
  - [ ] New `src/lib/options.ts`, NO server imports (imported by client and server):
        `unitPriceFor(basePaisa, chosen: {priceDeltaPaisa}[])` →
        `Math.max(0, base + Σ)`; `optionText(chosen: {name}[])` → `"Double shot, No ice"`;
        `defaultOptionIds(groups)`; `validateSelection(groups, optionIds)` returning the
        first problem `{ reason, groupId?, optionId? }` or null (unknown/foreign option,
        unavailable, duplicate, >1 in single, missing required).
  - [ ] Types `ModifierGroupRow` / `ModifierOptionRow` / `OrderEventOption` in
        `src/types/orders.ts` (keep that file import-free).
  - [ ] Signed formatter in `src/lib/format.ts`: `signedLkrFromPaisa(delta)` →
        `"+LKR 1,000"`, `"−LKR 1,000"` (U+2212), `""` for 0. Do not reuse `deduction()`
        (takes rupees, drops "LKR").

- [ ] **Task 3 — Menu API (AC: 3)**
  - [ ] `MenuItemRow.modifierGroups: ModifierGroupRow[]` (required, `[]` when none).
  - [ ] Load groups (`isActive`) + options for the tenant in a second query, ordered by
        displayOrder, name; attach in the existing Map assembly. Unavailable options
        returned with `available: false`.
  - [ ] Preserve: unavailable items returned; single fetch; the socket patch spreads
        `...item` so the new field survives.

- [ ] **Task 4 — Staged round (AC: 7)**
  - [ ] `StagedLine` gains `optionIds: string[]` (sorted) and
        `options: { id, name, priceDeltaPaisa }[]` (display snapshot); `pricePaisa` is now
        the computed UNIT price.
  - [ ] `addLine(item, { seatSlotId, seatLabel, quantity?, modifierText?, optionIds? })`:
        default to `defaultOptionIds(item.modifierGroups)` when `optionIds` is undefined;
        compute price with `unitPriceFor`; merge only when `optionIds.join()` also matches.
  - [ ] `readStorage`: a missing `optionIds`/`options` reads as `[]` (precedent:
        `seatLabel`, ~:128); present values validated (array of strings / objects). NO
        storage-prefix bump — a bump would drop unsent rounds mid-service at deploy.
  - [ ] `acceptPrice(lineId, unitPricePaisa)` — per LINE, not per menuItemId.
  - [ ] Preserve: `newId()` non-secure fallback, `write()` resetting the send id,
        `clearSentLines`, the `MAX_LINE_QUANTITY` cap, functional updates.

- [ ] **Task 5 — Card and sheet (AC: 4, 5, 6)**
  - [ ] `menu-item-card.tsx`: tap adds with defaults; if `validateSelection(groups,
        defaultOptionIds(groups))` reports a missing required group, the tap calls
        `onOpenModifiers` instead. Options dot when `modifierGroups.length > 0`. Update
        the options button aria-label ("with options, a note or a quantity").
  - [ ] `modifier-sheet.tsx`: chip rows per group (required first, marked "Required"),
        signed deltas, disabled unavailable chips, live unit price + line total,
        Add disabled until valid; `onAdd({ quantity, modifierText, optionIds })`.
        Chips ≥ 56px tall (the system's waiter touch floor). Import
        `MAX_MODIFIER_TEXT` from `@/types/orders` (remove the local copy).
  - [ ] Preserve: native `<dialog>` + `showModal`, Escape → cancel, the two-ended
        backdrop press, `h-app`/`w-app` centring, the quantity stepper, the note.

- [ ] **Task 6 — Order screen and staged list (AC: 12)**
  - [ ] `stagedProblems`: per line, recompute from the live item + live options:
        missing/unavailable option → `{ kind: 'option-unavailable', optionName }`;
        computed unit ≠ `line.pricePaisa` → `price-changed` with the new UNIT price.
        Still nothing flagged while the menu is undefined; seat checks still first.
  - [ ] Send body adds `optionIds`; `quotedPricePaisa` stays the line's unit price.
  - [ ] `PRICE_CHANGED` / `OPTION_INVALID` handling locates the line by `lineIndex`
        (the server echoes it), not `lines.find(menuItemId)`.
  - [ ] `staged-round-list.tsx`: show the options (before the note) on each row; the
        `option-unavailable` message; Accept per line (`onAcceptPrice(lineId, price)`).
  - [ ] Pass `optionIds` from the sheet's `onAdd` through `stageItem`.

- [ ] **Task 7 — Server submission (AC: 8, 9)**
  - [ ] `orders/route.ts` schema: `optionIds: z.array(z.string().uuid()).max(20).default([])`;
        map `OptionInvalidError` → 422 `OPTION_INVALID`; add `lineIndex` to the
        `PRICE_CHANGED` body. Keep the unique-violation ordering comment intact.
  - [ ] `order.service.ts submitRound`: after the menu items' `FOR SHARE` read, read
        their groups and options `FOR SHARE` in the same transaction; per line, in line
        order: `validateSelection` → `OptionInvalidError(itemId, lineIndex, …)`;
        `unitPriceFor` → compare with `quotedPricePaisa` → `PriceChangedError(itemId,
        unit, lineIndex)`. Write `unitPricePaisa: unit` and `options: [snapshot]`.
  - [ ] Keep: replay-before-lock, line-order reporting, the Epic 8 placeholder position,
        `print_jobs` in the same transaction, emit only after commit.
  - [ ] `types/orders.ts`: `SubmitRoundLine.optionIds?`, error code `OPTION_INVALID`,
        `TicketLine.options?: string[]` (OPTIONAL — queued jobs predate it),
        `SubmittedItemRow.optionText`.

- [ ] **Task 8 — Tickets (AC: 10)**
  - [ ] `order.service.ts byDestination`: `TicketLine.options = snapshot names`.
  - [ ] `print/ticket.ts sanitizeLine`: sanitise every option string.
  - [ ] `print/escpos.ts buildTicket.item()`: after `"{qty} x {name}"`, one
        `"- {option}"` line per option (fold to ASCII FIRST, then `wrapLine` at
        indent+3), then the note. Guard with `Array.isArray(line.options)`. A name that
        folds to empty prints `"- (option)"`.
  - [ ] `print/transport.ts renderTicketText`: the same, in step.
  - [ ] `verify-escpos.ts`: add a case with options (incl. a long one that wraps and a
        legacy line with no `options` field).

- [ ] **Task 9 — History and bill (AC: 11)**
  - [ ] `submitted-rounds.ts` + `round-history.tsx`: select `options`, render the names.
  - [ ] `bill.service.ts`: select `orderEvents.options` in `collectBillable`; snapshot
        `optionText(options)` into `bill_lines.option_text` in `buildBill`; return it from
        `buildBill` and `getBill`. Money unchanged (unit price already includes deltas).
  - [ ] `types/bills.ts BillLineDetail.optionText`; `bill/page.tsx` maps it for recorded
        and draft lines; `bill-screen.tsx` `BillScreenLine.optionText`, `dishKey` includes
        it, and it renders on lines and split cards (before the note).

- [ ] **Task 10 — Seeds (AC: 13)**
  - [ ] `bar-menu.ts`: `SeedItem.modifierGroups?`; the options in AC 13; update the
        "Stage B" comment.
  - [ ] `seed.ts`: `.returning({ id })` on the item insert, then insert groups/options.
  - [ ] `seed-bar-menu.ts`: for every bar item (found OR created), ensure each group by
        (item, name) and each option by (group, name) — idempotent; second run changes
        nothing.
  - [ ] Run it on the dev database.

- [ ] **Task 11 — Verification (AC: 14)**
  - [ ] New `src/server/services/verify-options.ts` (matrix below), on the
        `verify-bills.ts` pattern; its own item in an INACTIVE category so live tablets
        never see it; cleanup deletes its order_events with triggers disabled in
        try/finally, then options, groups, item, category.
  - [ ] Re-run `verify-bills.ts`; pin its `firstItem` / `addItem` queries to items with
        NO required groups if they now pick one.
  - [ ] `pnpm exec tsc --noEmit`, `pnpm lint`, the three verify scripts.

## Dev Notes

### Decisions taken for this story (with reasons)

- **Groups per item, not shared.** The AC says "per item". A shared "Ice" group across
  drinks needs a join table and admin UI (Story 10.4); not now.
- **Snapshot as jsonb on the event, not folded into `modifier_text`.** `modifier_text`
  is the waiter's free text; mixing owner-defined options into it loses the structure
  (option ids, deltas) an audit (Epic 7) will want. `order_events.options` holds
  `{optionId, group, name, priceDeltaPaisa}`; `bill_lines.option_text` holds the words.
  No FKs inside the snapshot, so retiring an option never conflicts with history.
- **Defaults make one tap still work.** The UX promise is "zero-decision flow" and
  "two taps maximum" (`ux-design-specification.md` lines ~29, ~43). A required group
  with a default (Single) lets the card tap add instantly; the sheet is for changes.
- **Clamp at zero.** Matches the AC; LKR 0 lines and bills are already supported
  (commit 9282156 — "Record LKR 0 bill").

### The path a dish takes — files, current state, change, preserve

Full map: produced by research on commit `963f975`. Line numbers are approximate.

| Area | File | Today | Change | Must preserve |
|---|---|---|---|---|
| Schema | `src/server/db/schema.ts` | menu_items ~245-280 (no options); order_events ~433-506 (`unitPricePaisa` nullable, `modifierText`); bill_lines ~638-682 (snapshot name/seat/modifier) | new tables; `order_events.options`; `bill_lines.option_text` | append-only triggers on order_events, bills, bill_lines (migrations 0001, 0018) — never UPDATE rows |
| Menu API | `src/app/api/menu/route.ts` | `MenuItemRow` ~17-35; one LEFT JOIN query ~85-95; unavailable items returned | `modifierGroups` | type-only import into client files (no `server-only`) |
| Staging | `src/components/pos/use-staged-round.ts` | `StagedLine` ~23-40; merge on item+seat+note ~344-349; `acceptPrice(menuItemId,…)` ~411-418; tolerant `readStorage` ~89-136 | `optionIds`, `options`; merge includes options; per-line accept | `newId` fallback, `write()` resets send id, `clearSentLines`, caps |
| Card | `src/components/pos/menu-item-card.tsx` | tap = add as-is ~109-128; options glyph ~193-213 | defaults; route to sheet when required has no default; dot | 56px targets, "Add another" sr text |
| Sheet | `src/components/pos/modifier-sheet.tsx` | qty + note; `<dialog>`; local `MAX_MODIFIER_TEXT` ~11 | chips, live price, validity | dialog semantics, backdrop two-ended press (records a lost-note bug) |
| Order screen | `src/components/pos/order-screen.tsx` | `stagedProblems` ~690-723 compares base price; send body ~786-795; `refusedDishName` by itemId ~771-775; sheet ~1597-1610 | recompute with options; `optionIds` on the wire; locate by `lineIndex` | `sendIdForRound`, nothing flagged before menu loads, seat checks first, `sendBlocked` |
| Staged list | `src/components/pos/staged-round-list.tsx` | problem union ~18-29; Accept by menuItemId ~225-237 | options shown; `option-unavailable`; Accept per line | 56px repair buttons, stepper cap |
| Route | `src/app/api/sessions/[sessionId]/orders/route.ts` | `submitSchema` ~56-76; error mapping ~240-268 | `optionIds` default `[]`; `OPTION_INVALID`; `lineIndex` | ROUND_CONFLICT-before-PKEY ordering; emit after commit; no emit on replay |
| Service | `src/server/services/order.service.ts` | `submitRound` ~186-436; items `FOR SHARE` ~259-270; price check ~273-281; insert ~325-341; tickets ~344-359 | options read `FOR SHARE`; validate; compute; snapshot | replay before lock; line-order errors; Epic 8 placeholder position; print_jobs same tx |
| Types | `src/types/orders.ts` | limits ~36-38; `SubmitRoundLine`, `TicketLine`, `SubmittedItemRow` | fields above | file stays import-free |
| Tickets | `src/server/print/{ticket,escpos,transport}.ts` | `sanitizeLine` ~46-54; `buildTicket.item()` ~316-325; 48 cols; `renderTicketText` ~40-66 | option lines | queued jobs without the field still print; fold-then-measure (a 51-col overflow bug is recorded ~275-283) |
| Bill | `src/server/services/bill.service.ts`, `src/types/bills.ts`, `src/app/orders/[sessionId]/bill/page.tsx`, `src/components/pos/bill-screen.tsx` | snapshot name/note into bill_lines; `dishKey` ~205-207 | `option_text` snapshot; `dishKey` includes it | never join live menu/options at render (a rename once rewrote history) |
| History | `src/server/orders/submitted-rounds.ts`, `src/components/pos/round-history.tsx` | shows `modifierText` | show options | — |
| Seeds | `src/server/db/{bar-menu,seed,seed-bar-menu}.ts` | Mojito 250000, Whisky shots; seed-bar-menu `continue`s on found items | options; ensure-by-name | own pg Pool (`./index` imports server-only); idempotent; refuses production |

### Traps (each one would ship a bug)

1. **Merge must include options** — else tapping Double after Single bumps the Single
   line at the Single price.
2. **Accept is per line** — per dish it stamps one price on a Single and a Double.
3. **The client stale check must add the deltas** — comparing the base price flags
   every optioned line "price changed" forever and blocks Send.
4. **Required group + one tap** — without defaults the server refuses the WHOLE round.
5. **Same helper on both sides** — any divergence in the clamp or sum is a refused send.
6. **Never re-read options to display a sent line** — use the snapshot.
7. **`dishKey` must include options** — else "Mojito / No ice" and "Mojito" merge on
   the bill at the same price.
8. **Queued print jobs** — `TicketLine.options` optional; guard with `Array.isArray`.
9. **Lock options `FOR SHARE`** with the items, or a re-price can slip between check
   and insert.
10. **`optionIds` optional on the wire** — older tablets, mirrored rounds and
    `verify-bills.ts` bodies keep working.
11. **Negative money formatting** — `lkrFromPaisa(-100000)` prints a hyphen; use the
    new signed formatter.
12. **No storage-prefix bump** — tolerant read instead (see Task 4).

### Testing standards

No unit-test runner exists (no vitest/jest; CI only builds). Verification is
`verify-*.ts` scripts run with `pnpm exec tsx --env-file=.env <file>` against
`pnpm dev`, following `src/server/services/verify-bills.ts` (login with seed PINs
waiter 1234 / owner 5678; `check(name, ok, detail)`; a `mine` cleanup registry;
`try/finally cleanup()` that disables and re-enables the append-only triggers).

**`verify-options.ts` matrix:**
1. Correct quote with options → 201; `unit_price_paisa` = base + deltas; snapshot stored.
2. Wrong quote → 409 `PRICE_CHANGED` with the computed unit price and `lineIndex`.
3. Option from another item → 422 `OPTION_INVALID` (`reason: 'foreign'`).
4. Two options in a single group → 422 (`reason: 'too-many'`).
5. Required group missing → 422 (`reason: 'required'`).
6. Unavailable option → 422 (`reason: 'unavailable'`).
7. Duplicate option id → 422 (`reason: 'duplicate'`).
8. Deltas below zero → unit clamped to 0, accepted at quote 0.
9. Re-price the option after send → event and a later bill unchanged.
10. `print_jobs.ticket` lines carry the options.
11. `bill_lines.option_text` carries them; `getBill` returns them after an option rename.
12. Body without `optionIds` on an item with no groups → 201 (backward compatible).
13. Replay with the same `submissionId` → 200 replayed, no new events.

### Project Structure Notes

- New: `src/lib/options.ts`, `src/server/services/verify-options.ts`, migration 0028.
- Migrations: generated by `pnpm db:generate` (random names are the convention);
  hand-written SQL only via `drizzle-kit generate --custom --name=…`.
- Money: integer paisa only; display through `src/lib/format.ts`.
- Comments in this codebase record WHY and past bugs; keep that style and update the
  comments this story falsifies (schema `modifierText` doc, `modifier-sheet.tsx` header,
  `bar-menu.ts` "Stage B", the card's aria-label, `types/orders.ts` `quotedPricePaisa` doc).

### Previous story intelligence (Epic 4)

- **4.4 review** found: hydration mismatches from reading storage in a `useState`
  initialiser; mutators reading `lines` from the render closure (use functional
  updates); `crypto.randomUUID()` missing on plain-http tablets; dead controls; touch
  targets below 56px; `text-slate-400` failing AA. Do not reintroduce any.
- **4.5** established: the quote is a CHECK, never a value — the server writes its own
  price; `PRICE_CHANGED` flags the line and the waiter accepts; a changed line gets a
  new `submissionId`.
- **This session's billing review** (`deferred-work.md`, 2026-10-31): bills are written at
  Settle; LKR 0 bills are paid by definition; `bill_lines.quantity` + trigger guard
  double billing.

### Git intelligence

Recent commits: `963f975` stories done after review; `d3a9608` UI review fixes;
`9282156` server review fixes (LKR 0 bills, no auto-close); `c21a051` bar menu seed
(`bar-menu.ts`, `seed-bar-menu.ts`); `8e5cc0a`/`0954c95` menu Drinks pill. Patterns: one
commit per concern, long explanatory commit messages, verification recorded in them.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 4.8: Implement Priced Options]
- [Source: _bmad-output/planning-artifacts/prd.md#FR65]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-10-31.md#4.1]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md#Modifier Entry (~line 425-427), #Menu Browse (~line 417)]
- [Source: _bmad-output/implementation-artifacts/4-5-implement-order-submission-and-multi-destination-routing.md#Dev Notes (quote is a check)]
- [Source: _bmad-output/implementation-artifacts/4-4-implement-add-item-to-order-with-modifiers-and-seat-assignment.md#Review Findings]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
