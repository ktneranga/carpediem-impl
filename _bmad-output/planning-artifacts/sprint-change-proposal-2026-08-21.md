# Sprint Change Proposal — 2026-08-21

**Project:** carpe-diem-restaurant
**Author:** Teran
**Mode:** Batch
**Status:** APPROVED by Teran, 2026-08-21
**Scope classification:** **Major** — new epic, PRD NFR changes, architecture changes, MVP scope expansion

---

## Section 1 — Issue Summary

Three related issues were identified on 2026-08-21 while Story 1.4 sat in `review`. None arose from a story failure; all surfaced during architecture review and a follow-on brainstorming session.

### Issue A — No requirement covers a device losing the local network

**Type:** Incomplete original requirements.

NFR-R1 guarantees full operation "over the restaurant LAN without internet connectivity." It says nothing about a *device* losing the LAN itself. The two failure modes were conflated, and only one is defended.

**Evidence:**
- A search across PRD, architecture, epics, and UX specification returns no mention of Wi-Fi, access points, wireless coverage, or a site survey.
- The venue is four outdoor beach zones — bean bags, sun beds, tables, rooftop (`prd.md:61`). The rooftop is named the design benchmark for speed (`prd.md:249`).
- Provisioning requirements (`prd.md:296-300`) list env vars, printer IP, and feature flags. No network hardware is specified.
- The offline-resilience acceptance test (`prd.md:279`) simulates an *internet* outage — the failure that was never going to hurt operations.

### Issue B — Tablet ordering must not depend on site Wi-Fi

**Type:** New requirement / deliberate strategic choice.

Waiter tablets are the primary v1 order path (`prd.md:136`, Epics 3 and 4). Teran has directed that tablets must not depend on restaurant Wi-Fi, to avoid owning wireless coverage engineering at every customer site.

The agreed design, reached in the 2026-08-21 brainstorming session:

```
tablet  --HTTPS-->      cloud API  --queue-->        local POS (consume, commit, print)
tablet <--WebSocket--   cloud API  <--reply queue--  local POS
```

Local POS holds an **outbound** AMQP connection to a per-restaurant RabbitMQ queue, so no ports are opened at the restaurant. The cloud holds order *requests*; only the local POS creates real orders. When the internet is unavailable, **the tablet is not used** — staff take the order and enter it at the POS terminal, exactly as today.

The terminal fallback is what preserves NFR-R1: the tablet is an accelerator over a guaranteed path, so the system still runs fully on LAN with no internet. Only the convenience layer degrades.

### Issue C — There is no print queue

**Type:** Technical limitation discovered during review.

Ticket printing is a synchronous TCP call inside the order-submission Route Handler. There is no queue, no retry, and no durable pending-ticket store.

**Evidence:**
- `architecture.md:84` refers to a "print queue" in prose. Nothing implements it.
- `architecture.md:829-847` — `print.service.printTickets()` is called inline, TCP to `PRINTER_IP:9100`, 5-second timeout.
- Story 5.2 acceptance criteria, verbatim: on failure a `printer:alert` fires and the ticket data "is not silently discarded — the alert includes enough context to **reprint manually**."

**Why this matters.** Printer runs out of paper at 8pm. Twelve orders go in over four minutes. Twelve banners stack up. Someone reloads the paper, and a human must now correctly recall which twelve tickets to reprint, in order, under service pressure. That is an order existing with no ticket in the kitchen — the exact failure the product exists to eliminate (`prd.md:25`), arriving through the back door.

Issue C is independent of A and B. It affects v1 whether or not a single tablet ever ships.

---

## Section 2 — Impact Analysis

### Epic Impact

| Epic | Impact | Change |
|---|---|---|
| **Epic 1** — Foundation | Low | Story 1.6 (PWA baseline) gains an AC for client-side network loss |
| **Epic 3** — Zone & Table Nav | Low | Table state must reach tablets over the relay path; no structural change |
| **Epic 4** — Order Entry | Medium | Story 4.5 gains an idempotency key and a second ingestion path |
| **Epic 5** — Ticket Output | **High** | New print-queue story; Story 5.2 substantially rewritten |
| **Epic 10** — Config | Low | Two new feature flags |
| **Epic 11** — Vendor Ops | Low | Broker and consumer health added to monitoring |
| **NEW Epic 12** — Cloud Order Relay | **New** | Cloud API, broker, local consumer, reply path, tablet status UI |

