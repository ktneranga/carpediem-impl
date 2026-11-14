# Sprint Change Proposal: Void a Sent Item Before Launch

**Date:** 2026-11-14 · **Raised by:** Teran · **Scope:** Moderate (one new go-live story, backlog reorder)

## 1. Issue Summary

Nothing in the app can take back an item once it is sent to the kitchen. `ITEM_REMOVED` and
`ITEM_VOIDED` exist in the event enum, but no code writes them (checked 2026-11-14). A wrong dish
sent by mistake stays on the bill. Staff can only charge the guest for it or close the table as
unpaid, and both make the takings wrong.

Story 7.3 (comp + void) was moved after launch on 2026-11-06 because the full comp and permission
work was too much. This brings back only the void, which a restaurant needs on its first busy night.

## 2. Impact Analysis

**Epics**
- **Epic 7:** new go-live **Story 7.5: Void a Sent Item**, a slice of 7.3. Story 7.3 (comps,
  reversing records, the `comp` permission, reassignment) stays after launch.
- **Epic 6:** bills are immutable, so 7.5 adds **cancelling an unpaid bill**. Bill generation and the
  "is anything left to bill" checks must ignore cancelled bills.
- **Epic 9:** the Dashboard, the end-of-day slip and `loadSales` must leave cancelled bills out of
  every total. The "Unclosed & corrections" list already shows `ITEM_VOIDED` events, so voids show up
  there with no extra work.
- **Epic 5:** a void prints a VOID ticket on the item's station printer through the print queue.

**Artifacts**
- **PRD:** go-live list item 2 changes from "moved after launch" to "void only, in go-live".
- **Epics:** add Story 7.5 and note on 7.3 that its void part moved to 7.5.
- **Architecture:** a new append-only record for bill cancellation. Bills and bill lines stay
  immutable.
- **UX:** a void action on sent lines (order screen), a "Cancel bill" action on an unpaid bill (bill
  screen), and an approval PIN pad.

**Technical:** one migration (void link and approver, bill cancellation table), order and bill
services, the takings and insights queries, the print queue, and two POS screens.

## 3. Recommended Approach

**Direct adjustment.** Add Story 7.5 to the go-live order before 11-3 lite. **Rebuild** it small
instead of restoring the 7.3 stash: the stash is based on migrations 0033–0034 and the repo is past
0042. Reuse the stash's VOID ticket printing (`ticket.ts`, `escpos.ts`) and its sheet layout as
reference.

**Decisions (Teran, 2026-11-14)**
1. **Approval:** the waiter starts the void, and someone with the **owner role** approves by entering
   their PIN on the same tablet. There is no manager role (roles are waiter, owner and kitchen), so a
   trusted shift lead who needs to approve gets the owner role in Staff (10.2). Manage stays behind
   the owner password either way. Both the requester and the approver are recorded.
2. **Item already on an unpaid bill:** add **Cancel bill** for a bill with no payments, with the same
   approval. Its items go back to the order, the wrong item is voided, and a new bill is printed. A
   bill with any payment cannot be cancelled (that would be a refund, which is not planned).
3. **VOID ticket:** yes. `VOID · #042 · Table 5 · 1 × Fried Rice` goes to the item's station printer.

**This overrides the 2026-11-04 note on 7.3** that a void is a `comp_record` with `kind = void`. For
go-live a void is an **`ITEM_VOIDED` order event**. The voided units are simply never billed, so the
guest's bill does not show them as a negative line. The Dashboard already reads these events.

**Effort:** about 2–3 days (void about 1, bill cancel about 1, ticket and tests about half a day).
**Main risk:** cancelled bills must be left out of every bill query. Use one helper (or a view) so
none is missed. **Timeline:** launch moves back by that much. Install (1-4) stays last.

## 4. Detailed Change Proposals

### Epics: new story (insert after Story 7.4)

```
### Story 7.5: Void a Sent Item (go-live)

> Added 2026-11-14 by sprint-change-proposal-2026-11-14.md: the void part of 7.3, for launch.

As a waiter,
I want to void an item sent by mistake, with the owner's approval,
So that the guest is not charged and the kitchen stops making it.

Acceptance Criteria:

Given a sent line on an open order whose units are not on a bill
When the waiter taps Void on it, picks how many (1..unbilled units) and a reason
  ("Entered by mistake", "Guest changed mind", "Kitchen can't make it", "Other" + note)
Then an owner-role staff member enters their PIN on the same device to approve; on approval an
  ITEM_VOIDED order event is written, linked to the original line, with the quantity, reason,
  requesting staff and approving staff; the original event is not changed.

Given the void is approved
When the order and bill views refresh
Then the voided units are not billable, the order total and item counts drop, and a VOID ticket
  ("VOID · #042 · Table 5 · 1 × Fried Rice") is queued to that item's station printer.

Given a wrong PIN, a non-owner PIN, or quantity more than the unbilled units
When approval is attempted
Then nothing is written and the reason is shown; repeated wrong PINs follow the login lockout rules.

Given the item is on a bill with no payments
When an owner approves Cancel bill on the bill screen (reason required)
Then an append-only bill cancellation is recorded (bill, reason, requester, approver); the bill and
  its lines are not modified; the items count as unbilled again; the cancelled bill no longer counts
  in the Dashboard, the end-of-day slip, or "is the table finished"; a new bill can be generated.

Given a bill with any payment recorded
When Cancel bill is attempted
Then it is refused ("This bill has payments — it can't be cancelled").

Given a void or a bill cancellation
When the owner opens the Dashboard
Then it appears in "Unclosed & corrections" with the item, reason, requester and approver.
```

### Epics: Story 7.3 note

```
OLD: > **Moved after launch 2026-11-06 (Teran):** too complex for now. ...
NEW: > **Moved after launch 2026-11-06 (Teran):** too complex for now. ...
     > **2026-11-14:** the VOID part is now Story 7.5 (go-live), as an ITEM_VOIDED event with
     > owner-PIN approval. 7.3 keeps comps, reversing records, the `comp` permission and reassignment.
```

### PRD: go-live list, item 2

```
OLD: 2. ~~Void / comp a sent item (FR47, FR48, Story 7.3)~~ — moved after launch 2026-11-06 (Teran). Until then a sent item stays on the bill.
NEW: 2. Void a sent item with owner-PIN approval, and cancel an unpaid bill (FR48 append-only; Story 7.5, added 2026-11-14). Comps (FR47) remain after launch.
```

### Sprint status

```
GO-LIVE ORDER: ... → 9-5 → 7-5 (void) → 11-3 (lite) → 1-4 (install)
epic-7: in-progress  # 7-5 only for go-live
7-5-void-a-sent-item: backlog  # added 2026-11-14, go-live
```

## 5. Implementation Handoff

**Scope: Moderate.** One new story and a reorder, no replan. Route to the Developer:
`bmad-create-story 7.5`, then `bmad-dev-story`.

**Done when:**
- A sent item can be voided before billing, with owner-PIN approval, and a VOID ticket prints.
- An unpaid bill can be cancelled and reissued without the voided item.
- The Dashboard and end-of-day slip totals leave out voided units and cancelled bills (verify scripts).
- No order event, bill or bill line is ever updated or deleted.
