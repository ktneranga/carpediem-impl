# Story 10.3 (lite): Floor — Zones & Tables

Status: review

- **Epic:** 10 — System Configuration & Staff Management
- **Scope (Teran, 2026-11-13):** the LITE cut, brought into go-live — zones (the floor pills) and their tables,
  managed from Manage. The station half of the epic's 10.3 (per-station `output_mode`, `connection_mode`,
  `pizza_kitchen` station type, `business_day_start_hour` on a settings screen) stays post-launch, in a later 10.3b.
- **Built like 10.4:** Manage area page, `/api/manage/...` routes behind the 10.0 gate, versioned writes logged to
  `config_changes`, drag and drop with `SortableList`, one socket broadcast after each save.

## Story

As an owner,
I want to add, rename, reorder and remove the floor's zones and tables from Manage,
so that the floor plan on every tablet matches the restaurant as it is laid out today.

## Acceptance Criteria

1. **See the floor.** Manage → **Floor** lists the zones in floor order, each with its tables in order. A table shows
   its label, seats (if set), and a badge when it is occupied or out of service right now.
2. **Zones.** Add (name). Rename. Drag to reorder — the floor's zone pills follow the same order. Remove — refused
   while the zone still has tables (`409 ZONE_NOT_EMPTY`): move or remove them first. The zone icon is the floor's
   own (`zoneIcon(name)`), shown beside the name.