**Epic 1 can still be completed as planned.** No epic becomes obsolete. No rollback is required — completed Stories 1.1, 1.2, and 1.3 are foundation work and are unaffected.

**Sequencing.** The print queue must land before or alongside Story 5.2, since 5.2's synchronous call is what it replaces. Epic 12 depends on Epics 4 and 5 being functional and is therefore appended last rather than inserted, which also avoids renumbering eleven epics and breaking `sprint-status.yaml`.

### Story Impact

**Modified:**
- **Story 1.6** — add AC: tablet loses network mid-session; offline state appears; no partial order is written; clean recovery on reconnect. Distinct from the existing server-unreachable test.
- **Story 4.5** — add client-generated order UUID with a unique constraint; submission must be idempotent.
- **Story 5.2** — rewritten. Ticket generation stays; the synchronous TCP call becomes a queued job. Retains ESC/POS byte formatting and the USB/TCP mode split.

**New:**
- **Story 5.0 (or 5.1a)** — Implement the print queue (Postgres transactional outbox + worker).
- **Epic 12 stories** — see Section 4.

### Artifact Conflicts

**PRD** (`prd.md`)
- NFR-R1 needs clarification that tablet ordering is explicitly exempt and degrades to terminal entry.
- NFR-P1 (≤3s) applies to the LAN path only; the relay path needs its own budget.
- NFR-S4 currently forbids operational data leaving the premises without owner opt-in. Order contents transiting a cloud queue violate this as written.
- Integration List (`prd.md:350-356`) omits the message broker and cloud relay API.
- Feature flag table (`prd.md:304-310`) needs tablet-ordering flags.
- Offline-resilience test (`prd.md:279`) tests the wrong failure.
- MVP scope expands materially.

**Architecture** (`architecture.md`)
- Infrastructure & Deployment (`:271`) — broker and consumer absent.
- API & Communication Patterns (`:226`) — no queue ingestion path documented.
- Core Data Flow (`:829`) — single submission path; relay variant missing.
- Post-MVP Cloud Sync (`:991`) — partially promoted into MVP; its constraint "syncer must be additive only, never modifies per-restaurant operational data" (`:1085`) is contradicted by inbound order delivery and must be rewritten.
- No print queue design; no idempotency rule.
- Schema needs a `print_jobs` table and an order idempotency key.

**UX Design** (`ux-design-specification.md`)
- No order status states for a relayed order (`sent → accepted → printed`, or `rejected`).
- No tablet-unavailable state directing staff to the terminal.
- Printer alert semantics change: "failed, reprint manually" becomes "queued, retrying."
- Kitchen display and owner dashboard are unaffected.

**Other artifacts**
- `docker-compose.yml` — consumer process (in-app or separate service).
- Migrations — `print_jobs` table, idempotency column.
- Monitoring — Uptime Kuma should watch consumer connection state and queue depth.
- Testing — new failure scenarios: duplicate delivery, printer down with backlog, tablet drop mid-order.

### Technical Impact

- **New runtime dependency:** a hosted RabbitMQ broker (self-hosted on the cloud VPS, or CloudAMQP). Recurring cost per restaurant, and a new operational surface.
- **New failure mode:** at-least-once delivery makes duplicate orders possible. On append-only tables (NFR-D1/S3) a duplicate is permanent and un-deletable by design. Idempotency is mandatory from day one, not retrofittable.
- **Print queue is local-only.** It must work with the internet dead (NFR-R1), so Postgres — not the cloud broker — backs it.

---

## Section 3 — Recommended Approach

### Options evaluated

**Option 1 — Direct Adjustment.** Modify existing stories, add new stories within the current epic structure.
*Viable for Issues A and C. Not sufficient for Issue B* — the cloud relay is a new service tier, not a story.
Effort: Low (A, C) · Risk: Low

**Option 2 — Rollback.** Revert completed work to simplify.
*Not viable and not needed.* Stories 1.1–1.3 are unaffected foundation. Nothing to gain.
Effort: N/A · Risk: N/A

