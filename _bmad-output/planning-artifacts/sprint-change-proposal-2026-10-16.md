> ## ⛔ REVERTED 2026-10-19
>
> Teran reverted the whole redesign, this change with it. `order_sessions.bill_mode`,
> `setBillMode`, the `/bill-mode` route and the switch are all gone from the code, and
> `zoneUsesSeats()` is the rule again.
>
> **This document is kept, not deleted**, because the analysis in it outlived the code. The
> finding that matters: the premise the change was raised on was WRONG. `openSession` has
> always created "Seat 1" for every session regardless of zone, so `order_events.seat_slot_id`
> was never null and a Bean Bags order already WAS a one-bill order. Anyone revisiting this
> should start from §2 rather than re-deriving it.
>
> **One loose end on the dev database:** migration 0022 was applied before the revert, so the
> `bill_mode` column still physically exists there, and `__drizzle_migrations` still has its
> row. Both are harmless — the column is `NOT NULL DEFAULT 'one'` and nothing reads it, and
> drizzle ignores a recorded migration with no matching file. A fresh install is clean. Drop
> the column if the tidiness is worth a migration.

# Sprint Change Proposal — "One bill / Separate bills" replaces zone-decided seats

**Date:** 2026-10-16
**Raised by:** Teran, from the new order-entry design
**Scope classification:** **Moderate** — one migration, no rework of built billing

---

## 1. Issue summary

The new order-entry design puts a **One bill / Separate bills** switch at the top of the order
panel. One bill is the default, hides the seat picker entirely, and puts every item on the table's
bill. Separate bills reveals seat chips. The waiter may switch mid-order.

Today that decision is made by the ZONE, not the waiter. `zoneUsesSeats()` returns true for Tables
and false for Bean Bags, Sun Beds, Rooftop and counter sales — Teran's decision of 2026-09-16.

---

## 2. The analysis changed the answer — correcting the trigger

The change was raised on the premise that it would make `order_events.seat_slot_id` legitimately
NULL in ordinary operation, breaking Story 6.4's Trap 2 and forcing rework of per-seat billing.

**That premise is wrong, and the correction makes this a much smaller change.**

`openSession` and its counter-sale sibling already create **"Seat 1" for every session**, in the
same transaction, regardless of zone — `table-session.service.ts:139` and `:189`. Confirmed against
the live database:

```
Bean Bags   2 sessions   2 seats     <- one hidden Seat 1 each
Tables      1 session    3 seats
```

So a Bean Bags order today **is** a One bill order: one seat, picker hidden, every item on it.
`zoneUsesSeats` gates **presentation only** — the seat picker, the round history's seat column, the
modifier sheet's seat label, and whether the kitchen ticket groups by seat. The server has always
required a seat on every line (`SubmitRoundLine.seatSlotId: string`, not optional) and always
validates it belongs to the session.

**What the design actually asks for already exists in the data model.** What changes is who decides,
and when.

### The consequence for "N without seat"

The design shows items added before switching as *"N without seat"*. Implemented literally — a null
`seat_slot_id` — that WOULD break things: Story 6.4's Trap 2, the `bill_lines.seat_label` snapshot,
`submitRound`'s validation, and the kitchen ticket's grouping.

It does not need to be literal. Those items are on **Seat 1**. The honest rendering is *"N not yet
assigned to a person"*, and the repair is to move them onto a person — which the seat picker already
does. No nulls, no migration to billing, no change to Story 6.4.

---

## 3. Impact analysis

### Epic / story impact

| Story | Impact |
|---|---|
| **4.3** Seat slot management | Seats stop being zone-gated. The component is unchanged; what changes is when it renders. ACs reworded, not rewritten. |
| **4.4** Add item with seat assignment | Unchanged. An item always lands on a seat; in One bill mode that seat is always Seat 1. |
| **4.5** Order submission | Unchanged. `usesSeats` on the ticket payload now comes from the session's mode rather than the zone. |
| **5.2** ESC/POS ticket | `escpos.ts:328` groups by seat when `usesSeats`. Source changes; behaviour does not. **See risk 1.** |
| **6.4** Per-seat billing | **No rework.** Trap 2 holds, the unique index holds, `bill_lines.seat_label` holds. AC-12's `usesSeats` gate changes meaning: "Bill This Seat" is offered when the session is in Separate bills mode rather than when the zone has seats. |
| **6.2 / 6.5** | Unaffected. |