3. **Tables.** Add to a zone (label, seats optional 1–30). Edit label and seats. Move to another zone (a zone select
   in the table's editor). Drag to reorder within a zone. Labels are unique among the restaurant's tables, ignoring
   case (`409 LABEL_TAKEN`); 1–20 characters, trimmed.
4. **Remove a table.** Asks once. Refused while it has an open order or is part of a merged group
   (`409 TABLE_IN_USE`, "Close or move the order on Table 7 first"). Removed tables vanish from the floor, from the
   Move / Merge pickers and from seating; nothing is deleted, so old orders, bills and receipts still name them.
   A "Show removed tables" switch lists them with **Restore** (refused if another active table now has the label).
5. **Edits never disturb service.** Renaming a table or moving it to another zone while it is occupied is allowed:
   its open order stays on it, the card moves with it. Out-of-service state (Story 3.7) is untouched by any edit.
6. **Every tablet follows.** Each save broadcasts `floor:changed`; the floor and the order screen's table pickers
   refetch. No reload needed.
7. **Two people editing.** Saves carry the loaded `version`; a stale one is refused (`409 STALE`) and the screen
   reloads, as in 10.4. A drop over a list that changed meanwhile is refused the same way.
8. **Sync-ready (FR71).** Every create, edit, move, reorder, remove and restore of a zone or table bumps `version`,
   sets `updated_at`, and appends to `config_changes` in the same transaction.
9. **Owner only, behind the Manage password** — the 10.0 gate on `/manage` and `/api/manage`.
10. **No regressions.** Seating, merge, unmerge, move, close, out of service and return to service work as before
    for active tables. `verify-receipt --paper-only`, `verify-order-number`, `verify-menu-admin`, type-check and lint
    pass. (Printing regressions run in the go-live test round.)

## Tasks / Subtasks

- [x] **Task 1: Migration (AC 4, 7, 8)**
  - [x] `zones`: `version integer not null default 1`, `updated_at timestamptz not null default now()`.
  - [x] `tables`: `is_active boolean not null default true`, `version`, `updated_at`.
  - [x] Unique label among ACTIVE tables: `CREATE UNIQUE INDEX idx_tables_tenant_label_active ON tables
        (tenant_id, lower(label)) WHERE is_active` — declare it in `schema.ts` with `uniqueIndex(...).on(...)
        .where(...)` and `sql\`lower(${t.label})\``. Check the live data has no duplicate labels before migrating.
  - [x] `pnpm db:generate`, read the SQL, `pnpm db:migrate`. It will be 0039.
- [x] **Task 2: Removed tables are gone everywhere (AC 4)**
  - [x] Add `eq(tables.isActive, true)` to every place that LISTS or ACCEPTS a table for new use:
        `GET /api/tables` (grid query ~line 126), `/api/tables/[tableId]/sessions` (seat: 404 `TABLE_NOT_FOUND` for a
        removed one), `/api/tables/[tableId]/merge` (~125, ~135), `/api/sessions/[sessionId]/tables` (move picker /
        add table, ~136), `/api/tables/[tableId]/out-of-service`, `/api/config/tables/[tableId]/return-to-service`.
  - [x] Do NOT filter where a table is read for HISTORY: `receipt.service.ts` (~111, ~130), `order.service.ts` (~466),
        `unmerge`, `sessions/close`, the group-labels query in `/api/tables` (~185 — an open group can only contain
        active tables anyway, because removal is refused while in use).
- [x] **Task 3: Floor service (AC 2–5, 7, 8)**
  - [x] New `src/server/services/floor-admin.service.ts`, the same shape as `menu-admin.service.ts` (copy its
        `versionedUpdate` / `insertRow` / `reorderRows` approach; share code only if it stays simple — two small
        services are fine). Functions: `createZone`, `updateZone`, `removeZone`, `createTable`, `updateTable`
        (label, capacity, zoneId), `setTableActive`, `reorderRows('zone' | 'table', …)`, `loadFloorForManage`.
  - [x] Rules in the service: names/labels trimmed; zone name 1–40, table label 1–20; capacity null or 1–30; label
        unique ignoring case among active tables (check first for a clean `LabelTakenError`; the unique index is the
        backstop — map its violation to the same error); a table's zone must be an active zone of the tenant;
        a zone with active tables cannot be removed; a table with an open `order_session_tables` row
        (`released_at IS NULL`) or `status = 'occupied'` cannot be removed.
  - [x] Moving a table to another zone puts it at the end of that zone's order.
  - [x] `loadFloorForManage` returns zones (active) with tables (active, plus removed when asked), each table with
        `status`, `inUse` (open session), `capacity`, `version`.
- [x] **Task 4: API (AC 2–4, 7, 9)**
  - [x] `src/server/menu-admin/route.ts` is generic enough to reuse: add a `broadcast` argument to `menuWrite` (or a
        sibling `floorWrite`) so floor writes emit `floor:changed` instead of `menu:changed`, and map the new errors
        (`ZONE_NOT_EMPTY`, `TABLE_IN_USE`, `LABEL_TAKEN` → 409).
  - [x] Routes under `src/app/api/manage/floor/`: `GET ?removed=1`; `POST zones`, `PATCH zones/[id]`,
        `DELETE zones/[id]?version=`; `POST zones/[id]/tables`; `PATCH tables/[id]` (label, capacity, zoneId),
        `DELETE tables/[id]?version=`, `POST tables/[id]/restore`; `POST reorder` `{ kind: 'zone' | 'table',
        parentId, ids }`.
- [x] **Task 5: Tell the tablets (AC 6)**
  - [x] `emitFloorChanged()` in `src/server/socket/events.ts` → `floor:changed`.
  - [x] `table-grid.tsx`: `useSocketEvent('floor:changed', …)` invalidates `TABLES_QUERY_KEY`. The order screen's
        table pickers (move / merge / add table) refetch on it too — find their query keys.
- [x] **Task 6: Manage → Floor screen (AC 1–5, 7)**
  - [x] Add `{ href: '/manage/floor', title: 'Floor', … }` to `MANAGE_SECTIONS` (after Menu) and a page at
        `src/app/manage/(area)/floor/page.tsx` rendering a new `src/components/manage/floor-editor.tsx`.
  - [x] Layout like the menu editor: zones as a draggable list on the left (icon from `zoneIcon`, name, table count,
        rename / remove on the selected one, "+ Add zone"); the selected zone's tables as a draggable grid or list on
        the right (label, seats, Occupied / Out of service badge, Edit, Remove); "+ Add table". A small sheet edits a
        table: Label, Seats, Zone (select). "Show removed tables" switch with Restore.
  - [x] Reuse `SortableList`, the confirm dialog pattern, `call`/`run` error handling and the `id + version` keying
        from `menu-editor.tsx`. Extract shared bits into `src/components/manage/` if it keeps both files simpler.
- [x] **Task 7: Verify (all ACs)**
  - [x] New `src/server/services/verify-floor-admin.ts`, modelled on `verify-menu-admin.ts` (owner login, Manage
        session opened in the database, no accepted sends). Everything it makes is named `ZZ …`, soft-removed at the
        end; its `config_changes` rows deleted with the guard off only around its own cleanup.
  - [x] Run the regressions in AC 10.

## Dev Notes

### Decisions already taken

| Decision | Why |
|---|---|
| Remove = `is_active = false` on tables; zones already have `is_active` | Sessions, bills and receipts point at tables (`order_session_tables`, `order_sessions.table_id`). History keeps naming them. |
| Refuse removing a table in use; allow renaming or moving it | Removing an occupied table would strand a live order; a rename or a zone move changes nothing about the order. |
| Unique labels among active tables | Waiters, tickets and bills identify tables by label; two "Table 7"s is a wrong-table bill waiting to happen. Restoring checks it too. |
| One broadcast `floor:changed` → refetch | Same reasoning as `menu:changed`: rare edits, small data, no drift. |
| Stations stay out (10.3b, post-launch) | Today one printer serves every station (`resolveTransport`); per-station config only matters with a second printer. |

### 🚨 Trap 1: every table query

Removal only works if every query that offers a table for NEW use filters `is_active` (Task 2 list). Miss the seat
route and a removed table can still be opened by id from a stale tablet; miss the move picker and an order can be
moved onto it. Grep `from(tables)` and `innerJoin(tables` and decide each one consciously: new use → filter;
history → do not.

### 🚨 Trap 2: zones appear on the floor only through their tables

`table-grid.tsx` builds the zone pills from the table rows (`zones` useMemo ~line 1029). An empty zone has no pill —
that is fine and expected. The pill ORDER comes from `/api/tables`' `ORDER BY zones.display_order`, so reordering
zones in Manage reorders the pills with no floor code change.

### 🚨 Trap 3: label uniqueness and the partial index

Existing seeded tables may already collide ignoring case; check before adding the index (fix the seed data first if
so). A rename to "table 7" when "Table 7" exists must fail with `LABEL_TAKEN`, not a 500 from the index.

### 🚨 Trap 4: merged groups

A table in a merged group has an `order_session_tables` row with `released_at IS NULL` — the "in use" check covers
it. Do not rely on `tables.status` alone.

### 🚨 Trap 5: out of service

`tables.status = 'unavailable'` with `unavailable_reason` is Story 3.7's state, written through its own routes with
`table_status_events`. Floor edits never write `status` or `unavailable_reason`.

### What must keep working

- The floor grid, zone pills, Bar tab pill, seating, merge, unmerge, move, close, out-of-service: unchanged for
  active tables.
- `verify-menu-admin` (shares `src/server/menu-admin/route.ts` if that helper is generalised).
- `seed.ts` on a fresh database (new columns have defaults).

### Out of scope

- Stations, printers, KDS output mode (10.3b). Business-day start hour on a settings screen (10.3b / 10.5).
- A visual drag-to-position floor map; tables stay a list/grid in label order within zones.

### Project Structure Notes

| File | Change |
|---|---|
| `src/server/db/schema.ts`, migration 0039 | Task 1 |
| `src/app/api/tables/route.ts`, `src/app/api/tables/[tableId]/{sessions,merge,out-of-service}/route.ts`, `src/app/api/sessions/[sessionId]/tables/route.ts`, `src/app/api/config/tables/[tableId]/return-to-service/route.ts` | Task 2 |
| `src/server/services/floor-admin.service.ts` (new) | Task 3 |
| `src/server/menu-admin/route.ts`, `src/app/api/manage/floor/**` (new) | Task 4 |
| `src/server/socket/events.ts`, `src/components/pos/table-grid.tsx`, order-screen table pickers | Task 5 |
| `src/app/manage/(area)/sections.tsx`, `src/app/manage/(area)/floor/page.tsx`, `src/components/manage/floor-editor.tsx` (new) | Task 6 |
| `src/server/services/verify-floor-admin.ts` (new) | Task 7 |

### Testing

| # | Case | Expected |
|---|---|---|
| 1 | Add zone, add two tables | on `GET /api/tables` in that zone, in order |
| 2 | Reorder zones / tables (drop) | `/api/tables` order follows; stale list → 409 |
| 3 | Duplicate label (other case) on add, rename, restore | 409 `LABEL_TAKEN` |
| 4 | Rename and move an occupied table to another zone | allowed; its session still on it |
| 5 | Remove a table with an open session / in a merged group | 409 `TABLE_IN_USE` |
| 6 | Remove a free table | gone from `/api/tables`; seat it by id → 404; move picker does not offer it |
| 7 | Restore | back on the floor |
| 8 | Remove a zone with tables / empty | 409 `ZONE_NOT_EMPTY` / 200 |
| 9 | Stale version edit | 409 `STALE` |
| 10 | `config_changes` rows | one per write, with the row after it |
| 11 | `floor:changed` | heard after each save |
| 12 | Waiter / owner without Manage unlock | 403 / 401 `MANAGE_LOCKED` |

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Story 10.3 and its 2026-10-02 / 2026-09-06 notes]
- [Source: _bmad-output/implementation-artifacts/10-4-implement-menu-management.md — the pattern this follows]
- [Source: _bmad-output/implementation-artifacts/10-0-manage-area-and-owner-password.md — the Manage gate]
- [Source: src/app/api/tables/route.ts; src/components/pos/table-grid.tsx ~1029 (zones from tables), ~687 (socket)]
- [Source: src/lib/design.ts — `zoneIcon`]
- [Source: src/components/manage/menu-editor.tsx, sortable-list.tsx; src/server/menu-admin/route.ts; src/server/services/menu-admin.service.ts]

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- **Migration 0039:** `zones.version/updated_at`; `tables.is_active/version/updated_at`; partial unique index
  `idx_tables_tenant_label_active` on `(tenant_id, lower(label)) WHERE is_active`. Live data checked first: no duplicates.
