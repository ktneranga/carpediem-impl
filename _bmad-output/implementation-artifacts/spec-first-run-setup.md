---
title: 'First-run setup: start a restaurant from an empty install'
type: 'feature'
created: '2026-11-14'
status: 'done'
baseline_commit: '6e199f8'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A fresh install has every table but no restaurant and no owner, so nobody can sign in; the only way in today is restoring a dump from a developer PC. Every new restaurant starts empty.

**Approach:** When the database has no tenant, the app shows a one-time setup screen — restaurant name, time zone, owner name + 4-digit PIN, Manage password — that creates the tenant, its config and the first owner in one transaction, then sends to sign-in. Menu, floor and staff are then entered in Manage as today. Restaurant settings (bill header/footer, logo, tax…) are a separate follow-up (deferred-work.md).

## Boundaries & Constraints

**Always:** Setup works ONLY while `tenants` is empty — checked inside the transaction under a table lock, so two simultaneous submits create one restaurant. PIN rules as Staff (`checkPin`), Manage password rules as Manage (`isValidManagePasswordLength`, bcrypt cost 10). Time zone must be a valid IANA zone (`Intl`), default `Asia/Colombo`. The PIN and password never appear in a response or log. Once a tenant exists, `/setup` and `/api/setup` refuse and point to sign-in.

**Ask First:** creating any demo data (zones, tables, menu); setting fields beyond the five on the screen.

**Never:** a setup route that works when a tenant exists; seeding sample data in production; changing the existing `/manage/unlock` first-time flow.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh install | no tenant; open `/login` | redirect to `/setup` | N/A |
| Setup | valid name, zone, owner name, PIN, password ×2 | 201; tenant + tenant_config (restaurant name) + owner staff (job `owner`) + Manage password hash; screen says "Set up — sign in with your PIN" → `/login` | N/A |
| Invalid input | empty name, bad zone, PIN not 4 digits, password < 8 bytes or mismatch | 400/422 naming the field | form shows it, nothing written |
| Already set up | a tenant exists | `/setup` redirects to `/login`; `POST /api/setup` 409 `ALREADY_SET_UP` | N/A |
| Race | two submits at once on an empty DB | exactly one tenant; the other gets 409 | N/A |

</frozen-after-approval>

## Code Map

- `src/proxy.ts` -- `isPublic` + the `/login` redirect when not provisioned
- `src/server/db/schema.ts` -- `tenants` (name, timezone, manage_password_hash), `tenantConfig` (restaurant_name required), `staff`
- `src/server/services/staff-admin.service.ts` -- `checkPin`, `cleanStaffName`, `recordConfigChange` pattern (`log`)
- `src/server/services/manage-password.service.ts` -- `isValidManagePasswordLength`, bcrypt cost
- `src/lib/staff-jobs.ts` -- job `owner` → role `owner`
- `src/app/login/page.tsx` -- PIN pad screen; style reference for `/setup`

## Tasks & Acceptance

**Execution:**
- [x] `src/server/services/setup.service.ts` -- `isProvisioned()` (cached once true), `checkSetup(input)` (validation, field-named errors), `runSetup(input)`: one transaction, `LOCK TABLE tenants IN EXCLUSIVE MODE`, refuse if any tenant, insert tenant (name, timezone, password hash), tenant_config (restaurant_name), owner staff (job `owner`, role `owner`, bcrypt PIN), config_change for the staff row -- the one place the rules live
- [x] `src/app/api/setup/route.ts` -- `POST`, zod body, maps errors to 400/409/422; never echoes PIN/password
- [x] `src/app/setup/page.tsx` + `setup-form.tsx` -- server page redirects to `/login` when provisioned; form: restaurant name, time zone (select of common zones + Asia/Colombo default), owner name, PIN, PIN again, Manage password, again; on success → `/login`
- [x] `src/proxy.ts` -- `/setup` and `POST /api/setup` public; unauthenticated `/login` GET redirects to `/setup` when not provisioned
- [x] `src/server/services/verify-setup.ts` -- runs against a throwaway database state: refuses when a tenant exists (always true on dev), and on an EMPTY schema in a separate local database checks the full path, validation and the race (two parallel `runSetup`)

**Acceptance Criteria:**
- Given setup finished, when the owner signs in with the new PIN and opens Manage, then the Manage password from setup unlocks it.
- Given setup finished, when Manage → Staff opens, then the owner is listed with job Owner.

## Design Notes

`isProvisioned()` caches `true` in memory (a tenant is never deleted), so the proxy's `/login` check costs one query per process until the first restaurant exists, then none.

Race test needs an empty `tenants` table; dev has one. The verify script creates a temporary database (`CREATE DATABASE cdrms_setup_verify`), runs `drizzle-kit migrate` against it, exercises setup there, and drops it.

## Verification

**Commands:**
- `npx tsx --conditions=react-server --env-file=.env src/server/services/verify-setup.ts` -- all pass
- `npx tsc --noEmit -p .` and `npx eslint` on touched files -- clean

**Manual checks:**
- On the empty POS install (1-4): open the app → `/setup` → fill in → sign in with the PIN → Manage asks for the password just set.

## Suggested Review Order

**Only on an empty install**

- Entry point: lock tenants, refuse if any exists, create all three in one transaction.
  [`setup.service.ts:100`](../../src/server/services/setup.service.ts#L100)

- Public route refuses before any bcrypt work once set up; JSON only.
  [`route.ts:32`](../../src/app/api/setup/route.ts#L32)

- The proxy sends /login to /setup while there is no restaurant.
  [`proxy.ts:113`](../../src/proxy.ts#L113)

- The page re-checks the database itself, so no redirect loop.
  [`page.tsx:14`](../../src/app/setup/page.tsx#L14)

**Rules**

- Field-named validation; time zone stored in its standard spelling.
  [`setup.service.ts:61`](../../src/server/services/setup.service.ts#L61)

**UI and tests**

- Five fields, PIN and password typed twice, byte-length check like the server.
  [`setup-form.tsx:27`](../../src/app/setup/setup-form.tsx#L27)

- 16 checks, the full path and the race on a throwaway migrated database.
  [`verify-setup.ts:1`](../../src/server/services/verify-setup.ts#L1)
