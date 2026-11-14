# Story 10.6: Per-User Permissions

Status: review

<!-- Go-live. Brought forward 2026-11-14 by sprint-change-proposal-2026-11-14-permissions.md.
     After 7-5, before 11-3 lite / 1-4. Security-critical: the Manage gate changes. -->

## Story

As the owner,
I want to give individual staff members extra permissions without making them an owner,
so that a trusted shift lead or cashier can do specific jobs while everyone else stays limited.

## Decisions (Teran, 2026-11-14; change any before dev)

- **Grantable permissions** (stored per staff member):
  `custom_charge`, `approve_voids`, `open_cash_drawer`, `manage_dashboard`, `manage_menu`,
  `manage_floor`, `manage_settings`.
- **Owners hold every permission implicitly.** Nothing is stored for them and nothing can be taken
  away from them.
- **Only waiter-access staff can hold permissions** (jobs with access `waiter`: waiter, bartender,
  cashier, helper). Kitchen staff are display-only. Changing someone's job to a kitchen or owner job
  clears what they hold.
- **Staff management (Manage → Staff, PINs, permissions) is never grantable.** Nobody can grant
  themselves more. Availability (sold-out) stays open to all waiters, as today.
- **A granted Manage area is opened with the person's own PIN session.** There is no Manage password
  for them, and the owner's Manage password stays the owner's. The owner's own flow is unchanged.
- **Revocation takes effect on the next request.** Permissions are read fresh from `staff` on every
  request, not from the session snapshot.

## Acceptance Criteria

1. **Grant / revoke.** In Manage → Staff, each waiter-access person has a "Permissions" control with
   seven switches (Custom charge, Approve voids, Open cash drawer, Dashboard, Menu, Floor, Settings).
   Saving uses the staff row's existing versioned update and is recorded in `config_changes` as today
   (the payload includes `permissions`). Owner and kitchen rows show no switches: "Owners can do
   everything" / "Kitchen staff can't hold permissions".
2. **Server refuses invalid grants:** an unknown permission, or a permission given to a kitchen or
   owner row, → 422. Only the owner, behind the Manage password, can reach the staff routes, as today.
3. **Custom charge.** `canAddCustomCharge` is true for owners and holders of `custom_charge`. The send
   route and the order page both use it (unchanged call sites, new signature).
4. **Cash drawer (no sale).** `canOpenCashDrawer` is true for owners and holders of
   `open_cash_drawer`. The `/api/cash-drawer` entry in `ROUTE_ROLES` widens to owner + waiter; the
   route's own `canOpenCashDrawer` check is the guard. The floor shows the drawer icon to holders.
5. **Approve voids.** A holder of `approve_voids`:
   - voids and cancels unpaid bills with no PIN prompt (approver = themselves), and
   - their PIN approves another waiter's void (`findApprover` candidates = active owners + active
     holders).
   The lockout is unchanged. The order screen's `needsApproval` and the bill screen's `canApprove`
   come from the same rule.
6. **Manage areas.** A non-owner holding `manage_<area>`:
   - opens that area's pages and APIs with no Manage session or password;
   - is refused (403 for APIs, redirected to `/` for pages) on every other `/manage/*` and
     `/api/manage/*` path, including Staff, unlock, password and lock;
   - sees in the Manage nav only Availability plus their granted areas, and no Lock button;
   - `/manage` sends them to their first granted area (else Availability).

   Area → paths:
   - **Dashboard:** `/manage/dashboard`, `/manage/end-of-day` (redirect), `/api/manage/dashboard/**`
     (insights, summary, cash-count, print).
   - **Menu:** `/manage/menu`, `/api/manage/menu/**`.
   - **Floor:** `/manage/floor`, `/api/manage/floor/**`.
   - **Settings:** `/manage/settings`, `/api/manage/settings`.
7. **The owner is unchanged:** the owner still needs the Manage password for every Manage area except
   Availability.
8. **The POS "Manage" menu entry** (floor and order screens) shows for owners and for anyone with at
   least one Manage area. Waiters without areas keep "Sold out" only.
