---
title: 'Vendor access: sign-in and database export'
type: 'feature'
created: '2026-11-14'
status: 'done'
baseline_commit: 'a169396'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Before launch there is no automatic off-site backup (11-3 lite's nightly job is deferred), so the developer needs a one-click way to download the whole database from the POS, without giving any restaurant user that power.

**Approach:** A separate `/vendor` sign-in with a long password from `.env` (not a staff PIN, not in the staff list or PIN pad). Signed in, the vendor can only download a full `pg_dump -Fc` streamed from the server. Every sign-in and export is recorded, and the owner sees "Vendor access: last used <date>" in Manage. Brought forward from 11-1; replaces the automatic part of 11-3 lite (Teran, 2026-11-14).

## Boundaries & Constraints

**Always:** password from `VENDOR_SECRET` (already in `.env.example`); feature off when it is unset or shorter than 16 characters. Constant-time compare. Vendor cookie signed with the existing `signSessionId`, `httpOnly`, `sameSite=strict`, 30-minute absolute life. The audit table is append-only (immutable trigger). The vendor session grants nothing on staff routes (no `x-staff-*` headers). pg_dump runs against `DATABASE_URL`; the password never appears in a response or log.

**Ask First:** any vendor ability beyond sign-in and export; showing vendor access anywhere other than the Manage nav.

**Never:** a vendor staff role or PIN; storing the dump on the server; restore through the app; nightly/cron backups (deferred 11-3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sign in | right password | 200, vendor cookie, `sign_in` row | N/A |
| Wrong password | wrong password | 401 `INVALID_PASSWORD`, nothing recorded | after 5 wrong in a row (process-wide): 429 `LOCKED` for 15 min |
| Not configured | `VENDOR_SECRET` unset/short | `/vendor` says vendor access is off; login 503 `VENDOR_DISABLED` | N/A |
| Export | valid vendor cookie | 200 stream, `Content-Disposition: attachment; filename="carpe-diem_YYYY-MM-DD_HHMM.dump"`, `export` row | N/A |
| Export, no/expired cookie | none, forged, or > 30 min | 401 `VENDOR_SIGN_IN_REQUIRED` | N/A |
| pg_dump missing | binary not found | 503 `PG_DUMP_MISSING`, no `export` row | logged |

</frozen-after-approval>

## Code Map

- `src/proxy.ts` -- `isPublic`: staff-session gate; `/vendor` and `/api/vendor/*` must bypass it (handlers check the vendor cookie)
- `src/server/auth/session-cookie.ts` -- `signSessionId` / `verifySessionCookie` HMAC, reused for the vendor cookie
- `src/server/db/schema.ts` -- new `vendor_access_events` table
- `src/app/manage/(area)/layout.tsx`, `manage-nav.tsx` -- owner-visible "last used" line
- `docker/Dockerfile` -- runner stage `node:22-alpine`; needs `postgresql17-client`
- `.env.example` -- `VENDOR_SECRET` already listed; reword its comment

## Tasks & Acceptance

**Execution:**
- [x] `src/server/db/schema.ts` + `migrations/0044_vendor_access.sql` -- table `vendor_access_events (id, tenant_id, kind enum 'sign_in'|'export', created_at clock_timestamp())`, index on `(tenant_id, created_at)`, `immutable_vendor_access_events` trigger -- the audit record
- [x] `src/server/services/vendor.service.ts` -- `vendorConfigured()`, `checkVendorPassword()` (timingSafeEqual on SHA-256 digests, in-memory lockout), `startVendorSession()` (insert `sign_in`, return signed cookie of its id), `validateVendorSession(cookie)` (row is `sign_in` and < 30 min old), `recordExport()`, `lastVendorAccess(tenantId)`, `dumpFilename()` -- one place for the rules
- [x] `src/app/api/vendor/login/route.ts`, `logout/route.ts`, `export/route.ts` -- login sets cookie `__cdrms_vendor`; export spawns `PG_DUMP_PATH ?? 'pg_dump'` with `--format=custom --no-owner --dbname=<DATABASE_URL>` and returns its stdout as a stream; ENOENT → 503; non-zero exit is logged
- [x] `src/app/vendor/page.tsx` + `vendor-panel.tsx` -- password form when signed out; "Download database" + "Sign out" when signed in; minimal, light, no staff chrome
- [x] `src/proxy.ts` -- treat `/vendor` and `/api/vendor/*` as public
- [x] `src/app/manage/(area)/layout.tsx`, `manage-nav.tsx` -- when unlocked, a small muted line above Lock: "Vendor access: last used 14 Nov, 21:30" or "never"
- [x] `docker/Dockerfile` -- `apk add --no-cache postgresql17-client` in the runner stage; `.env.example` comment for `VENDOR_SECRET` (16+ chars, enables /vendor)
- [x] `src/server/services/verify-vendor.ts` -- the matrix rows except the live dump; plus "cookie of a non-sign_in row is refused" and "an UPDATE on vendor_access_events raises"

**Acceptance Criteria:**
- Given a staff PIN session only, when `/api/vendor/export` is called, then 401 — staff roles never reach it.
- Given a vendor cookie, when any staff route is called, then it is treated as signed out (no staff headers).
- Given exports happened, when the owner opens Manage unlocked, then the last sign-in/export time shows.
- Given the built image, when `pg_dump --version` runs in the app container, then it reports 17.x.

## Design Notes

The sign-in row's id is the session id: no sessions table, and the audit trail and the session are one fact. Lockout is process-wide (one POS server); a restart clears it, as with the void PIN lockout.

## Verification

**Commands:**
- `npx tsx --conditions=react-server --env-file=.env src/server/services/verify-vendor.ts` -- all pass
- `npx tsc --noEmit -p .` and `npx eslint` on touched files -- clean
- `docker exec carpe-diem-rms-db-1 pg_dump -U postgres --format=custom --no-owner cdrms | head -c 5` -- starts `PGDMP` (the exact arguments the route uses)

**Manual checks:**
- In the installed stack (1-4): sign in at `/vendor`, download, `pg_restore --list` the file.

## Suggested Review Order

**Export: never a broken file passed off as a backup**

- Entry point: auth, then off-switch, single-flight, then pg_dump.
  [`route.ts:37`](../../src/app/api/vendor/export/route.ts#L37)

- Password goes in PGPASSWORD, not on the command line or in logs.
  [`route.ts:68`](../../src/app/api/vendor/export/route.ts#L68)

- Waits for the first byte; no bytes is a 502 and nothing is recorded.
  [`route.ts:112`](../../src/app/api/vendor/export/route.ts#L112)

- Recorded only once data is flowing; no record, no export.
  [`route.ts:122`](../../src/app/api/vendor/export/route.ts#L122)

- A part-way failure errors the stream so the download visibly fails.
  [`route.ts:132`](../../src/app/api/vendor/export/route.ts#L132)

**Sign-in and session**

- Constant-time compare; lockout counts wrong tries within 15 minutes.
  [`vendor.service.ts:49`](../../src/server/services/vendor.service.ts#L49)

- The sign-in audit row's id is the session; 30 minutes by the DB clock.
  [`vendor.service.ts:97`](../../src/server/services/vendor.service.ts#L97)

- Login route: never echoes the password; limit matches the secret's.
  [`login/route.ts:23`](../../src/app/api/vendor/login/route.ts#L23)

- Exact vendor paths bypass the staff gate; no staff headers are ever set.
  [`proxy.ts:36`](../../src/proxy.ts#L36)

**Owner visibility**

- Last sign-in and last export, formatted in the restaurant's zone.
  [`layout.tsx:32`](../../src/app/manage/(area)/layout.tsx#L32)

- Each kind read separately so a sign-in never hides an export.
  [`vendor.service.ts:122`](../../src/server/services/vendor.service.ts#L122)

**Storage and packaging**

- Append-only audit table.
  [`schema.ts:451`](../../src/server/db/schema.ts#L451)

- Immutable trigger on it.
  [`0044_vendor_access.sql:12`](../../src/server/db/migrations/0044_vendor_access.sql#L12)

- pg_dump 17 in the app image, matching the db service.
  [`Dockerfile:28`](../../docker/Dockerfile#L28)

**UI and tests**

- Sign-in form, then Download / Sign out; network errors shown.
  [`vendor-panel.tsx:13`](../../src/app/vendor/vendor-panel.tsx#L13)

- 26 checks: service, login route, export route failure paths.
  [`verify-vendor.ts:1`](../../src/server/services/verify-vendor.ts#L1)
