# Story 10.2: Staff accounts in Manage

Status: review

<!-- Go-live. Next after 8.3 in the launch order. Testing deferred to the final round (launch rush). -->

## Story

As the owner,
I want to add staff, set their names, roles and PINs, and deactivate someone who has left — in Manage → Staff,
so that only the right people can sign in, and every order, payment and bill names the right person.

## Decisions (made while writing the story, 2026-11-13; change any before dev)

- **Roles are the three the app has:** `waiter`, `owner`, `kitchen` (labels "Waiter", "Owner", "Kitchen").
  The epic's `staff` / `manager` don't exist (`permissions.ts`, Story 10.0 Trap 1). No enum change.
- **API under `/api/manage/staff`**, not the epic's `/api/staff`: it inherits both gates (owner role + Manage
  password) like Menu and Floor. Leave the existing `/api/staff` owner-only policy in place, unused.
- **PIN:** exactly 4 digits (FR38, the login route's `/^\d{4}$/`). bcrypt cost 10 (`bcryptjs`, as login).
  Never logged, never returned, never written to `config_changes`.
- **No hard delete.** Deactivate keeps the row (orders, bills and payments point at it).
- **Names:** 1–40 characters, trimmed; unique among ACTIVE staff, case-insensitive (`NAME_TAKEN`), because the
  name is what prints on the bill as cashier and what the badge shows.
- **You can't change your own role or deactivate yourself** here (protects against locking yourself out;
  another owner can). You CAN change your own name and PIN.

## Acceptance Criteria

1. **List.** Manage → Staff (replacing the `ComingSoon` placeholder) lists active staff — name, role badge,
   "You" on the signed-in owner's row — ordered by role (Owner, Waiter, Kitchen) then name. Below, a
   collapsed **"Deactivated (N)"** group lists inactive staff with a Reactivate action. Loads in well under 1 s.
2. **Add.** "Add staff" opens a sheet: name, role (three large choice buttons, Waiter preselected), PIN
   (4-digit numeric field, `inputMode="numeric"`, shown as dots with a show/hide eye). `POST /api/manage/staff`
   `{ name, role, pin }` → hashes the PIN, inserts `staff` (`is_active` true, `version` 1), one
   `config_changes` row, 201 with the staff row WITHOUT `pinHash`.
3. **PIN must be unique among active staff.** On create, PIN change and reactivate, the candidate PIN is
   compared with bcrypt against every OTHER active staff member's `pin_hash` in the tenant; a match →
   409 `PIN_TAKEN` "That PIN is already in use. Choose another." To make two simultaneous saves unable to
   both pass, take `pg_advisory_xact_lock(hashtext('staff_pin:' || tenant_id))` at the start of every staff
   write transaction. (Why: login takes the first bcrypt match, so a shared PIN silently signs one person
   in as the other — epics.md 10.2, Story 3.3 review note.)
4. **Edit.** Tapping a row opens the same sheet: name, role, and a "Set a new PIN" field (empty = keep).
   `PATCH /api/manage/staff/:id` `{ version, name?, role?, pin? }` — only provided fields change; optimistic
   `WHERE version = $expected` (409 `STALE`); version + 1, `updated_at = now()`; one `config_changes` row;
   200 without `pinHash`.
5. **Role change takes effect at once.** `staff_sessions.role` is a denormalised copy read by the proxy on
   every request. In the same transaction as a role change: `UPDATE staff_sessions SET role = $new WHERE
   staff_id = $id`, and if the new role is not `owner`, `DELETE FROM manage_sessions` for that person's
   sessions (a demoted owner loses an open Manage at once). The person stays signed in with the new role.
