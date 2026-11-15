---
title: 'Manage UI polish before launch: password eye, enable/disable switches, settings layout with sample bill'
type: 'feature'
created: '2026-11-15'
status: 'done'
baseline_commit: 'da63f53'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Owners can't check what they typed into password/PIN fields. Menu and Floor hide rows behind a "Remove" bin and a "Show removed" checkbox, with no way back for categories or zones. The category/zone columns are cramped. Settings is one long column with no picture of the printed bill.

**Approach:**
- Add a shared password input with an eye toggle.
- Replace Remove/Restore on Menu and Floor with an on/off switch on every row. Disabled rows stay listed in Manage, greyed out, and are hidden from the POS.
- Widen the category and zone columns.
- Give Settings a left section nav and a live sample bill on the right, built from the unsaved form values.

## Boundaries & Constraints

**Always:**
- Disabled means `is_active = false`, the same flag "Remove" sets today. The POS queries already hide it.
- No DB migration.
- The sample bill is drawn from the same wrap/amount helpers the printer uses (`wrapLine`, `amountLines`, `foldToAscii`, `PAPER_COLUMNS` from `src/server/print/escpos.ts`, which is pure and client-safe), so its line breaks match the paper.
- The logo is drawn from the raster (`rasterToRgba`).

**Ask First:**
- Letting a category or zone be disabled while it still has enabled dishes or tables (a cascade).
- Adding any npm dependency, e.g. a QR library.

**Never:**
- An eye on the login PIN pad.
- Hard deletes.
- Changing the escpos byte output.
- Building or pushing a Docker image (Teran, 2026-11-15).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Disable dish | switch off | greyed in Manage, gone from POS menu | STALE → reload + message |
| Disable category with enabled dishes | switch off | refused, switch stays on | existing CategoryNotEmpty message: "Turn its dishes off first" |
| Enable category / zone | switch on a disabled one | listed normally again, back on POS | STALE → reload |
| Enable dish whose category is disabled | switch on | refused | existing MenuRuleError message |
| Disable table in use | switch off | refused | existing TableInUse message |
| Enable table whose zone is disabled | switch on | refused with message "Turn its zone on first" | 409 |
| Settings preview | type in header/footer/name | sample bill updates live, wraps at 48 cols | — |
| Preview, QR link empty | — | no QR block | — |

</frozen-after-approval>

## Code Map

- `src/components/password-input.tsx` -- NEW shared input + eye button (Eye/EyeOff, `aria-pressed`, 44px target).
- `src/app/manage/unlock/unlock-form.tsx`, `src/app/setup/setup-form.tsx`, `src/app/vendor/vendor-panel.tsx`, `src/components/manage/staff-editor.tsx` -- password/PIN fields.
- `src/server/services/menu-admin.service.ts` -- `removeCategory`, `setItemActive`, `loadMenuForManage` (categories filtered to active).
- `src/server/services/floor-admin.service.ts` -- `removeZone`, `setTableActive`, `loadFloorForManage` (`removed` list).
- `src/app/api/manage/menu/items/[id]/restore/route.ts` -- pattern for new restore routes.
- `src/components/manage/menu-editor.tsx`, `floor-editor.tsx` -- columns (`lg:w-72`), rows, "Show removed" checkbox, ConfirmDialog.
- `src/components/manage/settings-editor.tsx` -- Card sections, form state.
- `src/server/print/escpos.ts` -- `buildReceipt` layout to mirror.

## Tasks & Acceptance

**Execution:**
- [x] `src/components/password-input.tsx` -- create; use it in the 4 forms, staff editor's own toggle replaced -- one behaviour everywhere.
- [x] `menu-admin.service.ts` -- `setCategoryActive(enable)`; manage loader returns disabled categories (with `isActive`) and always all dishes -- re-enable path.
- [x] `floor-admin.service.ts` -- `setZoneActive(enable)`; table enable refuses a disabled zone with a clear MenuRule-style message -- re-enable path.
- [x] `src/app/api/manage/menu/categories/[id]/restore/route.ts`, `src/app/api/manage/floor/zones/[id]/restore/route.ts` -- POST enable, same shape as item restore.
- [x] `src/components/manage/manage-ui.tsx` -- `Switch` (role="switch", aria-checked, 44px).
- [x] `menu-editor.tsx`, `floor-editor.tsx` -- a switch on each category/dish/zone/table row; disabled rows greyed with an "Off" chip, after the enabled ones, not draggable; drop "Show removed" and the remove confirm; widen the columns `lg:w-72` → `lg:w-80`.
- [x] `src/components/manage/settings/sample-bill.tsx` -- NEW 48-col monospace paper:
  - logo, name, header lines;
  - sample table, date and two dish lines;
  - Subtotal, Service, Tax and Total, computed from the form's percents;
  - footer, a QR block (a QR icon box plus a shortened link) and the caption.
