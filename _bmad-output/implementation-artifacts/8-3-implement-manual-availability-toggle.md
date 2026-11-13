# Story 8.3: Sold out — manual availability toggle (86 an item)

Status: review

<!-- Go-live. Next after 10.3 lite in the launch order. Testing deferred to the final round (launch rush). -->

## Decisions (Teran, 2026-11-13)

- **Who:** owner AND waiters, without the Manage password. There is no `manager` role
  (`permissions.ts`); a waiter is who hears "the fish is finished" from the kitchen, and the owner is not
  always on site. Kitchen role: no (they tell a waiter). Every toggle is logged with the person's id.
- **Where:** inside the Manage dashboard, as the **Sold out** section `/manage/sold-out` — no separate
  screen (Teran: one dashboard for everything). It is the one Manage section that opens WITHOUT the
  Manage password, and the only one a waiter can reach: a waiter in Manage sees just "Sold out" in the
  section list. Reached from the staff badge menu ("Sold out") on the floor and order screens, and from
  the Manage section list for the owner.
- **Options too:** a sauce or side can run out as well. The order screen already greys unavailable
  options (`modifier-sheet.tsx`), so the same screen toggles options.
- Portion counts (8.1, 8.2) are NOT built. `portion_count` exists but nothing sets it; ignore it except
  to pass it through in the socket payload.

## Story

As a waiter or the owner,
I want to mark a dish (or an option) sold out, and back on, from one quick screen during service,
so that no tablet can send an order for something the kitchen has run out of.

## Acceptance Criteria

1. **Reach it.** The staff badge menu (`staff-menu.tsx`) shows **Sold out** for owner and waiter roles
   (not kitchen), above Switch user (and below Manage for the owner). It opens `/manage/sold-out`.
   - No Manage password is asked for `/manage/sold-out` — owner or waiter.
   - Every OTHER Manage page and `/api/manage/...` route keeps both gates (owner role + Manage session)
     exactly as today. A waiter who types `/manage/menu` is sent to `/`; an owner without a Manage
     session who clicks Menu from the Sold out section gets the unlock screen, as today.
   - Kitchen: `/manage/sold-out` → `/`; `/api/menu-items/...` and `/api/menu-options/...` → 403.
   - In the Manage section list a waiter sees only **Sold out** (plus Back to floor; no Lock button).
     The owner sees all sections as today.
