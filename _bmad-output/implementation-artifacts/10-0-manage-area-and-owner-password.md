# Story 10.0: Manage Area & Owner Password

Status: review

- **Epic:** 10 — System Configuration & Staff Management
- **Requirement:** FR70, NFR-S7 (sprint-change-proposal-2026-11-04.md)
- **Go-live:** yes. 10.4 (menu), 8.3 (sold out), 10.2 (staff) and 9.5 (end of day) all live inside this area.
- **Why a password on top of the PIN:** the area is reachable from outside the restaurant over Tailscale, and a
  4-digit PIN is 10,000 guesses. A PIN alone never opens configuration.

## Story

As an owner,
I want one place for configuration that a PIN alone cannot open,
so that I can manage the restaurant from the counter or from home safely.

## Acceptance Criteria

1. **Way in.** An owner opens Manage from their staff badge on the floor (tap → small menu: **Manage**, **Switch
   user**) or by going to `/manage`. A waiter's or kitchen user's badge tap still switches user at once, as today.
2. **Password once per Manage session.** Entering Manage with no live Manage session shows the unlock screen.
   The right password starts a Manage session and returns the owner to the page they asked for.
3. **First time sets it.** If the restaurant has no Manage password yet, the unlock screen asks the owner to
   choose one (typed twice; 8–72 characters) instead. It is stored hashed with bcrypt, never in plain text,
   never logged, never returned.
4. **Rate-limited.** After 5 wrong passwords in a row, every attempt is refused for 5 minutes, even a right one.
   The screen says how long to wait. The count is per restaurant, kept in the database (a restart does not reset
   it), and goes back to 0 after a right password. Two attempts racing cannot both slip past the limit.
5. **The area.** `/manage` shows a section list — **Menu, Sold out, Staff, End of day** — beside the content.
   Laid out for a laptop (list on the left), and usable on a tablet (list becomes a top row). Each section is a
   page; until its own story lands it says what will be there and which story builds it. Also: **Back to floor**
   and **Lock** (ends the Manage session at once).
6. **15 minutes idle.** A Manage session not used for 15 minutes ends. The next Manage page or `/api/manage`
   call goes back to the unlock screen (pages) or answers `401 MANAGE_LOCKED` (API). The POS session is not
   affected.
7. **Tied to the PIN session.** A Manage session belongs to the one POS session that unlocked it. Signing out,
   switching user, or the POS session timing out ends it. Another tablet signed in as the same owner must unlock
   on its own.
8. **Owner only.** `/manage` and `/api/manage` are owner-only in `ROUTE_ROLES`. A waiter or kitchen user going to
   `/manage` is sent to the floor; to `/api/manage/...` gets 403. (The epic's "a manager reaches only Sold out" has
   no role to apply to yet: there is no `manager` role. See Dev Notes.)
9. **Locked out of your own restaurant.** A command run on the server, `pnpm manage:reset-password`, clears the
   Manage password and the lockout, so the next owner entry sets a new one.
10. **No regressions.** Sign-in, sign-out, the floor, orders, bills and payments behave as before.
    `verify-receipt --paper-only`, `verify-order-number`, `verify-drawer --bytes-only`, type-check and lint pass.

## Tasks / Subtasks

