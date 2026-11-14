# Sprint Change Proposal: Per-User Permissions Before Launch

**Date:** 2026-11-14 · **Raised by:** Teran · **Scope:** Moderate (one story brought forward and widened)

## 1. Issue Summary

Only the owner role can add a custom charge, approve voids, cancel bills, open the cash drawer with no
sale, or enter Manage. A restaurant needs to trust a shift lead or a cashier with some of these
without making them an owner. An owner can do everything, including Staff and the Manage password.
Story 10.6 (FR67) was planned after launch with one permission. Teran wants it at launch, with four.

## 2. Impact Analysis

**Epics**
- **Epic 10:** Story 10.6 moves into go-live and grows from one permission to four.
- **Epic 4 (custom charge, 4.9), Epic 6 (cash drawer, 6.7), Epic 7 (voids, 7.5) and Epic 10 (Manage
  gate, 10.0):** their owner-only checks become permission checks. An owner still holds every
  permission.

**Artifacts**
- **PRD:** the go-live list gains 10.6, and the "After launch" line loses "per-user permissions".
- **Epics:** Story 10.6 gets acceptance criteria.

**Technical**
- A permissions store per staff member.
- One permission check used by the proxy, the routes and the screens.
- A Manage gate that lets a non-owner into only their granted areas using their PIN session.
- Staff screen controls to grant permissions.
- An audit record of every change.

## 3. Recommended Approach

**Direct adjustment.** Build 10.6 now, between 7-5 and the install (1-4).

**Decisions (Teran, 2026-11-14)**
1. **Permissions the owner can grant to a single staff member:**
   - `custom_charge`: add a custom charge.
   - `approve_voids`: void a sent item or cancel an unpaid bill without the owner's PIN, and approve
     another staff member's void with their own PIN.
   - `open_cash_drawer`: open the drawer with no sale.
   - **Manage areas,** each granted separately: Dashboard, Menu, Floor, Settings.
2. **Staff stays owner-only and can never be granted,** so nobody can grant themselves more.
   Availability is already open to waiters.
3. **The way in is the person's own PIN.** A staff member opens their granted Manage areas with their
   PIN session alone. The owner's Manage password stays the owner's. Every action is logged as them.
4. **Checked on the server for every gated action;** a screen only hides what is not allowed.
   Permission changes are audited.

**Effort:** about 1.5–2 days. **Risk:** the Manage gate is security-critical. A missed route would
either lock out a granted person or let someone in. Use one route→area map, shared by the proxy and
the nav, and test every `/api/manage/*` prefix. **Timeline:** launch moves back by that much.

## 4. Detailed Change Proposals

### Epics: Story 10.6 acceptance (replace the bullet list)

```
OLD:
- The owner grants or revokes individual permissions for individual staff in the back office, beyond their role.
- First permission: `custom_charge` (Story 4.9).
- Checked on the server for every gated action; changes are audited.

NEW:
> Brought into go-live 2026-11-14 (sprint-change-proposal-2026-11-14-permissions.md).
- In Manage → Staff the owner grants or revokes, per staff member: custom_charge, approve_voids,
  open_cash_drawer, and Manage areas Dashboard / Menu / Floor / Settings (each separately).
  Staff management is never grantable; owners hold every permission implicitly.
- approve_voids: the holder voids and cancels unpaid bills without a PIN prompt, and their PIN
  approves other staff's voids (same lockout as today).
- Manage areas: a holder signed in with their own PIN opens exactly their granted areas — pages
  and APIs — with no Manage password; every other Manage page and API is refused (403).
- Checked on the server for every gated action (proxy + routes); screens hide what is not allowed.
- Every grant and revoke is recorded (who, whom, what, when).
```

### PRD: go-live list and the "After launch" line

```
ADD to the go-live list: 7. Per-user permissions (FR67, Story 10.6): custom charge, void approval,
   no-sale drawer, chosen Manage areas, granted by the owner per staff member.
"After launch" line: remove "per-user permissions".
```

### Sprint status

```
GO-LIVE ORDER: ... → 9-5 → 7-5 (void) → 10-6 (permissions) → 11-3 (lite) → 1-4 (install)
10-6-implement-per-user-permissions: backlog  # brought into go-live 2026-11-14
epic-10: in-progress
```

## 5. Implementation Handoff

**Scope: Moderate.** Route to the Developer: `bmad-create-story 10.6`, then `bmad-dev-story`. The
size and security weight make a full story worth it rather than quick-dev.

**Done when:**
- Every gated action (custom charge, void, cancel bill, approving another's void, no-sale drawer,
  each Manage area's pages and APIs) passes or refuses by permission, on the server, with a
  verify script covering each one.
- Nobody but an owner can reach Staff or change permissions.
- Grants and revokes are audited.
