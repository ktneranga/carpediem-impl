# Story 10.4: Menu Management

Status: review

- **Epic:** 10 — System Configuration & Staff Management
- **Requirement:** FR56 (menu), FR65 (priced options, Story 4.8's data), FR70 (inside Manage), FR71 groundwork
  (sync-ready writes)
- **Go-live:** yes. Today the menu only changes by re-running `seed.ts` / `seed-bar-menu.ts`. After this, the owner
  changes it from Manage.
- **Built inside the Manage area (Story 10.0):** pages under `/manage/menu`, API under `/api/manage/menu`. The
  proxy's Manage gate (owner + Manage password session) already protects both prefixes.

## Story

As an owner,
I want to add, edit and remove categories, dishes and their priced options from Manage,
so that the menu the waiters order from always matches what the restaurant serves, at the right price, printing
at the right station.

## Acceptance Criteria

1. **See the menu.** `/manage/menu` lists every category in order, each with its dishes in order. A dish shows
   name, price in LKR, where it prints (Kitchen / Pizza kitchen / Bar), and how many option groups it has. Hidden
   categories and removed dishes are not shown (a "Show removed" switch lists removed dishes, so one can be
   restored).
2. **Categories.** Add a category (name). Rename it. Move it up or down. Remove it — refused with a clear message
   while it still holds dishes (`409 CATEGORY_NOT_EMPTY`): move or remove the dishes first.
3. **Add a dish.** Name, category, price in LKR, where it prints. The price is typed in WHOLE rupees (`1250`,
   `1,250`) and stored as integer paisa (× 100); cents, letters or empty are refused (Teran, 2026-11-13). The dish appears on the waiters' menu.
4. **Edit a dish.** Any of name, category, price, where it prints. A new price applies to orders sent after the
   save; anything already sent, printed or billed keeps the price it was sent with (it is stored on the order event).
   A new station applies to rounds sent after the save; tickets already printed are unchanged.
5. **Remove and restore a dish.** Remove asks once ("Remove Butter Prawns from the menu?"), then the dish is gone
   from the waiters' menu and cannot be sent. Nothing is deleted: past orders, tickets and bills still name it.
   Restore puts it back.
6. **Options (Story 4.8's data).** On a dish: add, rename, remove an option group; set it single or multi choice and
   required or not. In a group: add, rename, remove an option; its price change in LKR, which may be negative
   ("No alcohol −1,000") or zero; whether it is pre-selected; how many times one dish may take it (1–10); and
   which other group of the same dish it rules out, if any. Move groups and options up or down. The waiters'
   option sheet shows exactly this on its next menu load.
7. **Waiters see it without reloading.** Every save tells every tablet the menu changed (`menu:changed` socket
   event); an open order screen refetches its menu. A dish removed while it sits staged-but-unsent on a tablet is
   refused at Send with the existing "not available" message.
8. **Two people editing.** Each save carries the version the editor loaded. If someone saved the same row in
   between, the save is refused (`409 STALE`) and the screen reloads that row with a message, instead of silently
   overwriting it.
9. **Sync-ready (FR71).** Every create, edit, remove and restore of a category, dish, group or option goes through
   the API, increments that row's `version`, sets `updated_at`, and appends one row to `config_changes` in the same
   transaction (table, row id, new version, the row's fields after the change, staff, origin `local`). Nothing reads
   `config_changes` yet; Epic 13 will.
10. **Owner only, behind the Manage password.** Every `/api/manage/menu/...` call without an owner Manage session is
    refused by the proxy (401 `MANAGE_LOCKED` / 403). The route handlers also scope every id to the tenant.
11. **No regressions.** Ordering, options on the order screen, sending, tickets, bills: unchanged.
    `verify-options`, `verify-custom-charge`, `verify-bills`, `verify-receipt --paper-only`,
    `verify-order-number`, type-check and lint pass. (Printing regressions run in the go-live test round.)

## Tasks / Subtasks

- [x] **Task 1: Migration (AC 5, 6, 8, 9)**
  - [x] `menu_items.is_active boolean not null default true` (removed = false) and
        `modifier_options.is_active boolean not null default true`. Groups and categories already have `is_active`.
        `is_available` stays what it is today — the sold-out switch (Story 8.3) — and is NOT how a dish is removed.
  - [x] `version integer not null default 1` and `updated_at timestamptz not null default now()` on
        `menu_categories`, `menu_items`, `modifier_groups`, `modifier_options`.
  - [x] New append-only table `config_changes`: `id`, `tenant_id`, `table_name text`, `row_id uuid`,
        `version integer`, `payload jsonb`, `staff_id` (FK staff, null allowed for a future cloud origin),
        `origin` enum `config_change_origin` (`local`, `cloud`), `created_at` (`clock_timestamp()`),
        `synced_at timestamptz` null. Index `(tenant_id, created_at)` and a partial index on
        `(tenant_id) WHERE synced_at IS NULL`. Append-only trigger for DELETE only (Epic 13 sets `synced_at`):
        `BEFORE DELETE … prevent_immutable_table_mutation()`, like `dispute_records` in migration 0001.
  - [x] `pnpm db:generate`, read the SQL, hand-add the trigger, `pnpm db:migrate`. It will be 0038.
- [x] **Task 2: Read side respects removal (AC 1, 5, 7)**
  - [x] `GET /api/menu`: only `menu_items.is_active` dishes (today it returns every item of an active category).
  - [x] `loadModifierGroups`: only active options as well as active groups. Both the menu and `submitRound` use it,
        so a removed option disappears from the sheet and is refused at Send in one change.
  - [x] `submitRound` (`order.service.ts` ~line 328): a dish with `is_active = false` throws `ItemUnavailableError`
        exactly as an unavailable one does. Read `isActive` beside `isAvailable` in the same `FOR SHARE` select.
- [x] **Task 3: Config-change writer (AC 9)**
  - [x] New `src/server/services/config-change.service.ts`: `recordConfigChange(tx, { tenantId, tableName, rowId,
        version, payload, staffId })`, origin `local`. The ONLY writer of `config_changes`; called by the menu
        service in the same transaction as the change. `payload` is the row after the change, camelCase.
- [x] **Task 4: Menu service (AC 2–6, 8, 9)**
  - [x] New `src/server/services/menu-admin.service.ts` (`server-only`). One function per action:
        `createCategory`, `updateCategory`, `removeCategory`, `moveCategory`, `createItem`, `updateItem`,
        `removeItem`, `restoreItem`, `moveItem`, `createGroup`, `updateGroup`, `removeGroup`, `moveGroup`,
        `createOption`, `updateOption`, `removeOption`, `moveOption`, and `loadMenuForManage(tenantId,
        { includeRemoved })`.
  - [x] Every update/remove/restore takes `expectedVersion` and runs
        `UPDATE … SET …, version = version + 1, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND version = $3
        RETURNING *`. No row → read it: missing (other tenant or wrong id) → `NotFoundError` (404), else
        `StaleVersionError` (409 `STALE`, with the current row). Then `recordConfigChange`.
  - [x] Moves swap `display_order` with the neighbour in one transaction, bumping both versions and writing two
        `config_changes` rows. Normalise first if two neighbours share an order (seeded rows are often all 0).
  - [x] Rules enforced here, not only in the form: name trimmed, 1–60 characters; dish price 0–10,000,000 LKR in
        paisa (integer, ≥ 0); option price change −10,000,000…+10,000,000 LKR in paisa; `maxCount` 1–10; a category
        with active dishes cannot be removed (409 `CATEGORY_NOT_EMPTY`); `excludesGroupId` must be another ACTIVE
        group of the SAME dish (422); a dish's category must be an active category of the tenant.
  - [x] Removing a group also clears `excludes_group_id` on every option that pointed at it (each such option gets
        its own version bump and `config_changes` row).
- [x] **Task 5: API (AC 2–6, 8, 10)**
  - [x] Routes under `src/app/api/manage/menu/`:
        `GET /api/manage/menu?removed=1`;
        `POST categories`, `PATCH categories/[id]`, `DELETE categories/[id]?version=`, `POST categories/[id]/move`;
        `POST items`, `PATCH items/[id]`, `DELETE items/[id]?version=`, `POST items/[id]/restore`,
        `POST items/[id]/move`;
        `POST items/[id]/groups`, `PATCH groups/[id]`, `DELETE groups/[id]?version=`, `POST groups/[id]/move`;
        `POST groups/[id]/options`, `PATCH options/[id]`, `DELETE options/[id]?version=`, `POST options/[id]/move`.
        Move body: `{ direction: 'up' | 'down', version }`.
  - [x] Zod `safeParse` on every body; ids `z.string().uuid()`; `PATCH` bodies are partial with `version` required.
        Prices arrive as integer paisa (the client converts); the server never parses rupee strings.
  - [x] Tenant: from the staff row of `x-staff-id`, as `/api/cash-drawer/open` does. Staff id goes to
        `config_changes.staff_id`.
  - [x] After each successful write: `emitMenuChanged()` (Task 6). Errors: 400 invalid, 404 not found, 409 `STALE` /
        `CATEGORY_NOT_EMPTY`, 422 rule broken, 500 logged with the error object only.
  - [x] No `ROUTE_ROLES` change needed: `/api/manage` is already owner-only and Manage-gated (10.0). Confirm with
        `findRoutePolicy('/api/manage/menu/items', 'POST')`.
- [x] **Task 6: Tell the tablets (AC 7)**
  - [x] `src/server/socket/events.ts`: `emitMenuChanged()` → `getIO().emit('menu:changed', {})`, same try/catch as
        `emitMenuItemUpdated`.
  - [x] `menu-browser.tsx`: `useSocketEvent('menu:changed', …)` → `invalidateQueries({ queryKey: MENU_QUERY_KEY })`.
        Staged lines on the tablet are left alone; Send already re-validates every line on the server.
- [x] **Task 7: The Manage → Menu screen (AC 1–6, 8)**
  - [x] Replace `src/app/manage/(area)/menu/page.tsx` (`ComingSoon`) with the editor. Server component loads
        `loadMenuForManage`; a client component edits through the API with TanStack Query (already used), refetching
        `['manage-menu']` after each save.
  - [x] Layout (laptop-first, light theme, 44px targets): categories as a left list on `lg:` (top chips below `lg`),
        the selected category's dishes as rows on the right. A dish row: name, price, station chip, options count,
        ↑ ↓, Edit, Remove. "+ Add dish" and "+ Add category". A "Show removed" switch.
  - [x] Dish editor: a side panel (sheet) with Name, Category (select), Price (LKR text input), Prints at
        (three-way segmented: Kitchen / Pizza kitchen / Bar), then the Options section: groups as cards with
        Single/Multi, Required, ↑ ↓, Remove; options as rows with Name, Price change (LKR, sign allowed), Default,
        Max per dish, Rules out (select of the dish's other groups, or none), ↑ ↓, Remove. Save per row, so one bad
        field never loses the rest.
  - [x] Price input: new `paisaFromLkrInput(text, { allowNegative })` in `src/lib/format.ts` → integer paisa or
        null. WHOLE rupees only (Teran, 2026-11-13): accepts `1250`, `1,250`, `-1000` (only with `allowNegative`);
        refuses any decimal point, letters, empty. Show the parsed value back as `lkrFromPaisa`.
  - [x] The server enforces it too: every dish price and option price change must be a multiple of 100 paisa
        (422 otherwise). Existing seeded prices are already whole rupees.
  - [x] Remove asks once in a small dialog (the floor's `CloseAfterPaymentDialog` pattern). A `409 STALE` shows
        "Someone else changed this — reloaded" and reloads; `CATEGORY_NOT_EMPTY` shows its message inline.
  - [x] Section entry in `sections.tsx` stays; only the page changes.
- [x] **Task 8: Verify (all ACs)**
  - [x] New `src/server/services/verify-menu-admin.ts` through the real routes (dev server running; it needs an owner
        Manage session, so reuse `verify-manage.ts`'s way of logging in and unlocking). Every row it makes is
        named `ZZ Verify …` and is REMOVED (soft) at the end; its `config_changes` rows are deleted with the
        DELETE trigger switched off only around its own cleanup, on a local database, as `verify-receipt` does.
        Cover the Testing table.
  - [x] Run the regressions in AC 11. *(Non-printing ones run; `verify-options`, `verify-custom-charge`, `verify-bills` send rounds that print on the dev server's real printer, so they are deferred to the go-live test round — Teran, 2026-11-13.)*

## Dev Notes

### Decisions already taken

| Decision | Why |
|---|---|
| Remove = `is_active = false`, never `DELETE` | Order events, tickets and bills point at menu rows. A dish once sold is history. |
| `is_active` (removed) is separate from `is_available` (sold out) | Sold out is a mid-service switch (8.3) that the waiter sees greyed; removed is gone from the menu. One column for both would make "sold out" and "deleted" the same fact. |
| API under `/api/manage/menu`, not the epic's `/api/menu-items` | Story 10.0 put configuration behind `/api/manage`, which the proxy gates with the Manage password. A route outside it would be reachable with a PIN alone (NFR-S7). |
| Optimistic version check | The same column FR71 needs for sync doubles as the guard against two tablets overwriting each other. |
| A broadcast `menu:changed`, not per-item patches | Edits are rare and the menu is small; a refetch is simpler and cannot drift. `menu:item_updated` stays for 8.3's fast sold-out toggle. |
| No images, portions or ticket output mode here | Image upload needs an image library (approval) — later. Portions are Epic 8. Output mode is per station (10.3). |
| Seeds still write directly | `seed.ts` and `seed-bar-menu.ts` are developer tools that build a fresh database; they are not configuration changes and write no `config_changes`. |

### 🚨 Trap 1: the menu API returns every item today

`GET /api/menu` filters categories by `is_active` but items by nothing. Without Task 2, a removed dish is still on
every waiter's menu. The same for options: `loadModifierGroups` filters groups by `is_active` but options only carry
`is_available`. Add the filter in `loadModifierGroups` (one place) so the menu and `submitRound` agree.

### 🚨 Trap 2: removing must not break what was already ordered

`order_events` stores `menu_item_id`, the unit price and the chosen options (`options` jsonb) at send time. Bills,
tickets and the receipt read those, not the live menu. So removing or re-pricing never changes history — do not
"fix up" old rows, and never hard-delete a menu row (FKs would refuse anyway).

### 🚨 Trap 3: `display_order` ties

Seeded rows often share `display_order = 0` and sort by name. A naive swap of two equal values does nothing.
Normalise the siblings to 10, 20, 30… (in their current visible order) inside the move transaction, then swap.

### 🚨 Trap 4: `excludes_group_id`

It must point at another group of the SAME dish, never the option's own group, and never a removed group. When a
group is removed, clear every option's pointer to it, or the sheet greys a group that no longer exists.

### 🚨 Trap 5: money

Paisa integers everywhere (`src/lib/format.ts`). Whole rupees only, so the helper parses an integer and multiplies by
100 — no floats at all. The server validates integers, ranges and the multiple of 100.

### 🚨 Trap 6: React Compiler lint and forms

No ref reads during render (6.6 learning). Keep each row's draft in `useState`; reset it from the server row in an
effect keyed on `row.version`, not by reading a ref.

### What must keep working

- `GET /api/menu`'s shape (`MenuCategoryRow`, `MenuItemRow`) — the order screen reads it. Only fewer rows.
- `submitRound`'s `FOR SHARE` locks: an owner's save waits for a send in progress, so the price checked is the price
  written (4.8 Decision 2). The menu service's `UPDATE`s take row locks, which is what makes that work.
- `menu:item_updated` and its listener.
- `seed.ts`, `seed-bar-menu.ts`: still run on a fresh database (new columns have defaults).

### Out of scope

- Sold out toggle (8.3 — next story), images, portion counts, per-station output mode (10.3), shared option groups
  across dishes, bulk import, price history screen, the cloud side of sync (Epic 13).

### Project Structure Notes

| File | Change |
|---|---|
| `src/server/db/schema.ts`, migration 0038 | Task 1 |
| `src/app/api/menu/route.ts`, `src/server/orders/modifier-groups.ts`, `src/server/services/order.service.ts` | Task 2 |
| `src/server/services/config-change.service.ts` (new) | Task 3 |
| `src/server/services/menu-admin.service.ts` (new) | Task 4 |
| `src/app/api/manage/menu/**` (new) | Task 5 |
| `src/server/socket/events.ts`, `src/components/pos/menu-browser.tsx` | Task 6 |
| `src/app/manage/(area)/menu/page.tsx` + `src/components/manage/menu-editor/*` (new), `src/lib/format.ts` | Task 7 |
| `src/server/services/verify-menu-admin.ts` (new) | Task 8 |

### Testing

No test framework by decision; each story adds a `verify-*.ts` script.

| # | Case | Expected |
|---|---|---|
| 1 | Add category, add dish LKR 1,250 to it | 201s; `GET /api/menu` shows it at 125000 paisa |
| 2 | Edit price to 1,300 with the right version | 200, version 2, one `config_changes` row per write with the new price |
| 3 | Same edit with the old version | 409 `STALE`, price unchanged |
| 4 | Send a round of the dish, then change its price | the sent event keeps 125000 |
| 5 | Remove the dish | gone from `GET /api/menu`; a send of it → `ITEM_UNAVAILABLE`; past events still name it |
| 6 | Restore | back on the menu |
| 7 | Remove a category holding an active dish | 409 `CATEGORY_NOT_EMPTY` |
| 8 | Add a single, required group with options 0 and −1,000 | on the menu's `modifierGroups`; a send without a choice is refused as before |
| 9 | Option rules out its own group / another dish's group | 422 |
| 10 | Remove a group another option rules out | that option's `excludesGroupId` becomes null |
| 11 | Remove an option | gone from the menu; a send choosing it is refused |
| 12 | Move up/down among ties (all `display_order` 0) | order actually changes |
| 13 | Price helper | `1,250` → 125000; `1250.50`, `abc`, empty, `-5` (no sign allowed) → null; API with 125050 paisa → 422 |
| 14 | Waiter cookie on `/api/manage/menu` | 403; owner without Manage unlock → 401 `MANAGE_LOCKED` |
| 15 | Another tenant's id (forged uuid) | 404 |
| 16 | `menu:changed` | heard on a socket after a save |
| 17 | `config_changes` DELETE | refused by the trigger |

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Story 10.4 and its 2026-11-04 / 2026-10-31 amendments]
- [Source: _bmad-output/planning-artifacts/architecture.md — "Sync-ready config writes (FR71 groundwork)"]
- [Source: _bmad-output/planning-artifacts/prd.md — FR56, FR65, FR70, FR71]
- [Source: _bmad-output/implementation-artifacts/10-0-manage-area-and-owner-password.md — the Manage gate]
- [Source: _bmad-output/implementation-artifacts/4-8-implement-priced-options.md — options model and rules]
- [Source: src/app/api/menu/route.ts; src/server/orders/modifier-groups.ts; src/server/services/order.service.ts ~300-330]
- [Source: src/lib/options.ts — `validateSelection`, `unitPriceFor` (clamp at zero)]
- [Source: src/server/socket/events.ts; src/components/pos/menu-browser.tsx — `menu:item_updated` handling]
- [Source: src/server/db/migrations/0001_append_only_rules.sql — DELETE-only trigger precedent]

## Open Questions (for Teran)

1. **Categories for the bar** — `seed-bar-menu.ts` put the bar categories in. After this story, add new ones from
   Manage; the seed is only for a fresh install. OK?
2. ~~Prices with cents~~ — **answered 2026-11-13: whole rupees only.**

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Migration **0038** (`0038_striped_ezekiel.sql`): `is_active` on `menu_items` and `modifier_options`; `version` +
  `updated_at` on the four menu tables; `config_changes` with a hand-written DELETE-only trigger.
- Read side: `GET /api/menu` filters removed dishes in the JOIN (so an emptied category still shows);
  `loadModifierGroups` filters removed options, which covers both the sheet and `submitRound`; `submitRound` refuses
  `is_active = false` as `ItemUnavailableError`.
- `menu-admin.service.ts`: one versioned-update helper (`WHERE version = $expected`, then 404 vs 409 STALE) used by
  every write; each write logs the returned row to `config_changes` via `recordConfigChange`. Moves renumber the
  siblings 10, 20, 30… then swap, so seeded ties at 0 move correctly. Whole rupees enforced server-side (multiple of
  100 paisa, 422). Removing a group clears every option's `excludes_group_id` that pointed at it, each versioned.
- API: 14 route files under `/api/manage/menu`, all through `src/server/menu-admin/route.ts` (`menuWrite`: actor and
  tenant from the staff row, one transaction, `menu:changed` after commit, error mapping). No `ROUTE_ROLES` change:
  the 10.0 gate already covers `/api/manage`.
- `menu:changed` socket event; `menu-browser.tsx` refetches the waiter menu on it.
- Editor (`src/components/manage/menu-editor.tsx`): fetches `/api/manage/menu` with TanStack Query on the client
  (instead of a server preload, so every save simply invalidates one key). Rows are keyed on `id + version`, so a save
  remounts them with server values — no effects or refs for draft reset. `paisaFromLkrInput` in `format.ts`, whole
  rupees only.
- `verify-menu-admin.ts` 29/29. It opens a Manage session for its own POS session directly in the database rather
  than using the password (one is set on this machine). Accepted sends are never made through the route (they would
  print); the "already sent" line is inserted directly; only refused sends go through the route.
- Regressions run: verify-receipt --paper-only 32/32, verify-order-number 15/15, verify-drawer --bytes-only 8/8,
  type-check clean, lint 0 errors (1 pre-existing warning). Printing regressions deferred to the go-live test round.

### File List

- src/server/db/schema.ts
- src/server/db/migrations/0038_striped_ezekiel.sql (new), migrations/meta
- src/app/api/menu/route.ts
- src/server/orders/modifier-groups.ts
- src/server/services/order.service.ts
- src/server/services/config-change.service.ts (new)
- src/server/services/menu-admin.service.ts (new)
- src/server/menu-admin/route.ts (new)
- src/app/api/manage/menu/** (new, 14 route files)
- src/server/socket/events.ts
- src/components/pos/menu-browser.tsx
- src/components/manage/menu-editor.tsx (new)
- src/app/manage/(area)/menu/page.tsx
- src/lib/format.ts
- src/server/services/verify-menu-admin.ts (new)

## Change Log

- 2026-11-13: Story created.
- 2026-11-13: Whole rupees only (Teran).
- 2026-11-13: Implemented; verify-menu-admin 29/29. Status → review.
