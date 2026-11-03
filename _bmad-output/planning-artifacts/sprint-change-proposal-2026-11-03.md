# Sprint Change Proposal — Order numbers, USB printing & ticket sync

**Date:** 2026-11-03 · **Author:** Teran (with Dev agent) · **Mode:** Incremental · **Scope:** Minor

---

## 1. Issue Summary

While preparing a first live print test with the restaurant's Xprinter XP-Q80B (2–3 Nov), four needs
surfaced and were built straight away, outside any story:

1. **USB printing.** No network cable was available; the printer is on USB (Windows name `XP-80C`).
   NFR-I1 said USB was deferred to Story 10.3.
2. **Stations serving together.** One round can print a KOT, a KOT-P and a BOT. Each station only saw
   its own slip, so food for one table could go out at different times. Listing every station's items
   on every slip was rejected (paper); a one-line `SERVE WITH: KOT-P + BOT` was chosen instead.
3. **Order numbers.** Orders had no human-readable number. Tickets showed only table, round and time —
   ambiguous after moves, merges or a table reused the same evening, and useless for finding a past order.
   Chosen: a daily `#042` restarting each business day (4 AM cut-off) plus a permanent `20261102-042`.
4. **Number and date in the app.** The number on table cards, bar tabs, order and bill screens; today's
   date next to the clock.

**Evidence / commits:** `49d1806` USB printers · `b56487d` SERVE WITH line · `8d7a605` order numbers
(migration 0032) · `ce15afc` number on the floor, date in every header. Verified: `verify-escpos` 53/53,
`verify-order-number` 15/15, `verify-bills` 119/119, type-check clean. Test tickets accepted by the
XP-80C spooler; physical print not yet confirmed.

## 2. Impact Analysis

| Area | Impact |
|---|---|
| **Epic 5** (printing) | Story 5.2's ticket layout and delivery path changed — recorded as an amendment note. |
| **Epic 7** (audit) | Story 7.2 gains find-by-number and a numbered history header. |
| **Epic 9** (dashboard) | Orders shown by number; days grouped by business date. |
| **Story 10.3** | No longer builds USB; keeps per-station selection, `connection_mode`, and gains the cut-off hour setting. |
| **PRD** | New FR68; FR18 and NFR-I1 amended. |
| **Architecture** | New amendments section: order-number trigger, USB transport, payload fields. |
| **UX spec** | Where the number shows, date in the staff badge, ticket layout. |
| **Technical** | Migration 0032 (backfilled existing sessions). `TableStatusChangedPayload` gains a required field. New env var `PRINTER_USB_NAME`. No rollback, no MVP scope change. |

## 3. Recommended Approach

**Direct Adjustment.** The work is built and verified; the documents only need to catch up, plus two
acceptance criteria for a story not yet started (7.2). Effort: documentation only. Risk: low — the main
open risk is that the new code has not been through code review (see §5). Timeline impact: none.

## 4. Detailed Change Proposals (all approved, all applied)

### PRD
1. **FR68 added** after FR67 — daily `#042` + permanent `20261102-042`; configurable business-day
   cut-off (default 4 AM); assigned by the database, immutable; shown on tickets, cards, tabs, order and
   bill screens; the key for finding a past order.
2. **FR18 amended** — order number in header and foot, date as well as time, SERVE WITH line naming other
   stations by type only. **NFR-I1 rewritten** — TCP and USB (`PRINTER_USB_NAME`, RAW spooler or `/dev`
   path), USB wins when both set, per-station selection stays with 10.3, spooler-accept caveat.

### Epics
3. **Story 5.2** — "Amended 2026-11-03" note: USB delivery, `KOT #042` header, dated round line,
   SERVE WITH, `Order 20261102-042` foot, optional payload fields, verify counts.
4. **Story 7.2** — two acceptance criteria: find a past order by `20261102-042` or `#042` + business date
   ("No order 20261102-042" when nothing matches); history header shows both numbers, table/tab, business date.
5. **Epic 9** — note: orders shown by number; days grouped by business date, not calendar date.
   **Story 10.3** — inherited note narrowed (USB exists; per-station `connection_mode` and the
   `business_day_start_hour` setting remain). **NFR-I1 copies** in the requirements inventory and Epic 5
   summary updated.

### Architecture
6. Print Queue "Delivery is a seam" paragraph updated (three transports). New section
   **"Amendments — Order numbers & USB printing, 2026-11-03"**: trigger + counter table, business date,
   immutability, `src/lib/order-number.ts` as the only formatter, required `dailyNumber` on the table
   event; USB transport precedence and mechanism; optional ticket payload fields.

### UX
7. Flow A ticket header and Flow B correction line updated (a correction keeps `#042`). New section
   **"Order numbers & tickets (2026-11-03)"**: placement on card, bar tab, order screen, bill screen,
   history/reports; date in the staff badge; ticket layout with SERVE WITH.

## 5. Implementation Handoff

**Scope: Minor** — Developer agent.

| Who | What |
|---|---|
| **Dev / Reviewer** | Run `bmad-code-review` on commits `49d1806..ce15afc` — this code shipped without a story review. |
| **Teran** | Confirm a physical print on the XP-80C (KOT with SERVE WITH and `Order …` foot) and look at the `#042` on a table card in the browser. |
| **Story 7.2 author** | Pick up the two new acceptance criteria when creating the story. |
| **Story 10.3 author** | Per-station `connection_mode`; owner setting for `business_day_start_hour`. |

**Success criteria:** documents match the code (done); the review above finds no blocking issue;
a real ticket prints with the number, date and SERVE WITH line.
