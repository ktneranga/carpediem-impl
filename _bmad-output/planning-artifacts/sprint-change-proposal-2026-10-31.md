---
date: 2026-10-31
author: Teran (with Claude, Correct Course workflow, batch mode)
scope: Moderate — backlog reorganisation, no replan
status: approved — applied 2026-10-31
---

# Sprint Change Proposal — Billing built ahead of plan, bar tabs, priced options

## 1. Issue summary

Between 2026-10-21 and 2026-10-31 the billing flow and the bar were built
directly against Teran's designs (bill screen 27–32, settle dialog 31, login
37), outside the create-story → dev-story → code-review cycle. The code and the
plan have diverged:

| In the code | In the plan |
|---|---|
| Bill screen, Settle with cash / card / cash + card, table auto-close | Story 6.5 **backlog** |
| Split bill: columns per person, drag or tap-to-move, split by quantity | Stories 6.1 / 6.3 **backlog — deferred post-demo** |
| Counter sale replaced by nicknamed **bar tabs** in a Bar zone; drinks-only, always one bill | Story 3.9 (counter sale); no bar stories |
| Six bar categories; a Drinks pill on table menus | nothing |
| Switching to One bill no longer collapses seats; per-seat billing moved into the bill screen's split; "Add another round" removed | sprint-change-proposal-2026-10-16, decision D2 (collapse) |
| **Planned, not built:** priced options (no alcohol / single / double), a custom charge gated by a per-user permission | nothing |

**Type:** new requirements from the restaurant (bar tabs, priced drinks, custom
charges, cash + card), and one failed approach (D2's collapse destroyed the
seat grouping to tidy data nothing read).

**Evidence:** commits `c21e336` (one bill stops moving items) through `416ed16`
(login to the design); migrations 0023–0026; Teran's design screenshots 20–37.

## 2. Impact analysis

### Epics

- **Epic 6** — 6.1, 6.3, 6.5 are implemented and need their stories amended to
  match what was built, then code review. 6.4's UI moved; its endpoint remains.
- **Epic 4** — gains four stories: bar tabs and bar menu (built), priced
  options and custom charge (to build).
- **Epic 3** — Story 3.9 (counter sale) is superseded by the bar tab; its
  session model is reused unchanged (`kind = 'counter'`).
- **Epic 10** — gains per-user permissions (10.6); menu management (10.4) gains
  modifier groups.
- **Epics 7, 8, 9, 11** — no change. Epic 9's reports must treat
  `bill_lines.quantity` as the billed units (see Architecture).

### Artifacts

- **PRD** — FR22 and FR64 amended; FR65–FR67 added (section 4.2).
- **Architecture** — five schema facts to record (section 4.3).
- **UX spec** — the bill screen, split, settle dialog, bar zone and Drinks pill
  are specified by the screenshots, not the spec (section 4.4).

### Technical

Already shipped and migrated on the dev database. No rollback. Known gaps,
carried as action items in section 5:

- No code review has been run on the billing code, which takes money.
- `verify-bills.ts` covers 6.2/6.4 only; nothing scripted covers payments,
  split bills or quantity splits.
- Kitchen tickets still print `COUNTER` for a bar tab (FR18).

## 3. Recommended approach

**Direct adjustment.** Record what was built as amended stories marked
`review`, add the new stories, and run code review before anything new is
built on top.

- *Rollback* rejected: the work is what the restaurant asked for and tested
  by hand; reverting it would re-open walkout-recorded paid tables.
- *MVP review* not needed: Epic 6 was always MVP; only its order changed.

**Effort:** low for the paperwork; one code-review pass (medium); then two
new stories (4.8 medium, 4.9 small) and 10.6 (medium).
**Risk:** the unreviewed payment code. Mitigated by reviewing it first.
**Timeline:** no change to later epics.

## 4. Detailed change proposals

### 4.1 Stories (epics.md and sprint-status.yaml)

**Story 6.1 — SplitBillCanvas** · status `backlog` → `review`