- **Removed tables (Trap 1):** `is_active` filter on `/api/tables`, seat, seat's extra tables, merge (anchor and targets),
  attach/move (`sessions/[id]/tables`), out-of-service and return-to-service. History reads untouched. Also added to
  `occupyTables`' UPDATE, so a removal racing a seating cannot leave an order on a removed table: removal UPDATEs the row
  first (holding its lock), then checks in-use; a seating in flight blocks on that lock and fails once it commits.
- **Service:** `floor-admin.service.ts` mirrors `menu-admin.service.ts` (versioned update, insert, reorder) and reuses its
  error classes. In-use = open `order_session_tables` row OR `status = 'occupied'` (Trap 4 tested with status forced to
  open). Restoring a table whose zone was removed goes to a zone the caller names (UI: "Restore to <zone on screen>").
  Edits never write `status` / `unavailable_reason`.
- **API:** `menuWrite` and a new `floorWrite` share one `manageWrite` (only the broadcast differs). New 409s:
  `ZONE_NOT_EMPTY`, `TABLE_IN_USE`, `LABEL_TAKEN` (also mapped from the unique index, the backstop).
- **Tablets:** `floor:changed` → `table-grid.tsx` invalidates `['tables']`. The Move / Merge / add-table pickers all
  read that one query, so no other listener is needed.
