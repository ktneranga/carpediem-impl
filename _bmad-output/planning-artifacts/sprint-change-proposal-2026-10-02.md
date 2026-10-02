# Sprint Change Proposal — 2026-10-02

**Trigger:** Stories 5.0 and 5.2 (both `done`)
**Scope classification:** Minor — documentation only. No code changes, no story changes, no MVP change.
**Prepared for:** Teran

---

## Section 1 — Issue Summary

**The approved changes of 2026-08-21 were implemented in code and never written back into the planning
artifacts.** `epics.md`, `prd.md` and `architecture.md` still describe the printing design that proposal
replaced — the one the code deliberately does not have.

This is not a design disagreement. The work is finished, verified and committed; the documents simply
never caught up. It matters because `epics.md` is what the next story is written from, and anyone
reading it today would be misled about how printing works.

**Category:** process gap — an approved change proposal was applied to the code but not to its sources.

**Evidence**

| Document | Says | Reality since |
|---|---|---|
| `epics.md:1468` Story 5.2 | "send them to the configured thermal printer via TCP **immediately upon order submission**"; a 5-second inline timeout; `printer:alert` means "reprint manually" | Story 5.0 (2026-09-25): delivery is a queued job with six attempts and a backoff ladder; nothing on the request path touches a printer |
| `epics.md` Epic 5 | no Story 5.0 at all | 5.0 exists, is `done`, and is what 5.2 was built on |
| `epics.md:118`, `prd.md:509` NFR-P1 | "Order submission completes and **all tickets are printed** within 3 seconds" | Submission answers in ~60ms; ticket delivery is asynchronous and may legitimately take a minute of retries |
| `epics.md:147`, `prd.md:546` NFR-I2 | "Printer timeout or connection failure produces an **immediate** visible alert" | A failure is retried first; the alert distinguishes "still trying" from "gave up" (Change U3) |
| `epics.md:146`, `prd.md:545` NFR-I1 | "supports both USB and TCP/IP" | TCP only; USB deferred to Story 10.3, which owns station configuration |
| `architecture.md:870` | `print.service.printTickets()` inline in the submit flow, response carries `ticketsPrinted` | The submit transaction inserts `print_jobs` rows; a worker delivers them |
| `architecture.md:800`, `:824` | `src/server/services/print.service.ts`, `src/lib/escpos.ts` | `src/server/print/` — that folder exists because everything under `services/` carries `server-only`, which throws in the worker's process |

The 2026-08-21 proposal's own Changes **A1** (a Print Queue architecture section) and **A5** (the
`print_jobs` schema) were likewise never applied.

---

## Section 2 — Impact Analysis

### Epic Impact

| Epic | Impact | Change |
|---|---|---|
| **Epic 5** — Ticket Output | **High (documentation)** | Goal rewritten; Story 5.0 added; Story 5.2's delivery half rewritten. The WORK is complete — 5.0 and 5.2 are `done`. |
| **Epic 10** — Config | Low | Story 10.3 gains the scope it inherited: `station_configs.output_mode` / `connection_mode` columns, a `pizza_kitchen` station type, per-destination printers, and the USB path. |
| **Epic 11** — Vendor Ops | Low | Story 11.4 should watch queue depth (`print_jobs` pending older than N minutes, and any `dead` row) rather than a worker container — the worker runs in the existing Node process. |
| Epics 1–4, 6–9, 12 | None | — |

**No epic becomes obsolete, none is added, and the order does not change.** Stories 5.1 (KOTTicket) and
5.3 (KDS screen) stay deferred: **Teran's decision, 2026-10-02 — paper only for the demo**, with
`kds_display_enabled` false. FR19 and FR20 therefore move out of demo scope, not out of the product.

### Story Impact

- **New in `epics.md`:** Story 5.0 — the text below matches what was built, not the original proposal
  (two deliberate divergences, both recorded in the story: `ticket jsonb` rather than `payload BYTEA`,
  and a `destination` rather than a `station_id` FK).
- **Rewritten:** Story 5.2 — ticket content ACs survive verbatim; the delivery ACs are replaced.
- **Unchanged:** every other story. Nothing is rolled back.

### Artifact Conflicts

- **PRD** — NFR-P1, NFR-I1, NFR-I2 (three lines).
- **Epics** — the Epic 5 block, the two story bodies, the same three NFRs, one Epic 10 scope note.
- **Architecture** — the missing Print Queue section, the missing `print_jobs` schema, the Core Data
  Flow, two file-plan paths.
- **UX** — no correction needed. The spec has no printer-alert section; Change U3's three states live in
  the epic's ACs and are built. One optional addition is proposed for completeness.
- **`deferred-work.md`** — already current (updated during the 5.2 review).

### Technical Impact

**None.** No code changes. No schema changes. No new dependencies. The implementation is already the
thing these documents will describe.

---