**Option 3 — MVP Review.** Reduce or redefine scope.
*Relevant to Issue B only.* Issues A and C are small and clearly in scope. Issue B adds a cloud API, a broker, a consumer, a reply path, and status UI — realistically four to six stories plus recurring hosting cost.
Effort: High · Risk: Medium

### Selected: **Hybrid**

1. **Issues A and C → Direct Adjustment.** Small, high-value, unambiguously v1. Proceed immediately.
2. **Issue B → New Epic 12, in v1 scope as directed**, sequenced last, with an explicit documented decision point to defer if timeline pressure emerges.

### Rationale

Issue C is the highest-value item in this proposal and the cheapest to fix. It is a live reliability gap in already-scheduled Epic 5 work, and it undermines the product's core promise. It should not wait behind the tablet decision.

Issue A is a documentation gap with a hardware answer. Writing the NFR costs nothing and prevents a silent assumption from shipping.

Issue B is the largest single scope addition in this proposal and deserves to be named as such. It is a deliberate business tradeoff — accepting cloud infrastructure cost and complexity in exchange for never owning Wi-Fi coverage at customer sites. Teran has confirmed v1 scope. Sequencing it last preserves the option to defer without disrupting anything else, because no other epic depends on it.

**MVP impact: yes, scope expands.** Epic 12 is net-new work not present in the original eleven-epic plan.

---

## Section 4 — Detailed Change Proposals

### 4.1 PRD Changes

**Change P1 — Clarify NFR-R1** (`prd.md:516`)

OLD:
> **NFR-R1:** System operates fully over the restaurant LAN without internet connectivity — an internet outage has zero impact on order entry, ticket printing, bill generation, or payment recording

NEW:
> **NFR-R1:** System operates fully over the restaurant LAN without internet connectivity — an internet outage has zero impact on order entry, ticket printing, bill generation, or payment recording **when performed at a POS terminal. Tablet-based order entry is an optional accelerator layer and is explicitly exempt from this guarantee; see NFR-R5.**

*Rationale:* Preserves the product's central claim while stating honestly that the tablet layer depends on connectivity.

**Change P2 — Add NFR-R5 through NFR-R7** (after `prd.md:519`)

NEW:
> - **NFR-R5:** Tablet-based order entry requires internet connectivity. When unavailable, tablets display an unmistakable unavailable state and staff enter orders at the POS terminal. No order is ever composed, queued, or held on a tablet while disconnected.
> - **NFR-R6:** Local network coverage must be continuous across all seating zones for any device participating in POS operation. A site survey validating signal strength at the furthest table of each zone is a go-live prerequisite.
> - **NFR-R7:** An order submitted from a tablet is delivered to the local POS exactly once. Duplicate delivery from the transport layer must not produce a duplicate order or a duplicate ticket.

**Change P3 — Scope NFR-P1 to the LAN path** (`prd.md:498`)

OLD:
> **NFR-P1:** Order submission (staff taps "Send Order") completes and all tickets are printed or displayed within 3 seconds under normal LAN conditions

NEW:
> **NFR-P1:** Order submission at a POS terminal completes and all tickets are printed or displayed within 3 seconds under normal LAN conditions
> - **NFR-P1a:** Order submission from a tablet over the cloud relay completes within 30 seconds under normal connectivity. The waiter's device shows an explicit intermediate state until the local POS confirms commit and print.

**Change P4 — Amend NFR-S4 for relayed order data** (`prd.md:509`)

OLD:
> **NFR-S4:** All application data resides on the local PostgreSQL instance; no operational data is transmitted to external services without explicit Owner opt-in

NEW:
> **NFR-S4:** All application data resides on the local PostgreSQL instance. No operational data is transmitted to external services without explicit Owner opt-in. **Cloud relay order transport is such an opt-in, governed by the `cloud_relay_enabled` tenant flag; when disabled, no order data leaves the premises. Relayed order requests are transient, encrypted in transit, and deleted from the cloud once the local POS acknowledges commit.**

**Change P5 — Add integrations** (`prd.md:355`, Integration List table)

NEW ROWS:
> | Message broker (RabbitMQ) | Cloud | Yes | Per-restaurant queue; local POS connects outbound, no inbound ports |
> | Cloud relay API | Cloud | Yes | Tablet order capture and status; holds order requests only, never commits |