- [x] `settings-editor.tsx` -- three columns at `xl`:
  - left: section nav (Bill, Logo, Review QR, Money, Business day) that scrolls to the section;
  - middle: the form;
  - right: sticky sample bill.
  - Stacked below `xl`, with the preview after the form.
- [x] `verify-menu-admin.ts`, `verify-floor-admin.ts` -- add category/zone enable cases.

**Acceptance Criteria:**
- Given any form password/PIN field, when the eye is tapped, then the text shows and the label reads "Hide".
- Given a disabled dish/table, when a waiter opens the POS, then it is not shown, and in Manage it is visible, greyed, with its switch off.
- Given the settings form is edited but not saved, then the sample bill already shows the change.

## Design Notes

The sample bill is a picture of paper, not a print. It uses `font-mono`, `width: 48ch`, a white background in both themes, and the name in double size (24 cols). Using the real wrap helpers keeps an over-long header line breaking exactly as it will print. A true QR would need a library, so the preview shows a QR placeholder; the printer still draws the real one.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: clean
- `pnpm exec tsx --env-file=.env src/server/services/verify-menu-admin.ts` and `verify-floor-admin.ts` -- expected: all pass

**Manual checks:**
- Tablet width: the columns fit. Settings at 1280px shows three columns.

## Spec Change Log

- 2026-11-15 (Teran, during implementation): the Settings left column is a menu with a single item, **Bill**, not five section links. Later pages (Printers, Security, …) join it.
- Review patches: parent rows locked (`FOR UPDATE`) in switch-off and child switch-on paths; switches that can only fail are disabled with a reason; edit sheets offer only on parents; table-in-off-zone → 409 `ZONE_OFF`; sample bill shows the link and warns about what Save or the printer will refuse; layout stacks below `xl`.

## Suggested Review Order

**On/off switches (Menu, Floor)**

- Entry point: off = `is_active` false; switching back on puts it at the end of the list.
  [`menu-admin.service.ts:164`](../../src/server/services/menu-admin.service.ts#L164)

- Parent row locked first, so a child switched on at the same moment is counted.
  [`menu-admin.service.ts:147`](../../src/server/services/menu-admin.service.ts#L147)

- The same for zones, plus the "Turn its zone on first" guard (409).
  [`floor-admin.service.ts:205`](../../src/server/services/floor-admin.service.ts#L205)
  [`floor-admin.service.ts:102`](../../src/server/services/floor-admin.service.ts#L102)

- One switch component; `why` disables it and explains.
  [`manage-ui.tsx:98`](../../src/components/manage/manage-ui.tsx#L98)

- Category and zone switches refuse while children are on.
  [`menu-editor.tsx:376`](../../src/components/manage/menu-editor.tsx#L376)
  [`floor-editor.tsx:282`](../../src/components/manage/floor-editor.tsx#L282)

- New "switch back on" routes mirror the item restore route.
  [`restore/route.ts:8`](../../src/app/api/manage/menu/categories/[id]/restore/route.ts#L8)
  [`route.ts:124`](../../src/server/menu-admin/route.ts#L124)

**Settings with sample bill**

- The preview uses the printer's own wrap helpers, so lines break as they print.
  [`sample-bill.tsx:63`](../../src/components/manage/settings/sample-bill.tsx#L63)

- Left menu (Bill only for now) and the three-column layout.
  [`settings-editor.tsx:29`](../../src/components/manage/settings-editor.tsx#L29)

**Password eye**

- Shared field; used by unlock, setup, vendor and staff PIN.
  [`password-input.tsx:15`](../../src/components/password-input.tsx#L15)

**Tests**

- Category off/on cycle, listing, STALE.
  [`verify-menu-admin.ts:206`](../../src/server/services/verify-menu-admin.ts#L206)

- Zone off/on, table blocked in an off zone.
  [`verify-floor-admin.ts:217`](../../src/server/services/verify-floor-admin.ts#L217)