```
OLD (AC): fractional assignment is not possible; each item is assigned as a
whole unit to one person only

NEW: a line of quantity > 1 can be split by units ("Move 1 of 2"); a single
unit cannot be divided (sharing one dish between people is deferred). Items
move by tap-then-"Move here" (touch) or drag (pointer events, so it works on a
tablet). Identical dishes in one person's column show as one card.
```
*Rationale:* two guests each having one of a "2× Lion Lager" is the commonest
bar split (Teran, 2026-10-25).

**Story 6.3 — Mid-Settlement Person Split** · `backlog` → `review`

```
NEW (added ACs):
- Opened from the bill screen's "Paying separately? → Split bill"; offered
  once the bill has two or more UNITS.
- Columns are named after the order's seats ("thattaya", "Seat 2"); a
  Separate-bills order opens pre-split by seat, a One-bill order opens with
  items unassigned. New columns continue "Seat 3", "Seat 4".
- A person's bill is written at THEIR Settle, not before: bill type `split`,
  `person_label`, exactly their units; refused whole (409 ITEMS_NOT_BILLABLE)
  if any unit is already billed.
- "Merge into one bill" returns to the whole-table view.
- The arrangement is kept per session in localStorage and restored only under
  the same bill mode.

OLD: POST /api/sessions/:id/bills/split with an assignment map
NEW: one POST /api/sessions/:id/bills { type: 'split', items: [{eventId,
quantity}], personLabel } per person, at their Settle
```

**Story 6.4 — Per-Seat-Slot Billing** · stays `done`, amended

```
NEW (note): the order screen's "Bill Seat N" button and its preview were
removed (2026-10-25). Paying one seat early is now the bill screen's split,
pre-filled by seat. The seat-bill endpoint remains for verify-bills.ts.
```

**Story 6.5 — Payment Recording & Auto-Close** · `backlog` → `review`

```
OLD: POST /api/bills/:billId/payments { method: "split", cashAmount, cardAmount }
NEW: { tenders: [{ method: 'cash'|'card', amountPaisa }] } — one or two
     tenders, one per method; two rows for a cash + card payment.

NEW (added ACs):
- "Bill & split" OPENS the bill screen and writes nothing; the bill is
  recorded at Settle (consolidated, or split per person).
- Amounts are what was APPLIED; a payment past the outstanding total is
  refused (409 OVERPAYMENT). Change is the screen's arithmetic.
- Settle dialog per design 31: Cash (received, quick notes, change, Clear),
  Card, Cash + card (cash part typed, card part the rest).
- Auto-close when EVERY bill is settled AND nothing is unbilled — not "the
  last bill is settled" — through closeSession(reason 'settled').
- Bill & split is offered only once a round has been sent, and from the
  floor's action bar for a table or a bar tab.
```

**Story 3.9 — Counter Sale** · stays `done`, amended

```
NEW (note): superseded on screen by Story 4.6 (bar tabs). The session model
(`kind = 'counter'`, no table) is unchanged.
```