**Change P6 — Add feature flags** (`prd.md:304-310`, flag table)

NEW ROWS:
> | `tablet_ordering_enabled` | `true` | `false` |
> | `cloud_relay_enabled` | `true` | `false` |

**Change P7 — Fix the offline-resilience test** (`prd.md:279`)

OLD:
> **Offline resilience:** Simulate internet outage during service — all core functions must remain fully operational.

NEW:
> **Offline resilience:** Simulate internet outage during service — all core functions must remain fully operational at the POS terminal; tablets must show the unavailable state and hold nothing.
> **Device network loss:** Carry a tablet out of network range mid-order — the offline state must appear, no partial order may be written, and recovery on reconnect must be clean.
> **Printer outage:** Disconnect the printer during service — tickets must queue durably and flush automatically on reconnection with no manual reprint.

**Change P8 — Add provisioning requirement** (`prd.md:296-300`)

NEW BULLET:
> - Network: wireless coverage validated across all seating zones before go-live; outdoor-rated access points where zone geometry requires them

### 4.2 Architecture Changes

**Change A1 — New section: Print Queue Architecture** (insert after Infrastructure & Deployment, `architecture.md:298`)

NEW:
> ### Print Queue
>
> Ticket printing is asynchronous and durable. Order submission never blocks on the printer.
>
> **Transactional outbox.** Ticket jobs are inserted into `print_jobs` in the **same transaction** as the order commit. An order can never exist without its tickets queued.
>
> **Worker.** A worker per production destination drains its jobs in order, opens TCP to the station's printer, and marks the job `printed`. Retry with backoff: 1s, 2s, 5s, 15s, 30s. After N attempts a job is dead-lettered — an alert fires, but the job remains in the table and flushes automatically when the printer returns.
>
> **Local only.** The print queue is Postgres-backed, never the cloud broker. Printing must work with the internet dead (NFR-R1). Postgres is already in the stack, and it is the only option permitting transactional enqueue — a broker would introduce a dual-write problem where a failed publish leaves an order with no ticket.
>
> **Idempotent.** Job state moves `pending → printing → printed`. A retry must never double-print.

**Change A2 — New section: Cloud Order Relay** (insert after Print Queue)

NEW:
> ### Cloud Order Relay
>
> Waiter tablets reach the POS over the internet rather than site Wi-Fi.
>
> ```
> tablet  --HTTPS-->      cloud API  --publish-->      RabbitMQ (queue per tenant)
>                                                            |
> local POS  --outbound AMQP, long-lived-->  consumes -------+
>   -> validate -> inventory decrement -> audit append -> enqueue print job   [one transaction]
>   -> publish result to reply queue
> cloud API  --consumes reply-->  pushes status to tablet over WebSocket
> ```
>
> **The local POS dials out.** No ports are opened at the restaurant; NFR-S5 is unaffected. Messages are pushed down the open connection, so latency is network round-trip rather than a polling interval.
>
> **The cloud proposes, the local POS commits.** The cloud holds order *requests*. Only the local PostgreSQL creates orders, decrements inventory, and writes audit rows. Single write master is preserved and NFR-D3/D4 hold unchanged.
>
> **Durability.** If the local POS is down — restart, power blip, Watchtower update — messages persist in the queue and deliver on reconnect. This is the specific property a raw socket cannot provide, and the reason a broker is used rather than an outbound Socket.io client.
>
> **Idempotency is mandatory.** RabbitMQ delivers at-least-once. A crash between commit and ack redelivers the message. A client-generated order UUID with a unique constraint at the local database is required from day one; on append-only tables a duplicate is permanent.
>
> **Degradation.** No internet means the tablet shows an unavailable state and holds nothing. Staff enter the order at the POS terminal.

**Change A3 — Add relay variant to Core Data Flow** (`architecture.md:829`)

Add a second flow beneath the existing LAN submission flow, showing queue ingestion converging on the same `order.service.submit()` entry point.

**Change A4 — Rewrite the Post-MVP Cloud Sync constraint** (`architecture.md:1085`)

OLD:
> - Syncer must be **additive only** — never modifies per-restaurant operational data