- [x] **Task 1: Schema + migration (AC 3, 4, 6, 7)**
  - [x] `tenants`: `manage_password_hash text` (null = not set), `manage_failed_attempts integer not null
        default 0`, `manage_locked_until timestamptz`.
  - [x] New table `manage_sessions`: `id uuid pk`, `staff_session_id uuid not null references staff_sessions(id)
        ON DELETE CASCADE`, `created_at`, `last_active_at` (both `defaultNow()`). Index on `staff_session_id`.
        The cascade is what makes AC 7 true: every path that deletes a POS session (logout, idle expiry in
        `validateSession`, `deleteExpiredSessions`, 10.2's deactivate) also ends Manage.
  - [x] `pnpm db:generate`, read the SQL (check the `ON DELETE cascade`), `pnpm db:migrate`. It will be 0037.
- [x] **Task 2: Manage session service (AC 2, 6, 7)**
  - [x] New `src/server/services/manage-session.service.ts` (NO `server-only` import: `proxy.ts` imports it, same
        note as `session.service.ts`).
  - [x] `MANAGE_COOKIE_NAME = '__cdrms_manage'`; the cookie value is `signSessionId(manageSessionId)` from
        `session-cookie.ts` — reuse the HMAC, do not write a second signer.
  - [x] `createManageSession(staffSessionId)`, `destroyManageSession(id)`,
        `validateManageSession(cookieValue, staffSessionId)` → null unless the signature is good, the row exists,
        it belongs to THIS staff session, and its idle age (computed by PostgreSQL, `now() - last_active_at`) is
        at most 15 minutes. An expired row is deleted. `touchManageSession` with the same 30-second throttle as
        `touchSession`.
  - [x] `MANAGE_IDLE_MINUTES = 15` as a constant (NFR-S7). Not a tenant setting yet.
- [x] **Task 3: Password service (AC 3, 4, 9)**
  - [x] New `src/server/services/manage-password.service.ts`: `getManagePasswordState(tenantId)` →
        `{ isSet, lockedForSeconds }`; `setManagePassword(tenantId, password)` refuses if one is already set
        (409) — first-time only in this story; `checkManagePassword(tenantId, password)` →
        `ok | wrong | locked(seconds)`.
  - [x] `checkManagePassword` runs in ONE transaction with `SELECT … FOR UPDATE` on the tenant row: refuse if
        `manage_locked_until > now()`; else bcrypt-compare; on a miss increment the count and, at 5, set
        `manage_locked_until = now() + interval '5 minutes'` and reset the count; on a hit reset both. The row lock
        is what stops parallel guesses each reading "4 so far". Database clock only.
  - [x] bcrypt cost 10 (architecture.md), `bcryptjs` (already a dependency). Validate 8–72 characters in UTF-8
        BYTES (`Buffer.byteLength`), because bcrypt silently ignores everything past 72 bytes.
  - [x] `src/server/db/reset-manage-password.ts` + `"manage:reset-password"` in `package.json` scripts (same
        `tsx --env-file-if-exists=.env` form as `db:seed`): sets the hash to null, the count to 0, the lock to null,
        deletes every `manage_sessions` row, prints one line. Refuses nothing: it is run by whoever has the server.
- [x] **Task 4: Routes (AC 2, 3, 4, 5, 8)**
  - [x] `ROUTE_ROLES`: add `{ prefix: '/manage', roles: ['owner'] }` and `{ prefix: '/api/manage', roles: ['owner'] }`
        BEFORE adding any route (an unmatched prefix is default-allow).
  - [x] `POST /api/manage/unlock` `{ password }` → sets the Manage cookie, `200`; wrong → `401 WRONG_PASSWORD`
        with `attemptsLeft`; locked → `429 LOCKED` with `retryAfterSeconds` (and a `Retry-After` header); not set →
        `409 NOT_SET`.
  - [x] `POST /api/manage/password` `{ password }` (first time) → hashes, then starts a Manage session as unlock
        does, `201`; already set → `409 ALREADY_SET`. Too short/long → `400`.
  - [x] `POST /api/manage/lock` → deletes the Manage session and the cookie, `200`. Safe with none.
  - [x] Cookie options exactly as the POS cookie (`httpOnly`, `sameSite: 'strict'`, the same conditional
        `secure`, `path: '/'`), `maxAge` 15 minutes. Never put the password in a log line or an error message.
- [x] **Task 5: The gate in `proxy.ts` (AC 2, 6, 7, 8)**
  - [x] After the existing role check, for `/manage…` and `/api/manage…` EXCEPT `/manage/unlock`,
        `/api/manage/unlock`, `/api/manage/password` and `/api/manage/lock`: `validateManageSession(cookie,
        session.sessionId)`. Missing → pages redirect to `/manage/unlock?next=<path>` (reuse the `return-to`
        helpers' rules: only a same-origin `/manage` path is accepted as `next`), API answers
        `401 { code: 'MANAGE_LOCKED' }`. Valid → `touchManageSession` and refresh the cookie's `maxAge` when touched.
  - [x] A failure inside the gate (database down) refuses, never lets through.
- [x] **Task 6: Screens (AC 1, 2, 3, 5)**
  - [x] `src/app/manage/unlock/page.tsx` (outside the area layout): asks `getManagePasswordState`; renders the set
        form (password + confirm) or the unlock form; shows `Wrong password — N tries left` and
        `Too many tries. Try again in M min.`; on success `router.replace(next || '/manage')`. Password input
        `type="password"` `autoComplete="current-password"` (or `new-password` when setting).
  - [x] `src/app/manage/(area)/layout.tsx`: section list Menu · Sold out · Staff · End of day, current one marked
        (`aria-current="page"`); Back to floor; Lock (calls `/api/manage/lock`, then goes to the floor). Light
        theme, laptop-first: `md:` two columns, below `md` a horizontal row. Desktop sizes are fine; keep 44px
        targets anyway, it is used on tablets too.
  - [x] `src/app/manage/(area)/page.tsx` redirects to `/manage/menu`. Four pages `menu`, `sold-out`, `staff`,
        `end-of-day`, each a short "Coming with Story X" panel (10.4, 8.3, 10.2, 9.5) — those stories replace them.
  - [x] Floor: `StaffBadge` stays as it is; `table-grid.tsx` gives the owner a small menu on tap (Manage → `/manage`,
        Switch user → `signOut`). Everyone else keeps `onStaffTap={signOut}`. Close on Escape and outside tap.
- [x] **Task 7: Verify (all ACs)**
  - [x] New `src/server/services/verify-manage.ts` through the real routes (dev server running, ideally with
        `PRINTER_USB_NAME=` empty). It sets, uses and finally CLEARS the Manage password it made, so a run leaves
        the tenant as it found it — if a password was already set, it refuses to run unless `VERIFY_MANAGE_PASSWORD`
        holds it, and then restores nothing it did not change. Cover the Testing table.
  - [x] Run the regressions in AC 10.

## Dev Notes

### Decisions already taken

| Decision | Why |
|---|---|
| Manage session in its own table, FK to `staff_sessions` with cascade | AC 7 for free: every way a POS session ends already deletes its row. No code in logout or expiry needs to know Manage exists. |
| Separate cookie, signed with the existing HMAC | A second secret or a second signing scheme is how the two drift. `signSessionId` signs any id. |
| Password on `tenants`, lockout on `tenants` | One password per restaurant (architecture.md: `tenants.manage_password_hash`). The limit protects the password, so it is per restaurant, not per device — an attacker can change devices. |
| Lockout counted in the database under a row lock | In-memory counters reset on restart and are per process; parallel requests would each see "4 so far". |
| First owner entry sets the password (AC 3) | The epic's rule. At install (Story 1.4) Teran sets it on site before Tailscale is opened, so the first entry is his. |
| Placeholder section pages | The area and its gate ship first; 10.4 / 8.3 / 10.2 / 9.5 each replace one page. |

### 🚨 Trap 1: there is no manager role

The roles are `waiter`, `owner`, `kitchen` (`permissions.ts` explains why). The epic's "a manager reaches only Sold
out, without the password" cannot be built yet. When 8.3 builds Sold out, it decides who besides the owner may use
it (probably a per-person permission from 10.6), and gives that screen its own route OUTSIDE the password gate.
Do not add a role here.

### 🚨 Trap 2: the POS idle timeout is shorter than Manage's

`tenant_config.session_timeout_minutes` is 5 for Carpe Diem. Every Manage request also passes the POS session check
and touches it, so active use keeps both alive. But an owner who reads a page for 6 minutes without a request loses
the POS session first, and with it (cascade) the Manage session: the next click goes to the PIN pad, then the
unlock screen. That is the rule working, not a bug. Do NOT make Manage extend or bypass the POS timeout. Raised as
Open Question 1.

### 🚨 Trap 3: the proxy matcher and static assets

`proxy.ts` runs for every non-static path. The gate must match `/manage` and `/manage/...` exactly — not
`/manager-notes` — use the same `pathname === p || pathname.startsWith(p + '/')` test as `findRoutePolicy`. And
`/manage/unlock` must stay reachable with no Manage session, or nobody can ever unlock.

### 🚨 Trap 4: open redirect through `next`

`/manage/unlock?next=https://evil.example` must not send anyone off-site. Accept `next` only if it starts with
`/manage` and not `//`. `src/lib/return-to.ts` already solves this for login; reuse its check or mirror it.

### 🚨 Trap 5: bcrypt's 72-byte limit and the password in logs

bcrypt ignores bytes past 72, so "a 100-character password" would really be its first 72. Refuse over 72 bytes.
Zod's default error echoes the received value; return a fixed message instead (the login route's comment on the PIN
explains this). `console.error` the error object only, never the body.

### 🚨 Trap 6: React Compiler lint

This repo's lint refuses reading a ref during render (6.6). Keep the badge menu's open state in `useState`; close on
outside tap with an effect, not a ref read in render.

### What must keep working

- `validateSession`, `touchSession`, login, logout: unchanged except that deleting a POS session now also deletes its
  Manage session (database cascade).
- Waiter and kitchen badge taps sign out exactly as today.
- Every existing `ROUTE_ROLES` entry; the new prefixes are additions.
- The socket authenticator in `server.ts` reads only the POS cookie; it does not need the Manage cookie.

### Out of scope

- Changing the Manage password from inside Manage (the reset command covers a forgotten one). Open Question 2.
- The sections' real content (10.4, 8.3, 10.2, 9.5), the hamburger drawer (10.1, post-launch), sync status (Epic 13).
- Per-device trust, 2FA, password strength rules beyond length.

### Project Structure Notes

| File | Change |
|---|---|
| `src/server/db/schema.ts`, migration 0037 | Task 1 |
| `src/server/services/manage-session.service.ts` (new) | Task 2 |
| `src/server/services/manage-password.service.ts` (new), `src/server/db/reset-manage-password.ts` (new), `package.json` | Task 3 |
| `src/server/auth/permissions.ts`, `src/app/api/manage/{unlock,password,lock}/route.ts` (new) | Task 4 |
| `src/proxy.ts` | Task 5 |
| `src/app/manage/unlock/page.tsx`, `src/app/manage/(area)/{layout,page}.tsx`, `src/app/manage/(area)/{menu,sold-out,staff,end-of-day}/page.tsx` (new), `src/components/pos/table-grid.tsx` (badge menu) | Task 6 |
| `src/server/services/verify-manage.ts` (new) | Task 7 |

### Testing

No test framework by decision; each story adds a `verify-*.ts` script.

| # | Case | Expected |
|---|---|---|
| 1 | Owner, no password set, `GET /manage/menu` | redirect to `/manage/unlock?next=/manage/menu` |
| 2 | `POST /api/manage/password` 7 chars / 73 bytes | 400, nothing stored |
| 3 | Set a password | 201, Manage cookie set, hash in `tenants` starts `$2`, password text nowhere in the row |
| 4 | Set again | 409 `ALREADY_SET` |
| 5 | Fresh owner login, `GET /api/manage/...` without unlock | 401 `MANAGE_LOCKED` |
| 6 | Unlock with the right password | 200, Manage pages load |
| 7 | 4 wrong, then right | 401 ×4 with `attemptsLeft` 4→1, then 200 and the count is 0 |
| 8 | 5 wrong | the 5th answers 429; a right password during the lock is 429 too |
| 9 | 6 wrong attempts sent at once | exactly the limit counted; the lock is set once |
| 10 | Lock expiry (set `manage_locked_until` to the past) | right password → 200 |
| 11 | Manage idle 16 min (backdate `last_active_at`) | 401 `MANAGE_LOCKED`; the POS session still works (`GET /api/tables` 200) |
| 12 | Logout | the `manage_sessions` row is gone |
| 13 | Same owner, second login (another tablet) | that session is locked until it unlocks itself |
| 14 | Manage cookie from session A sent with session B's POS cookie | refused |
| 15 | Waiter: `/manage` page, `/api/manage/unlock` | redirect to `/`; 403 |
| 16 | `next=https://evil.example` and `next=//evil.example` | ignored; lands on `/manage` |
| 17 | `pnpm manage:reset-password` | hash null, count 0, lock null, no Manage sessions |
| 18 | Lock button | session row gone; next Manage request is locked |

### References

- [Source: _bmad-output/planning-artifacts/epics.md — Story 10.0]
- [Source: _bmad-output/planning-artifacts/prd.md — FR70, NFR-S7]
- [Source: _bmad-output/planning-artifacts/architecture.md — "Manage area auth (FR70, NFR-S7)"]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md — "Manage area (2026-11-04)"]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-11-04.md]
- [Source: src/proxy.ts; src/server/services/session.service.ts — CLOCK AUTHORITY note; src/server/auth/session-cookie.ts]
- [Source: src/server/auth/permissions.ts — default-allow for unmatched prefixes; no manager role]
- [Source: src/app/api/auth/login/route.ts — never echo the credential; cookie options]