2. **The section.** Manage → Sold out (replacing the `ComingSoon` placeholder) lists every ACTIVE dish (`is_active = true`, active category), grouped by
   category in the menu's order, with the Food / Drinks split and category icons as in Manage → Menu
   (drinks = a category whose active dishes all print at the bar — reuse the 10.4 rule, don't copy it).
   - A search field at the top filters dishes by name (case-insensitive, as you type).
   - Each dish row: name, price, and a large toggle (≥ 44px target) labelled "Available" / "Sold out".
     Sold-out rows are visibly marked (struck name, `unavailable-*` tokens).
   - A **"Sold out now (N)"** block at the top lists everything currently off — dishes and options —
     each with its toggle, so putting things back on never needs scrolling. Hidden when N = 0.
   - A dish with active option groups has a small "Options" disclosure under it; opening it shows each
     active option with its own toggle.
   - It sits in the Manage layout (section list beside it); "Back to floor" is the nav's existing link.
3. **Toggle a dish.** `PATCH /api/menu-items/:itemId/availability` with `{ available: boolean }`:
   - sets `menu_items.is_available`; **last write wins** — no expected version is sent (a boolean set
     twice is the same result; a STALE error mid-service would only slow a waiter down);
   - when the value actually changes: `version + 1`, `updated_at = now()`, and one `config_changes` row
     in the same transaction (FR71, like 10.4). When it is already that value: no write, no log row,
     200 with the current state;
   - an inactive (removed) or unknown dish, or another tenant's: 404 `NOT_FOUND`;
   - after commit, emits `menu:item_updated` `{ itemId, available, portionCount }` (the existing
     `emitMenuItemUpdated`; the waiter menu already patches its cache from it);
   - returns 200 `{ success: true, data: { id, available, version } }`.
4. **Toggle an option.** `PATCH /api/menu-options/:optionId/availability` with `{ available }`: same
   rules on `modifier_options.is_available` (inactive option, or one whose group/dish is inactive → 404),
   then emits `menu:changed` (options have no fast-path payload; the menu refetches).
5. **Put all back on.** A "Put everything back on" button in the "Sold out now" block (shown when
   N > 0) with a one-step confirm ("Put 4 items back on?"). `POST /api/menu-items/availability/reset`
   sets every active sold-out dish AND option back to available in ONE transaction — one version bump and
   one `config_changes` row per changed row — then emits `menu:changed` once. Returns the count.
6. **Every tablet within 2 s.** The order screen's menu greys the dish and disables Add without a refresh
   (already wired to `menu:item_updated` / `menu:changed`). A staged, unsent line for that dish is
   flagged by the existing staged-problems logic in `order-screen.tsx`, and Send refuses it on the
   server (`order.service.ts` already throws `ItemUnavailableError` on `!isAvailable`). The Sold out
   section on another tablet also updates (listen to both events and invalidate its query).
7. **Manage stays consistent.** Manage → Menu (`menu-editor.tsx`) also invalidates its query on
   `menu:item_updated`, so a toggle elsewhere bumps the version it holds and the owner's next edit is not
   refused as STALE. Manage → Menu does not get its own toggle (one place to do it).
8. **Optimistic and honest.** A toggle flips at once; if the request fails it flips back and shows a
   short inline message ("Could not save. Try again."). Double taps while saving are ignored for that row.
9. **Verify script** `src/server/services/verify-sold-out.ts` passes (see Testing).

Out of scope: portion counts (8.1/8.2), the dashboard inventory alert (Epic 9), "sold out by whom" on
screen, a per-person permission (10.6 may narrow waiters later — through ONE function, see Task 1).

## Tasks / Subtasks

- [x] **Task 1 — Access (AC 1)**
  - [x] `permissions.ts`: add `{ prefix: '/manage/sold-out', roles: ['owner','waiter'] }` (longest
        prefix beats `/manage` owner-only), `{ prefix: '/api/menu-items', roles: ['owner','waiter'] }`,
        `{ prefix: '/api/menu-options', roles: ['owner','waiter'] }` BEFORE any route exists (unmatched
        prefix = default-allow). Add `canMarkSoldOut(role)` → owner or waiter, with the same comment
        pattern as `canOpenCashDrawer` (10.6 changes this function and these entries together). Update
        the `/manage` comment that says "Story 8.3 gives that screen its own route outside".
  - [x] `proxy.ts`: exempt `/manage/sold-out` (exact, or `startsWith('/manage/sold-out/')`) from
        `needsManageSession` — a separate `MANAGE_PASSWORD_FREE` set with a comment, NOT added to
        `MANAGE_GATE_EXEMPT` (that one means "the way in"). Same exact-or-slash test as
        `findRoutePolicy`, so `/manage/sold-outx` is still gated. The APIs live under `/api/menu-items`
        and `/api/menu-options`, outside `/api/manage`, so they need no gate change.
  - [x] Manage layout + nav: `(area)/layout.tsx` reads the role (`headers().get('x-staff-role')`, set by
        the proxy) and passes it to `ManageNav`. Mark the Sold out entry in `MANAGE_SECTIONS` as
        `waiter: true` (or similar); for a waiter the nav shows only those sections and hides Lock.
        `(area)/page.tsx` redirects a waiter to `/manage/sold-out` instead of `/manage/menu`.
- [x] **Task 2 — Service (AC 3, 4, 5)** in `src/server/services/menu-admin.service.ts` (it owns
      `TABLES`, `log`, the errors):
  - [x] `setItemAvailable(tx, { tenantId, staffId, id, available })` — UPDATE … WHERE id, tenant,
        `is_active`, `is_available <> $available` RETURNING; if no row, read it: missing/inactive →
        `MenuNotFoundError`, else return the unchanged row (no log). On a change, `log(...)`. Returns the
        row. Category must be active too (join or a second read).
  - [x] `setOptionAvailable(tx, …)` — same for options; option, its group and its dish all active.
  - [x] `resetAvailability(tx, { tenantId, staffId })` — UPDATE … SET is_available = true, version + 1
        WHERE active AND NOT is_available RETURNING, for items then options; `log` each row. Returns count.
  - [x] `loadSoldOutBoard(db, tenantId)` — active categories → active dishes (id, name, pricePaisa,
        available, destination) → active groups → active options (id, name, available), menu order.
        Reuse `loadMenuForManage` if its shape fits; don't write a third menu query.
- [x] **Task 3 — Routes (AC 3, 4, 5)**
  - [x] `src/app/api/menu-items/[itemId]/availability/route.ts` (PATCH),
        `src/app/api/menu-options/[optionId]/availability/route.ts` (PATCH),
        `src/app/api/menu-items/availability/reset/route.ts` (POST),
        `src/app/api/menu-items/sold-out/route.ts` (GET, the board).
  - [x] Use the shared helper in `src/server/menu-admin/route.ts`: add `soldOutWrite(request, write,
        broadcast)` (or let `manageWrite` take the broadcast) — actor from the staff row, one transaction,
        broadcast after commit, same error mapping. The item route broadcasts
        `emitMenuItemUpdated({ itemId, available, portionCount })` from the returned row, so the write must
        return the row. Zod: `{ available: z.boolean() }`, `idSchema` for the param.
  - [x] Note `[itemId]` vs the existing `idParam(params)` helper, which reads `.id` — either name the
        folder `[id]` or add a param name argument. Do not let `menu-items/availability/reset` collide with
        `[id]`: static segments win in Next, but check the PATCH on `[id]/availability` isn't shadowed.
- [x] **Task 4 — Screen (AC 2, 6, 8)**
  - [x] `src/app/manage/(area)/sold-out/page.tsx` (replace the `ComingSoon` placeholder) rendering
        `src/components/manage/sold-out-board.tsx` (client), styled like `menu-editor.tsx` /
        `floor-editor.tsx` (reuse `manage-ui.tsx` pieces): TanStack Query key `['sold-out']`, socket
        listeners for `menu:item_updated` and `menu:changed` → invalidate; search; Food/Drinks pills;
        "Sold out now" block; per-dish Options disclosure; optimistic toggles with rollback.
  - [x] Toggle control: a real `<button role="switch" aria-checked>` with a visible text state. Rows
        keyed by id (not id+version — the switch must not remount mid-tap).
  - [x] Reuse `menuCategoryIcon`, `routeForDestination`/`StationChip` look, `formatLkr` — import, don't
        copy. If the Food/Drinks split lives inside `menu-editor.tsx`, move that function to a shared
        module (e.g. `src/lib/menu-sections.ts`) and import it from both.
- [x] **Task 5 — Entry points (AC 1, 7)**
  - [x] `staff-menu.tsx`: optional `onSoldOut` prop → a "Sold out" item (lucide `Ban` or `CircleSlash`
        icon) above Switch user. Pass it from `table-grid.tsx` and `order-header.tsx` when
        `canMarkSoldOut(role)`; navigate with the router.
  - [x] Update the Sold out `MANAGE_SECTIONS` text ("Mark dishes and options sold out. Waiters can do
        this too, without the password.").
  - [x] `menu-editor.tsx`: also invalidate on `menu:item_updated` (AC 7).
- [x] **Task 6 — Verify (AC 9)** `src/server/services/verify-sold-out.ts`, run with
      `npx tsx --conditions=react-server src/server/services/verify-sold-out.ts`. Do NOT send accepted
      orders (the dev server prints to the real XP-80C). Cases:
  - [x] item off → `is_available` false, version + 1, one `config_changes` row with the staff id;
        same call again → no version change, no new row;
  - [x] item on again; removed item → NotFound; another tenant's id → NotFound;
  - [x] option off/on, and an option under a removed dish → NotFound;
  - [x] reset: 2 dishes + 1 option off → count 3, all on, 3 log rows;
  - [x] `order.service` refuses a sold-out dish (call the validation path that throws
        `ItemUnavailableError` without committing an accepted send — or roll the transaction back);
  - [x] RBAC: `isRoleAllowed` true for owner/waiter, false for kitchen on `/manage/sold-out`,
        `/api/menu-items/x/availability`, `/api/menu-options/x/availability`; waiter still false on
        `/manage`, `/manage/menu`, `/api/manage/menu`; `/manage/sold-out` needs no Manage session but
        `/manage/sold-outx` and `/manage/menu` still do (export `needsManageSession` or move it to a
        testable module);
  - [x] cleanup restores every row it touched (and deletes only its own `config_changes` rows — the table
        is DELETE-guarded by a trigger; follow how `verify-menu-admin.ts` handles it).
  - [x] `npx tsc --noEmit` and `npm run lint` clean.

## Dev Notes

### What already exists (don't rebuild)

- `menu_items.is_available` and `modifier_options.is_available` (default true). `is_active = false` means
  REMOVED (10.4) and is a different thing — never touch `is_active` here.
- `/api/menu` returns unavailable items on purpose (greyed, not hidden) — leave it.
- Waiter side is done: `menu-browser.tsx` patches the cache on `menu:item_updated` and refetches on
  `menu:changed`; `menu-item-card.tsx` greys and disables Add (label "Off today"); `modifier-sheet.tsx`
  disables unavailable options; `order-screen.tsx` flags staged lines that became unavailable;
  `order.service.ts:330` refuses `!isAvailable || !isActive` on send.
- `emitMenuItemUpdated` / `MenuItemUpdatedPayload` in `src/server/socket/events.ts` — exists, unused
  until now. Use it; import the payload type, never retype it.
- `recordConfigChange` (`config-change.service.ts`) — the only writer of `config_changes`; `log()` in
  `menu-admin.service.ts` wraps it with `TABLES[kind].name`.
- `versionedUpdate` needs an expected version — that's why the toggle gets its own small UPDATE
  (decision above: last write wins).

### Guardrails

- No semicolons; don't run prettier. `createElement(lookupIcon(...), props)` for dynamic icons (React
  Compiler lint `static-components`). No ref reads during render.
- Tenant from the staff row (`actorOf`), never from the request.
- Socket emit AFTER the transaction commits, never inside it.
- New route prefixes go in `ROUTE_ROLES` before the route file exists.
- Whole-rupee prices are display only here; nothing writes prices.

### Files

- UPDATE: `src/proxy.ts`, `src/server/auth/permissions.ts`, `src/server/services/menu-admin.service.ts`,
  `src/server/menu-admin/route.ts`, `src/components/pos/staff-menu.tsx`, `src/components/pos/table-grid.tsx`,
  `src/components/pos/order-header.tsx`, `src/components/manage/menu-editor.tsx`,
  `src/app/manage/(area)/{layout,page,manage-nav,sections}.tsx`, `src/app/manage/(area)/sold-out/page.tsx`.
- NEW: `src/components/manage/sold-out-board.tsx`, the four route files above,
  `src/server/services/verify-sold-out.ts`, possibly `src/lib/menu-sections.ts`.
- No migration: every column exists.

### Testing

No test framework; each story adds a `verify-*.ts` script (see `verify-menu-admin.ts`,
`verify-floor-admin.ts` for the manage-session-free, tenant-scoped pattern). Browser try of Manage → Sold out (owner and waiter)
on a tablet goes into the final test round.

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Story 8.3 (amended 2026-11-04)]
- [Source: _bmad-output/implementation-artifacts/10-0-*.md — Trap 1: no manager role]
- [Source: _bmad-output/implementation-artifacts/10-4-implement-menu-management.md — versioning, config_changes, Food/Drinks]
- [Source: src/server/socket/events.ts — `menu:item_updated` naming and payload rule]
- [Source: src/server/auth/permissions.ts — default-allow for unmatched prefixes]

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Debug Log References

