# Sprint Change Proposal — Go-live plan & two-way menu/staff cloud sync

**Date:** 2026-11-04 · **Author:** Teran (with Dev agent) · **Mode:** Batch · **Scope:** Moderate

---

## 1. Issue Summary

**A — No defined go-live line.** The PRD says all MVP capabilities are load-bearing (prd.md:389), yet the
sprint is ordered by epic, and several things a restaurant cannot open without are either unbuilt or
deferred, while non-essential work (7.1 DisputeTimeline) is next in line. Checked against the code on
2026-11-04:

| Gap | Evidence |
|---|---|
| The customer bill cannot be printed | `bill-screen.tsx`: "PRINT RECEIPT (bill printing is not built)"; no FR or story covers it |
| A sent item cannot be voided or comped | `comp_records` is read by `bill.service.ts`, written by nothing; Story 7.3 is backlog |
| Menu, prices and sold-out change only by a developer | Stories 10.4, 8.3 backlog; menu comes from seed scripts |
| Staff and PINs change only by a developer | Story 10.2 backlog |
| No end-of-day takings for the cash count | Epic 9 backlog |
| No backup of any kind | `docker/scripts/backup.sh` does not exist; NFR-R4 unmet |

**B — Remote menu/staff management.** Teran (2026-11-04): the owner should be able to change the menu
and staff on the local POS **or** remotely through a cloud dashboard; local changes back up to the cloud
when the internet is available, remote changes sync down to the local POS, and the POS shows they are
synced. The architecture's Post-MVP Cloud Sync (architecture.md:1109) covers local → cloud and vendor
"menu templates" down, but states the syncer is "additive only — never modifies per-restaurant
operational data" and "no conflict resolution is needed". Two-way owner edits contradict both.

**Decision taken in conversation:** management lives in the same app as a separate **Manage** area
(`/manage`), entered with the owner's PIN **plus a password**, reachable remotely over Tailscale at
launch; the cloud dashboard and two-way sync come after launch, and launch-time menu/staff writes are
built sync-ready so nothing is reworked.

## 2. Impact Analysis