## Open Questions (for Teran)

1. **Idle timeouts.** The PIN session ends after 5 minutes idle, so working in Manage from home will ask for the PIN
   again after 5 quiet minutes, then the password. Keep that, or give owners a longer PIN timeout?
2. **Changing the password.** This story only sets it the first time and resets it from the server. Want a
   "Change password" inside Manage now, or later?

## Dev Agent Record

### Agent Model Used

Claude Opus 5.5 (claude-opus-5-5)

### Debug Log References

- `verify-manage.ts` first run 29/30: case 16b looked for `evil.example` anywhere in the unlock page, but Next's
  router state echoes the request URL into the RSC payload whatever the app does. The check now reads the `next`
  prop the form is actually given (`/manage`). 30/30 after.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Migration 0037: three `tenants` columns and `manage_sessions` with `ON DELETE cascade` to `staff_sessions` (read
  in the SQL). Logout, idle expiry and the sweep end Manage with no code change (case 12 proves logout).
- `manage-session.service.ts`: cookie `__cdrms_manage` signed with the existing `signSessionId`; validation needs
  the row AND this POS session id in one WHERE (cases 13, 14); idle age by PostgreSQL; 30 s touch throttle.
- `manage-password.service.ts`: bcrypt cost 10, 8–72 UTF-8 bytes; check runs in one transaction under
  `SELECT … FOR UPDATE` on the tenant row. Six parallel wrong guesses → exactly 4 × 401 + 2 × 429, lock 300 s
  (case 9). First-time set uses `WHERE hash IS NULL`, so two racing setters cannot both win.