- `pnpm exec tsx --env-file=.env src/server/services/verify-sold-out.ts` → 32/32 (dev server running).
- Regression: verify-menu-admin 31/31, verify-floor-admin 30/30. verify-manage NOT run: a real Manage
  password is set and the script needs `VERIFY_MANAGE_PASSWORD`. The gate cases this story touches are
  re-checked in verify-sold-out (waiter → `/`, owner without a session → unlock, `/manage/sold-out` free,
  `/manage/sold-outx` still gated).
- `npx tsc --noEmit` clean; `npm run lint` 0 errors (1 older warning in `socket/index.ts`).

### Completion Notes List

- Access: `needsManageSession` moved from `proxy.ts` to `src/server/auth/manage-gate.ts` (testable), with a
  separate `MANAGE_PASSWORD_FREE` list (exact-or-slash match). `ROUTE_ROLES` has `/manage/sold-out`,
  `/api/menu-items` and `/api/menu-options` for owner + waiter; `canMarkSoldOut(role)` added.
- The Manage layout reads `x-staff-role`; a waiter sees only Sold out and no Lock. `/manage` sends a
  non-owner to Sold out.
- Service: `setItemAvailable`, `setOptionAvailable`, `resetAvailability` (last write wins; version bump and
  log row only on a real change; the whole active chain is required, otherwise NotFound).
  `loadSoldOutBoard` reuses `loadMenuForManage`, which now also returns `isAvailable` on dishes and options.
