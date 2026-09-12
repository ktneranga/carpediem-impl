---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-02b-vision', 'step-02c-executive-summary', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation', 'step-07-project-type', 'step-08-scoping', 'step-09-functional', 'step-10-nonfunctional', 'step-11-polish', 'step-12-complete']
workflowStatus: complete
completedAt: '2026-05-17'
releaseMode: phased
classification:
  projectType: saas_b2b
  domain: hospitality-restaurant
  complexity: medium
  projectContext: greenfield
inputDocuments:
  - _bmad-output/brainstorming/brainstorming-session-2026-05-03-now.md
  - _bmad-output/planning-artifacts/research/technical-tech-stack-restaurant-management-system-research-2026-05-16.md
  - _bmad-output/planning-artifacts/research/technical-targeted-restaurant-update-delivery-docker-watchtower-research-2026-05-17.md
workflowType: 'prd'
---

# Product Requirements Document - Carpe Diem Restaurant Management System

**Author:** Teran
**Date:** 2026-05-17

## Executive Summary

The Carpe Diem Restaurant Management System (CDRMS) replaces a fully manual operation at Carpe Diem Restaurant — a multi-zone beach venue with 4 seating areas, 15+ tables, a 100+ item menu, and 8 staff. The system eliminates the primary failure modes of manual operation: income invisibility, inventory stock-outs discovered mid-service, and the verbal-order theft loop (verbal order → kitchen fulfills without ticket → cash pocketed, no record).

The owner's current role is the entire operating system — audit trail, fraud detector, error handler, inventory watcher, and shift supervisor simultaneously. CDRMS transfers that cognitive load to software. Success is measured by one outcome: the owner stepping away from a peak service shift with confidence that the operation is running correctly and accountably.

**Primary users:**
- **Owner / manager** — real-time visibility into orders, revenue, inventory, and staff activity from any device, on or off premises
- **Waitstaff** — zone-aware order entry, order status visibility, and audit trail protection from bill disputes
- **Kitchen and bar staff** — digital ticket display (KDS/BOT) replacing verbal communication, closing the verbal-order loop at the production stage

### What Makes This Special

**Operational integrity through mandatory ticket issuance.** The verbal-order theft loop has three breaking points: order entry, kitchen/bar production, and payment recording. CDRMS closes all three simultaneously. Kitchen and bar only produce what has a digital ticket. This is a structural control gate — the path of least resistance is the honest path.

**Designed for the operational reality of beach restaurants.** Generic POS systems assume one kitchen, fixed-role staff, and individual table orders. CDRMS is built for a different reality: three order destinations (Kitchen, Pizza Kitchen, Bar), fluid staff roles where any team member can take or close an order, 4 distinct outdoor seating zones with zone-aware table management, and group dynamics where merged tables from different zones settle individually.

**Merged table + split settlement engine.** Groups that span zones, merge mid-service, and settle in separate ways are standard beach restaurant operations — not edge cases. CDRMS tracks item-level ownership from order entry through final settlement, enabling accurate individual bills without reconstructing the meal from memory at payment time.

**Dual-sided transparency.** The audit trail is not surveillance — it is the shared record that protects both owner and staff. When a customer disputes a bill, the waiter shows exactly what was ordered, when, by whom, and how it was assigned. Every dispute path is logged. Every comp generates a loss record. Accountability is structural, not personal — and staff who work with integrity have proof of it.

**Self-hosted SaaS for coastal environments.** CDRMS runs as a Docker container stack on-premises at each restaurant. Internet connectivity is not required for daily operations — all devices communicate over the local network. Vendor-controlled updates are delivered via Watchtower (image registry pull), preserving SaaS update economics without cloud data dependency. Purpose-built for environments where connectivity is unreliable.

## Project Classification

- **Project Type:** Self-hosted SaaS B2B — subscription model, on-premises deployment per tenant, vendor-controlled updates
- **Domain:** Hospitality — beach restaurant operations
- **Complexity:** Medium — real-time multi-destination order routing, multi-zone coordination, merged table settlement engine; no regulated compliance requirements
- **Project Context:** Greenfield — replacing a fully manual operation; fresh team, no legacy migration
- **Platform:** Next.js PWA (web, tablet, and KDS displays from a single codebase), PostgreSQL, Docker Compose, local-first deployment
- **Ticket output:** Configuration-driven per station — `print` (ESC/POS thermal printer) or `display` (KDS/BOT tablet). Carpe Diem v1 uses a single central printer for all ticket types (KOT, KOT-P, BOT, Bill). Per-station printers and KDS/BOT displays are implemented in the codebase but disabled in Carpe Diem's configuration.

## Success Criteria

### User Success

- **100% order capture from day one.** Every order placed at Carpe Diem goes through the system. No verbal-order bypass. No unrecorded kitchen or bar production. This is the foundational success condition — partial adoption is not a success state.
- **Owner morning dashboard.** The owner opens one screen and sees: yesterday's total revenue, any payment discrepancies, all comped or disputed items with reasons, and current inventory levels before service begins. No manual reconciliation required.
- **Zone-aware order entry under 20 seconds.** A waiter in any of the 4 zones (bean bags, sun beds, tables, rooftop) submits a complete order in 4 taps or fewer. Speed must match or beat the verbal-order habit from day one.
- **Kitchen and bar produce only ticketed items.** KOT and BOT displays show all pending tickets in real time. No ticket, no production. Staff on kitchen and bar side treat the display as the authoritative source.
- **Flexible bill settlement.** At close, the waiter generates either a single bill (one person pays for all) or a mid-settlement split: the waiter drags and drops already-entered items to assign them to individual persons, generating a separate bill for each. Each person settles independently by any payment method. Item ownership is whole-item only — no fractional splitting.
- **Staff protected from disputes.** When a customer disputes an item, the waiter pulls up the full audit trail on-screen: what was ordered, when, by whom, which person it was assigned to. The record speaks; the waiter facilitates.

### Business Success

- **System live on opening day.** The full core chain — order entry → KOT/BOT routing → bill generation → payment recording → owner dashboard — is operational before the first customer sits down.
- **Zero unrecorded cash transactions.** End-of-day cash reconciliation: the system produces an expected-cash figure. Any gap is visible and flagged. The owner does not need to reconstruct cash manually.
- **Owner confidence to step away.** Within 2 weeks of launch, the owner can leave the restaurant during a service shift and trust that the system is running correctly — without needing to call in or check manually beyond the dashboard.
- **SaaS growth (post-Carpe Diem).** First additional beach restaurant customer onboarded within 12 months of Carpe Diem launch.