NEW:
> - The **syncer** (event push to the fleet hub) remains additive only — never modifies per-restaurant operational data.
> - The **order relay consumer** is a separate concern and does deliver inbound order requests. It never writes directly; it hands requests to `order.service.submit()`, which applies the same validation, atomicity, and audit rules as a LAN submission.

**Change A5 — Schema additions**

NEW:
> ```sql
> print_jobs(
>   job_id UUID PK, tenant_id FK, order_id FK, station_id FK,
>   ticket_type TEXT, payload BYTEA,
>   status TEXT,              -- pending | printing | printed | dead
>   attempts INT DEFAULT 0, last_error TEXT,
>   created_at TIMESTAMPTZ, printed_at TIMESTAMPTZ
> )
>
> -- Orders gain an idempotency key
> ALTER TABLE order_sessions ADD COLUMN client_order_uuid UUID UNIQUE;
> ```
> `print_jobs` is mutable state, not an audit table — it is exempt from the append-only RULE.

**Change A6 — Update Infrastructure & Deployment** (`architecture.md:271-298`)

Add the relay consumer to the service listing and note the broker as an external cloud dependency. Add `CLOUD_RELAY_URL`, `BROKER_URL`, and `BROKER_CREDENTIALS` to the environment variable list.

### 4.3 UX Changes

**Change U1 — Relayed order status states**

NEW: The `OrderActionStrip` gains states for relayed submission — `sent` (accepted by cloud), `accepted` (local POS committed), `printed` (ticket produced), `rejected` (with reason, e.g. item unavailable). `sent` must be visually distinct from `printed`; a waiter must never read "sent" as "the kitchen has it."

**Change U2 — Tablet unavailable state**

NEW: When the relay is unreachable, the tablet displays a full-screen unmistakable state: ordering unavailable, use the POS terminal. No order composition is permitted. This is deliberately non-dismissible — a waiter must not be able to work past it into a dead end.

**Change U3 — Printer alert semantics**

OLD: persistent banner meaning "printer failed, reprint manually."
NEW: banner distinguishes **queued and retrying** (informational; system will recover) from **dead-lettered** (needs attention). Manual reprint stops being the recovery mechanism.

### 4.4 Epic and Story Changes

**Change E1 — New Story 5.0: Implement Durable Print Queue** (insert before Story 5.1, `epics.md:1206`)

> As the system,
> I want ticket print jobs persisted transactionally and delivered by a retrying worker,
> So that a printer outage never results in a lost ticket or a manual reprint burden on staff.
>
> **Acceptance Criteria:**
> - Given an order is submitted, when it commits, then print jobs for every destination are inserted in the same transaction; if the job insert fails the order commit fails.
> - Given a print job is pending, when the worker picks it up, then status moves to `printing` and TCP delivery is attempted to the station printer.
> - Given delivery fails, when the worker retries, then backoff is 1s, 2s, 5s, 15s, 30s and `attempts` increments.
> - Given the printer is disconnected for an extended period, when it reconnects, then all pending jobs flush automatically in creation order with no manual action.
> - Given a job exceeds the retry limit, when it is dead-lettered, then an alert fires and the job remains recoverable in the table.
> - Given a worker crashes mid-print, when it restarts, then a job stuck in `printing` is recovered without double-printing.
> - Given the HTTP order-submission response, when measured, then it does not block on printer I/O.

**Change E2 — Rewrite Story 5.2**

Ticket generation, ESC/POS byte assembly, and the USB/TCP mode split are retained. The synchronous TCP call and its inline 5-second timeout are removed; Story 5.2 now enqueues to `print_jobs`. The `printer:alert` AC changes per Change U3. The ≤3s NFR-P1 AC is rewritten to measure submission-to-response, with ticket delivery measured separately.

**Change E3 — Story 1.6 gains an AC**

> Given the tablet loses network connectivity mid-session, when the waiter attempts to act, then the offline state appears within 2 seconds, no partial order is written, and on reconnect the session recovers cleanly with no duplicate or orphaned state.

**Change E4 — Story 4.5 gains idempotency**

> Given an order submission carries a client-generated UUID, when the same UUID is submitted more than once, then exactly one order is created, exactly one set of tickets is queued, and subsequent submissions return the original result.

**Change E5 — New Epic 12: Cloud Order Relay**

