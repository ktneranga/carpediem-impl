---
title: 'Manage → Restaurant settings, with logo upload'
type: 'feature'
created: '2026-11-14'
status: 'done'
baseline_commit: '41853a2'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The bill's name, header, footer, logo, review QR, service charge, tax and business-day hour can only be set in the database or the seed file; a restaurant set up from empty has no way to set them.

**Approach:** A Manage → Settings page (owner, behind the Manage password) that edits those fields, and turns an uploaded PNG/JPG into the printer's 1-bit logo in the browser, with a preview of exactly what will print. No Google logo or second QR (Teran, 2026-11-14).

## Boundaries & Constraints

**Always:** Owner + Manage password (the `/api/manage` prefix). The server re-validates everything, including the logo bytes with the same rules the printer uses (`widthDots` multiple of 8, ≤ 576; `heightDots` 1–600; byte length = rows × width/8). Service charge in basis points (0–3000, two decimals of a percent); tax a whole percent (0–30, the column is an integer). Business-day hour 0–23. QR link: printable ASCII, no spaces, ≤ 300, `http(s)://`. Header/footer: up to 6 lines of 48 characters each. A save is recorded in `config_changes`. Concurrent edits: a stale save is refused (409), never silently overwritten.

**Ask First:** converting tax to basis points; letting the owner change the time zone here.

**Never:** server-side image libraries (conversion is in the browser); storing the original image; changing what was already billed (rates apply to new bills only).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open | owner, Manage unlocked | form filled with current values and the current logo preview | N/A |
| Save | valid fields | 200; next bill prints the new header/footer/QR/logo; next new bill uses the new rates | N/A |
| Invalid field | e.g. service 40%, QR with a space, 7 header lines | 422 naming the field; nothing saved | form shows it |
| Logo upload | PNG/JPG ≤ 5 MB | scaled to the chosen width (192/288/384 dots), black-and-white by a lightness threshold the owner can slide, transparent = white; preview; saved with the form | non-image or > 5 MB: message, nothing changes |
| Remove logo | "Remove logo" | saved as null; bills print no logo | N/A |
| Stale | another tablet saved since this one loaded | 409 `STALE`, form reloads | N/A |

</frozen-after-approval>

## Code Map

- `src/server/db/schema.ts` -- `tenantConfig` (restaurant_name, receipt_header/footer, receipt_qr_url/caption, receipt_logo, tax_rate_percent, service_charge_bp, updated_at), `tenants.business_day_start_hour`
- `src/server/print/escpos.ts` -- `rasterImage` rules (mirror them on save); `src/server/print/ticket.ts` -- `receiptTextLines`, QR ASCII rule
- `src/server/menu-admin/route.ts` -- `actorOf`, `readBody`, `menuFail`, manage write pattern
- `src/server/services/config-change.service.ts` -- `recordConfigChange`
- `src/app/manage/(area)/sections.tsx` -- add the Settings section; `staff/page.tsx` + `components/manage/staff-editor.tsx` -- page/editor pattern, `manage-ui` controls

## Tasks & Acceptance

**Execution:**
- [x] `src/server/services/settings.service.ts` -- `loadSettings(tenantId)` (fields + `updatedAt` as the version), `checkSettings(input)` (field-named `SettingsFieldError`), `checkLogo(logo)` (printer rules), `saveSettings(tx, actor, input, expectedUpdatedAt)`: lock the config row, refuse stale, update tenant_config (+ `updated_at = clock_timestamp()`) and `tenants.business_day_start_hour`, record a `config_changes` row for `tenant_config` (version = number of previous config changes for it + 1; payload without the logo bytes, `logoChanged: true` instead)
- [x] `src/app/api/manage/settings/route.ts` -- `GET` and `PUT`; zod body ≤ 200 KB; maps field errors 422, stale 409
- [x] `src/lib/logo-raster.ts` -- pure function: RGBA pixels + width + threshold → `{ widthDots, heightDots, data }` (alpha-composite on white, luminance < threshold = ink, MSB-left rows, height capped at 600 by scaling); and `rasterToImageData` for the preview
- [x] `src/components/manage/settings-editor.tsx` + `src/app/manage/(area)/settings/page.tsx` -- sections: Bill (name, header, footer), Review QR (link, caption), Logo (file input → canvas → `logo-raster`, width choice, threshold slider, preview at print scale, Remove), Money (service %, tax %), Day (turnover hour, with "applies to new orders"); one Save; light/dark like the other Manage pages
- [x] `src/app/manage/(area)/sections.tsx` -- add `Settings` (owner only, after Staff)
- [x] `src/server/services/verify-settings.ts` -- matrix rows through the service: valid save + reload, each invalid field, stale refused, logo rules (bad width / short data refused, good accepted), remove logo, config_change written without logo bytes; and `logo-raster` on a tiny synthetic image (known bits)

**Acceptance Criteria:**
- Given a saved logo, when a bill prints, then `escpos.rasterImage` accepts it (same validator).
- Given the service charge changed, when a NEW bill is generated, then it uses the new rate; an existing bill is unchanged.

## Design Notes

`updated_at` is the version (tenant_config has no `version` column; adding one is not needed for one row edited by one owner). Conversion runs in the browser on a `<canvas>`, so the POS server needs no image library — the reason the column stores a ready raster.

## Verification

**Commands:**
- `npx tsx --conditions=react-server --env-file=.env src/server/services/verify-settings.ts` -- all pass
- `npx tsc --noEmit -p .` and `npx eslint` on touched files -- clean
- `verify-receipt.ts`, `verify-bills.ts` -- still pass

**Manual checks:**
- Upload the Carpe Diem logo, save, print a bill on the real printer.

## Suggested Review Order

**Saving safely**

- Entry point: lock the row, refuse a stale version, save, record the change.
  [`settings.service.ts:161`](../../src/server/services/settings.service.ts#L161)

- Every field checked, field-named errors, control characters removed.
  [`settings.service.ts:121`](../../src/server/services/settings.service.ts#L121)

- The logo is accepted only if the printer's own validator would print it.
  [`settings.service.ts:87`](../../src/server/services/settings.service.ts#L87)

**The logo, in the browser**

- Pixels → 1-bit raster: transparent is paper, lightness threshold, MSB left.
  [`logo-raster.ts:39`](../../src/lib/logo-raster.ts#L39)

- Pick, resize, threshold, preview drawn from the raster that will print.
  [`settings-editor.tsx:243`](../../src/components/manage/settings-editor.tsx#L243)

**Page and tests**

- Form keyed by version; stale saves explain themselves; no focus refetch.
  [`settings-editor.tsx:48`](../../src/components/manage/settings-editor.tsx#L48)

- 27 checks: converter bits, save/reload, every invalid field, stale, logo rules.
  [`verify-settings.ts:1`](../../src/server/services/verify-settings.ts#L1)