### PRD

- **FR10** ("create multiple seat slots … upfront") and **FR11** ("assign order items to a specific
  seat slot") remain true. Neither says the zone decides. No FR changes; one clarifying note.

### Architecture

- `zoneUsesSeats` stops being a rule and becomes a **default**. Worth keeping for exactly that: a
  Tables order can still default to Separate bills if that proves to be what waiters want.
- One new column — see §4.

### UX spec

- Needs the switch documented, plus the mid-order switching rules.
- `deferred-work.md`'s entry *"Orders outside the Tables zone cannot be split by seat at billing —
  hide the per-seat option for those zones"* (2026-09-16) is **superseded**: any order can now be
  separate-billed. The entry is marked resolved rather than deleted.

---

## 4. The one real schema change

```sql
ALTER TABLE order_sessions
  ADD COLUMN bill_mode bill_mode_enum NOT NULL DEFAULT 'one';   -- 'one' | 'separate'
```

**Why stored rather than derived.** The tempting derivation is "more than one seat means separate
bills". It is wrong in the case that matters: a party of four at one table, all paying together, may
still want four seats so the kitchen knows whose fish is whose. Seat count answers "how many people
are we tracking"; bill mode answers "how many bills will there be". Deriving one from the other
collapses two questions that the design deliberately separates.

`order_sessions` is NOT append-only, so the toggle is an ordinary UPDATE.

---

## 5. Decisions (Teran, 2026-10-16)

### D1 — One bill is a NON-SEAT order, everywhere the waiter looks

No seat chips, no seat on an order line, no seat column in the round history, no seat in the
modifier sheet — **and no seat line on the kitchen ticket**. "Seat 1" continues to exist in the
database as plumbing and is never named on screen.

Bill mode therefore answers ONE question: **are we tracking people at all?**

| | One bill | Separate bills |
|---|---|---|
| Seat chips | hidden | shown |
| Order lines | no seat | per person |
| Round history | no seat column | per person |
| Kitchen ticket | no seat line | grouped by person |

This settles the ticket risk in the opposite direction to the original recommendation, and it is
the better answer: one rule, no special case, and the waiter's choice is explicit rather than
something the system did behind their back.

**The cost, stated plainly:** today a Tables order ALWAYS prints seats on the ticket. Under the new
default a table of six prints a ticket with no indication of who gets which plate, unless the waiter
chooses Separate bills. That is a real reduction in what the runner is told, accepted knowingly —
the seat note was described in `deferred-work.md` as "the moment the note earns its keep", and it
now reaches the kitchen only when people are being tracked.

### D2 — Switching back to One bill collapses the grouping

Items on Person 1, 2 and 3 all move onto one bill, and the grouping is **gone** — switching to
Separate bills again does not restore it. Chosen over refusing the switch, because a dead end
mid-service is the worse failure. The waiter re-assigns if they meant it.

### Risk that remains open

**Default One bill everywhere reverses the 2026-09-16 decision for Tables.** That decision made
Tables the seated zone; the new default makes every order unseated until a waiter says otherwise.
Deliberate and reasonable — most tables do pay together — but combined with D1 it means seats, seat
notes and per-person tickets are now opt-in rather than the norm for table service.

---

## 6. Recommended approach

**Direct adjustment.** No rollback, no MVP change, no rework of Epic 6.

1. Migration 0022: `order_sessions.bill_mode`.
2. Order screen: the switch, seat chips conditional on mode, "not yet assigned" wording.
3. `usesSeats` on the ticket payload decoupled from bill mode (risk 1).
4. Story 6.4's AC-12 gate reworded from zone to mode.
5. `deferred-work.md` entry marked superseded; UX spec and epics updated.

Sequenced as part of the order-entry redesign already underway, not as a separate story — it is the
same screen and the same change.

---

## 7. Handoff

**Moderate.** Planning artifacts updated here; implementation continues in the order-entry redesign.

Open for Teran: **risk 1** (should the ticket keep seats in One bill mode?) and **risk 2** (what
happens to Seat 2's items when switching back).