## Section 3 — Recommended Approach

**Option 1 — Direct Adjustment. Effort: Low. Risk: Low. Viable, and recommended.**
Edit the four documents to describe what exists.

**Option 2 — Rollback.** Not viable and not wanted: it would mean reverting two finished, verified
stories to match a design that was superseded on purpose.

**Option 3 — MVP Review.** Not applicable. MVP scope is unchanged; the demo path (paper tickets) is
complete.

**Selected: Option 1.**

The only judgement call inside it is how to write NFR-P1, because the old single number conflated two
things the system now separates. The proposal splits it rather than relaxing it: the waiter-facing
promise gets *stricter* (submission answers in under a second, measured at ~60ms), and ticket delivery
gets its own, honest budget.

---

## Section 4 — Detailed Change Proposals

### 4.1 `epics.md` — Epic 5 summary

**OLD** (`epics.md:337`)
> **Goal:** Implement the full ticket generation and delivery pipeline — KOT, KOT-P, and BOT tickets
> generated on order submission, printed to ESC/POS thermal printers via TCP, and displayed on KDS
> screens when enabled. Printer failures surface immediately as visible alerts; no ticket is silently
> dropped.

**NEW**
> **Goal:** Implement the full ticket generation and delivery pipeline — KOT, KOT-P and BOT tickets
> queued transactionally with the order, delivered to ESC/POS thermal printers over TCP by a retrying
> worker, and displayed on KDS screens when enabled. A printer outage delays tickets; it never loses
> them, and it never delays the waiter.
>
> **Sequencing:** Story 5.0 (the queue) comes first — Story 5.2 delivers through it.

Add to **Requirements Covered**:
> - NFR-R2 (a queued ticket survives a printer outage, a restart and a deploy)

Amend three lines in the same list:
> - NFR-P1 (**submission answers within 1 second; ticket delivery is measured separately**)
> - NFR-I1 (**TCP; USB deferred to Story 10.3 with the rest of station configuration**)
> - NFR-I2 (**a failed ticket is retried, then alerted on; never silently dropped**)

### 4.2 `epics.md` — insert Story 5.0 before Story 5.1

> ### Story 5.0: Implement Durable Print Queue
>
> As the system,
> I want ticket print jobs persisted transactionally and delivered by a retrying worker,
> So that a printer outage never results in a lost ticket or a manual reprint burden on staff.
>
> **Acceptance Criteria:**
>
> **Given** an order is submitted, **when** it commits, **then** print jobs for every destination present
> are inserted in the same transaction; if the job insert fails, the order commit fails with it.
>
> **Given** a print job is pending, **when** the worker picks it up, **then** its status moves to
> `printing` and delivery is attempted to that destination's printer.
>
> **Given** delivery fails, **when** the worker retries, **then** the waits are 1s, 2s, 5s, 15s, 30s and
> `attempts` increments on each claim.
>
> **Given** the printer is disconnected for an extended period, **when** it reconnects, **then** all
> pending jobs flush automatically in creation order with no manual action.
>
> **Given** a job exceeds the retry limit, **when** it is dead-lettered, **then** an alert fires and the
> job remains in the table, recoverable.
>
> **Given** a worker crashes mid-print, **when** it restarts, **then** a job stuck in `printing` is
> recovered, and the recovery is recorded so a duplicate ticket has an explanation.
>
> **Given** one station's printer is failing, **when** later tickets arrive for that same station,
> **then** they wait behind it rather than overtaking it — a kitchen must not receive round 3 before
> round 2.
>
> **Given** the HTTP order-submission response, **when** measured, **then** it does not block on printer
> I/O.

### 4.3 `epics.md` — Story 5.2, delivery ACs replaced

**Keep unchanged:** the user story, and the ACs covering ticket CONTENT (one payload per destination;
type label, table identifiers, seat sub-headers, items, quantities, modifiers, timestamp, paper cut).

**REMOVE** the three ACs describing synchronous delivery: the inline `PRINTER_IP:9100` write on
submission, the 5-second timeout with its `printer:alert` + "reprint manually", and the
connection-failure AC with the same semantics. **REMOVE** the USB AC (deferred — see 4.6). **REPLACE**
the NFR-P1 AC.