9. **Headers can't be forged.** The proxy strips any incoming `x-staff-permissions` and sets it only
   from the database (comma-separated, owners get the full set).

## Tasks / Subtasks

- [x] **T1 — Schema + migration `0045_staff_permissions.sql`** (AC 1, 2): `staff.permissions text[] NOT NULL DEFAULT '{}'`,
      CHECK every element is one of the seven (`permissions <@ ARRAY[...]::text[]`). Mirror in `schema.ts`.
- [x] **T2 — `src/server/auth/permissions.ts`** (AC 3–6, 9): `PERMISSIONS` const + `Permission` type; `MANAGE_AREAS`
      (area → page prefixes + api prefixes + permission, the ONE map); `effectivePermissions(role, stored)`;
      `hasPermission(role, perms, p)`; `manageAreaOf(pathname)` (null = not an area path); `canAddCustomCharge(role, perms)`,
      `canOpenCashDrawer(role, perms)`, `canApproveVoids(role, perms)`, `canOpenManage(role, perms)`;
      `parsePermissionsHeader(value)`. Keep `isRoleAllowed` as is; widen `/api/cash-drawer` to owner+waiter.
      Update the doc comments that said "until 10.6".
- [x] **T3 — `session.service.ts` `validateSession`** (AC 6, 9): also return the staff row's `permissions` and `role`
      FRESH (join `staff` on `staff_sessions.staff_id`; keep the session's role semantics, but permissions from staff).
- [x] **T4 — `src/proxy.ts`** (AC 6, 7, 9): strip `x-staff-permissions`; for a non-owner on a Manage path:
      if `manageAreaOf(path)` is granted → allow WITHOUT a Manage session (skip `ROUTE_ROLES` owner rule and
      `needsManageSession`); otherwise the existing refusal. Owners: exactly today's flow. Set `x-staff-permissions`.
- [x] **T5 — Call sites** (AC 3–5, 8): orders route + order page (custom charge); cash-drawer route + `table-grid`/
      `floor-header` (drawer icon); `void.service` (`resolveApproval`, `findApprover` with holders); voids/cancel routes
      pass permissions; order page `canManage`/void `needsApproval` and bill page `canApprove` from `canApproveVoids`;
      `table-grid` + `order-screen` Manage entry from `canOpenManage`; `app/page.tsx` passes permissions to the grid.
- [x] **T6 — Manage area UI** (AC 6): `(area)/layout.tsx` + `manage-nav.tsx` show Availability + granted areas for a
      non-owner (no Lock, no vendor line); `(area)/page.tsx` redirect rule.
- [x] **T7 — Staff management** (AC 1, 2): `staff-admin.service.ts` — `permissions` in `ManageStaff`, `updateStaff`
      accepts `permissions` (validated, waiter-access only, cleared on job change to kitchen/owner), logged via
      existing `log()`; `staffFields`/route schema; `staff-editor.tsx` switches per row.
- [x] **T8 — `src/server/services/verify-permissions.ts`**: pure rule tests (`manageAreaOf` for every
      `/api/manage/*` route file — enumerate `src/app/api/manage/**/route.ts` so a new route can't be missed;
      Staff/password/lock/unlock map to null), `effectivePermissions`, grant validation (kitchen/owner/unknown
      refused, job change clears), `findApprover` with a holder PIN, `resolveApproval` self-approve for a holder,
      `canAddCustomCharge`/`canOpenCashDrawer` matrix, `validateSession` returns fresh permissions (revoke →
      next call sees it), proxy-level: a waiter with `manage_menu` gets `/api/manage/menu` and is refused
      `/api/manage/staff` + `/api/manage/settings` (call `proxy()` with a real signed session cookie).
- [x] **T9 — Regression:** verify-voids, verify-staff-admin, verify-menu-admin, verify-floor-admin,
      verify-settings, verify-dashboard, verify-custom-charge, verify-drawer, verify-manage (with
      `VERIFY_MANAGE_PASSWORD`), `tsc`, `eslint`.

## Dev Notes

### Current state (read before changing)

- **Roles:** `waiter | owner | kitchen` (no manager). Role is snapshotted in `staff_sessions.role` at
  login. `ROUTE_ROLES` in `server/auth/permissions.ts` is longest-prefix, deny-by-default for listed
  prefixes: `/manage` and `/api/manage` are owner-only, and `/api/cash-drawer` is owner-only.
- **Manage gate:** `server/auth/manage-gate.ts` `needsManageSession` (exempt: unlock/password/lock;
  password-free: `/manage/sold-out`). The proxy checks the role first, then the Manage session. It sets
  `x-staff-id`, `x-staff-role` and `x-manage-unlocked`, and strips them from incoming requests first.
- **Role checks to convert:**
  - `canAddCustomCharge` (orders route :251, order page :213)
  - `canOpenCashDrawer` (cash-drawer route :46, table-grid :1241)
  - `void.service` `resolveApproval`, `role === 'owner'`, and `findApprover`, owners only
  - bill page `canApprove` (:191)
  - order page `canManage` (owner), used for the Manage entry and the void `needsApproval`
  - table-grid `onManage` (:1238)
  - `(area)/layout.tsx` `owner`, and `(area)/page.tsx`
- **Staff writes:** `staff-admin.service.ts` `updateStaff` (versioned, `log()` → `config_changes`,
  never the PIN hash), `accessOf(jobTitle)` in `lib/staff-jobs.ts`.
- **Manage API routes:** use `actorOf` (staff → tenant) and no role check. The gate is the proxy, so
  `manageAreaOf` must cover every route file.

### Guardrails

- **One map** (`MANAGE_AREAS`) used by the proxy, the nav and the verify script. Never a second list.
- **Deny by default:** any `/manage` or `/api/manage` path not in an area is owner-only, as today.
  Granting must never widen a non-area path.
- **Owners' flow untouched.** The Manage password still guards the owner.
- **Fresh permissions:** don't put permissions in `staff_sessions`. Revoking must bite immediately.
- **Hiding UI is courtesy;** the server decides (each route re-checks the permission, as the cash
  drawer route does today).
- **UI weight:** permission switches live inside the staff row (small, owner-only, rarely changed).
  Don't put them on the main list as columns.

### Files

New: `src/server/db/migrations/0045_staff_permissions.sql`, `src/server/services/verify-permissions.ts`.
Changed: `schema.ts`, `server/auth/permissions.ts`, `server/services/session.service.ts`, `proxy.ts`,
`app/api/sessions/[sessionId]/orders/route.ts`, `app/api/cash-drawer/open/route.ts`,
`app/api/sessions/[sessionId]/voids/route.ts`, `app/api/bills/[billId]/cancel/route.ts`,
`server/services/void.service.ts`, `app/orders/[sessionId]/page.tsx`, `app/orders/[sessionId]/bill/page.tsx`,
`app/page.tsx`, `components/pos/table-grid.tsx`, `components/pos/order-screen.tsx`, `app/manage/(area)/layout.tsx`,
`app/manage/(area)/manage-nav.tsx`, `app/manage/(area)/page.tsx`, `server/services/staff-admin.service.ts`,
`server/menu-admin/route.ts` (`staffFields`), `app/api/manage/staff/[id]/route.ts`, `components/manage/staff-editor.tsx`.

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-11-14-permissions.md]
- [Source: _bmad-output/planning-artifacts/epics.md#Story 10.6]; PRD FR67
- [Source: src/server/auth/permissions.ts] — ROUTE_ROLES, the "until 10.6" notes on each `can*`
- [Source: src/server/auth/manage-gate.ts], [Source: src/proxy.ts]

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Debug Log References

- `verify-permissions.ts` → 28/28 (walks all 32 `/api/manage/**` route files; drives the real `proxy()` with signed cookies).
- Regression: verify-voids 34/34, verify-staff-admin 39/39, verify-menu-admin 31/31, verify-floor-admin 30/30,
  verify-settings 27/27, verify-dashboard 17/17, verify-custom-charge 22/22, verify-bills 119/119, verify-setup 16/16,
  verify-vendor 27/27, verify-drawer 39/39. `tsc` clean; eslint clean on touched files.
- verify-manage not run: it needs `VERIFY_MANAGE_PASSWORD` (a Manage password is set locally).
- verify-receipt: 60/62 before this story too. Its "settling queues a receipt" check printed the bill first, and
  since 2026-11-13 a waiting BILL counts as handed over, so the receipt is skipped. The test now clears every print
  job before it (test-only fix). After the fix: 81/81 (the earlier failure had stopped later checks running).

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- **Data:** `staff.permissions text[]` (migration 0045) with a CHECK listing the seven names.
- **One map:** `MANAGE_AREAS` in `permissions.ts` (area → pages + APIs + permission). The proxy, the Manage
  nav, the `/manage` redirect and the verify script all read it. Anything not in it stays owner-only.
- **Proxy:** a non-owner holding the area's permission passes the Manage path with their PIN session alone
  (no role rule, no Manage password). `/manage` itself admits anyone with an area. The owner's flow is unchanged
  (still 401 MANAGE_LOCKED without the password). `x-staff-permissions` is stripped from requests and set from
  the database.
- **Fresh:** `validateSession` joins `staff` and returns `permissions` every request; a revoke is refused on the
  next request (tested).
- **Call sites:** `canAddCustomCharge` / `canOpenCashDrawer` take permissions (`/api/cash-drawer` admits waiters;
  the route checks). Void approval: `canApproveVoids` (owner or `approve_voids`) self-approves; `findApprover`
  candidates are every active person who can approve. Order page `canApproveVoids` → void sheet; bill page
  `canApprove`; Manage entry on the floor/order screens from `canOpenManage`. The void sheet's PIN pad says
  "Approver PIN".
- **Staff:** `updateStaff` accepts `permissions` (full set). Unknown names, kitchen or owner rows are refused
  (422). Granting yourself is refused (`OwnAccountError`). A job change to kitchen/owner clears them. Audited
  through the existing staff `config_changes` record. The staff sheet has "Extra permissions" switches in two
  groups (On the floor / Manage areas), shown only for waiter-access staff.
- Not done (outside the ACs): a list-row badge showing who holds extra permissions; only the sheet shows them.

### File List

New:
- src/server/db/migrations/0045_staff_permissions.sql
- src/server/db/migrations/meta/0045_snapshot.json
- src/server/services/verify-permissions.ts

Modified:
- src/server/db/schema.ts
- src/server/db/migrations/meta/_journal.json
- src/server/auth/permissions.ts
- src/server/services/session.service.ts
- src/proxy.ts
- src/server/services/void.service.ts
- src/server/services/staff-admin.service.ts
- src/server/menu-admin/route.ts
- src/app/api/manage/staff/[id]/route.ts
- src/app/api/sessions/[sessionId]/orders/route.ts
- src/app/api/sessions/[sessionId]/voids/route.ts
- src/app/api/bills/[billId]/cancel/route.ts
- src/app/api/cash-drawer/open/route.ts
- src/app/orders/[sessionId]/page.tsx
- src/app/orders/[sessionId]/bill/page.tsx
- src/app/page.tsx
- src/app/manage/(area)/page.tsx
- src/app/manage/(area)/layout.tsx
- src/app/manage/(area)/manage-nav.tsx
- src/components/pos/order-screen.tsx
- src/components/pos/table-grid.tsx
- src/components/pos/void-sheet.tsx
- src/components/manage/staff-editor.tsx
- src/server/print/verify-receipt.ts (test fix, see Debug Log)

### Change Log

- 2026-11-14: Story 10.6 implemented — per-user permissions (custom charge, approve voids, no-sale drawer,
  Manage areas Dashboard/Menu/Floor/Settings), granted in Manage → Staff, checked in the proxy and the routes,
  read fresh per request, audited. Status → review.
