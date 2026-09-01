---
stepsCompleted: [1, 2, 3, 4]
inputDocuments: []
session_topic: 'How a tablet gets an order to the POS without depending on site Wi-Fi'
session_goals: 'Surface transport options beyond LAN-only vs cloud-only; reach a defensible v1 direction; make any NFR-R1 trade-off knowingly rather than silently'
selected_approach: 'ai-recommended'
techniques_used: ['Constraint Mapping', 'Morphological Analysis', 'Chaos Engineering']
ideas_generated: 11
context_file: ''
---

# Brainstorming Session Results

**Facilitator:** Teran
**Date:** 2026-08-21

## Session Overview

**Topic:** How a tablet gets an order to the POS without depending on site Wi-Fi

**Goals:**
- Surface transport options beyond the two already under debate (LAN-only vs. cloud-only)
- Reach a direction defensible enough to commit to for v1
- Avoid sacrificing NFR-R1 silently — if it is traded away, trade it knowingly

### Context Guidance

_No context file supplied. Session runs against live project knowledge: PRD, architecture, epics, and UX specification for carpe-diem-restaurant._

**Relevant standing constraints (held loosely — open to challenge during ideation):**
- NFR-R1: full operation over LAN with zero internet dependency
- NFR-P1: order submission to ticket print within 3 seconds
- NFR-S4: no operational data leaves the premises without owner opt-in
- NFR-D3/D4: atomic concurrent writes; inventory never below zero
- Printer is a TCP device on the local network (`PRINTER_IP:9100`)
- Venue: 4 outdoor beach zones (bean bags, sun beds, tables, rooftop)

**Embedded assumption flagged at setup:** the phrase "without depending on site Wi-Fi" is a constraint, not the underlying problem. The underlying problem is how an order reliably travels from a waiter's hands into the POS queue. The constraint is treated as fair game for challenge during the session.

### Session Setup

**Approach selected:** [2] AI-Recommended Techniques

---

## Technique Selection

**Approach:** AI-Recommended Techniques
**Analysis Context:** Tablet-to-POS order transport, with the goal of escaping a binary LAN-vs-cloud frame and reaching a defensible v1 decision without silently sacrificing NFR-R1.

**Diagnosis driving the recommendation:**
- Not an idea shortage — an *option space* shortage. "Transport" was being treated as one atomic choice when it decomposes into several independent parameters.
- The topic carries a pre-installed constraint ("without site Wi-Fi") that was decided before the session and had not yet been examined.

**Recommended Techniques:**

- **Phase 1 — Constraint Mapping** _(deep, est. 15–20 min)_: Surface every constraint and sort real from imagined. Required before any NFR trade-off can be made knowingly rather than by default. This is where the "no site Wi-Fi" constraint gets examined honestly.
- **Phase 2 — Morphological Analysis** _(deep, est. 30–40 min)_: Decompose transport into parameters (carrier medium x buffer location x commit authority x failure behavior x confirmation timing) and combine systematically. The load-bearing phase — directly generates options beyond the two under debate.
- **Phase 3 — Chaos Engineering** _(wild, est. 20–30 min)_: Deliberately break surviving candidates against worst-case scenarios. A transport decision is a reliability decision; it should be won by surviving failure, not by argument. Makes every sacrificed NFR explicit.

**Total estimated time:** 65–90 minutes

**AI Rationale:** The arc shifts creative domain each phase — analytical, then combinatorial, then adversarial — to counter semantic clustering and prevent drift back toward pre-existing opinions. Phase 3 is drawn from a deliberately different shelf as the phase most likely to overturn the preferred answer.

---

## Technique Execution Results

**Facilitation note:** The planned three-phase sequence was not run as designed. Teran stopped Phase 1 (Constraint Mapping) partway through — the constraint inventory did not fit how he was thinking about the problem — and instead presented a worked design of his own. Facilitation adapted to follow that, which proved far more productive than the scripted technique. Ideas below emerged from that dialogue rather than from formal technique execution.

**Constraint Mapping (Phase 1) — abandoned early.** The documented constraint inventory (C1–C11) was placed on the board and is retained in the Session Overview above. The "real vs imagined" sort was never run. The one constraint it did surface as undocumented — "tablets must not depend on site Wi-Fi" — turned out to be the correct framing anyway.

**Morphological Analysis (Phase 2) — not run.**

**Chaos Engineering (Phase 3) — not run.**

**What replaced them:** direct design dialogue on Teran's own proposal, with the facilitator contributing alternatives, naming failure modes, and checking claims against the existing PRD and architecture.

---

## Idea Inventory

### Theme 1 — Transport Architecture: Cloud As Relay, Not As Tier

*The unifying insight: the cloud is a mailbox between two endpoints that cannot see each other, not a second POS.*