- Routes share `src/server/auth/manage-route.ts` (not listed in the story): they need the POS session id, which the
  proxy does not pass, so the POS cookie is validated again there. The body is read by hand, never through a Zod
  issue list, so the password cannot be echoed.
- Proxy gate after the role check: a waiter is refused as a waiter (redirect to `/` / 403), never shown the unlock
  screen. Exempt: `/manage/unlock`, `/api/manage/{unlock,password,lock}`. Database failure → locked.
  `/manager-notes` is not matched (case 15b).
- `next`: new `safeManagePath` / `manageUnlockUrl` in `return-to.ts` reuse `safeReturnPath` and additionally require a
  Manage path other than the unlock screen.
- Badge menu: new `StaffMenu` component, rendered by `FloorHeader` only when `onManage` is passed; `table-grid.tsx`
  passes it for the owner only. Waiter/kitchen keep `StaffBadge` → `signOut`, unchanged. Close on Escape and
  outside tap via a document listener + `closest()`, no ref read in render.
- Area: `(area)` route group so `/manage/unlock` sits outside the layout. Sections list in `sections.tsx`; each of
  the four pages is a "Coming with Story X" panel.
- Verified: `verify-manage` 30/30 (all 18 Testing cases plus sub-checks; it restores the tenant's Manage columns
  and deletes its own POS sessions). Regressions: `verify-receipt --paper-only` 32/32, `verify-drawer --bytes-only`
  8/8, `verify-order-number` 15/15, also `verify-bills` 119/119, `verify-custom-charge` 22/22, `verify-options`
  33/33. `tsc --noEmit` clean; `pnpm lint` 0 errors (1 pre-existing warning in `src/server/socket/index.ts`).
