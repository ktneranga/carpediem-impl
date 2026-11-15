---
title: 'Menu bulk upload from an Excel sheet'
type: 'feature'
created: '2026-11-15'
status: 'done'
baseline_commit: 'b3e804e'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Entering a full menu (about 150 dishes for Carpe Diem) one dish at a time in Manage → Menu takes hours.

**Approach:**
- Manage → Menu gets a **Bulk upload** button.
- It downloads an .xlsx of the current menu: Dishes and Options sheets plus a "How to" sheet. On a new POS the sheets are empty.
- The owner fills the sheet in and uploads it. The server checks every row and shows what will change; **Import** applies it all in one transaction.
- Also deliver the Carpe Diem menu, taken from the PDF, as a ready-filled sheet.

## Boundaries & Constraints

**Always:**
- Write through the existing menu-admin service functions, so names, prices, versions and `config_changes` follow today's rules.
- All or nothing: one transaction, and any row error imports nothing.
- Matching is case-insensitive: category by name, dish by category + name, option group by dish + name, option by group + name.
- Existing rows are updated only where a value differs. Rows never in the sheet are left alone; nothing is ever deleted (Teran: option a).
- Row order in the sheet is the order of new rows.
- One `menu:changed` broadcast.
- Owner or `manage_menu`, the same gate as Manage → Menu.

**Ask First:**
- Deleting or switching off rows missing from the sheet.
- Uploads over 1,000 rows.

**Never:**
- A DB migration.
- Dish descriptions (Teran: no).
- Excluded-group links (`excludesGroupId`) in the sheet; they stay in Manage.
- Building or pushing an image.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh POS | filled sheet, empty menu | check shows "N categories, M dishes new"; Import creates them | — |
| Same sheet uploaded twice | no edits | check shows "nothing to change"; Import writes nothing | — |
| Price edited | one dish 2300 → 2500 | "1 dish updated", price set | — |
| Bad row | price "abc", 2350.5, empty name, name > 60, unknown station | nothing imported; list "Dishes row 14: Price must be whole rupees" | 422 with every error |
| Duplicate | same category + dish twice | error on the second row | 422 |
| Option row for a dish not in the sheet and not on the menu | — | error naming the row | 422 |
| Matches a switched-off category or dish | — | error "is switched off in Manage: switch it on or rename" | 422 |
| Not an xlsx / over 1 MB | — | "Choose the .xlsx you downloaded" | 400 |

</frozen-after-approval>

## Code Map

- `src/server/services/menu-admin.service.ts` -- createCategory/createItem/updateItem/createGroup/updateGroup/createOption/updateOption, cleanName (1–60), checkPrice (whole rupees, ≥0 for dishes), checkMaxCount (1–10), loadMenuForManage.
- `src/server/menu-admin/route.ts` -- `menuWrite` (actor, tx, broadcast, error mapping), `menuFail`.
- `src/app/api/manage/menu/route.ts` -- GET auth pattern (x-staff-id → tenant).
- `src/components/manage/menu-editor.tsx` -- header where the button goes; `call`, sheet patterns.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- add `exceljs` (pinned).
- [x] `src/server/menu-import/workbook.ts` -- NEW, pure, no `server-only`, so scripts can use it.
  - `buildMenuWorkbook(categories)` → xlsx Buffer.
  - **Dishes** sheet: Category | Dish | Price (LKR) | Station.
  - **Options** sheet: Category | Dish | Option group | Choose (One/Many) | Required (Yes/No) | Option | Extra price (LKR) | Default (Yes/No) | Max per dish.
  - Station and Yes/No columns get dropdowns; the header row is frozen and bold.
  - **How to** sheet: short instructions.
  - `parseMenuWorkbook(buffer)` → rows, or a list of errors.
- [x] `src/server/services/menu-import.service.ts` -- NEW.
  - `importMenu(tx, {tenantId, staffId, rows, apply})` matches against the menu and returns a summary (new/updated counts per kind plus errors).
  - With `apply` it writes through the menu-admin functions; without it, it only plans.