- Routes: PATCH `/api/menu-items/[itemId]/availability` (emits `menu:item_updated` from the returned row),
  PATCH `/api/menu-options/[optionId]/availability` and POST `/api/menu-items/availability/reset` (emit
  `menu:changed`), GET `/api/menu-items/sold-out`. Shared `soldOutWrite` in `menu-admin/route.ts`; the
  broadcast now receives the write's result; `idParam` takes a param name. The item PATCH also returns
  `portionCount`, passed through to the socket payload.
- Screen: `sold-out-board.tsx` — search (covers the whole menu; the Food/Drinks pills are set aside while
  typing), Food/Drinks pills, a "Sold out now (N)" block with "Put everything back on" and a confirm, a
  per-dish Options disclosure, `role="switch"` toggles (44px, "Available" / "Sold out"), optimistic with
  rollback and "Could not save. Try again.", double taps ignored while saving. Listens to both menu events.
- The Food/Drinks rule moved to `src/lib/menu-sections.ts` and both editors import it. `ConfirmDialog` got an
  optional `confirmLabel`.
- Entry points: staff badge menu "Sold out" (Ban icon) between Manage and Switch user, on the floor (through
  `FloorHeader`) and the order screen (through `OrderHeader`, with `canMarkSoldOut` from the order page).
  Manage → Menu invalidates on `menu:item_updated`.