- **UI:** Manage → Floor (after Menu). Zones list left, selected zone's tables right, both drag-sortable; table sheet
  (label, seats, zone); "Show removed tables" with Restore. Shared bits (`call`/`ApiError`, control styles,
  `ConfirmDialog` with a `note`) extracted to `manage-ui.tsx`; the menu editor now imports them.
- **Verify:** `verify-floor-admin.ts` 30/30 (all 12 testing cases, plus capacity/label length, out-of-service untouched,
  removed list). Its cleanup hard-deletes its own ZZ zones/tables/sessions on a local DB (soft-removes elsewhere) and
  puts the real zones back in their order. Regressions: verify-menu-admin 31/31, verify-order-number 15/15,
  verify-receipt --paper-only 32/32, verify-bills 119/119, verify-options 33/33, verify-custom-charge 22/22, tsc clean,
  lint 0 errors (1 pre-existing warning in `socket/index.ts`). verify-manage not run: it needs VERIFY_MANAGE_PASSWORD.
- **Fixture fixes:** the verify scripts that pick a free table now require `t.is_active`; verify-bills' dish picker now
  requires `m.is_active` (it was picking a soft-removed `ZZ Verify` dish left by verify-menu-admin — a 10.4 leftover).
- UI not clicked through in a browser — left for the go-live test round.

### File List

- src/server/db/schema.ts
- src/server/db/migrations/0039_moaning_brother_voodoo.sql (new)
- src/server/db/migrations/meta/0039_snapshot.json (new)
- src/server/db/migrations/meta/_journal.json
- src/app/api/tables/route.ts
- src/app/api/tables/[tableId]/sessions/route.ts
- src/app/api/tables/[tableId]/merge/route.ts
- src/app/api/tables/[tableId]/out-of-service/route.ts
- src/app/api/sessions/[sessionId]/tables/route.ts
- src/app/api/config/tables/[tableId]/return-to-service/route.ts
- src/server/services/table-session.service.ts
- src/server/services/floor-admin.service.ts (new)
- src/server/menu-admin/route.ts
- src/app/api/manage/floor/route.ts (new)
- src/app/api/manage/floor/zones/route.ts (new)
- src/app/api/manage/floor/zones/[id]/route.ts (new)
- src/app/api/manage/floor/zones/[id]/tables/route.ts (new)
- src/app/api/manage/floor/tables/[id]/route.ts (new)
- src/app/api/manage/floor/tables/[id]/restore/route.ts (new)
- src/app/api/manage/floor/reorder/route.ts (new)
- src/server/socket/events.ts
- src/components/pos/table-grid.tsx
- src/app/manage/(area)/sections.tsx
- src/app/manage/(area)/floor/page.tsx (new)
- src/components/manage/floor-editor.tsx (new)
- src/components/manage/manage-ui.tsx (new)
- src/components/manage/menu-editor.tsx
- src/server/services/verify-floor-admin.ts (new)
- src/server/print/verify-receipt.ts
- src/server/services/verify-bills.ts
- src/server/services/verify-custom-charge.ts
- src/server/services/verify-options.ts
- _bmad-output/implementation-artifacts/sprint-status.yaml

## Change Log

- 2026-11-13: Story created (lite scope: zones and tables, go-live — Teran).
- 2026-11-13: Implemented (migration 0039, floor service + API, `floor:changed`, Manage → Floor screen, verify script);
  status → review.