### Technical Success

- **Local-first reliability.** System operates fully over the restaurant LAN. Internet outage has zero impact on order entry, KOT/BOT routing, bill generation, or payment recording.
- **Real-time ticket delivery.** KOT/BOT displays receive new tickets within 3 seconds of order submission.
- **Zero-downtime updates.** New software versions deploy per restaurant without interrupting active service (via `docker-rollout` + health check).
- **Data durability through updates.** PostgreSQL volume is never touched during app container updates. All historical orders, payments, and inventory records survive every deployment.
- **Peak load handling.** System handles 40+ concurrent orders per shift without UI degradation or ticket delay.

### Measurable Outcomes

| Metric | Target | When |
|---|---|---|
| Orders through system | 100% | Day 1 |
| Order entry time (any zone) | ≤ 20 seconds | Day 1 |
| KOT/BOT delivery latency | < 3 seconds | Day 1 |
| Cash reconciliation gap | Visible and flagged | Day 1 |
| Owner shift-away confidence | Achieved | Week 2 |
| Additional restaurant onboarded | 1 | Month 12 |

---

## Product Scope

### MVP — Minimum Viable Product

The core chain must work end-to-end before launch. Nothing is optional within this list.

1. **Zone-aware table management** — 4 zones (bean bags, sun beds, tables, rooftop), table status (open/occupied/unavailable), within-zone table merging, and staff-initiated out-of-service with owner-only restoration *(scope amended 2026-09-06; "closed" corrected to "unavailable", which is the actual `tableStatusEnum` value)*
2. **Order entry** — multi-round open tabs, multi-destination routing (Kitchen KOT, Pizza Kitchen KOT, Bar BOT), item modifiers, and **counter sales for walk-up customers who are not seated** *(scope amended 2026-09-10 — sprint-change-proposal-2026-09-10-counter-sale.md; a customer buying at the bar could not be recorded at all)*
3. **Ticket output** — ESC/POS thermal printer for KOT, KOT-P, BOT, and bills (Carpe Diem v1); KDS/BOT tablet display mode built-in but configuration-disabled
4. **Bill generation** — single-payer bill and mid-settlement drag-and-drop split (whole-item assignment to individual persons, separate bill per person, independent settlement by any payment method)
5. **Payment recording** — cash, card, or split (cash + card on one bill); any staff member can close a bill
6. **Owner dashboard** — revenue (today / yesterday), order activity, comps and disputes, inventory flags; single screen
7. **Basic inventory** — portion count per item, auto-marks unavailable at zero, manual reset at start of service
8. **Fluid staff authentication** — any staff member can log in and perform any function; actions attributed to the logged-in user
9. **Audit trail** — every order, modification, payment, comp, and dispute logged with timestamp and staff identity

### Growth Features (Post-MVP)

- Dispute resolution workflow — comp logging with reason codes, escalate-to-owner notification on mobile
- Merged table mid-service re-assignment — link two active tables retroactively, reassign items across merged order history
- Tip pooling — automatic collection per payment transaction, configurable end-of-shift distribution formula
- Employee performance tracking — covers per staff, upsell rate, order accuracy, tips generated
- Advanced inventory — par level alerts, forecasting by menu item, emergency restock workflow
- Multi-restaurant onboarding — SaaS management plane (license validation, update channels, opt-in telemetry)
- Reporting and analytics — beyond daily dashboard: weekly/monthly trends, top items, waste tracking

### Vision (Future)

- Self-hosted SaaS platform distributed globally to beach and resort restaurants
- Native mobile waiter app (React Native) for fully untethered order entry
- Second-location unified dashboard — one owner view across multiple restaurants
- AI-assisted inventory forecasting and shift scheduling
- Third-party integrations — payment terminals, supplier ordering, accounting export

## User Journeys

### Journey 1: Waiter — Peak Service Order Entry (Happy Path)

**Meet Nina.** She's 23, two seasons at a beach restaurant, fast with orders. Her current system is her memory and a shout down to the bar. She's not dishonest — she's optimized for speed. If the new system is slower than her habit, she will route around it without a second thought.

**Saturday, 8pm. Rooftop.** Six tables occupied, music loud, kitchen backed up. A group of four sits down. Nina takes the full order: two grilled fish, one pasta, three cocktails, a shisha. Complex order — multi-item, multi-destination.

Nina opens the app on the bar tablet. She taps **Rooftop** — her working zone. Only rooftop tables appear. She taps **Table 12**, searches "grilled" — right item in one tap. Items go in. Cocktails route to Bar automatically. She hits **Send Order**.

One big green confirmation: *"Order sent — Kitchen (2), Bar (3)."* Done. 18 seconds. She's back at the table before the group finishes settling in.

At the bar, the central printer fires three tickets in sequence: KOT for the kitchen, BOT for the bar. The bar staff picks up the kitchen ticket and walks it to the pass. No one shouted anything. The record exists.

**Capabilities revealed:** Zone-aware table selection, fast item search, automatic multi-destination routing, instant confirmation, ESC/POS ticket printing per order.

---

### Journey 2: Waiter — Upfront Separate Orders, Same Table

**Two friends sit at Table 8.** Before Nina takes a single item, she asks: *"Will you be ordering together or separately?"*

*"Separately."*

Nina taps **Table 8 → Add Seat**. Two order slots appear: **Seat 1** and **Seat 2**. She selects Seat 1 and takes Person 1's order: grilled chicken, one beer. Switches to Seat 2 — pasta, one cocktail.

She hits **Send**. One print run: kitchen ticket shows both food items (same table, same timing), bar ticket shows both drinks. Kitchen and bar see nothing unusual — same table, normal service.

**End of meal.** Person 1 asks for the bill. Nina taps **Table 8 → Seat 1 → Print Bill**. Grilled chicken, one beer. Person 1 pays and leaves. Person 2 orders a dessert — it goes under Seat 2. When ready: **Seat 2 → Print Bill**. Pasta, cocktail, dessert. Done.

No drag and drop. No reconstruction. Ownership was tracked from the first tap.