**[Transport #1]: Cloud As Rendezvous**
*Concept:* Tablet and local POS cannot reach each other directly, so the cloud becomes the meeting point — tablet posts up, local pulls down.
*Novelty:* Reframes "cloud" from system tier to relay. No cloud POS, no dual-master, no feature parity to maintain.

**[Integrity #3]: Cloud Proposes, Local Commits**
*Concept:* The cloud holds an order *request*. It becomes a real order only when the local POS accepts it, decrements inventory, writes the audit row, and prints the KOT.
*Novelty:* Single write master survives contact with a distributed system. NFR-D3/D4 hold unchanged because only one database ever decides anything.

**[Transport #5]: Outbound Consumer, Inbound Orders** — *Teran's mechanism*
*Concept:* The local POS opens an outbound AMQP connection to a cloud RabbitMQ broker and consumes from its own queue. The cloud never dials in; it publishes.
*Novelty:* Solves the NAT problem and the latency problem with one move. No ports opened at the restaurant (NFR-S5 intact), and latency drops to network round-trip rather than a polling interval.

**[Fleet #7]: One Queue Per Restaurant**
*Concept:* Topic exchange, routing key per tenant, one queue per site.
*Novelty:* Multi-tenant isolation (NFR-SC1) extends into the transport layer for free, and the planned post-MVP vendor fleet hub gets a natural spine.

### Theme 2 — Graceful Degradation: Honest Failure Over Invisible Failure

**[Resilience #2]: Additive Tablet, Guaranteed Terminal** — *Teran's key move*
*Concept:* The tablet layer is explicitly optional. When the internet is unavailable the tablet is simply not used; the waiter takes the order and enters it at the POS terminal, as today.
*Novelty:* Most offline-first designs try to make the degraded path invisible. This one makes it honest — you lose speed, never correctness. Nothing to reconcile because nothing was ever held.
*Significance:* This is what preserves NFR-R1. The tablet is an accelerator over a guaranteed path, so the *system* still runs fully on LAN with no internet — only the convenience layer degrades. An earlier facilitator objection that "cloud tablets break NFR-R1" was wrong for this reason and was withdrawn.

**[Resilience #6]: The Queue Is The Buffer**
*Concept:* If the local POS is down — container restart, power blip, Watchtower update mid-service — messages sit durably in the queue and deliver on reconnect.
*Novelty:* A raw socket or webhook cannot do this. A dropped WebSocket loses the order; a durable queue holds it. This is the central argument for paying RabbitMQ's ops cost.

### Theme 3 — Feedback and Correctness

**[Feedback #9]: Correlation ID From Tap To Ticket**
*Concept:* One ID generated on the tablet travels through the cloud, into the queue, into the local commit, back through a reply queue, and lands on the same tablet. Status moves `sent → accepted → printed`, or `rejected: item sold out`.
*Novelty:* The same ID that makes the reply routable also makes the order idempotent. One mechanism, two problems.

**Return path shape agreed:**

```
tablet  --HTTPS-->      cloud  --queue-->        local POS
tablet <--WebSocket--   cloud  <--reply queue--  local POS
```

AMQP for the server-to-server hop; WebSocket for the server-to-client hop. A tablet is a poor AMQP client — AMQP is not a browser protocol, broker credentials on staff devices are a liability, and tablets drop connections constantly.

**Open risk flagged — idempotency is mandatory.** RabbitMQ delivers at-least-once. If the local POS commits an order and prints, then crashes before acking, the message redelivers and produces a duplicate order and a duplicate KOT. On append-only tables (NFR-D1/S3) that duplicate is permanent. A client-generated order UUID with a unique constraint at the local database is required from day one, not bolted on later.

**[Discipline #11]: Queue At Boundaries, Socket Inside**
*Concept:* Use a broker where messages cross a network or trust boundary, or where durability across a restart matters. Use in-process Socket.io for everything already local and fast.
*Novelty:* A reusable rule that stops "we have RabbitMQ now" from becoming the answer to everything. Routing kitchen-display or table-status updates through a cloud broker would make them slower and add an internet dependency where none exists today — a straight downgrade.

### Theme 4 — Local Print Reliability (unplanned find, independent of the tablet question)

**[Reliability #10]: The Missing Print Queue**
*Concept:* Order commits → ticket rows enqueued in the same database transaction → a worker drains the queue, retrying with backoff. Printer down? Tickets stay queued and flush automatically when it returns.
*Novelty:* Converts printer failure from "a human must remember twelve things" into "the system catches up on its own." Transactional enqueue means an order can never exist without its ticket queued.

**The gap as it stands today.** There is no print queue. Printing is a synchronous TCP call inside the Route Handler (`print.service.printTickets()`, 5-second timeout). The phrase "print queue" appears once at `architecture.md:84` as prose; nothing implements it. Per Story 5.2, on failure a `printer:alert` fires and the ticket data "is not silently discarded — the alert includes enough context to reprint manually." Recovery is therefore a human reading a red banner and re-triggering the print by hand.

**Why this matters.** Printer runs out of paper at 8pm. Twelve orders go in over four minutes. Twelve banners stack up. Someone reloads the paper, and a human must now correctly recall which twelve tickets to reprint, in order, under pressure. That is an order existing with no ticket in the kitchen — the exact gap the product exists to close, arriving through the back door.

**Best practice adopted for the print queue:**

1. Transactional outbox — insert the ticket job in the same transaction as the order commit
2. Never block the HTTP response on printing; a worker prints asynchronously
3. Retry with backoff (1s, 2s, 5s, 15s, 30s)
4. Idempotent — a retry must never double-print; mark job `printing` → `printed`
5. Dead-letter after N attempts — alert staff, but the job stays recoverable and flushes when the printer returns
6. One worker per destination so tickets do not interleave

**Decision: Postgres, not RabbitMQ, for the print queue.** RabbitMQ introduces a dual-write problem — commit the order to Postgres, then publish to the broker; if the publish fails you have an order with no ticket. A Postgres-backed job table allows order and ticket job to be inserted in one transaction. The print queue must also work with the internet dead (NFR-R1), so it has to be local regardless, and Postgres is already in the stack.

### Parked / Rejected Alternatives

**[Transport #4]: Tailscale Tablet** — *considered, then downgraded*
*Concept:* Put waiter tablets on the tailnet; they reach the local server at its Tailscale IP from LTE. No cloud app, no order API, no menu duplication, NFR-S4 fully intact.
*Verdict:* Strong for manager/owner devices that occasionally need the POS from off-site. Weak as the primary waiter order path — it puts a third-party coordination service in the hot path of every order, adds per-tablet login state staff can break, and still fails if the restaurant's internet drops. Kept on the board as a niche option.

**[Transport #8]: Reuse Socket.io Instead Of A Broker** — *rejected*
*Concept:* The local server opens a Socket.io *client* connection out to the cloud hub and receives orders over it. Same outbound-dial trick, zero new infrastructure.
*Verdict:* Gets most of the property for none of the ops cost, but loses durability entirely — a dropped socket during a POS restart loses the order. Rejected in favour of RabbitMQ specifically to buy idea #6.

---

## Prioritization

**Top priority — act on regardless of the tablet decision:**

1. **The print queue (#10).** A v1 reliability gap in Epic 5, already-scheduled work, independent of everything else discussed. Postgres-backed, transactional outbox.

**Committed direction for tablet ordering:**

2. **Cloud relay + RabbitMQ + terminal fallback (#1, #2, #3, #5, #6, #7).** Teran's design. Answers the original question, preserves NFR-R1 through honest degradation, and keeps a single write master.

**Must be designed before any code:**

3. **Idempotency and the return path (#9).** At-least-once delivery makes duplicate prevention mandatory, and the waiter needs to see order status resolve. These are the two least-designed parts.

**Parked:** Tailscale tablets (#4) for owner/manager devices only. Socket.io transport (#8) rejected.

---

## Session Summary

**Original question:** How does a tablet get an order to the POS without depending on site Wi-Fi?

**Answer reached:** Tablet submits over the internet to a cloud API. The cloud publishes to a per-restaurant RabbitMQ queue. The local POS holds an outbound connection to the broker and consumes, then commits and prints locally. Status returns via a reply queue and reaches the tablet over WebSocket. When the internet is unavailable, the tablet is not used and staff fall back to the POS terminal.

**Both session goals met:**

- Options beyond the LAN-vs-cloud binary: eight transport and resilience concepts, two of them parked with reasons rather than forgotten.
- A defensible direction: the design holds because the tablet is additive rather than primary, which is precisely what keeps NFR-R1 alive.

**Honest note on process.** This was a convergent design session, not a divergent one — roughly a dozen ideas, not the hundred a full brainstorming run targets. The user redirected away from the planned technique sequence toward his own worked proposal, and the session was more useful for it. The facilitator's job became stress-testing and extending a real design rather than generating breadth.

**Facilitator correction recorded.** An earlier claim that cloud-connected tablets necessarily break NFR-R1 was wrong. It holds only when the tablet is the sole order path; the terminal-fallback design defeats it. Noted here so the reasoning is not re-litigated later from the wrong premise.

**Unplanned find.** The missing print queue was discovered by accident, from asking how KOT printing currently gets its orders. It is arguably the most valuable outcome of the session and has nothing to do with tablets.

---

## Recommended Next Steps

1. **Run `bmad-correct-course`** to fold the tablet transport decision into the PRD, architecture, and epics. Bundle with the Wi-Fi coverage NFR discussed before this session.
2. **Add the print queue to Epic 5** — likely a new story before or alongside Story 5.2, since 5.2's synchronous TCP call is what it replaces.
3. **Write the idempotency rule into the architecture** before any queue code is written.
4. **Decide where the broker runs** — self-hosted on the cloud VPS versus CloudAMQP — and what it costs per restaurant.