> **Goal:** Enable waiter tablets to submit orders over the internet rather than site Wi-Fi, via a cloud relay and per-restaurant message queue, with the local POS remaining the sole authority that creates orders. When connectivity is unavailable, tablets degrade to an explicit unavailable state and staff use the POS terminal.
>
> - **12.1** Cloud relay API — menu read endpoint, order capture endpoint, per-tenant API keys
> - **12.2** Message broker provisioning — per-restaurant queues, credentials, TLS, reply queues
> - **12.3** Local relay consumer — outbound AMQP connection, reconnect with backoff, idempotent ingestion into `order.service.submit()`
> - **12.4** Reply path and tablet status — result publishing, cloud consumption, WebSocket push to tablet
> - **12.5** Tablet unavailable state and terminal fallback UX
> - **12.6** Relay observability — consumer connection health, queue depth, and dead-letter alerting in Uptime Kuma

**Change E6 — Epic 10 gains a story scope note**

Story 10.5 (tenant feature flags) must cover `tablet_ordering_enabled` and `cloud_relay_enabled`.

### 4.5 sprint-status.yaml Changes

```yaml
  # ── Epic 5 ── add before 5-1
  5-0-implement-durable-print-queue: backlog

  # ── Epic 12: Cloud Order Relay ─────────────────────────────────────────
  epic-12: backlog
  12-1-implement-cloud-relay-api: backlog
  12-2-provision-message-broker-and-queues: backlog
  12-3-implement-local-relay-consumer: backlog
  12-4-implement-reply-path-and-tablet-status: backlog
  12-5-implement-tablet-unavailable-state-and-fallback: backlog
  12-6-implement-relay-observability: backlog
  epic-12-retrospective: optional
```

---

## Section 5 — Implementation Handoff

**Scope classification: Major.** A new epic, PRD non-functional requirement changes, and architecture changes exceed direct developer implementation.

| Change set | Route to | Deliverable |
|---|---|---|
| PRD changes P1–P8 | Product Manager (`bmad-edit-prd`) | Updated PRD with revised NFR-R1, new NFR-R5/R6/R7, NFR-P1a, amended NFR-S4 |
| Architecture changes A1–A6 | Architect (`bmad-create-architecture`) | Print queue and cloud relay sections, schema additions, corrected sync constraint |
| UX changes U1–U3 | UX Designer (`bmad-create-ux-design`) | Relayed order status states, tablet unavailable state, revised alert semantics |
| Epic and story changes E1–E6 | Product Owner / Developer (`bmad-create-epics-and-stories`) | New Story 5.0, rewritten 5.2, amended 1.6 and 4.5, new Epic 12 |
| `sprint-status.yaml` | Developer (`bmad-sprint-planning`) | Regenerated tracking with Epic 12 and Story 5.0 |

### Recommended sequence

1. **Unblock Story 1.4 first** — three review findings are still open and unrelated to this proposal. `bmad-dev-story`.
2. **Apply PRD changes** — everything downstream references the new NFRs.
3. **Apply architecture changes** — print queue and relay design.
4. **Apply epic and story changes**, then regenerate sprint status.
5. **Apply UX changes** — needed before Epic 12 stories, not before Story 5.0.
6. **Re-run `bmad-check-implementation-readiness`** to confirm the four planning artifacts are aligned again.

### Success criteria

- No ticket can be lost by a printer outage; recovery requires no human memory.
- An order submitted twice by the transport layer produces one order and one ticket.
- With the internet down, a POS terminal can take an order, print a KOT, generate a bill, and record a payment — unchanged.
- With the internet down, a tablet shows an unmistakable unavailable state and holds nothing.
- Wireless coverage is validated at the furthest table of every zone before go-live.

### Open decisions requiring Teran

1. **Broker hosting** — self-hosted on the cloud VPS versus CloudAMQP, and the recurring per-restaurant cost.
2. **Epic 12 timing** — confirmed as v1 scope. Sequenced last, so it remains deferrable without disrupting other epics if timeline pressure emerges.
3. **Tablet hardware** — the relay only helps if tablets have LTE. Wi-Fi-only tablets cannot reach the cloud at the moment they cannot reach the LAN. This is a purchasing decision that should be made before Epic 12 begins.