**Capabilities revealed:** Multi-seat order creation on a single table, seat-level order entry and isolation, unified kitchen/bar ticket routing regardless of seat structure, seat-level bill generation, ability for one seat to close while the other remains open.

---

### Journey 3: Waiter — Mid-Settlement Bill Split (Fallback Path)

**Same table, different setup.** One person gave Nina the whole order. Chicken burger, club sandwich, two beers, one mojito — entered as a single order, because that's what it was.

End of meal: *"Can we get separate bills? I had the burger and two beers."*

Nina taps **Table 8 → Settle → Split Bill**. All five items appear in one column. Two columns appear: **Person 1**, **Person 2**. She drags burger → Person 1. Two beers → Person 1. Sandwich → Person 2. Mojito → Person 2. Running totals update in real time.

She taps **Generate Bills**. Two bills print. Person 1 pays card. Person 2 pays cash. Table closes.

**Capabilities revealed:** Mid-settlement drag-and-drop item assignment, per-person bill generation, independent payment per person, mixed payment methods on the same table.

---

### Journey 4: Waiter — Dispute Resolution

**A customer at Table 5 insists she never ordered the prawn starter.** It's on the bill. She's unhappy. Nina is now standing at the table while a dispute unfolds.

Nina taps **Table 5 → Bill → Item History → Prawn Starter**. The screen shows: entered at 7:42pm by Nina — Round 2 — assigned to Seat 1. Timestamp, staff name, round number, seat.

She turns the screen toward the customer: *"Here's the full order history — it was added in the second round at 7:42."* The customer sees the record. Either she accepts it — dispute resolved, no cost absorbed — or Nina comps it with a required reason code. The comp logs automatically and feeds into the owner's end-of-day report as a loss line.

Nina didn't get blamed. The record spoke.

**Capabilities revealed:** Per-item audit trail (who, when, which round, which seat), on-screen dispute review, comp logging with reason code, loss reporting.

---

### Journey 5: Kitchen Staff — Printed Ticket Workflow (Carpe Diem v1)

**Meet Roshan.** Under the old system, KOTs were shouted through a window or scrawled on paper. He'd miss items when it was noisy. Under CDRMS, the central printer at the bar fires a ticket the moment an order is submitted.

7:45pm: A ticket comes off the bar printer. The bar staff picks it up and walks the kitchen copy to the pass. Roshan reads: Table 12 — Grilled Fish ×2, Pasta ×1. He starts cooking. No ambiguity about what was ordered or for which table.

When dishes are plated, the physical ticket moves to the "done" rail — same as before, just with a printed source instead of a verbal one.

**Note:** KDS tablet display mode is built into the system but disabled in Carpe Diem's configuration. Future SaaS customers can enable per-station tablet displays instead of or alongside printing.

**Capabilities revealed:** ESC/POS ticket printing triggered on order submission, ticket content includes table number, seat, items, and destination label (KOT / KOT-P / BOT), configuration flag to enable/disable display mode per station.

---

### Journey 6: Owner — Morning Dashboard and Remote Monitoring

**The owner is at home on Sunday morning.** He opens CDRMS on his phone.

One screen: last night's revenue LKR 248,500 — cash expected vs. recorded gap of LKR 700 flagged — 2 comps issued (prawn starter dispute, dessert service delay) — inventory flags: chicken at 3 portions, Tiger Beer at 4 bottles.

He calls the shift lead about the cash gap. He messages the kitchen about restocking. He never left home. He never reviewed a paper log.

That evening he's at a family dinner. He glances at the app: 12 open tables, 6 active orders, LKR 89,000 revenue to date. Everything looks normal. He puts his phone away.