**New Story 4.6 — Bar Tabs** · `review` (built)
> As a bartender, I want to open a tab named by how the guest looks, so I can
> find it when they come back to pay.
- "Bar · N open" in the zone bar after Rooftop replaces the Counter sale button.
- New tab asks for a staff-only nickname (max 40); Skip opens an unnamed quick sale.
- Tabs read "Tab 7 · white shirt"; newest first, with Newest/Oldest first and a
  late-tabs bar (open > 2 h, the floor's stale rule).
- A tab's order screen is drinks only and always one bill (no switch, no seats).
- Floor action bar for a tab: Seat at table · Bill & split · Open tab.
- Nickname never printed on a guest's bill.

**New Story 4.7 — Bar Menu & Drinks Pill** · `review` (built)
- Six bar categories (Cocktails, Mocktails, Coffee, Tea, Beer, Whisky); a drink
  is an item whose `production_destination` is `bar`.
- Table menus show food chips plus one Drinks pill that swaps the row to the
  drink categories; search covers both.
- Sample items until Story 10.4; `seed-bar-menu.ts` migrates an existing database.

**New Story 4.8 — Priced Options** · `backlog` · next to build
> As a bartender, I want to add a Mojito as "double shot" or "no alcohol" and
> see the price change, so the bill is right without arithmetic.
- Modifier groups per item (single/multi choice, required or not), each option
  with a price change in paisa (may be negative; a line never goes below 0).
- The options sheet shows a live price; the server recomputes the price from
  the chosen option ids and refuses a quote that does not match.
- The unit price is fixed on the order event at send, as today.
- Chosen options print on the ticket and show on the bill.

**New Story 4.9 — Custom Charge** · `backlog` · after 10.6
- A line with a typed name and price, on a table or a tab.
- Allowed only for staff holding the `custom_charge` permission (owner by
  default until 10.6); audited with who, when and the amount.
- Goes on the bill like any line; prints on no kitchen ticket.

**New Story 10.6 — Per-User Permissions** · `backlog`
- The back office grants individual permissions to individual staff, beyond
  their role (first: `custom_charge`).

**Story 10.4 — Menu Management** · amended
- Gains management of modifier groups and options (Story 4.8's data).

### 4.2 PRD

- **FR22** — OLD: "by assigning whole order items to individual persons".
  NEW: "by assigning order items, or part of an item's quantity, to individual
  persons".
- **FR64** — append: "On screen a counter order is a **bar tab**, optionally
  named by a staff-only description of the guest ('white shirt'), shown in a
  Bar section of the floor. Its menu is the bar's, and it is always a single
  bill; a split happens at payment."
- **FR65 (new)** — Staff can choose priced options for a menu item (e.g. no
  alcohol, single or double shot); the option's price change is applied to the
  item's price at the time it is ordered.
- **FR66 (new)** — Staff holding the custom-charge permission can add a line
  with a name and price to an order; every such line is attributed and audited.
- **FR67 (new)** — The owner can grant or revoke individual permissions for
  individual staff members, beyond their role.
- **Bill mode** — sprint-change-proposal-2026-10-16 D2 is reversed: switching
  to One bill hides seats and moves nothing; switching back restores them.

### 4.3 Architecture (record, no redesign)

- `payment_records.bill_id` NOT NULL; one row per tender; settled = rows sum to
  `bills.total_paisa` (migration 0023).
- `bill_type` gains `split`; `bills.person_label` (0024).
- `bill_lines.quantity`; `UNIQUE(order_event_id)` replaced by the
  `bill_lines_within_event_quantity` trigger — no event billed past its
  quantity (0025). Reports must sum `bill_lines.quantity`, not event quantity.
- `order_sessions.tab_label`, staff-only (0026).
- "Consolidated" is identified by `bills.type`, never by a null seat.

### 4.4 UX

The bill screen, split, settle dialog, bar zone, Drinks pill and login are
specified by Teran's screenshots 27–37 rather than by
`ux-design-specification.md`. Add a short "Billing & bar (2026-10)" section to
the spec pointing at them, so the next designer starts from what shipped.

## 5. Implementation handoff

**Scope: Moderate** — backlog reorganisation; Developer and PO.

| # | Action | Owner |
|---|---|---|
| 1 | Apply 4.1 to `epics.md`; update `sprint-status.yaml` (6-1, 6-3, 6-5 → review; add 4-6, 4-7 review; 4-8, 4-9, 10-6 backlog; epic-4 → in-progress) | Dev (this workflow, on approval) |
| 2 | Apply 4.2 to `prd.md`, 4.3 to `architecture.md`, 4.4 to the UX spec | Dev (this workflow, on approval) |
| 3 | **Code review** of commits `0738a9a`…`d1f64a4` (payments, split, quantity split, bar tabs) | `bmad-code-review` |
| 4 | Extend verification to payments, split bills and quantity splits | Dev, with the review |
| 5 | FR18: print the tab name on tickets for a bar tab instead of `COUNTER` | Dev, small fix |
| 6 | Story 4.8 Priced Options: create → dev → review | `bmad-create-story` |

**Deferred, recorded so they are not lost:** sharing one item between people
(fractional split); tips; printing the bill and receipt; comps (Epic 7).

**Success criteria:** the plan and `sprint-status.yaml` match the code; the
billing code has passed review; the next story created (4.8) plans against the
current model.