| Area | Impact |
|---|---|
| **Epic 1** | 1.4 gains the on-site install checklist (boot start, Tailscale, printer, tablets). |
| **Epic 6** | New Story 6.6 — print the customer bill. |
| **Epic 7** | 7.3 (comp/void) moves into go-live; 7.1, 7.2, 7.4 after. |
| **Epic 8** | 8.3 (sold-out toggle) into go-live; 8.1, 8.2 after. |
| **Epic 9** | New Story 9.5 — end-of-day takings. 9.1–9.4 after launch (and partly superseded by Epic 13's cloud dashboard). |
| **Epic 10** | New Story 10.0 — Manage area + owner password; 10.1 drawer reduced to a link into it; 10.2 and 10.4 into go-live with sync-ready writes; 10.3, 10.5, 10.6 after. |
| **Epic 11** | 11.3 simplified into go-live (nightly local backup + off-site copy); rest after. |
| **New Epic 13** | Cloud Hub & Two-Way Config Sync — post-launch. |
| **PRD** | FR69 (bill print), FR70 (Manage area), FR71 (two-way config sync, post-MVP); NFR-S4 and NFR-S7; go-live scope section. |
| **Architecture** | Manage-area auth; sync-ready config writes (`config_changes`, `version`); Cloud Sync section rewritten for two-way config. |
| **UX** | Manage area layout; sync status indicator. |
| **Technical** | New migration at go-live: `version` + `updated_at` on `menu_items`, `menu_categories`, modifier tables, `staff`; `config_changes` table; `tenants.manage_password_hash`. No rework of shipped code. |

## 3. Recommended Approach

**Direct Adjustment + re-sequencing.** Nothing shipped is rolled back and MVP goals are unchanged; the
sprint is re-ordered around a go-live line, one story is added per gap, and the two-way sync is planned as
a new post-launch epic. Effort: ~9 stories to go-live (2 reviews, 7.3, 6.6, 10.0, 10.2, 10.4+8.3, 9.5,
11.3-lite, 1.4 install). Risk: medium on 6.6 (printer layout) and 10.0 (auth); low elsewhere. The sync-ready
writes cost one small migration now and save a rework later.

## 4. Detailed Change Proposals

### 4.1 PRD

**P1 — New FRs** (after FR68):

```
- **FR69:** Staff can print the customer bill for any generated bill on the receipt printer: restaurant
  name, order number (FR68), table(s) or tab, business date and time, itemised lines with options and
  notes, comps, subtotal, service charge, tax, total, and — once settled — the payment method(s) and any
  change given. A reprint is marked `COPY`. *(Added 2026-11-04 — sprint-change-proposal-2026-11-04.md.
  The bill screen could settle a bill but not hand the guest one.)*
- **FR70:** All owner configuration (menu, sold-out, staff, end-of-day takings, later tables and
  settings) lives in one **Manage** area of the same app. Entering it requires an owner PIN session
  **and** the Manage password; managers enter only the sold-out screen. It is laid out for a laptop as
  well as a tablet, and is reachable remotely over Tailscale. *(Added 2026-11-04.)*
- **FR71 (Post-MVP):** Menu and staff configuration is kept in step between the local POS and a cloud
  dashboard in both directions. A change made locally is saved locally at once and sent to the cloud
  when the internet is available; a change made in the cloud dashboard is applied to the local POS on its
  next connection. When the same record was changed on both sides while apart, the later edit wins and
  the overwritten one is kept in the change log. The Manage area shows the sync state: synced, changes
  waiting, or offline since a time. Orders, payments and audit records sync one way only (local → cloud).
  *(Added 2026-11-04 — Teran.)*
```

**P2 — NFR-S4 amended** (append):

```
  Config sync (FR71) is a second such opt-in, governed by `cloud_sync_enabled`; when disabled nothing
  leaves the premises. *(amended 2026-11-04)*
```

**P3 — New NFR-S7** (after NFR-S6):

```
- **NFR-S7:** The Manage area requires the Manage password in addition to an owner PIN session; the
  password is stored hashed, entry is rate-limited, and the Manage session expires after 15 minutes idle.
  A 4-digit PIN alone never opens configuration, because the area is reachable from outside the
  restaurant. *(Added 2026-11-04.)*
```

**P4 — New subsection "Go-live line (2026-11-04)"** under Project Scoping & Phased Development, after
"MVP Feature Set (Phase 1)":

```
### Go-live line (2026-11-04)

The restaurant is handed the system when these work end to end on site; everything else follows launch.

1. Order entry, routing and printed tickets (built) — reviews of 4.8/4.9 closed.
2. Void / comp a sent item with a reason (FR47, FR48, Story 7.3).
3. Customer bill printed (FR69, Story 6.6).
4. Manage area (FR70): menu with prices, options and sold-out (FR56, FR36); staff and PINs (FR58);
   end-of-day takings by business date (FR50, FR54 subset).
5. Nightly backup, local plus an off-site copy (NFR-R4).
6. Installed on site: starts on boot, survives a power cut, Tailscale for the owner, printer and tablets
   tested at the furthest table (NFR-R6).

After launch: audit timeline views (7.1, 7.2, 7.4), KDS, portion counts, dashboard charts, table/zone
editor, per-user permissions, branding, vendor APIs, then Epic 13 (cloud hub and FR71), then Epic 12
(cloud order relay) only if site Wi-Fi proves a problem.
```

### 4.2 Epics

**E1 — Epic List:** add Epic 13 entry after Epic 11:

```
### Epic 13: Cloud Hub & Two-Way Config Sync (Post-launch)

**Goal:** A hosted hub that receives each restaurant's records (one way), stores its backups, gives the
owner a cloud dashboard without Tailscale, and keeps menu and staff in step in both directions with a
visible sync state on the POS.

**Requirements Covered:** FR71, FR53 (remote access without VPN), NFR-S4 (opt-in), NFR-R4 (off-site backup)
```

**E2 — New Story 6.6** (after 6.5):

```
### Story 6.6: Print the Customer Bill

> **Added 2026-11-04** *(sprint-change-proposal-2026-11-04.md)* · FR69 · go-live

As a cashier, I want to print the bill the guest pays from, so that the guest can check it and keep it.

**Given** a generated bill **When** staff tap Print bill **Then** a receipt job is queued on the print
queue (Story 5.0) to the receipt printer — the same queue, retries and dead-lettering as tickets
**Given** the receipt **Then** it shows restaurant name, `#042` and `Order 20261102-042`, table(s) or tab,
date and time, each line with options and note, comps, subtotal, service charge, tax and total
**Given** a settled bill **Then** the receipt also shows payment method(s), amount tendered and change
**Given** a bill already printed **When** it is printed again **Then** the receipt is marked `COPY`
**Given** a split bill **Then** each person's / seat's bill prints on its own receipt
```

**E3 — New Story 9.5** (after 9.4):

```
### Story 9.5: End-of-Day Takings

> **Added 2026-11-04** · FR50, FR54 (subset) · go-live — a plain Manage screen, not the Epic 9 charts

As an owner, I want the day's takings at close, so that I can count the drawer against them.

**Given** the owner opens Manage → End of day **Then** for a business date (today by default, turning
over at `business_day_start_hour`) it shows: number of orders, gross sales, comps, service charge, tax,
cash, card, and orders still open
**Given** orders are still open **Then** they are listed by `#042` and table, so the day is not closed blind
**Given** a past business date is chosen **Then** the same figures are shown for that date
**Given** the screen **Then** it can be printed on the receipt printer
```

**E4 — New Story 10.0** (before 10.1):

```
### Story 10.0: Manage Area & Owner Password

> **Added 2026-11-04** · FR70, NFR-S7 · go-live

As an owner, I want one place for configuration that a PIN alone cannot open, so that I can manage the
restaurant from the counter or from home safely.

**Given** an owner session **When** the owner opens ☰ → Manage (or `/manage`) **Then** the Manage
password is asked once per Manage session; a wrong password is rate-limited (5 tries, then 5 minutes)
**Given** no Manage password is set yet **Then** the first owner entry sets one
**Given** the Manage area **Then** it lists Menu, Sold out, Staff and End of day (more sections later),
laid out for a laptop and usable on a tablet
**Given** a manager session **Then** only Sold out is available, without the password
**Given** 15 minutes idle **Then** the Manage session ends; the POS session is unaffected
```

**E5 — Story 10.1 note:**

```
> **Amended 2026-11-04:** the drawer's management links collapse to one **Manage** link into the
> Manage area (Story 10.0). The drawer itself is post-launch; at go-live the link sits in the owner's
> staff badge menu.
```

**E6 — Stories 10.2 and 10.4, same note on each:**

```
> **Amended 2026-11-04 — sync-ready (FR71):** every create, edit and deactivate goes through the API
> (never a direct DB write), bumps the row's `version` and `updated_at`, and appends a row to
> `config_changes` (table, row id, version, field values, staff, time, origin `local`). Nothing reads
> `config_changes` until Epic 13; writing it now means sync needs no rework. Reachable from the Manage
> area (Story 10.0).
```

**E7 — Story 8.3 note:**

```
> **Amended 2026-11-04:** go-live. Lives in Manage → Sold out, the one Manage screen a manager can open
> without the password. Sync-ready like 10.4.
```

**E8 — Story 11.3 note:**

```
> **Amended 2026-11-04:** a go-live subset is built first — `backup.sh` nightly at 03:00 (pg_dump,
> 30-day retention, host volume) plus a copy to a second place (USB drive or a cloud folder), and a
> one-page restore card. The on-demand vendor API remains post-launch.
```

**E9 — Story 1.4 note:**

```
> **Amended 2026-11-04 — on-site install (go-live):** the stack starts on boot and after a power cut;
> Tailscale on the server and the owner's devices; USB printer configured; each zone's furthest table
> tested from a tablet (NFR-R6).
```

**E10 — New Epic 13 section at the end of the file**, with stories:

```
13.1 Cloud hub: API + hosted PostgreSQL, per-restaurant API keys
13.2 Record push (local → cloud, one way): orders, payments, comps, audit, by cursor
13.3 Off-site backup upload to the hub (extends 11.3)
13.4 Owner cloud dashboard: menu, staff and reports from anywhere, no Tailscale
13.5 Two-way config sync: `config_changes` up, cloud edits down over an outbound connection,
     later-edit-wins with the loser kept in the log
13.6 Sync status in the Manage area: ✓ Synced / ⟳ N waiting / ⚠ Offline since 7:40 PM
```
(each with Given/When/Then written at story creation)

**E11 — sprint-status.yaml:** add `6-6`, `9-5`, `10-0`, `epic-13` with `13-1`…`13-6`; add a go-live
order comment block at the top:

```
# GO-LIVE ORDER (sprint-change-proposal-2026-11-04.md):
#   review 4-8, 4-9 → 7-3 → 6-6 → 10-0 → 10-4 + 8-3 → 10-2 → 9-5 → 11-3 (lite) → 1-4 (install)
# Everything else is after launch.
```

### 4.3 Architecture

**A1 — New amendments section "Go-live & config sync, 2026-11-04":**

```
### Manage area auth (FR70, NFR-S7)
- `/manage/*` pages and `/api/manage/*` routes require an owner session AND a Manage session cookie,
  issued after `tenants.manage_password_hash` (bcrypt) matches; 15-minute idle expiry; 5 failures →
  5-minute lockout. Managers reach `/manage/sold-out` only.

### Sync-ready config writes (FR71 groundwork)
- `version int` + `updated_at` on `menu_categories`, `menu_items`, modifier groups/options, `staff`.
- `config_changes` (append-only): id, tenant_id, table_name, row_id, version, payload jsonb, staff_id,
  origin ('local' | 'cloud'), created_at, synced_at null.
- Written in the same transaction as the config change, by the service layer — the only writer.

### Bill printing (FR69)
- A `receipt` job kind on the existing print queue; layout in `escpos.ts` beside tickets.
```

**A2 — Post-MVP Cloud Sync section, "Key Constraints"** — OLD:

```
- Syncer must be **additive only** — never modifies per-restaurant operational data
```
NEW:
```
- Syncer is **additive only for operational data** — orders, payments, comps and audit rows go up,
  never down. **Configuration (menu, staff) is two-way (FR71):** `config_changes` rows go up; cloud
  edits come down over the syncer's OUTBOUND connection and are applied through the same service layer
  as a local edit (origin `cloud`). Conflict: higher `updated_at` wins; the losing change stays in
  `config_changes`, so nothing is lost silently.
```
and the line "No conflict resolution is needed because:" gains "— for operational data. Config conflicts
are resolved as in Key Constraints."

### 4.4 UX

**U1 — New section "Manage area (2026-11-04)"** at the end:

```
- Entered from the owner's staff-badge menu → **Manage**; password prompt once per Manage session.
- Laptop-first layout: left list of sections (Menu · Sold out · Staff · End of day), content on the
  right; on a tablet the list becomes a top row. Light theme, waiter touch sizes not required.
- Sold out: one list of today's dishes with a big toggle each — the manager screen, used mid-service.
- Sync status (Epic 13): one small line under the section list — ✓ Synced 7:42 PM / ⟳ 3 changes
  waiting / ⚠ Offline since 7:40 PM. Owner-only; never shown on the POS floor.
```

## 5. Implementation Handoff

**Scope: Moderate** — backlog re-ordered and new stories added (PO/Dev); no replan.

| Who | What |
|---|---|
| **Dev** | Follow the go-live order in sprint-status; `bmad-create-story` for each before building. |
| **Reviewer** | 4.8, 4.9, then commits `49d1806..729461b` (USB, SERVE WITH, order numbers, edit-a-dish). |
| **Teran** | Confirm receipt contents for 6.6; choose the off-site backup target (USB drive or cloud folder). |
| **Later (Architect)** | Epic 13 design detail — hub hosting, auth, outbound channel — before 13.1. |

**Success criteria:** every go-live item works on the restaurant's own hardware for one full service; a
restore from last night's backup succeeds on a spare machine; menu and staff changes write
`config_changes` rows.