**Capabilities revealed:** Owner dashboard (revenue, cash reconciliation gap, comp log, inventory flags), real-time order visibility, remote access over internet (owner's mobile connects to the system via Tailscale VPN or cloud relay).

---

### Journey Requirements Summary

| Journey | Capabilities Revealed |
|---|---|
| 1 — Waiter happy path | Zone selection, item search, multi-destination routing, ESC/POS printing |
| 2 — Upfront separate orders | Multi-seat table model, seat-level order entry, seat-level billing |
| 3 — Mid-settlement split | Drag-and-drop item assignment, per-person bill, mixed payment methods |
| 4 — Dispute resolution | Per-item audit trail, comp logging with reason code, loss reporting |
| 5 — Kitchen printed ticket | ESC/POS ticket output, configuration-driven print vs. display mode |
| 6 — Owner dashboard | Revenue summary, cash gap flag, comp log, inventory alerts, remote access |

## Domain-Specific Requirements

### Compliance and Regulatory

- **No PCI-DSS scope:** The application records payment outcomes only (amount, method, staff ID). Card processing is handled exclusively by an external physical terminal. No card data transits or is stored in the system.
- **No customer PII collected:** Orders are table-scoped and anonymous. No customer names, contact details, or accounts are created or stored.
- **Staff data:** Employee records (name, role, PIN/login) are minimal PII. Standard access controls and local storage apply. No third-party HR system integration required for v1.

### Technical Constraints

- **Audit trail immutability:** All order entries, modifications, payments, comps, and disputes are append-only records. No record may be edited or deleted after creation. Corrections are new records (e.g. a comp creates a new loss record, not an edit to the original).
- **Local-first data residency:** All transaction data resides on the restaurant's local PostgreSQL instance. No operational data is transmitted to external services without explicit owner opt-in.
- **Concurrent access:** Multiple staff members may be active on different devices simultaneously. Order state must be consistent across all devices in real time — no race conditions on table status or item availability.

### Risk Mitigations

| Risk | Mitigation |
|---|---|
| Staff bypassing system under pressure | System must be faster than verbal habit from day one — rooftop zone is the design benchmark |
| Cash gap undetected | End-of-day reconciliation produces expected vs. actual cash figure; gaps flagged on owner dashboard |
| Audit trail disputed | Records are append-only and timestamped; no staff member can alter a submitted order |
| Local server hardware failure | UPS protects against power blips; `restart: unless-stopped` Docker policy auto-recovers from crashes; daily automated backup; vendor remote access via Tailscale for diagnosis and remediation; plain-language physical recovery card for staff |
| Unauthorized remote access | Owner remote access via Tailscale VPN only; no public-facing ports opened |

## Innovation & Novel Patterns

### Innovation Areas

**1. Financial Control Gate — Reframing the POS**

CDRMS challenges the assumption that a restaurant management system is a convenience tool. The core design principle — *the path of least resistance must be the honest path* — embeds financial control into the workflow architecture. KOT/BOT ticket generation is not optional or supplementary; it is the only production authorization mechanism. This is a structural innovation in how restaurant software approaches operational integrity, not just a feature addition.

**2. Self-Hosted SaaS for Connectivity-Constrained Environments**

The combination of subscription SaaS economics with local-first on-premises deployment (Docker + Watchtower vendor-controlled updates) produces a deployment model that cloud-native competitors cannot serve. Internet connectivity is zero-dependency for daily operations. Purpose-built for coastal, resort, and outdoor hospitality environments where cloud-first software consistently fails.

**3. Dual-Path Settlement Engine for Fluid Group Dynamics**

The upfront seat model (declare separate at order entry) and the mid-settlement drag-and-drop split (declare separate at payment) are two first-class paths that serve the same real-world scenario — groups whose billing structure is unknown at the start of service. Most restaurant software supports one or neither. Designing both as intentional primary paths reflects genuine vertical-specific domain knowledge.

### Market Context

Generic POS competitors (Square, Toast, Lightspeed) are designed for fixed-role, single-kitchen, indoor restaurant environments. Their split-bill implementations, where they exist, are settlement workarounds rather than first-class order models. The beach/resort hospitality vertical is structurally underserved — the operational signature (fluid roles, merged outdoor zones, cash-heavy, high fraud exposure) is ignored by general-purpose systems.

### Validation Approach

- **Control gate:** Measure percentage of orders routed verbally vs. through the system after week 1. Target: 0% verbal bypass.
- **Settlement engine:** Track frequency of mid-settlement splits vs. upfront seat creation. High mid-settlement use = training gap; high upfront seat use = system working as designed.
- **Offline resilience:** Simulate internet outage during service — all core functions must remain fully operational at the POS terminal; tablets must show the unavailable state and hold nothing.
- **Device network loss:** Carry a tablet out of network range mid-order — the offline state must appear, no partial order may be written, and recovery on reconnect must be clean.
- **Printer outage:** Disconnect the printer during service — tickets must queue durably and flush automatically on reconnection with no manual reprint.

### Risk Mitigation

| Innovation Risk | Mitigation |
|---|---|
| Staff circumventing the control gate | UX designed faster than verbal habit; kitchen/bar trained to refuse unticketted orders |
| Self-hosted deployment friction for SaaS customers | Documented single-command Docker setup; Watchtower handles all subsequent updates |
| Settlement engine confusion under pressure | Rooftop zone as UX design benchmark; 4-tap maximum for any settlement path |

## SaaS B2B Specific Requirements

### Tenant Model

Each restaurant is an **isolated single-tenant deployment** — one Docker Compose stack (Next.js app container + PostgreSQL container) per restaurant. No shared database, no cross-tenant data access. Tenant isolation is physical (separate volumes, separate containers), not logical.

**Tenant lifecycle:**
- Provisioning: developer runs setup script, configures `docker-compose.yml` with restaurant-specific env vars (restaurant name, zone names, printer IP, feature flags)
- Updates: Watchtower pulls new app images from GHCR; database migrations run automatically on container startup
- Backup: daily `pg_dump` to local storage; optional cloud backup via owner opt-in
- Network: wireless coverage validated across all seating zones before go-live; outdoor-rated access points where zone geometry requires them

**Feature flags per tenant (stored in PostgreSQL config table):**

| Flag | Carpe Diem v1 | Default (SaaS) |
|---|---|---|
| `ticket_output_mode` | `print` | `print` |
| `kds_display_enabled` | `false` | `false` |
| `per_station_printers` | `false` | `false` |
| `bot_display_enabled` | `false` | `false` |
| `auth_mode` | `session_short` | `session_short` |
| `session_timeout_minutes` | `5` | `5` |
| `financial_action_reauth` | `true` | `true` |
| `tablet_ordering_enabled` | `true` | `false` |
| `cloud_relay_enabled` | `true` | `false` |

**Auth mode values:**

| Mode | Behaviour | Best For |
|---|---|---|
| `session_persistent` | PIN creates a session with configurable timeout (15–60 min); no reauth between actions | Dedicated terminals, fine dining, low staff fluidity |
| `session_short` | PIN creates a short session (default 5 min idle); financial actions always require fresh PIN if `financial_action_reauth` is true | Casual/beach restaurants, shared terminals, fluid staff |
| `per_transaction` | PIN required at the start of each new order or transaction; no persistent session | QSR, high-volume, maximum speed environments |
| `per_action` | PIN required for every write action | Maximum accountability, high-fraud-risk environments |

### RBAC Matrix

Staff authenticate via a **4 digit PIN code** on the shared device. Each action is recorded with the authenticated staff member's identity. PIN is set by the owner during staff setup.

| Capability | Owner | Manager | Staff | Kitchen/Bar |
|---|---|---|---|---|
| Order entry (any table/zone) | ✓ | ✓ | ✓ | — |
| Bill generation and printing | ✓ | ✓ | ✓ | — |
| Payment recording (cash/card/split) | ✓ | ✓ | ✓ | — |
| Mid-settlement bill split | ✓ | ✓ | ✓ | — |
| Comp an item (with reason code) | ✓ | ✓ | — | — |
| View own order audit trail | ✓ | ✓ | ✓ | — |
| View all-staff audit trail | ✓ | ✓ | — | — |
| Menu availability toggle (86 item) | ✓ | ✓ | — | — |
| Full menu management (add/edit/remove) | ✓ | — | — | — |
| Staff management (add/edit/set PIN) | ✓ | — | — | — |
| Owner dashboard (full) | ✓ | — | — | — |
| Shift summary (revenue, comps, gaps) | ✓ | ✓ | — | — |
| Inventory management | ✓ | ✓ | — | — |
| System configuration | ✓ | — | — | — |
| KDS/BOT ticket view | ✓ | ✓ | — | ✓ |
| KDS/BOT ticket status update | ✓ | ✓ | — | ✓ |

**Role definitions:**
- **Owner** — full system access; sets up staff, zones, menu, and configuration
- **Manager** — shift-level authority; can comp items, toggle menu availability, view shift summary; cannot manage staff or change system config
- **Staff** — operational access; order entry, billing, payment recording
- **Kitchen/Bar** — display-only when KDS/BOT enabled; no order entry or billing access

### Integration List

| Integration | Type | MVP | Notes |
|---|---|---|---|
| ESC/POS thermal printer | Local USB or TCP/IP | Yes | KOT, KOT-P, BOT, bills; single central printer for Carpe Diem |
| Tailscale VPN | Network | Yes | Owner remote dashboard access; no public port exposure |
| GHCR (GitHub Container Registry) | Cloud | Yes | Watchtower pulls app updates; server authenticates with PAT |
| Message broker (RabbitMQ) | Cloud | Yes | Per-restaurant queue; local POS connects outbound, no inbound ports opened |
| Cloud relay API | Cloud | Yes | Tablet order capture and status; holds order requests only, never commits |
| Card payment terminal | Physical hardware | No integration | External device; system records payment outcome only |

### Implementation Considerations

- **PIN session management:** Authentication behaviour is driven by the tenant's `auth_mode` configuration flag. In `session_short` mode (Carpe Diem default): PIN entry creates a session that expires after `session_timeout_minutes` of idle time (default: 5 min). When `financial_action_reauth` is true, bill generation and payment recording always require fresh PIN entry by the acting person — regardless of active session state. This ensures accurate audit attribution on the two actions that matter most financially. In `session_persistent` mode, sessions last up to the configured timeout with no mid-session reauth. In `per_transaction` mode, PIN is required at the start of each new order. In `per_action` mode, PIN is required for every write action.
- **Action-level audit attribution:** Each action (order opened, items added, bill generated, payment recorded) stores its own `staff_id` independently — attributed to whoever authenticated for that specific action, not inherited from a prior session. This ensures accurate attribution even when multiple staff interact with the same order across its lifecycle.
- **No "Switch User" button required:** Under `session_short` and `per_transaction` modes, sessions expire naturally and quickly. The next person simply authenticates for their action — no explicit user-switching UI needed.
- **Concurrent device access:** Multiple devices (tablets, bar terminal) can be active simultaneously under different staff PINs. Order state synchronised via WebSocket subscriptions over LAN.
- **Offline PIN auth:** PIN validation runs against local PostgreSQL — no internet required for authentication.
- **Audit immutability:** All role-based actions (especially comps) are written as append-only records with timestamp, staff ID, and role at time of action.

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** Problem-solving MVP — the full core chain (order entry → ticket generation → bill settlement → payment recording → owner dashboard) must be operational end-to-end before the first customer sits down. The control gate only functions when complete; partial adoption is explicitly not a success state.

**Resource Requirements:** 1–2 full-stack TypeScript/Next.js developers, 1 part-time DevOps for Docker and network setup, access to target thermal printer hardware throughout development for integration testing.

### MVP Feature Set (Phase 1)

**Core User Journeys Supported:**
All 6 journeys are fully supported in MVP — waiter happy path order entry, upfront separate orders (seat model), mid-settlement bill split, dispute resolution (on-screen audit trail + comp logging), kitchen printed ticket workflow, and owner morning dashboard with remote monitoring.

**Must-Have Capabilities:**
All 9 capabilities defined in the Product Scope MVP section are load-bearing — none are optional or deferrable. Removing any single item breaks the operational control gate. Validation: each capability was tested against "without this, does the system fail its core purpose?" — all returned yes.

### Post-MVP Roadmap

Post-launch development follows the Growth and Vision feature sets defined in the Product Scope section. Phase 2 (Growth) addresses dispute escalation, merged-table re-assignment, tip pooling, advanced inventory, and the SaaS management plane. Phase 3 (Vision) delivers the multi-restaurant platform, native mobile app, and third-party integrations.

### Risk Mitigation Strategy

**Technical Risks:**
Real-time WebSocket sync validated with 5+ concurrent devices before launch (Supabase Realtime handles this at proven scale). ESC/POS printer integration tested on target hardware throughout development — USB is the fallback if TCP/IP network config is complex on-site. Mid-settlement drag-and-drop is prototyped early against the 20-second / 4-tap rooftop benchmark; not shipped if this bar isn't met.

**Market Risks:**
Order entry speed (≤20 seconds) is a go / no-go launch condition. No partial-mode launch that permits verbal orders alongside the system — the control gate must be the only path from day one. Staff training on the rooftop zone (highest-pressure scenario) before launch day.

**Resource Risks:**
Printer integration and mid-settlement drag-and-drop are the two highest-effort MVP items — developed in parallel with core order flow, not sequentially. Docker setup documented as a single command; tested on target restaurant hardware before delivery. If team size is reduced, the USB-only printer configuration reduces on-premises network setup complexity.

## Functional Requirements

### Zone & Table Management

- **FR1:** Staff can browse and select tables filtered by zone (bean bags, sun beds, tables, rooftop)
- **FR2:** Staff can view the current status of each table (open / occupied / closed)
- **FR3:** Staff can open a new order session on any available table
- **FR4:** System enforces a single active order session per table at a time
- **FR5:** Staff can view all currently occupied tables and their active order summaries

### Order Entry & Routing

- **FR6:** Staff can add menu items to an active order session across multiple ordering rounds (open tab model)
- **FR7:** Staff can search or browse the menu by item name or category
- **FR8:** Staff can add modifiers or special instructions to individual order items
- **FR9:** System automatically routes each order item to the correct production destination (Kitchen, Pizza Kitchen, or Bar) based on item configuration
- **FR10:** Staff can create multiple seat slots on a single table to track separate orders from the same table upfront
- **FR11:** Staff can assign order items to a specific seat slot at the time of order entry
- **FR12:** Staff can submit an order, simultaneously routing items to all applicable destinations in one action
- **FR13:** System prevents ordering of items currently marked as unavailable

### Ticket Output (Print & Display)

- **FR14:** System generates a KOT (Kitchen Order Ticket) for kitchen-destined items on order submission
- **FR15:** System generates a KOT-P (Pizza Kitchen Order Ticket) for pizza kitchen-destined items on order submission
- **FR16:** System generates a BOT (Bar Order Ticket) for bar-destined items on order submission
- **FR17:** System prints generated tickets to a configured ESC/POS thermal printer
- **FR18:** Each printed ticket includes **every table identifier in the session** (e.g. `BB1 + BB3` for a merged group) — **or the label `COUNTER` where the session has no table** — seat identifiers, item names, quantities, and the ticket type label (KOT / KOT-P / BOT) *(amended 2026-09-06 for FR62 — a merged party's ticket naming one table leaves the runner with two possible destinations; amended 2026-09-10 for FR64 — a blank destination line on a counter ticket sends the runner nowhere)*
- **FR19:** System displays tickets on a KDS/BOT screen when display mode is enabled per station (configuration-driven)
- **FR20:** Kitchen/Bar staff can mark a displayed ticket as in-progress or completed (when KDS mode is enabled)

### Bill Generation & Settlement

- **FR21:** Staff can generate a single consolidated bill for all items in a table session
- **FR22:** Staff can initiate a mid-settlement split by assigning whole order items to individual persons
- **FR23:** System displays running per-person totals as items are assigned during a mid-settlement split
- **FR24:** System generates a separate bill for each person in a mid-settlement split
- **FR25:** Staff can generate a bill for a specific seat slot independently of other seat slots at the same table
- **FR26:** Individual seat slots can be closed and settled independently while other seats at the same table remain open
- **FR27:** Each generated bill includes itemized order contents, per-item price, any applied comps, and a subtotal

### Payment Recording

- **FR28:** Staff can record a cash payment against any open bill
- **FR29:** Staff can record a card payment against any open bill
- **FR30:** Staff can record a split payment (partial cash + partial card) on a single bill
- **FR31:** Any authenticated staff member with the Staff role or above can record payment for any open bill
- **FR32:** System closes a table session automatically when all associated open bills are settled

### Inventory Management

- **FR33:** Owner and Manager can set and update portion counts for any menu item
- **FR34:** System decrements a menu item's portion count each time the item is ordered
- **FR35:** System automatically marks a menu item as unavailable when its portion count reaches zero
- **FR36:** Owner and Manager can manually toggle a menu item's availability at any time (86 an item)
- **FR37:** Owner and Manager can manually reset or adjust portion counts (e.g., at the start of service)

### Staff Authentication & Access Control

- **FR38:** Staff can authenticate on any device using a personal 4 digit PIN. *(AMENDED 2026-09-06: was 4–6 digits. Reduced to a single fixed length because staff recall these from memory mid-service, and a longer PIN buys accountability that a forgotten one immediately loses. A fixed length is also what allows the pad to sign in automatically on the last digit, removing the confirm tap from the action every shift begins with.)*
- **FR39:** Owner can create, edit, and deactivate staff accounts, assigning each a role and PIN
- **FR40:** System enforces role-based access — each capability is available only to roles that hold the relevant permission
- **FR41:** Session duration and expiry behaviour is controlled by the tenant's `auth_mode` and `session_timeout_minutes` configuration flags
- **FR42:** When `financial_action_reauth` is enabled, bill generation and payment recording always prompt the acting staff member to enter their PIN before proceeding — regardless of any active session
- **FR43:** Every action (order opened, items added, bill generated, payment recorded) stores its own `staff_id` attributed to whoever authenticated for that specific action — not inherited from a prior session
- **FR44a:** Owner can configure the tenant's authentication mode (`auth_mode`), session timeout (`session_timeout_minutes`), and financial reauth requirement (`financial_action_reauth`) from system settings
- **FR44b:** The default authentication configuration for all new SaaS tenants is `auth_mode: session_short`, `session_timeout_minutes: 5`, `financial_action_reauth: true`

### Audit Trail & Dispute Resolution

- **FR44:** System records every order entry, item addition, modification, comp, and payment as an immutable append-only log with timestamp and authenticated staff identity
- **FR45:** Staff can view the complete item-level history for any order (who entered it, which round, which seat, when)
- **FR46:** Manager and Owner can view the full audit trail across all staff activity for any period
- **FR47:** Manager and Owner can comp an item with a mandatory reason code; the comp is recorded as a loss entry in the audit trail
- **FR47a:** Staff can reassign a mis-assigned item from one person to another within the same bill split as a correction, without generating a comp record
- **FR48:** Comping an item does not alter or delete the original order record — the comp is a new append-only record

### Owner Dashboard & Reporting

- **FR49:** Owner can view a dashboard summary of today's revenue updating in real time as payments are recorded during service, and yesterday's total revenue for comparison
- **FR50:** Owner can view a cash reconciliation summary — expected cash total versus recorded cash payments, with any gap explicitly flagged
- **FR51:** Owner can view all comps and disputes logged in a given shift, with reason codes, amounts, and staff identifiers
- **FR52:** Owner can view inventory alert flags for items at zero or critically low portions
- **FR53:** Owner can access the dashboard remotely from any network-connected device
- **FR54:** Manager can view a shift-level summary of revenue, comps, and payment gaps
- **FR60:** Owner and Manager can view tables with orders open beyond a configurable time threshold, flagged on the dashboard as long-open alerts
- **FR61:** Staff can close an open table session without payment, recording a reason (`abandoned` — opened in error or the party left before ordering; `walkout` — the party left without paying). The table returns to `open` immediately on all devices. Closing without payment is recorded in the append-only audit trail with the acting staff member, and appears on the owner dashboard distinctly from settled sessions. *(Added 2026-09-06 — sprint-change-proposal-2026-09-06.md. Before this, a table could be occupied but never released: the only close in the plan was a side effect of full payment, so a mis-tap, a party leaving before ordering, or a walkout left the table permanently occupied.)*
- **FR62:** Staff can merge two or more tables **within the same zone** into a single order, either before taking the order or mid-service. A merged group behaves as one session for ordering, ticketing and billing, while every table in the group displays as occupied and shows the group it belongs to. Staff can un-merge a table from a group while the session is open. Merging across zones is out of scope for v1. *(Added 2026-09-06 — sprint-change-proposal-2026-09-06-merge-and-availability.md. The positioning at prd.md:38-40 promised merged tables as a core differentiator, but no FR, no story and no schema support existed: `order_sessions.table_id` was single-valued.)*
- **FR63:** Any staff member can take a table **out of service** with a reason. **Only an owner can return a table to service.** Both actions are recorded in the append-only audit trail with the acting staff member, the reason, and a timestamp. *(Added 2026-09-06. Asymmetric by design: taking a table out fails safe, returning it to service is the risky direction.)*
- **FR64:** Staff can start an order that is **not attached to any table** — a counter sale — for walk-up customers who are not seated. A counter order behaves as an ordinary session for item entry, ticketing, billing, payment and audit; it differs only in having no table, appearing on no floor-plan card, and being labelled `COUNTER` on tickets and bills. Tables can be attached to a counter order later if the customer is subsequently seated, and a counter order may be settled before its items are produced. *(Added 2026-09-10 — sprint-change-proposal-2026-09-10-counter-sale.md. A customer buying a beer at the bar could not be recorded at all: `order_sessions.table_id` was `notNull` and every route, including the order screen itself, was addressed by table rather than by session.)*

### System Configuration & Tenant Management

- **FR55:** Owner can configure zone names and table layout for the restaurant
- **FR56:** Owner can manage the full menu — add, edit, remove items, set production destinations and prices
- **FR57:** Owner can configure per-station ticket output mode (print or KDS display)
- **FR58:** Owner can manage staff accounts — create, assign roles, set PINs, deactivate
- **FR59:** System reads tenant-specific feature flags from configuration and enables or disables capabilities accordingly (e.g., KDS display mode, per-station printers)

## Non-Functional Requirements

### Performance

- **NFR-P1:** Order submission at a POS terminal completes and all tickets are printed or displayed within 3 seconds under normal LAN conditions
- **NFR-P1a:** Order submission from a tablet over the cloud relay completes within 30 seconds under normal connectivity. The submitting device shows an explicit intermediate state until the local POS confirms commit and print
- **NFR-P2:** Table and menu browsing screens load within 1 second on the restaurant LAN
- **NFR-P3:** Bill generation — including mid-settlement drag-and-drop split with per-person total calculation — completes within 2 seconds
- **NFR-P4:** System sustains full performance with 10+ staff sessions simultaneously active across different devices
- **NFR-P5:** System handles 40+ concurrent active orders per shift without UI degradation or ticket delivery delay
- **NFR-P6:** Adding modifiers or special instructions to any order item completes in 2 taps or fewer from the item entry screen

### Security

- **NFR-S1:** Staff PIN credentials are stored as hashed values — plaintext PINs are never persisted, logged, or transmitted
- **NFR-S2:** No action can be performed without a valid authenticated PIN session; every device interaction is gated by authentication
- **NFR-S3:** Audit trail records are immutable at the database level — no role, including Owner, can modify or delete a submitted record
- **NFR-S4:** All application data resides on the local PostgreSQL instance. No operational data is transmitted to external services without explicit Owner opt-in. Cloud relay order transport is such an opt-in, governed by the `cloud_relay_enabled` tenant flag; when disabled, no order data leaves the premises. Relayed order requests are transient, encrypted in transit, and deleted from the cloud once the local POS acknowledges commit
- **NFR-S5:** Owner remote access is restricted to Tailscale VPN; no public-facing ports are exposed on the restaurant network
- **NFR-S6:** Staff sessions expire after a configurable idle timeout (default: 30 minutes); expired sessions require PIN re-entry before any action is permitted

### Reliability

- **NFR-R1:** System operates fully over the restaurant LAN without internet connectivity — an internet outage has zero impact on order entry, ticket printing, bill generation, or payment recording **when performed at a POS terminal. Tablet-based order entry is an optional accelerator layer and is explicitly exempt from this guarantee; see NFR-R5**
- **NFR-R2:** System achieves 99.5%+ uptime during service hours under normal local server operation (excluding planned maintenance windows)
- **NFR-R3:** PostgreSQL data volume is fully preserved through application container restarts, software updates, and hardware reboots
- **NFR-R4:** A daily automated backup of the PostgreSQL database is written to local storage; the recovery procedure is documented in plain language for a non-technical operator
- **NFR-R5:** Tablet-based order entry requires internet connectivity. When unavailable, tablets display an unmistakable unavailable state and staff enter orders at the POS terminal. No order is ever composed, queued, or held on a tablet while disconnected
- **NFR-R6:** Local network coverage is continuous across all seating zones for any device participating in POS operation. A site survey validating signal strength at the furthest table of each zone is a go-live prerequisite
- **NFR-R7:** An order submitted from a tablet is delivered to the local POS exactly once. Duplicate delivery from the transport layer does not produce a duplicate order or a duplicate ticket

### Data Integrity

- **NFR-D1:** All order, payment, comp, and dispute records are append-only — no record is edited or deleted after creation by any means
- **NFR-D2:** Database schema migrations are applied automatically on container startup without data loss and without operator action
- **NFR-D3:** Concurrent writes from multiple devices (order submissions, inventory decrements, table status changes) are handled atomically — no race conditions produce inconsistent state
- **NFR-D4:** Inventory portion counts are decremented atomically; concurrent orders for the same item cannot result in a count below zero without triggering the unavailable flag

### Integration

- **NFR-I1:** ESC/POS printer integration supports both USB and TCP/IP network connection modes; the active mode is configurable per deployment
- **NFR-I2:** Printer timeout or connection failure produces an immediate visible system alert — a failed ticket print is never silently dropped
- **NFR-I3:** Software updates are delivered via Watchtower image polling from GHCR and applied without interrupting active service (zero-downtime via docker-rollout + health check gate)
- **NFR-I4:** Tailscale VPN integration allows Owner dashboard access from any internet-connected device without requiring firewall rule changes or public port exposure at the restaurant

### Scalability

- **NFR-SC1:** Each restaurant deployment is an isolated Docker Compose stack — provisioning a new restaurant tenant requires no changes to existing deployments
- **NFR-SC2:** Single restaurant deployment is sized to handle 8+ concurrent staff sessions and 40+ active orders per shift as baseline; the application container can be vertically scaled on the local server if a restaurant grows beyond this baseline

---

## Vendor Operations & Remote Support

### Overview

Each CDRMS deployment is self-hosted at the restaurant with no technical staff on-site. The vendor (system developer) must be able to diagnose and resolve issues remotely — without visiting the physical location and without requiring any technical action from restaurant staff. This is a first-class product capability, not an afterthought: it is the operational model that makes self-hosted SaaS viable at scale.

When a restaurant owner calls to report an issue, the vendor opens a vendor support panel, reads the live diagnostic state of the installation, identifies the root cause, and either resolves it remotely or gives the owner a single plain-language action to take (e.g., "press the power button on the printer"). No Docker knowledge, no terminal access, and no technical skill is required from restaurant staff at any point.

### Remote Access Foundation

All vendor remote access operates exclusively over **Tailscale VPN**. Each restaurant server runs a Tailscale node. The vendor's devices run Tailscale nodes. The vendor accesses the restaurant's system through this private encrypted mesh — no public IP, no open firewall ports, no cloud relay required for data. Tailscale is already listed as an MVP integration (see Integration List).

### Vendor Health Dashboard

A vendor-only diagnostic interface, accessible via Tailscale at a protected route (`/vendor/health`), authenticated by a separate vendor credential not used by restaurant staff. The dashboard is invisible to all restaurant roles.

**Live diagnostic checks the dashboard runs:**

| Check | What it tests | Possible states |
|---|---|---|
| Internet connectivity | Ping to external IP from the server | Connected / Unreachable |
| Tailscale status | Tailscale node active and peered | Connected / Degraded |
| Application health | HTTP response from the Next.js health endpoint | Healthy / Degraded / Down |
| Database connection | PostgreSQL query response | Connected / Unreachable |
| Printer reachability | TCP connection to configured printer IP:9100 | Reachable / Timeout / Unreachable |
| Disk space | Host filesystem available space | OK / Warning (<20% free) / Critical (<5% free) |
| Memory usage | Host RAM utilisation | OK / Warning (>80%) / Critical (>95%) |
| Container uptime | Time since last container restart | Running since [timestamp] |

**Information surfaced:**

- Last 50 application error log entries
- Recent printer connection failure events with order references
- Application version currently running
- Time of last successful database backup

### Remote Actions

From the vendor support panel, the vendor can trigger the following actions without SSH or terminal access:

| Action | Mechanism | When used |
|---|---|---|
| Restart application container | Portainer API call | App frozen or in error state |
| Restart all services | Portainer API call | Multiple services degraded |
| Send printer reset command | TCP command to printer IP | Printer stuck mid-job |
| Trigger immediate database backup | pg_dump via API → file download | Before any risky remote action |
| Force Watchtower update check | Watchtower API trigger | Deploy a hotfix immediately |
| View live application logs | Portainer log stream | Real-time error diagnosis |

**Portainer** (open-source Docker management UI) runs as an additional service in the Docker Compose stack, accessible only over the Tailscale network. It provides the container management API that powers the restart and log-viewing actions above. Restaurant staff are never exposed to Portainer.

### Proactive Alerting

**Uptime Kuma** (open-source uptime monitoring) runs as an additional service in the Docker Compose stack. It polls the vendor health endpoint every 60 seconds and pushes a notification to the vendor (via Telegram or email) the moment any check transitions to a failed state.

The vendor is notified of a problem **before the restaurant owner calls**. This inverts the support dynamic: the vendor can often resolve issues proactively, before service is impacted.

**Alert channels:** Telegram (primary), email (fallback). Configured per vendor, not per restaurant.

### Automated Backup

A daily automated `pg_dump` runs at 03:00 local time on each restaurant server, writing a compressed backup file to local storage on the host machine. Backup files are retained for 30 days by default.

The vendor can also trigger an on-demand backup from the vendor support panel at any time — the backup is returned as a file download over the Tailscale connection. This is always the first action taken before any remote remediation.

Optional owner-configured cloud backup (encrypted upload to an owner-specified destination) is a post-MVP feature.

### Physical Recovery Procedure for Staff

For the subset of failure scenarios that cannot be resolved remotely (complete host machine power-off, hardware failure), a laminated instruction card is posted physically near the server hardware:

```
SYSTEM NOT WORKING?

1. Check the black box [photo]
   Power light on? → go to step 2
   Power light off? → press the power button, wait 2 minutes

2. Open the browser on any tablet
   Go to: [bookmark labelled "Carpe Diem POS"]
   Working? → done

3. Still not working?
   Call [Vendor name]: [phone number]
```

This is the complete staff recovery procedure. No Docker, no terminal, no technical knowledge required.

### Multi-Restaurant Vendor View (Post-MVP)

When additional restaurant tenants are onboarded, the vendor dashboard aggregates status across all installations:

```
VENDOR DASHBOARD — All Restaurants

  Carpe Diem, Negombo      ✅ All systems operational
  Beach Shack, Galle        ⚠️ Printer offline (since 19:41)
  Sunset Bar, Mirissa       ✅ All systems operational
```

Each row links to that restaurant's full health dashboard and remote action panel. This is the operational model for managing a fleet of self-hosted tenants without on-site visits.

### Functional Requirements — Vendor Operations

- **FR-V1:** A vendor-only health dashboard is accessible at a protected route, authenticated by vendor credentials, invisible to all restaurant roles
- **FR-V2:** The health dashboard displays live status for internet connectivity, application health, database connection, printer reachability, disk space, and memory usage
- **FR-V3:** The vendor can trigger a restart of the application container or all services remotely without SSH access
- **FR-V4:** The vendor can trigger an on-demand database backup and download the backup file over the Tailscale connection
- **FR-V5:** The vendor can view a live stream of application error logs from the remote support panel
- **FR-V6:** Uptime Kuma monitors the health endpoint and pushes a proactive alert to the vendor when any check fails
- **FR-V7:** A daily automated database backup runs at 03:00 local time and is retained for 30 days on local storage

### Non-Functional Requirements — Vendor Operations

- **NFR-V1:** All vendor remote access operates exclusively over Tailscale VPN — no vendor tooling exposes any port to the public internet
- **NFR-V2:** Vendor credentials and access routes are completely isolated from restaurant staff credentials; no restaurant role can access vendor tooling
- **NFR-V3:** Remote actions (container restart, backup trigger) complete within 30 seconds of vendor initiation under normal Tailscale connectivity
- **NFR-V4:** Vendor access to restaurant systems does not transmit operational order, payment, or staff data to any external service — diagnostic data (health status, logs) remains within the Tailscale private network
- **NFR-V5:** Uptime Kuma alert delivery latency is under 2 minutes from failure detection to vendor notification