- Not verified in a browser: the badge menu and the area layout at laptop/tablet widths were checked by lint and
  type-check only.
- Open Questions 1 and 2 left for Teran; nothing built for either.

### File List

- `src/server/db/schema.ts` (modified)
- `src/server/db/migrations/0037_manage_area.sql` (new)
- `src/server/db/migrations/meta/0037_snapshot.json` (new)
- `src/server/db/migrations/meta/_journal.json` (modified)
- `src/server/services/manage-session.service.ts` (new)
- `src/server/services/manage-password.service.ts` (new)
- `src/server/db/reset-manage-password.ts` (new)
- `package.json` (modified — `manage:reset-password`)
- `src/server/auth/permissions.ts` (modified)
- `src/server/auth/manage-route.ts` (new)
- `src/app/api/manage/unlock/route.ts` (new)
- `src/app/api/manage/password/route.ts` (new)
- `src/app/api/manage/lock/route.ts` (new)
- `src/proxy.ts` (modified)
- `src/lib/return-to.ts` (modified)
- `src/app/manage/unlock/page.tsx` (new)
- `src/app/manage/unlock/unlock-form.tsx` (new)
- `src/app/manage/(area)/layout.tsx` (new)
- `src/app/manage/(area)/manage-nav.tsx` (new)
- `src/app/manage/(area)/sections.tsx` (new)
- `src/app/manage/(area)/page.tsx` (new)
- `src/app/manage/(area)/menu/page.tsx` (new)
- `src/app/manage/(area)/sold-out/page.tsx` (new)
- `src/app/manage/(area)/staff/page.tsx` (new)
- `src/app/manage/(area)/end-of-day/page.tsx` (new)
- `src/components/pos/staff-menu.tsx` (new)
- `src/components/pos/floor-header.tsx` (modified)
- `src/components/pos/table-grid.tsx` (modified)
- `src/server/services/verify-manage.ts` (new)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified)

## Change Log

- 2026-11-12: Story created.
- 2026-11-12: Implemented — Manage area behind an owner password: migration 0037, Manage session + password
  services, unlock/password/lock routes, proxy gate, unlock screen, area layout with four placeholder sections,
  owner badge menu, `pnpm manage:reset-password`, `verify-manage.ts` (30/30). Status → review.