**NEW**
> **Given** a queued print job for a station with a printer configured
> **When** the worker delivers it
> **Then** a TCP connection is opened to `PRINTER_IP:PRINTER_PORT` with Node's `net`, the ESC/POS bytes
> are written, the write is confirmed flushed, and the socket is closed.
>
> **Given** the printer refuses the connection, is unreachable, or accepts but does not drain the write
> **When** the per-attempt timeout (5s) expires or the socket errors
> **Then** the attempt REJECTS with the cause named, and the job returns to the queue for its next
> attempt. A job is never marked printed on an attempt that did not demonstrably send.
>
> **Given** a job that has been retrying, or one that has been dead-lettered
> **When** staff are at any POS screen
> **Then** a banner distinguishes **queued and retrying** (informational — the system will recover) from
> **stopped** (needs attention), and a ticket that recovers clears its own banner. Manual reprint is not
> the recovery mechanism.
>
> **Given** no printer is configured for a station (`PRINTER_IP` blank)
> **When** a job is delivered
> **Then** the ticket is logged and the job completes — the queue is verifiable without hardware.
>
> **Given** the full submission flow
> **When** measured under normal LAN conditions
> **Then** submission-to-response is under 1 second (NFR-P1). Ticket delivery is measured separately and
> may take as long as the retry ladder requires.

### 4.4 NFR-P1 — `epics.md:118` and `prd.md:509`

**OLD**
> **NFR-P1:** Order submission at a POS terminal completes and all tickets are printed or displayed
> within 3 seconds under normal LAN conditions

**NEW**
> **NFR-P1:** Order submission at a POS terminal completes within **1 second** under normal LAN
> conditions. The response does not wait on printer I/O.
>
> **NFR-P1b:** A ticket reaches a healthy printer within 3 seconds of submission. When the printer is
> unavailable the job is retried on a bounded ladder (about 83 seconds to the final attempt) and is never
> discarded — delivery time is a property of the printer, not of the order.

### 4.5 NFR-I2 — `epics.md:147` and `prd.md:546`

**OLD**
> **NFR-I2:** Printer timeout or connection failure produces an immediate visible system alert — a failed
> ticket print is never silently dropped

**NEW**
> **NFR-I2:** A printer timeout or connection failure is retried automatically. Staff see **queued and
> retrying** while it recovers and **stopped** once the attempts are exhausted; a dead-lettered job
> remains in the queue, recoverable. A failed ticket print is never silently dropped.

### 4.6 NFR-I1 — `epics.md:146` and `prd.md:545`

**OLD**
> **NFR-I1:** ESC/POS printer integration supports both USB and TCP/IP network connection modes; the
> active mode is configurable per deployment

**NEW**
> **NFR-I1:** ESC/POS printer integration uses TCP/IP. USB support and per-station printer selection are
> deferred to Story 10.3, which owns station configuration — `station_configs` currently has no rows, no
> `connection_mode` column, and no `pizza_kitchen` station type.

### 4.7 `epics.md` — Epic 10 scope note

Add under Story 10.3:
> **Inherited from Epic 5 (2026-10-02):** station configuration must add `output_mode` (`print` / `kds`)
> and `connection_mode` (`tcp` / `usb`) to `station_configs`, add `pizza_kitchen` to the station type
> enum so it can express every `production_destination`, and seed one station per destination. Until it
> does, `resolveTransport` sends every destination to the single `PRINTER_IP`.

### 4.8 `architecture.md` — the three missing pieces

1. **New section, Print Queue** (Change A1, never applied) — transactional outbox, worker, retry ladder,
   dead-lettering, head-of-line ordering per destination, local-only and why PostgreSQL rather than a
   broker.
2. **Schema** — `print_jobs` as built: `ticket jsonb` (not `payload BYTEA` — Story 5.2 owns the bytes),
   `destination` (not `station_id` — those tables are empty), and explicitly NOT append-only.
3. **Core Data Flow** (`:865-875`) — replace `print.service.printTickets()` with the in-transaction
   enqueue, remove `ticketsPrinted` from the response, and add the worker's own flow beneath it.
4. **File plan** (`:800`, `:824`) — `src/server/print/`, with the one-line reason: `server-only` throws
   in the worker's process.

### 4.9 `ux-design-specification.md` — optional addition

The spec has no printer-alert section to correct. Proposed addition beside the owner `AlertBanner`:
> **Printer alert banner** — global, for signed-in staff. Three states: *retrying* (amber,
> informational), *stopped* (red, needs attention), and *recovered* (clears itself). Never
> auto-dismissing; capped at three with a dismiss-all.

---

## Section 5 — Implementation Handoff

**Scope: Minor.** Four documents, no code. Direct implementation.

| Deliverable | Where |
|---|---|
| Epic 5 summary, Story 5.0, Story 5.2 rewrite, three NFRs, Epic 10 note | `epics.md` |
| Three NFRs | `prd.md` |
| Print Queue section, `print_jobs` schema, Core Data Flow, file plan | `architecture.md` |
| Printer alert banner entry | `ux-design-specification.md` |

**Success criteria:** a reader who knows nothing of this conversation can open `epics.md`, read Epic 5,
and arrive at the system that exists — including why it is a queue, why delivery is asynchronous, and
what is deferred to Story 10.3.

**Not in scope:** the KNOWN GAP from the 5.2 review (a polite refusal is indistinguishable from a print
at the TCP layer). It is logged in `deferred-work.md` and needs its own decision, not a documentation
edit.