- Left for the final test round: a browser try of Sold out as owner and as waiter on a tablet.

### File List

- src/proxy.ts (modified)
- src/server/auth/manage-gate.ts (new)
- src/server/auth/permissions.ts (modified)
- src/server/services/menu-admin.service.ts (modified)
- src/server/menu-admin/route.ts (modified)
- src/server/services/verify-sold-out.ts (new)
- src/app/api/menu-items/[itemId]/availability/route.ts (new)
- src/app/api/menu-items/availability/reset/route.ts (new)
- src/app/api/menu-items/sold-out/route.ts (new)
- src/app/api/menu-options/[optionId]/availability/route.ts (new)
- src/app/manage/(area)/layout.tsx (modified)
- src/app/manage/(area)/page.tsx (modified)
- src/app/manage/(area)/manage-nav.tsx (modified)
- src/app/manage/(area)/sections.tsx (modified)
- src/app/manage/(area)/sold-out/page.tsx (modified)
- src/app/orders/[sessionId]/page.tsx (modified)
- src/components/manage/sold-out-board.tsx (new)
- src/components/manage/menu-editor.tsx (modified)
- src/components/manage/manage-ui.tsx (modified)
- src/lib/menu-sections.ts (new)
- src/components/pos/staff-menu.tsx (modified)
- src/components/pos/floor-header.tsx (modified)
- src/components/pos/order-header.tsx (modified)
- src/components/pos/order-screen.tsx (modified)
- src/components/pos/table-grid.tsx (modified)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified)

## Change Log

- 2026-11-13: Story 8.3 implemented — Manage → Sold out for owner and waiters without the Manage password;
  dish and option toggles, put everything back on, live updates; verify-sold-out 32/32. Status → review.