- [x] `src/app/api/manage/menu/import/route.ts` -- NEW.
  - GET downloads `menu-YYYY-MM-DD.xlsx`.
  - POST takes multipart `file` (≤1 MB) and `?apply=1`. Check runs in a read-only tx; apply runs via `menuWrite`.
- [x] `src/components/manage/menu-import-sheet.tsx` -- NEW sheet:
  1. Download the sheet.
  2. Choose the filled file, which is checked straight away.
  3. Show the summary or the errors (sheet, row, message).
  4. **Import** (disabled while there are errors), then reload the menu.
- [x] `src/components/manage/menu-editor.tsx` -- "Bulk upload" secondary button in the header opens the sheet.
- [x] `src/server/services/verify-menu-import.ts` -- matrix cases against a running server.
- [x] `_bmad-output/carpe-diem-menu.xlsx` -- the Carpe Diem menu from the PDF, made with `buildMenuWorkbook`. Contents:
  - Typos fixed: Margherita, Chocolate Brownie, Smoothie, Lassi, turmeric.
  - Variants kept as one dish at their price, e.g. "Classic/Coconut/Passion Mojito".
  - Add-ons as a category.
  - Stations: pizzas → Pizza kitchen; all drinks and Shisha → Bar; other food → Kitchen.
  - "Wine bottle", which has no price, is left out.

**Acceptance Criteria:**
- Given an empty menu, when the Carpe Diem sheet is uploaded and imported, then every category and dish appears on the POS in sheet order, at its price and station.
- Given the menu was imported, when Bulk upload's download is opened, then it holds exactly that menu, and uploading it unchanged changes nothing.

## Design Notes

The download and the upload use the same format, so "download, edit, upload" is also how someone fixes many prices at once. Checking first and importing second lets the owner see "12 new, 3 updated" before anything is written. The check runs the same matching code with `apply: false` and writes nothing.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit`, `pnpm lint` -- clean
- `pnpm exec tsx --env-file=.env src/server/services/verify-menu-import.ts` -- all pass
- `pnpm exec tsx --env-file=.env src/server/services/verify-menu-admin.ts` -- still 38/38

## Spec Change Log

- Review patches (2026-11-15): blank Options cells keep live values on existing groups/options (new ones take defaults); group Choose/Required conflicts across rows are errors; header row verified (no shifted columns); dates, #REF! and unsaved formulas flagged; a dish already in another category is refused, not duplicated; apply serialised per restaurant (advisory lock); body size checked before reading; a broken/foreign file is a 400 file error; the screen imports the exact bytes it checked; no broadcast when nothing changed.

## Suggested Review Order

**Matching and writing**

- Entry point: plan and apply share one path; apply locks, then writes via menu-admin.
  [`menu-import.service.ts:36`](../../src/server/services/menu-import.service.ts#L36)

- A dish already in another category is refused rather than duplicated.
  [`menu-import.service.ts:159`](../../src/server/services/menu-import.service.ts#L159)

- Group settings gathered across rows; blanks keep live values.
  [`menu-import.service.ts:185`](../../src/server/services/menu-import.service.ts#L185)

**The sheet format**

- Reading: header check, bad cells, blank → undefined.
  [`workbook.ts:207`](../../src/server/menu-import/workbook.ts#L207)

- Writing: the download, dropdowns and How to.
  [`workbook.ts:68`](../../src/server/menu-import/workbook.ts#L68)

**Route and screen**

- Size before reading, file errors 400, check read-only then apply.
  [`route.ts:39`](../../src/app/api/manage/menu/import/route.ts#L39)

- Check, show the summary, Import the same bytes.
  [`menu-import-sheet.tsx:47`](../../src/components/manage/menu-import-sheet.tsx#L47)

**Tests**

- 17 cases against the running server.
  [`verify-menu-import.ts:83`](../../src/server/services/verify-menu-import.ts#L83)