6. **Deactivate.** "Deactivate" (in the edit sheet, with `ConfirmDialog`: "Deactivate Nimal? They will be
   signed out on every tablet and can't sign in until reactivated.") → `PATCH … { version, active: false }`:
   `is_active` false, version + 1, one `config_changes` row, and `DELETE FROM staff_sessions WHERE staff_id =
   $id` in the same transaction (manage_sessions cascade). Their next request gets 401 → login screen.
   **Reactivate** → `{ version, active: true }`: PIN uniqueness re-checked (someone may have taken that PIN
   meanwhile → 409 `PIN_TAKEN`, the sheet then asks for a new PIN and sends `{ active: true, pin }`) and name
   uniqueness re-checked (`NAME_TAKEN`).
7. **Never lose the last owner.** Deactivating, or changing the role of, the only active owner → 422
   `LAST_OWNER` "There must always be at least one active owner." Own row: role control and Deactivate are
   disabled with a short note "Another owner can change this." The server refuses too (422 `OWN_ACCOUNT`).
8. **Validation.** Role not in the enum, PIN not `/^\d{4}$/`, name empty or > 40 → 422 `INVALID` with a
   human message; unknown or other-tenant id → 404. All errors shown inline in the sheet, the sheet stays open
   with the typed values (PIN field cleared).
9. **`config_changes` payload** is the row after the change MINUS `pinHash`, plus `pinChanged: true` when the
   PIN changed. Assert in the verify script that no `config_changes.payload` for `staff` contains `pinHash`
   or a `$2` bcrypt string.
10. **Verify script** `src/server/services/verify-staff-admin.ts` passes (see Tasks).

Out of scope: per-person permissions (10.6), a "manager" role, PIN reset by the staff member themselves,
showing who changed what.

## Tasks / Subtasks

- [x] **Task 1 — Migration (AC 4)**: `staff` gains `version integer NOT NULL DEFAULT 1` and
      `updated_at timestamptz NOT NULL DEFAULT now()` (same as 10.4/10.3). `npm run db:generate` →
      0041-ish; check the SQL; apply.
- [x] **Task 2 — Service** `src/server/services/staff-admin.service.ts` (pattern: `floor-admin.service.ts`):
  - [x] errors: `PinTakenError`, `NameTakenError`, `LastOwnerError`, `OwnAccountError`; reuse
        `MenuNotFoundError`, `StaleVersionError`, `MenuRuleError` (the shared route maps them).
  - [x] `lockStaff(tx, tenantId)` — the advisory lock (AC 3).
  - [x] `checkPinFree(tx, tenantId, pin, exceptId)` — bcrypt.compare against each other active row; compare
        ALL rows (no early exit needed, but fine either way — it's owner-only, behind two gates).
  - [x] `checkNameFree`, `cleanStaffName`, `checkRole`, `checkPin`.
  - [x] `createStaff`, `updateStaff` (name/role/pin, AC 5 session updates), `setStaffActive` (AC 6, AC 7).
  - [x] `loadStaffForManage(db, tenantId)` → `{ id, version, name, role, isActive }[]` (never `pinHash`).
  - [x] Every write logs via `recordConfigChange` with the AC 9 payload.
- [x] **Task 3 — Routes**: `src/app/api/manage/staff/route.ts` (GET list, POST create) and
      `src/app/api/manage/staff/[id]/route.ts` (PATCH). Use the shared helper in
      `src/server/menu-admin/route.ts` — add a `staffWrite` (no broadcast needed; pass a no-op) and map the
      four new errors (`PIN_TAKEN` 409, `NAME_TAKEN` 409, `LAST_OWNER` 422, `OWN_ACCOUNT` 422). The actor's
      `staffId` is the "own account" for AC 7. Zod: `pin: z.string().regex(/^\d{4}$/)`,
      `role: z.enum(staffRoleEnum.enumValues)`. Never echo the body in an error or a log.
- [x] **Task 4 — Screen**: `src/app/manage/(area)/staff/page.tsx` → `src/components/manage/staff-editor.tsx`
      (client), styled like `floor-editor.tsx`; reuse `call`, `ApiError`, `input`, `primary`, `secondary`,
      `ConfirmDialog` from `manage-ui.tsx`. The page passes the signed-in staff id (from `x-staff-id`) for
      "You". On `ApiError` with status 401 `MANAGE_LOCKED`, `call()` already sends to unlock — keep that.
      Rows keyed `id + version`. Role badge colours: owner brand, waiter slate, kitchen amber (existing
      tokens only). 44px targets.
- [x] **Task 5 — Sections text**: `MANAGE_SECTIONS` Staff: "Add staff, set their PINs and roles, and
      deactivate someone who has left."  (already says this — confirm, no change needed).
- [x] **Task 6 — Verify** `src/server/services/verify-staff-admin.ts`
      (`npx tsx --conditions=react-server …`), self-cleaning, uses its own tenant rows only:
  - [x] create waiter → hash is bcrypt, not the PIN; version 1; one `config_changes` row without `pinHash`;
  - [x] create with a PIN held by another active staff → `PinTakenError`; same PIN held only by an
        INACTIVE staff → allowed;
  - [x] duplicate active name (different case) → `NameTakenError`;
  - [x] edit name with stale version → `StaleVersionError`;
  - [x] role change waiter → owner updates that person's `staff_sessions.role`; owner → waiter deletes
        their `manage_sessions`;
  - [x] deactivate deletes their `staff_sessions`; reactivate with a now-taken PIN → `PinTakenError`;
  - [x] last active owner: deactivate → `LastOwnerError`, role change → `LastOwnerError`;
  - [x] actor == target: role change / deactivate → `OwnAccountError`; name change allowed;
  - [x] invalid role / 3-digit PIN / 41-char name → `MenuRuleError`;
  - [x] login still works: `bcrypt.compare(newPin, row.pinHash)` true after a PIN change.
  - [x] Cleanup: staff rows created by the script can't be deleted if anything references them — create
        nothing that references them (no orders); delete their `staff_sessions`, then the rows. `config_changes`
        is DELETE-guarded: follow `verify-floor-admin.ts`.
  - [x] `npx tsc --noEmit`, `npm run lint` clean.

## Dev Notes

### Current state (read before changing)

- `staff` (`schema.ts`): id, tenantId, name, role (`staff_role`: waiter/owner/kitchen), pinHash, isActive,
  createdAt. No version/updatedAt yet.
- `POST /api/auth/login` loops every ACTIVE staff, bcrypt-compares, takes the first match; a tenant with no
  active staff compares against `DUMMY_PIN_HASH`. Inactive staff therefore already can't sign in — nothing to
  change there.
- `validateSession` (`session.service.ts`) reads `staff_sessions` only — it does NOT re-check `staff.is_active`
  or `staff.role`. That is why AC 5/6 update or delete the session rows in the same transaction. Do not add a
  staff join to `validateSession` (it runs on every request; the denormalisation is deliberate).
- `manage_sessions.staff_session_id` → `staff_sessions.id` ON DELETE CASCADE, so deleting staff sessions also
  closes their Manage.
- The bill's cashier line and the staff badge read `staff.name` at the time; a rename shows on new bills only.
- Seed staff exist (owner + waiters); after the migration they are version 1.

### Guardrails

- PIN plaintext: only in the request body → zod → bcrypt. Not in logs, errors, responses, `config_changes`,
  React Query cache (clear the field after save), or the verify script output.
- Tenant from the actor's staff row (`actorOf`), never the request.
- No semicolons; don't run prettier. No ref reads during render (React Compiler lint).
- bcrypt in a loop inside a transaction is acceptable: ≤ ~30 staff × ~70 ms, owner-only, rare.

### Files

- UPDATE: `src/server/db/schema.ts`, `src/server/menu-admin/route.ts`, `src/app/manage/(area)/staff/page.tsx`.
- NEW: migration + snapshot, `src/server/services/staff-admin.service.ts`, `src/app/api/manage/staff/route.ts`,
  `src/app/api/manage/staff/[id]/route.ts`, `src/components/manage/staff-editor.tsx`,
  `src/server/services/verify-staff-admin.ts`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Story 10.2 (amended 2026-11-04), PIN uniqueness note 2026-09-06]
- [Source: src/app/api/auth/login/route.ts — first-match login, 4-digit PIN]
- [Source: src/server/services/session.service.ts — role denormalised on the session]
- [Source: src/server/services/floor-admin.service.ts, src/server/menu-admin/route.ts — Manage write pattern]
- [Source: _bmad-output/implementation-artifacts/10-0-*.md — no manager role]

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Debug Log References

### Completion Notes List

- Migration `0040_staff_version.sql` (staff.version, staff.updated_at) generated and applied locally.
- Service `staff-admin.service.ts`: create / edit / deactivate / reactivate under a per-tenant advisory lock;
  PIN checked with bcrypt against every other active row; name unique among active (case-insensitive); role change
  rewrites `staff_sessions.role` and closes Manage on demotion; deactivate deletes the person's sessions;
  LAST_OWNER and OWN_ACCOUNT guards; `config_changes` payload never holds `pinHash` (adds `pinChanged`).
- **Deviation (AC 6): Reactivate always takes a PIN.** Salted bcrypt hashes can't be compared with each other, so
  a deactivated person's stored PIN can't be checked for uniqueness. The Reactivate sheet asks for a PIN
  ("It can be their old one if no one else uses it"); `PIN_TAKEN` shows inline and the field clears.
- Routes: zod only length-caps name/role/pin so AC 8's bad role / PIN / name get 422 `INVALID` with a human
  message from the service (not a bare 400). `staffWrite`, four error mappings and `staffFields` added to
  `menu-admin/route.ts` (Next forbids extra exports from route files).
- Screen: list (Owner, Waiter, Kitchen, then name), "You" chip, role badges, collapsed "Deactivated (N)" with
  Reactivate; one sheet for add / edit / reactivate; errors inline; PIN cleared after every attempt; own role and
  Deactivate disabled with "Another owner can change this."
- Task 5: MANAGE_SECTIONS Staff text already matched — no change.
- Verify: `npx tsx --conditions=react-server --env-file=.env src/server/services/verify-staff-admin.ts` → 31/31
  (incl. a real two-saves-one-PIN race). Uses its own `ZZ Staff verify` tenant; cleanup confirmed.
- `npx tsc --noEmit` clean; `npm run lint` 0 errors (1 pre-existing warning in socket/index.ts).
- **Change (Teran, 2026-11-13): the job decides the access.** Staff have a job — Waiter, Bartender, Cashier,
  Helper, Chef, Owner (`src/lib/staff-jobs.ts`, column `staff.job_title`, migration `0041_staff_job_title.sql`
  with backfill owner → owner, kitchen → chef, waiter → waiter). There is no role picker: `role` follows the job
  (`accessOf`: Chef → kitchen, Owner → owner, the rest → waiter); the sheet shows "Can use: …" as text. The API
  takes `jobTitle`, not `role`. AC 5 / AC 7 now apply to a job change that changes access (session role rewrite,
  LAST_OWNER, OWN_ACCOUNT — your own job is locked). Extra rights for one person are Story 10.6. Verify 34/34.
- **Change (Teran, 2026-11-13): Delete.** `DELETE /api/manage/staff/:id?version=` → `deleteStaff`: only for
  someone with no history (added by mistake). Their sessions are removed, then the row; any foreign key
  (orders, bills, payments, change log as actor) refuses it → 409 `HAS_HISTORY` "…Deactivate them instead."
  Not yourself (`OWN_ACCOUNT`), not the last owner. Logged as `{ id, name, deleted: true }`. Small trash icon in
  the edit and reactivate sheets, with a confirm. New helper `isForeignKeyViolation` in `db/errors.ts`.
  Verify 39/39.
- UI not clicked through in a browser — deferred to the final test round (launch rush).

### File List

- src/server/db/schema.ts (updated)
- src/server/db/migrations/0040_staff_version.sql (new)
- src/server/db/migrations/meta/0040_snapshot.json (new)
- src/server/db/migrations/0041_staff_job_title.sql (new)
- src/server/db/migrations/meta/0041_snapshot.json (new)
- src/server/db/migrations/meta/_journal.json (updated)
- src/lib/staff-jobs.ts (new)
- src/server/services/staff-admin.service.ts (new)
- src/server/services/verify-staff-admin.ts (new)
- src/server/menu-admin/route.ts (updated)
- src/server/db/errors.ts (updated)
- src/app/api/manage/staff/route.ts (new)
- src/app/api/manage/staff/[id]/route.ts (new)
- src/components/manage/staff-editor.tsx (new)
- src/app/manage/(area)/staff/page.tsx (updated)

### Change Log

- 2026-11-13: Story 10.2 implemented — staff accounts in Manage (add, edit, PIN, role, deactivate, reactivate). Status → review.
- 2026-11-13: Added jobs (Bartender, Cashier, Helper, Chef…); the job sets the access, no separate role picker.
- 2026-11-13: Added Delete for staff with no history.
