---
stepsCompleted: [1, 2, 3]
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
---

# Carpe Diem Restaurant Management System - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for the Carpe Diem Restaurant Management System (CDRMS), decomposing requirements from the PRD, UX Design Specification, and Architecture into implementable stories.

---

## Requirements Inventory

### Functional Requirements

**Zone & Table Management**
- FR1: Staff can browse and select tables filtered by zone (bean bags, sun beds, tables, rooftop)
- FR2: Staff can view the current status of each table (open / occupied / closed)
- FR3: Staff can open a new order session on any available table
- FR4: System enforces a single active order session per table at a time
- FR5: Staff can view all currently occupied tables and their active order summaries

**Order Entry & Routing**
- FR6: Staff can add menu items to an active order session across multiple ordering rounds (open tab model)
- FR7: Staff can search or browse the menu by item name or category
- FR8: Staff can add modifiers or special instructions to individual order items
- FR9: System automatically routes each order item to the correct production destination (Kitchen, Pizza Kitchen, or Bar) based on item configuration
- FR10: Staff can create multiple seat slots on a single table to track separate orders upfront
- FR11: Staff can assign order items to a specific seat slot at time of order entry
- FR12: Staff can submit an order, simultaneously routing items to all applicable destinations in one action
- FR13: System prevents ordering of items currently marked as unavailable

**Ticket Output (Print & Display)**
- FR14: System generates a KOT (Kitchen Order Ticket) for kitchen-destined items on order submission
- FR15: System generates a KOT-P (Pizza Kitchen Order Ticket) for pizza kitchen-destined items on order submission
- FR16: System generates a BOT (Bar Order Ticket) for bar-destined items on order submission
- FR17: System prints generated tickets to a configured ESC/POS thermal printer
- FR18: Each printed ticket includes **every table identifier in the session** (e.g. `BB1 + BB3`), seat identifiers, item names, quantities, and ticket type label (KOT / KOT-P / BOT) *(amended 2026-09-06 for FR62 merged tables)*
- FR19: System displays tickets on a KDS/BOT screen when display mode is enabled per station (configuration-driven)
- FR20: Kitchen/Bar staff can mark a displayed ticket as in-progress or completed (when KDS mode is enabled)

**Bill Generation & Settlement**
- FR21: Staff can generate a single consolidated bill for all items in a table session
- FR22: Staff can initiate a mid-settlement split by assigning whole order items to individual persons
- FR23: System displays running per-person totals as items are assigned during a mid-settlement split
- FR24: System generates a separate bill for each person in a mid-settlement split
- FR25: Staff can generate a bill for a specific seat slot independently of other seat slots at the same table
- FR26: Individual seat slots can be closed and settled independently while other seats remain open
- FR27: Each generated bill includes itemized order contents, per-item price, any applied comps, and a subtotal

**Payment Recording**
- FR28: Staff can record a cash payment against any open bill
- FR29: Staff can record a card payment against any open bill
- FR30: Staff can record a split payment (partial cash + partial card) on a single bill
- FR31: Any authenticated staff member with the Staff role or above can record payment for any open bill
- FR32: System closes a table session automatically when all associated open bills are settled

**Inventory Management**
- FR33: Owner and Manager can set and update portion counts for any menu item
- FR34: System decrements a menu item's portion count each time the item is ordered
- FR35: System automatically marks a menu item as unavailable when its portion count reaches zero
- FR36: Owner and Manager can manually toggle a menu item's availability at any time (86 an item)
- FR37: Owner and Manager can manually reset or adjust portion counts (e.g., at start of service)

**Staff Authentication & Access Control**
- FR38: Staff can authenticate on any device using a personal 4 digit PIN *(amended 2026-09-06 from 4–6)*
- FR39: Owner can create, edit, and deactivate staff accounts, assigning each a role and PIN
- FR40: System enforces role-based access — each capability is available only to roles holding the relevant permission
- FR41: Session duration and expiry behaviour is controlled by the tenant's `auth_mode` and `session_timeout_minutes` configuration flags
- FR42: When `financial_action_reauth` is enabled, bill generation and payment recording always prompt the acting staff member to enter their PIN before proceeding — regardless of any active session
- FR43: Every action (order opened, items added, bill generated, payment recorded) stores its own `staff_id` attributed to whoever authenticated for that specific action — not inherited from a prior session
- FR44a: Owner can configure the tenant's authentication mode (`auth_mode`), session timeout (`session_timeout_minutes`), and financial reauth requirement (`financial_action_reauth`) from system settings
- FR44b: Default authentication config for all new SaaS tenants: `auth_mode: session_short`, `session_timeout_minutes: 5`, `financial_action_reauth: true`

**Audit Trail & Dispute Resolution**
- FR44: System records every order entry, item addition, modification, comp, and payment as an immutable append-only log with timestamp and authenticated staff identity
- FR45: Staff can view the complete item-level history for any order (who entered it, which round, which seat, when)
- FR46: Manager and Owner can view the full audit trail across all staff activity for any period
- FR47: Manager and Owner can comp an item with a mandatory reason code; comp is recorded as a loss entry in the audit trail
- FR47a: Staff can reassign a mis-assigned item from one person to another within the same bill split as a correction, without generating a comp record
- FR48: Comping an item does not alter or delete the original order record — the comp is a new append-only record

**Owner Dashboard & Reporting**
- FR49: Owner can view a dashboard summary of today's revenue updating in real time, and yesterday's total revenue for comparison
- FR50: Owner can view a cash reconciliation summary — expected cash total versus recorded cash payments, with any gap explicitly flagged
- FR51: Owner can view all comps and disputes logged in a given shift, with reason codes, amounts, and staff identifiers
- FR52: Owner can view inventory alert flags for items at zero or critically low portions
- FR53: Owner can access the dashboard remotely from any network-connected device
- FR54: Manager can view a shift-level summary of revenue, comps, and payment gaps
- FR60: Owner and Manager can view tables with orders open beyond a configurable time threshold, flagged on the dashboard as long-open alerts

**System Configuration & Tenant Management**
- FR55: Owner can configure zone names and table layout for the restaurant
- FR56: Owner can manage the full menu — add, edit, remove items, set production destinations and prices
- FR57: Owner can configure per-station ticket output mode (print or KDS display)
- FR58: Owner can manage staff accounts — create, assign roles, set PINs, deactivate
- FR59: System reads tenant-specific feature flags from configuration and enables or disables capabilities accordingly

**Vendor Operations & Remote Support**
- FR-V1: A vendor-only health dashboard is accessible at a protected route, authenticated by vendor credentials, invisible to all restaurant roles
- FR-V2: The health dashboard displays live status for internet connectivity, application health, database connection, printer reachability, disk space, and memory usage
- FR-V3: The vendor can trigger a restart of the application container or all services remotely without SSH access
- FR-V4: The vendor can trigger an on-demand database backup and download the backup file over the Tailscale connection
- FR-V5: The vendor can view a live stream of application error logs from the remote support panel
- FR-V6: Uptime Kuma monitors the health endpoint and pushes a proactive alert to the vendor when any check fails
- FR-V7: A daily automated database backup runs at 03:00 local time and is retained for 30 days on local storage

---

### NonFunctional Requirements

**Performance**
- NFR-P1: Order submission completes and all tickets are printed or displayed within 3 seconds under normal LAN conditions
- NFR-P2: Table and menu browsing screens load within 1 second on the restaurant LAN
- NFR-P3: Bill generation including mid-settlement drag-and-drop split with per-person total calculation completes within 2 seconds
- NFR-P4: System sustains full performance with 10+ staff sessions simultaneously active across different devices
- NFR-P5: System handles 40+ concurrent active orders per shift without UI degradation or ticket delivery delay
- NFR-P6: Adding modifiers or special instructions to any order item completes in 2 taps or fewer from the item entry screen

**Security**
- NFR-S1: Staff PIN credentials are stored as hashed values — plaintext PINs are never persisted, logged, or transmitted
- NFR-S2: No action can be performed without a valid authenticated PIN session; every device interaction is gated by authentication
- NFR-S3: Audit trail records are immutable at the database level — no role, including Owner, can modify or delete a submitted record
- NFR-S4: All application data resides on the local PostgreSQL instance; no operational data is transmitted to external services without explicit Owner opt-in
- NFR-S5: Owner remote access is restricted to Tailscale VPN; no public-facing ports are exposed on the restaurant network
- NFR-S6: Staff sessions expire after a configurable idle timeout (default: 5 minutes in session_short mode); expired sessions require PIN re-entry

**Reliability**
- NFR-R1: System operates fully over the restaurant LAN without internet connectivity — internet outage has zero impact on operations
- NFR-R2: System achieves 99.5%+ uptime during service hours under normal local server operation
- NFR-R3: PostgreSQL data volume is fully preserved through application container restarts, software updates, and hardware reboots
- NFR-R4: A daily automated backup of the PostgreSQL database is written to local storage; recovery procedure documented in plain language

**Data Integrity**
- NFR-D1: All order, payment, comp, and dispute records are append-only — no record is edited or deleted after creation by any means
- NFR-D2: Database schema migrations are applied automatically on container startup without data loss and without operator action
- NFR-D3: Concurrent writes from multiple devices are handled atomically — no race conditions produce inconsistent state
- NFR-D4: Inventory portion counts are decremented atomically; concurrent orders cannot result in a count below zero without triggering the unavailable flag

**Integration**
- NFR-I1: ESC/POS printer integration supports both USB and TCP/IP network connection modes; active mode configurable per deployment
- NFR-I2: Printer timeout or connection failure produces an immediate visible system alert — a failed ticket print is never silently dropped
- NFR-I3: Software updates are delivered via Watchtower image polling from GHCR and applied without interrupting active service
- NFR-I4: Tailscale VPN integration allows Owner dashboard access from any internet-connected device without requiring firewall rule changes

**Scalability**
- NFR-SC1: Each restaurant deployment is an isolated Docker Compose stack — provisioning a new restaurant tenant requires no changes to existing deployments
- NFR-SC2: Single restaurant deployment handles 8+ concurrent staff sessions and 40+ active orders per shift as baseline

**Vendor Operations**
- NFR-V1: All vendor remote access operates exclusively over Tailscale VPN — no vendor tooling exposes any port to the public internet
- NFR-V2: Vendor credentials and access routes are completely isolated from restaurant staff credentials
- NFR-V3: Remote actions (container restart, backup trigger) complete within 30 seconds of vendor initiation under normal Tailscale connectivity
- NFR-V4: Vendor access to restaurant systems does not transmit operational order, payment, or staff data to any external service
- NFR-V5: Uptime Kuma alert delivery latency is under 2 minutes from failure detection to vendor notification

---

### Additional Requirements

_Technical requirements from the Architecture document that affect implementation:_

- **AR1 — Project Initialization**: Initialize with `pnpm create next-app@latest carpe-diem-rms --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"` → Epic 1, Story 1
- **AR2 — Post-Init Packages**: Add shadcn/ui (`pnpm dlx shadcn@latest init`), Drizzle ORM + drizzle-kit + pg, Socket.io + socket.io-client, Recharts, @dnd-kit/core + @dnd-kit/sortable + @dnd-kit/utilities
- **AR3 — Custom Next.js Server**: Implement `server.ts` that creates HTTP server for Next.js and attaches Socket.io to the same port (3000)
- **AR4 — Docker Compose Stack**: Define docker-compose.yml with 5 services: app (Next.js), db (postgres:17-alpine), portainer, uptime-kuma, watchtower; all with `restart: unless-stopped`
- **AR5 — Database Migrations**: drizzle-kit migrate runs via container entrypoint script before app starts; migration files committed to repo
- **AR6 — Append-Only DB Constraint**: PostgreSQL RULE rejecting UPDATE and DELETE on `order_events`, `payment_records`, `comp_records`, `dispute_records` — applied in initial migration
- **AR7 — Connection Pool**: `DATABASE_POOL_MAX=20` env var; configure `pg.Pool({ max: parseInt(process.env.DATABASE_POOL_MAX ?? '10') })` in `src/server/db/index.ts`
- **AR8 — CI/CD Pipeline**: GitHub Actions workflow: push to `main` → build Docker image → push to GHCR; Watchtower polls GHCR every 5 minutes
- **AR9 — Health Endpoint**: `GET /api/health` returns app status, DB connection, printer reachability — used as Watchtower deployment gate
- **AR10 — Daily Backup**: `backup.sh` cron job at 03:00 local time; `pg_dump` to host-mounted volume; 30-day file retention
- **AR11 — Session Middleware**: `src/middleware.ts` validates session cookie on every request, injects `x-staff-id` and `x-staff-role` headers for all Route Handlers
- **AR12 — Server-Only Boundary**: `server-only` npm package imported at top of `src/server/db/index.ts` and `src/server/socket/index.ts` to enforce client/server separation
- **AR13 — Vendor Health Endpoint**: `GET /vendor/health` (separate from `/api/health`) with full diagnostic checks — internet, Tailscale, app, DB, printer TCP:9100, disk, memory, container uptime

---

### UX Design Requirements

_Actionable requirements from the UX Design Specification:_

- **UX-DR1**: Implement brand color token system — CSS variable `--color-brand` (#6EC1E4), full scale brand-50 through brand-900; brand-600 (#2288B4) as primary interactive (4.6:1 WCAG AA); brand-700 (#1A6A8C) as outdoor high-contrast variant (7.1:1 WCAG AAA)
- **UX-DR2**: Implement `[data-context]` attribute on `<html>` element, set server-side in root layout from authenticated staff role; values: `waiter` | `owner` | `kitchen`
- **UX-DR3**: Implement structural neutral palette (neutral-0 #FFFFFF through neutral-900 #0F172A, Slate family) and semantic status colors (status-open #22C55E, status-occupied #F59E0B, status-alert #EF4444)
- **UX-DR4**: Configure Inter font with full type scale — 32px Display, 24px H1, 18px H2, 16px Body, 14px Small, 12px Micro
- **UX-DR5**: Implement 4px base spacing scale — space-1 (4px) through space-12 (48px) as Tailwind custom tokens
- **UX-DR6**: Build `TableCard` component — zone-aware table status display (open/occupied/closed) with colour-coded indicator; 80×80px minimum touch target in waiter context; 44×44px in owner context
- **UX-DR7**: Build `OrderActionStrip` component — state-driven action bar with 5 states (empty / items-added / submitted / settling / closed); available actions change per state; full-width bottom strip on waiter tablet
- **UX-DR8**: Build `PINPad` component — 80×80px digit buttons (0–9 + clear + submit); numeric input only; `aria-label="Enter digit N"` per button; `aria-live="polite"` on PIN dot progress display; no virtual keyboard invocation
- **UX-DR9**: Build `SplitBillCanvas` component — @dnd-kit drag-and-drop item assignment; whole-item only (no fractional split); real-time running per-person totals on drag; accessible via keyboard (Tab + Space) per @dnd-kit accessibility guidelines
- **UX-DR10**: Build `KOTTicket` component — ticket card for kitchen/bar display; shows table, seat assignments, items + quantities, ticket type (KOT/KOT-P/BOT), submitted timestamp; in-progress and completed states
- **UX-DR11**: Build `DisputeTimeline` component — per-item audit history; shows who entered item, which ordering round, which seat, exact timestamp; designed for on-screen presentation to customers during disputes
- **UX-DR12**: Build `OwnerDashboard` composite — chart-first layout using Recharts; revenue trend chart (today vs yesterday by hour), cash reconciliation gap card with flag indicator, comp log table with reason codes, inventory alert list; dark surface (`[data-context="owner"]`)
- **UX-DR13**: Build `ZoneChipBar` component — horizontal scrollable chip row; "All Zones" chip + per-zone chips (Bean Bags, Sun Beds, Tables, Rooftop); instant filter (no Apply button); active chip highlighted with brand-600
- **UX-DR14**: Build `ContextHeader` component — context-sensitive header with breadcrumb; displays current zone → table → order state; no bottom tab bar anywhere in the application
- **UX-DR15**: Build `HamburgerDrawer` component — off-canvas navigation drawer for management/settings sections; never used for primary waiter operations (order entry); accessible via hamburger icon in header
- **UX-DR16**: Implement PWA via `@ducanh2912/next-pwa` — `public/manifest.json` + service worker; cache strategy: menu items, zone/table structure, static assets (shell); graceful offline state displayed when Docker server is unreachable; order data not cached
- **UX-DR17**: Implement WCAG AAA outdoor contrast — all interactive text in `[data-context="waiter"]` uses brand-700 (#1A6A8C) at minimum; verify 7.1:1 ratio via automated axe-core test
- **UX-DR18**: Implement touch target compliance — 56×56px minimum for all interactive elements in waiter context; 44×44px in owner/kitchen context; `touch-action: manipulation` on all interactive elements to eliminate 300ms tap delay
- **UX-DR19**: Implement `prefers-reduced-motion` — wrap all CSS transitions and animations; set `animation-duration: 0.01ms; transition-duration: 0.01ms` when user prefers reduced motion
- **UX-DR20**: Implement SaaS brand preset system — 8–10 curated brand color presets in tenant config table; custom hex input with server-side WCAG AA validation before saving
- **UX-DR21**: Implement Direction B zone map toggle — visual floor plan view of zones (optional); controlled by `zone_map_enabled` feature flag; default `false` for Carpe Diem v1
- **UX-DR22**: Implement dark owner dashboard surfaces — `[data-context="owner"]` uses neutral-900 background with Recharts configured for dark surface; owner context is visually distinct from waiter/kitchen contexts

---

### FR Coverage Map

| Requirement | Epic |
|---|---|
| FR1–FR5 (Zone & Table Management) | Epic 3 |
| FR6–FR13 (Order Entry & Routing) | Epic 4 |
| FR14–FR20 (Ticket Output) | Epic 5 |
| FR21–FR32 (Bill Settlement & Payment) | Epic 6 |
| FR33–FR37 (Inventory Management) | Epic 8 |
| FR38 (PIN Authentication) | Epic 2 |
| FR39 (Staff Account Management) | Epic 10 |
| FR40–FR44b (Session & Auth Config) | Epic 2 |
| FR44–FR48 (Audit Trail & Disputes) | Epic 7 |
| FR49–FR54, FR60 (Owner Dashboard) | Epic 9 |
| FR55–FR59 (System Configuration) | Epic 10 |
| FR-V1–FR-V7 (Vendor Operations) | Epic 11 |
| AR1–AR12 (Foundation Architecture) | Epic 1 |
| AR10, AR13 (Backup & Vendor Health) | Epic 11 |
| UX-DR1–UX-DR5 (Design Tokens) | Epic 1 |
| UX-DR6 (TableCard), UX-DR13 (ZoneChipBar), UX-DR14 (ContextHeader), UX-DR21 (Zone Map) | Epic 3 |
| UX-DR7 (OrderActionStrip) | Epic 4 |
| UX-DR8 (PINPad) | Epic 2 |
| UX-DR9 (SplitBillCanvas) | Epic 6 |
| UX-DR10 (KOTTicket) | Epic 5 |
| UX-DR11 (DisputeTimeline) | Epic 7 |
| UX-DR12 (OwnerDashboard), UX-DR22 (Dark Surfaces) | Epic 9 |
| UX-DR15 (HamburgerDrawer), UX-DR20 (Brand Presets) | Epic 10 |
| UX-DR16–UX-DR19 (PWA & Accessibility) | Epic 1 |
| NFR-P1 (3s ticket print) | Epic 5 |
| NFR-P2 (1s table/menu load) | Epic 3, Epic 4 |
| NFR-P3 (2s bill generation) | Epic 6 |
| NFR-P4–NFR-P6 (Concurrency & UX) | Epic 1, Epic 4 |
| NFR-S1–NFR-S2, NFR-S6 (Auth Security) | Epic 2 |
| NFR-S3, NFR-D1 (Immutable Audit) | Epic 7 |
| NFR-S4, NFR-S5 (Data Residency & VPN) | Epic 1, Epic 11 |
| NFR-R1–NFR-R4 (Reliability & Backup) | Epic 1 |
| NFR-D2 (Auto Migrations) | Epic 1 |
| NFR-D3 (Atomic Concurrent Writes) | Epic 4, Epic 6 |
| NFR-D4 (Atomic Inventory) | Epic 8 |
| NFR-I1–NFR-I2 (Printer Integration) | Epic 5 |
| NFR-I3 (Watchtower Updates) | Epic 1 |
| NFR-I4 (Tailscale Remote Access) | Epic 9 |
| NFR-SC1–NFR-SC2 (Scalability) | Epic 1 |
| NFR-V1–NFR-V5 (Vendor Operations) | Epic 11 |

---

## Epic List

### Epic 1: Project Foundation & Infrastructure

**Goal:** Establish the complete working development and production environment — from initialized Next.js project to deployed Docker Compose stack with CI/CD pipeline, database schema, custom Socket.io server, design token system, and PWA configuration. Every subsequent epic builds on this foundation.

**Requirements Covered:**
- AR1–AR12 (all architectural implementation requirements)
- UX-DR1–UX-DR5 (design token system: brand palette, `[data-context]`, neutrals, type scale, spacing)
- UX-DR16–UX-DR19 (PWA, WCAG AAA outdoor contrast, touch targets, reduced motion)
- NFR-R1–NFR-R4 (LAN-only operation, uptime, data preservation, backup)
- NFR-D2 (auto migrations on container start)
- NFR-I3 (Watchtower zero-downtime updates)
- NFR-SC1–NFR-SC2 (isolated per-restaurant stack)
- NFR-S4–NFR-S5 (local data residency, Tailscale VPN)
- NFR-P4–NFR-P5 (10+ concurrent sessions, 40+ active orders baseline)

---

### Epic 2: Staff Authentication & Session Management

**Goal:** Implement the full PIN-based authentication system — PIN pad UI, session creation and validation, session middleware header injection, role-based access enforcement, configurable session modes, and financial reauth prompts. Staff cannot access any other epic's functionality until this is complete.

**Requirements Covered:**
- FR38 (PIN authentication on any device)
- FR40–FR44b (RBAC, session config, financial reauth, per-action staff attribution, default auth config)
- FR39 (staff account creation — owner-facing; management UI in Epic 10, but the auth model lives here)
- AR11 (session middleware with `x-staff-id` / `x-staff-role` header injection)
- AR12 (server-only boundary enforcement)
- UX-DR8 (PINPad component — 80×80px buttons, aria-live, no virtual keyboard)
- NFR-S1 (bcrypt PIN hashing, never plaintext)
- NFR-S2 (no action without valid session)
- NFR-S6 (configurable idle timeout, PIN re-entry on expiry)

---

### Epic 3: Zone & Table Navigation

**Goal:** Implement the zone-filtered table grid — the waiter's primary landing screen. Staff can see all zones, filter by zone, see real-time table status (open/occupied/closed), and open a new order session on an available table. This is the entry point into the order flow.

**Requirements Covered:**
- FR1 (browse and filter tables by zone)
- FR2 (view current table status)
- FR3 (open a new order session on an available table)
- FR4 (enforce single active session per table)
- FR5 (view all occupied tables and active order summaries)
- UX-DR6 (TableCard component — zone-aware, colour-coded, 80×80px waiter touch target)
- UX-DR13 (ZoneChipBar — instant filter, no Apply button)
- UX-DR14 (ContextHeader — breadcrumb navigation, no bottom tab bar)
- UX-DR21 (Zone Map toggle — `zone_map_enabled` feature flag, default false)
- NFR-P2 (table browsing screen loads within 1 second on LAN)
- NFR-D3 (atomic concurrent session opens — no race on same table)

---

### Epic 4: Order Entry & Multi-Destination Routing

**Goal:** Implement the complete order entry flow — browsing and searching the menu, adding items to seats, applying modifiers, and submitting orders that are automatically routed to the correct production destination (Kitchen, Pizza Kitchen, or Bar). The open-tab model allows multiple ordering rounds per session.

**Requirements Covered:**
- FR6 (add items across multiple ordering rounds — open tab)
- FR7 (search or browse menu by name or category)
- FR8 (add modifiers and special instructions to items)
- FR9 (automatic routing to Kitchen, Pizza Kitchen, or Bar by item config)
- FR10 (create multiple seat slots on a table)
- FR11 (assign items to specific seat slots at order entry)
- FR12 (submit order, simultaneously routing to all destinations in one action)
- FR13 (prevent ordering of unavailable items)
- UX-DR7 (OrderActionStrip — 5-state action bar: empty / items-added / submitted / settling / closed)
- NFR-P2 (menu browsing loads within 1 second on LAN)
- NFR-P6 (add modifier in 2 taps or fewer from item entry screen)
- NFR-D3 (atomic concurrent order writes from multiple devices)

---

### Epic 5: Ticket Output — ESC/POS Printing & KDS Display

**Goal:** Implement the full ticket generation and delivery pipeline — KOT, KOT-P, and BOT tickets generated on order submission, printed to ESC/POS thermal printers via TCP, and displayed on KDS screens when enabled. Printer failures surface immediately as visible alerts; no ticket is silently dropped.

**Requirements Covered:**
- FR14 (KOT generation for kitchen items)
- FR15 (KOT-P generation for pizza kitchen items)
- FR16 (BOT generation for bar items)
- FR17 (print to configured ESC/POS thermal printer)
- FR18 (ticket includes **all** session table identifiers, seats, items, quantities, ticket type label — amended 2026-09-06 for merged tables)
- FR19 (KDS display when display mode enabled per station)
- FR20 (kitchen/bar staff mark ticket in-progress or completed on KDS)
- UX-DR10 (KOTTicket component — table, seats, items, type label, in-progress/completed states)
- NFR-P1 (order submission + ticket print/display within 3 seconds on LAN)
- NFR-I1 (supports USB and TCP/IP printer modes, configurable per deployment)
- NFR-I2 (printer timeout or failure triggers immediate visible alert; `printer:alert` Socket.io event)

---

### Epic 6: Bill Settlement & Payment Recording

**Goal:** Implement the complete billing and payment flow — consolidated bill generation, mid-settlement drag-and-drop split by person, per-seat-slot settlement, payment recording (cash / card / split), and automatic table session closure when all bills are settled. The SplitBillCanvas is the most complex UI component in the system.

**Requirements Covered:**
- FR21 (generate consolidated bill for full table session)
- FR22 (mid-settlement split — assign items to persons by drag)
- FR23 (real-time per-person running totals during split)
- FR24 (generate separate bill per person after split)
- FR25 (generate bill for a specific seat slot independently)
- FR26 (close and settle individual seat slots while others remain open)
- FR27 (bill includes itemized contents, per-item price, comps applied, subtotal)
- FR28 (record cash payment against open bill)
- FR29 (record card payment against open bill)
- FR30 (record split payment: partial cash + partial card on single bill)
- FR31 (any Staff role or above can record payment for any open bill)
- FR32 (auto-close table session when all associated bills are settled)
- UX-DR9 (SplitBillCanvas — @dnd-kit drag-and-drop, whole-item only, real-time totals, keyboard accessible)
- NFR-P3 (bill generation including drag-and-drop split within 2 seconds)
- NFR-D3 (atomic concurrent writes — no race on bill settlement)

---

### Epic 7: Audit Trail & Dispute Resolution

**Goal:** Implement the complete audit trail system — immutable append-only event log enforced at both database (PostgreSQL RULE) and application layer, per-item order history views, staff-facing dispute timeline, and manager/owner comp recording with reason codes. This is CDRMS's core accountability differentiator.

**Requirements Covered:**
- FR44 (immutable append-only log of every order event, payment, comp, and payment — with timestamp and staff_id)
- FR45 (staff view complete item-level history for any order)
- FR46 (manager/owner view full audit trail across all staff activity for any period)
- FR47 (comp an item with mandatory reason code; recorded as loss entry)
- FR47a (reassign mis-assigned item within a split as correction — no comp record generated)
- FR48 (comping does not alter original order record — comp is a new append-only record)
- AR6 (PostgreSQL RULE rejecting UPDATE/DELETE on audit tables)
- UX-DR11 (DisputeTimeline component — per-item history, who/when/round/seat — customer-facing during disputes)
- NFR-S3 (audit records immutable at DB level — no role can modify or delete)
- NFR-D1 (all order, payment, comp, dispute records are append-only)

---

### Epic 8: Inventory Management

**Goal:** Implement real-time inventory portion tracking — owners and managers set portion counts per item, counts decrement atomically on each order, items auto-flag as unavailable at zero, and manual override is available at any time (86'ing an item or resetting counts for a new service).

**Requirements Covered:**
- FR33 (owner/manager set and update portion counts per item)
- FR34 (system decrements portion count on each order)
- FR35 (auto-mark item unavailable when count reaches zero)
- FR36 (manual availability toggle at any time — 86 an item)
- FR37 (manual reset or adjust portion counts, e.g., at start of service)
- NFR-D4 (atomic inventory decrement — concurrent orders cannot go below zero without triggering unavailable flag)

---

### Epic 9: Owner Dashboard & Reporting

**Goal:** Implement the owner-facing analytics dashboard — real-time revenue summary (today vs. yesterday), cash reconciliation gap with explicit flagging, comp log with reason codes, inventory alerts, long-open table warnings, and shift-level manager summary. Accessible remotely via Tailscale.

**Requirements Covered:**
- FR49 (owner dashboard: today's revenue real-time + yesterday for comparison)
- FR50 (cash reconciliation: expected vs. recorded cash, gap flagged explicitly)
- FR51 (comps and disputes by shift: reason codes, amounts, staff IDs)
- FR52 (inventory alert flags: zero or critically low portion items)
- FR53 (owner remote access from any network-connected device)
- FR54 (manager shift-level summary: revenue, comps, payment gaps)
- FR60 (long-open table alerts: orders open beyond configurable threshold, flagged on dashboard)
- UX-DR12 (OwnerDashboard composite — Recharts chart-first layout, revenue trend, cash gap card, comp table, inventory alert list)
- UX-DR22 (dark owner dashboard surfaces — `[data-context="owner"]` neutral-900 background)
- NFR-I4 (Tailscale VPN allows remote owner dashboard access without firewall changes)
- NFR-P2 (dashboard loads within 1 second on LAN)

---

### Epic 10: System Configuration & Staff Management

**Goal:** Implement all owner/manager configuration surfaces — zone and table layout, full menu management (items, prices, production destinations, availability), per-station ticket output mode (print vs. KDS), staff account CRUD (create, role assignment, PIN, deactivate), and tenant feature flag management.

**Requirements Covered:**
- FR39 (owner creates, edits, and deactivates staff accounts with role and PIN)
- FR55 (owner configures zone names and table layout)
- FR56 (owner manages full menu: add/edit/remove items, destinations, prices)
- FR57 (owner configures per-station ticket output mode: print or KDS display)
- FR58 (owner manages staff accounts: create, roles, PINs, deactivation)
- FR59 (system reads tenant feature flags and enables/disables capabilities)
- UX-DR15 (HamburgerDrawer — off-canvas navigation for management sections; never used for waiter order entry)
- UX-DR20 (SaaS brand preset system — 8–10 curated presets, custom hex with server-side WCAG AA validation)

---

### Epic 11: Vendor Operations & Remote Support

**Goal:** Implement the complete vendor support layer — protected vendor health dashboard, remote container restart and backup trigger, live error log streaming, Uptime Kuma proactive alerting, and daily automated backup retention. All access restricted to Tailscale VPN; completely invisible to restaurant staff.

**Requirements Covered:**
- FR-V1 (vendor health dashboard at protected route; invisible to restaurant roles)
- FR-V2 (health dashboard: internet, app, DB, printer TCP:9100, disk, memory)
- FR-V3 (vendor can restart app container or all services without SSH)
- FR-V4 (vendor can trigger on-demand backup and download over Tailscale)
- FR-V5 (vendor can view live application error log stream)
- FR-V6 (Uptime Kuma pushes proactive alert to vendor when any check fails)
- FR-V7 (daily automated backup at 03:00 local time, 30-day retention)
- AR10 (`backup.sh` cron at 03:00, `pg_dump` to host-mounted volume, 30-day file retention)
- AR13 (`GET /vendor/health` with full diagnostic checks)
- NFR-V1 (all vendor access via Tailscale VPN — no public ports)
- NFR-V2 (vendor credentials isolated from restaurant staff credentials)
- NFR-V3 (remote actions complete within 30 seconds under normal Tailscale connectivity)
- NFR-V4 (vendor access does not transmit operational data to external services)
- NFR-V5 (Uptime Kuma alert delivery under 2 minutes from failure detection)

---

## Epic 1: Project Foundation & Infrastructure

**Goal:** Establish the complete working development and production environment — from initialized Next.js project to deployed Docker Compose stack with CI/CD pipeline, database schema, custom Socket.io server, design token system, and PWA configuration. Every subsequent epic builds on this foundation.

### Story 1.1: Initialize Next.js Project with Core Tooling

As a developer,
I want a fully initialized Next.js project with all required packages and a custom Socket.io server attached to the same port,
So that the team has a working, correctly structured foundation on which every CDRMS feature is built.

**Acceptance Criteria:**

**Given** a fresh development environment with Node.js ≥ 20, pnpm, and Docker available
**When** the developer runs the documented project initialization sequence
**Then** a Next.js 14 App Router project exists with TypeScript, Tailwind CSS v4, ESLint, `src/` directory, and `@/*` import alias configured

**Given** the initialized project
**When** all required packages are installed
**Then** `package.json` includes: `drizzle-orm`, `drizzle-kit`, `pg`, `socket.io`, `socket.io-client`, `recharts`, `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `server-only`; and shadcn/ui is initialized

**Given** the project with packages installed
**When** `server.ts` is created at the project root
**Then** it creates a Node.js HTTP server wrapping Next.js's request handler, attaches a Socket.io instance to the same server, and listens on port 3000 (or `PORT` env var)

**Given** the custom server is running
**When** a WebSocket client connects to `http://localhost:3000`
**Then** Socket.io accepts the connection successfully

**Given** `src/server/db/index.ts` and `src/server/socket/index.ts`
**When** either file is imported from a client-side component
**Then** the build fails with a `server-only` error, preventing accidental client-side access

**Given** the project started via the dev script
**When** `http://localhost:3000` is accessed
**Then** the Next.js application renders correctly, confirming Next.js and Socket.io coexist on the same port

---

### Story 1.2: Configure Design Token System

As a developer,
I want the complete CDRMS design token system implemented as CSS custom properties and Tailwind configuration,
So that all components across every epic use consistent brand colors, neutral palette, semantic status colors, typography, and spacing without re-implementing values.

**Acceptance Criteria:**

**Given** `src/app/globals.css`
**When** the browser renders any CDRMS page
**Then** the following CSS custom properties are defined: `--color-brand` (#6EC1E4) with a full `brand-50` through `brand-900` scale; `--color-brand-600` (#2288B4); `--color-brand-700` (#1A6A8C); neutral scale `neutral-0` (#FFFFFF) through `neutral-900` (#0F172A); status colors `--status-open` (#22C55E), `--status-occupied` (#F59E0B), `--status-alert` (#EF4444)

**Given** brand-600 (#2288B4) used as interactive text on a white background
**When** contrast ratio is measured
**Then** the ratio is ≥ 4.5:1 (WCAG AA pass)

**Given** brand-700 (#1A6A8C) used as interactive text in `[data-context="waiter"]`
**When** contrast ratio is measured
**Then** the ratio is ≥ 7:1 (WCAG AAA pass — outdoor use requirement)

**Given** `src/app/layout.tsx` (root layout)
**When** an authenticated staff member accesses the application
**Then** the `<html>` element carries a `data-context` attribute set server-side from the authenticated staff role: `"waiter"` for Staff, `"owner"` for Owner/Manager, `"kitchen"` for Kitchen/Bar

**Given** the root layout with no authenticated session
**When** an unauthenticated request renders the layout
**Then** `data-context` is absent or a neutral default that applies no context-specific styles

**Given** `tailwind.config.ts`
**When** a developer uses `text-brand-600` or `p-space-4`
**Then** Tailwind resolves correctly: `brand-600` → #2288B4; `space-4` → 16px (4 × 4px base unit)

**Given** the font configuration in the layout
**When** any text is rendered
**Then** Inter is the loaded font family; type scale CSS utilities are available: `text-display` (32px), `text-h1` (24px), `text-h2` (18px), `text-body` (16px), `text-small` (14px), `text-micro` (12px)

---

### Story 1.3: Establish Database Schema & Migration Pipeline

As a developer,
I want the complete Drizzle ORM schema defined with automated migrations on container startup and append-only constraints applied at the database layer,
So that the database structure is always correct when the app starts and audit records are protected from modification at the PostgreSQL level.

**Acceptance Criteria:**

**Given** `src/server/db/schema.ts`
**When** a developer reviews the schema
**Then** the following tables are defined: `tenants`, `staff`, `zones`, `tables`, `menu_categories`, `menu_items`, `order_sessions`, `order_events`, `payment_records`, `comp_records`, `dispute_records`, `printer_configs`, `station_configs`, `tenant_config`; each with appropriate columns, data types, and foreign key constraints

**Given** any monetary column in the schema (price, amount, total, subtotal)
**When** the column type is inspected
**Then** it is `integer` (paisa — LKR × 100) at every layer: schema definition, Drizzle types, and all application code; no `decimal`, `numeric`, or `float` type is used for money

**Given** a fresh Docker container start
**When** the container entrypoint script runs before the Next.js process starts
**Then** `drizzle-kit migrate` executes and applies all pending migrations in `src/server/db/migrations/` without operator action; if no pending migrations exist, the command exits cleanly

**Given** the append-only constraint migration has been applied
**When** any process attempts an `UPDATE` or `DELETE` on a row in `order_events`, `payment_records`, `comp_records`, or `dispute_records`
**Then** PostgreSQL rejects the operation with an error; the record remains unchanged; this holds for direct SQL queries, the ORM, and any database user

**Given** `src/server/db/index.ts`
**When** the module initializes the connection pool
**Then** `pg.Pool` is created with `max: parseInt(process.env.DATABASE_POOL_MAX ?? '10')`; `DATABASE_POOL_MAX=20` is documented in `.env.example` with a comment explaining the recommended value

**Given** the migrations directory
**When** it is inspected
**Then** it contains at minimum two ordered migration files: initial schema creation and the append-only RULE application; both committed to the repository

---

### Story 1.4: Configure Docker Compose Stack & Health Endpoint

As a system operator,
I want the application deployable as a self-contained Docker Compose stack with a working health endpoint,
So that the restaurant runs on a local server that starts reliably, survives restarts without data loss, and can be monitored by Uptime Kuma.

**Acceptance Criteria:**

**Given** `docker-compose.yml` in the repository root
**When** a developer inspects it
**Then** exactly 5 services are defined: `app` (Next.js, port 3000 exposed), `db` (postgres:17-alpine, port 5432 internal only), `portainer` (port 9000), `uptime-kuma` (port 3001), `watchtower`; all services have `restart: unless-stopped`

**Given** the Docker Compose stack
**When** `docker compose up -d` runs on a machine with Docker installed
**Then** all 5 services start and the Next.js app responds on port 3000 within 60 seconds

**Given** the stack running with data written to the database
**When** the `app` container is stopped and restarted
**Then** the PostgreSQL data volume is intact; no previously written data is lost; the app connects to the existing database on restart

**Given** the `db` service configuration
**When** the volume configuration is inspected
**Then** the PostgreSQL data directory is mounted as a named Docker volume (not a bind mount); running `docker compose down` without `--volumes` leaves the data volume intact

**Given** the Next.js application running
**When** `GET /api/health` is called
**Then** HTTP 200 is returned with a JSON body containing `status: "ok"`, `db: "connected"`, and `uptime` in seconds; response time is under 500ms

**Given** the database is unreachable
**When** `GET /api/health` is called
**Then** HTTP 503 is returned with `status: "degraded"` and `db: "error"` in the JSON body

**Given** `portainer` and `uptime-kuma` running
**When** accessed from the restaurant LAN (non-Tailscale)
**Then** both services are inaccessible; they are reachable only via Tailscale IP

**Given** the application container running
**When** the host's internet connection is severed after initial setup
**Then** the Next.js app continues to serve all requests normally; no operational feature degrades

---

### Story 1.5: Configure CI/CD Pipeline

As a developer,
I want a GitHub Actions pipeline that builds and pushes a Docker image to GHCR on every push to `main`, with Watchtower applying updates zero-downtime via the health endpoint,
So that software updates reach the restaurant server automatically without manual deployment.

**Acceptance Criteria:**

**Given** `.github/workflows/deploy.yml`
**When** a commit is pushed to the `main` branch
**Then** the GitHub Actions workflow triggers; builds a Docker image from the project `Dockerfile`; authenticates to GHCR using `GITHUB_TOKEN`; pushes the image tagged with both the commit SHA and `latest`

**Given** the `Dockerfile` in the repository root
**When** the image is built
**Then** it is a multi-stage build (build stage + minimal production stage); the final image contains the compiled Next.js output and the custom `server.ts`; the image starts successfully with `node server.ts`

**Given** the Watchtower service in `docker-compose.yml`
**When** the stack is running
**Then** Watchtower polls GHCR for a new `latest` image every 5 minutes using credentials configured via environment variable or mounted Docker config

**Given** Watchtower detects a new image
**When** it applies the update
**Then** the new container starts; Watchtower waits for `GET /api/health` to return HTTP 200 before removing the old container; active staff sessions experience no interruption

**Given** the new container fails its health check within the configured timeout
**When** Watchtower determines the update is unhealthy
**Then** it rolls back to the previous image; the restaurant LAN continues operating on the prior version

---

### Story 1.6: Configure PWA & Accessibility Baseline

As a waiter,
I want the application installable as a PWA with reliable offline awareness, outdoor-grade contrast, and properly sized touch targets,
So that I can use it on a tablet in direct sunlight without browser chrome, confident that every tap registers and the app clearly tells me when the server is unreachable.

**Acceptance Criteria:**

**Given** the app served over the restaurant LAN with `@ducanh2912/next-pwa` configured
**When** a staff member opens it in a mobile browser
**Then** the browser presents an install prompt; once installed, the app launches in standalone mode without browser chrome

**Given** the PWA service worker
**When** the Docker server becomes unreachable after initial load
**Then** menu items, zone/table structure, and static shell assets are served from cache; a "Cannot reach server" offline state UI is displayed; no order data is cached; no stale order state is served

**Given** any interactive element in `[data-context="waiter"]`
**When** the element's rendered size is measured
**Then** it is ≥ 56×56px; all interactive elements have `touch-action: manipulation` applied, eliminating the 300ms tap delay

**Given** any interactive element in `[data-context="owner"]` or `[data-context="kitchen"]`
**When** the element's rendered size is measured
**Then** it is ≥ 44×44px

**Given** all text and interactive elements in `[data-context="waiter"]`
**When** an automated axe-core accessibility test runs
**Then** zero contrast violations are reported; brand-700 (#1A6A8C) on white achieves ≥ 7:1 (WCAG AAA)

**Given** a device with `prefers-reduced-motion: reduce` active
**When** any animated element transitions
**Then** `animation-duration` and `transition-duration` are both `0.01ms`; layout updates correctly without any motion

**Given** `public/manifest.json`
**When** its contents are inspected
**Then** it contains: `name`, `short_name`, `start_url`, `display: "standalone"`, `background_color`, `theme_color`, and at least one icon each at 192×192px and 512×512px

---

## Epic 2: Staff Authentication & Session Management

**Goal:** Implement the full PIN-based authentication system — PINPad UI, session creation and validation, session middleware header injection, role-based access enforcement, configurable session modes, and financial reauth prompts. Staff cannot access any other epic's functionality until this is complete.

### Story 2.1: Build PINPad Component

As a staff member,
I want a touch-friendly PIN entry pad that accepts my 4 digit PIN without invoking the device keyboard,
So that I can authenticate quickly on any tablet or touchscreen without the software keyboard obscuring the screen.

**Acceptance Criteria:**

**Given** the PINPad component is rendered
**When** a staff member views it
**Then** it displays a digit grid (1–9, then 0) plus Clear and backspace keys — no Submit button, since entry ends on the fourth digit *(amended 2026-09-06)*; a PIN dot progress indicator of four dots showing filled/empty per entered digit; all digit buttons are 96×96px *(amended 2026-09-06: was 80×80px; the design pass raised the key size and the first PIN amendment missed this line)*

**Given** a staff member taps a digit button
**When** the tap is registered
**Then** the digit is appended to the internal PIN state; the corresponding dot fills; the device virtual keyboard does NOT appear at any point

**Given** the PINPad component is rendered
**When** a screen reader focuses on any digit button
**Then** `aria-label` reads "Enter digit N" where N is the digit value (0–9)

**Given** the PIN dot progress indicator
**When** the PIN state changes (digit added or cleared)
**Then** `aria-live="polite"` announces the current PIN length (e.g., "3 digits entered")

**Given** a staff member has entered one or more digits
**When** they tap Clear
**Then** all entered digits are removed and all dots return to empty state

**Given** a staff member has entered their fourth digit
**When** that digit lands
**Then** the component calls the provided `onSubmit` callback with the entered PIN string automatically, with no confirm tap; the PIN value is cleared from component state immediately after the callback is invoked

**Given** a staff member has entered fewer than four digits
**When** they stop entering
**Then** nothing is submitted and no error is shown — an incomplete PIN is a normal intermediate state, not a mistake; Clear and backspace remain available

> **Amended 2026-09-06.** These two ACs previously described a Submit button and a "PIN must be at least 4 digits" error. Both are gone. PIN length is now fixed at 4 (PRD FR38, amended the same day), which makes the fourth digit an unambiguous end of entry — so the pad signs in on its own. A confirm button could no longer be in a valid state: below four digits it would have to refuse, and at four the pad has already submitted. The short-PIN error is likewise unreachable, because the pad cannot hold a fifth digit and submits on the fourth.

---

### Story 2.2: Implement PIN Authentication & Session Creation

As a staff member,
I want to authenticate with my PIN and have a session established on the device,
So that I can access the system and all my actions are attributed to my verified identity.

**Acceptance Criteria:**

**Given** a staff member submits their PIN via the PINPad
**When** `POST /api/auth/login` is called with `{ pin: string }`
**Then** the server iterates active staff accounts and compares the submitted PIN against each stored bcrypt hash using `bcrypt.compare`; the database is never queried by plaintext PIN value

**Given** the PIN matches an active staff account
**When** the Route Handler completes
**Then** a new row is inserted into the `sessions` table with `staff_id`, `role`, `expires_at`, and `created_at`; an `httpOnly` `__cdrms_session` cookie is set on the response; HTTP 200 is returned with `{ success: true, role: string }`

**Given** the PIN does not match any active staff account
**When** the Route Handler completes
**Then** HTTP 401 is returned with `{ success: false, error: { code: "INVALID_PIN" } }`; no session row is created; response time is not shorter than a successful attempt (no timing oracle)

**Given** any staff record in the database
**When** the `pin_hash` column is inspected
**Then** it contains a bcrypt hash at cost factor 10; plaintext PIN is absent from every column, log entry, and HTTP response body at all times

**Given** a new tenant is provisioned (initial seed or first run)
**When** the `tenant_config` row is created
**Then** it is seeded with: `auth_mode: "session_short"`, `session_timeout_minutes: 5`, `financial_action_reauth: true`

**Given** `POST /api/auth/logout` is called with a valid session cookie
**When** the Route Handler processes the request
**Then** the corresponding session row is deleted from the `sessions` table; the `__cdrms_session` cookie is cleared from the response; HTTP 200 is returned

---

### Story 2.3: Implement Session Middleware & Role-Based Access Control

As the system,
I want every request validated against an active session with the staff member's identity injected into request headers,
So that all Route Handlers enforce RBAC without duplicating session validation logic.

**Acceptance Criteria:**

**Given** `src/middleware.ts` is the Next.js middleware
**When** any request arrives that is not `POST /api/auth/login`, `GET /api/health`, or a static asset
**Then** the middleware reads the `__cdrms_session` cookie, queries the `sessions` table, and either injects `x-staff-id` and `x-staff-role` headers (valid session) or redirects/rejects (invalid or missing session)

**Given** a request with a valid, non-expired session cookie
**When** the middleware validates it
**Then** the request proceeds with `x-staff-id` set to the staff's UUID and `x-staff-role` set to their role string; the Route Handler receives both headers

**Given** a request with no session cookie, an expired session, or an unrecognized session ID
**When** the middleware validates it
**Then** API routes return HTTP 401 with `{ success: false, error: { code: "UNAUTHENTICATED" } }`; page routes redirect to the login screen

**Given** `auth_mode` is `"session_short"` and `session_timeout_minutes` is 5
**When** a session's `last_activity_at` is more than 5 minutes ago
**Then** the session is treated as expired; the staff member must re-enter their PIN on the next request; the expired session row is deleted or marked invalid

**Given** a Route Handler reads `x-staff-id` from the request headers
**When** it records any action (order event, payment, comp)
**Then** it uses that header value directly as `staff_id` on the created record; it never infers `staff_id` from any ambient state or session context

**Given** a staff member with role `"staff"` sends a request to a route requiring role `"manager"` or above
**When** the middleware checks the role against the route's permission requirement
**Then** HTTP 403 is returned with `{ success: false, error: { code: "FORBIDDEN" } }`; the underlying action is not executed

**Given** the `sessions` table
**When** its schema is inspected
**Then** it contains: `session_id` (PK), `staff_id` (FK → staff), `role`, `created_at`, `expires_at`, `last_activity_at`; no plaintext credential is stored in any column

---

### Story 2.4: Implement Financial Reauth Flow

As the system,
I want all bill generation and payment recording actions to prompt PIN re-entry when `financial_action_reauth` is enabled,
So that every financial action is attributed to a confirmed, authenticated identity regardless of any ambient session.

**Acceptance Criteria:**

**Given** `financial_action_reauth` is `true` in `tenant_config`
**When** a staff member initiates bill generation or payment recording
**Then** the PINPad component appears as a blocking modal overlay before the action proceeds; the underlying bill/payment Route Handler is not called until PIN verification completes

**Given** the staff member enters a correct PIN in the financial reauth modal
**When** the PIN is verified server-side
**Then** the financial action proceeds; the action's `staff_id` is set to the PIN-verified staff member's ID on the resulting record

**Given** the staff member enters an incorrect PIN in the financial reauth modal
**When** verification fails
**Then** an inline error is shown; the staff member may retry; the bill or payment record is not created; no partial record is written

**Given** `financial_action_reauth` is `false` in `tenant_config`
**When** a staff member with an active session initiates bill generation or payment recording
**Then** no PIN reauth modal is shown; the action proceeds using the session's `x-staff-id` directly

**Given** a bill record is created (with or without reauth)
**When** the record is inspected in the database
**Then** `staff_id` is the UUID of the staff member who authenticated for that specific action; it is never null

**Given** a payment record is created
**When** the record is inspected in the database
**Then** `staff_id` reflects the staff member who authenticated for that specific payment; the record is append-only and cannot be modified after creation

---

## Epic 3: Zone & Table Navigation

**Goal:** Implement the zone-filtered table grid — the waiter's primary landing screen. Staff can see all zones, filter by zone, see real-time table status, and open a new order session on an available table.

### Story 3.1: Build Navigation Components (ZoneChipBar, ContextHeader, TableCard)

As a developer,
I want the three core navigation components built and tested with all their variants,
So that the table grid screen and every subsequent feature can compose from tested, accessible primitives.

**Acceptance Criteria:**

**Given** the `ZoneChipBar` component is rendered with a list of zone names
**When** a staff member views it
**Then** it renders a horizontally scrollable chip row with an "All Zones" chip first, followed by one chip per zone (Bean Bags, Sun Beds, Tables, Rooftop); the active chip is highlighted with `brand-600` background; overflow chips are reachable by horizontal scroll with no visible scrollbar

**Given** the `ZoneChipBar` with one chip active
**When** a staff member taps a different zone chip
**Then** the filter state updates immediately with no "Apply" button required; the previously active chip loses its highlight; the newly tapped chip gains `brand-600` highlight

**Given** the `TableCard` component rendered in `[data-context="waiter"]`
**When** its dimensions are measured
**Then** the touch target is ≥ 80×80px; the card displays: table identifier, zone label, and a colour-coded status indicator (open → `status-open` #22C55E; occupied → `status-occupied` #F59E0B; closed → `status-alert` #EF4444)

**Given** the `TableCard` component rendered in `[data-context="owner"]`
**When** its dimensions are measured
**Then** the touch target is ≥ 44×44px; status colours are unchanged

**Given** the `TableCard` for an occupied table
**When** a screen reader announces it
**Then** the accessible name includes the table identifier and status (e.g., "Table 4 — Occupied")

**Given** the `ContextHeader` component rendered at the top level (zone list, no table selected)
**When** the component renders
**Then** it shows the restaurant name only; no breadcrumb trail; no bottom tab bar is rendered anywhere in the application at any navigation level

**Given** the `ContextHeader` when a zone is selected
**When** the component renders
**Then** the breadcrumb reads "Zones → [Zone Name]"; tapping "Zones" navigates back to the full zone list

**Given** the `ContextHeader` when a table is selected within a zone
**When** the component renders
**Then** the breadcrumb reads "Zones → [Zone Name] → Table [N]"; tapping either ancestor segment navigates back to that level

---

### Story 3.2: Implement Zone-Filtered Table Grid with Real-Time Status

As a waiter,
I want to see all tables filtered by zone with their live status,
So that I can instantly know which tables are available without hunting.

**Acceptance Criteria:**

**Given** a waiter lands on the main screen after authenticating
**When** the table grid loads
**Then** all tables across all zones are displayed using `TableCard` components; each card shows the correct status from the database; the `ZoneChipBar` is visible with "All Zones" active by default; load time is under 1 second on the restaurant LAN

**Given** the table grid is displayed
**When** a waiter taps a zone chip in the `ZoneChipBar`
**Then** only tables belonging to that zone are shown; the filter is instant with no additional network request (client-side filter on already-loaded data)

**Given** the table grid is displayed
**When** another device opens or closes a table session
**Then** the affected `TableCard` updates its status colour and label within 2 seconds via Socket.io `table:status_changed` event; no manual refresh is required

**Given** the Socket.io `table:status_changed` event is received
**When** TanStack Query processes the invalidation
**Then** only the affected table's data is refetched; the full table list is not re-fetched

**Given** a table with status "open"
**When** a waiter views its `TableCard`
**Then** the card is tappable and navigates to the table detail/order screen

**Given** a table with status `unavailable`
**When** a waiter views its `TableCard`
**Then** the card is visually distinct (greyed or `status-alert` colour); tapping it does not open a session; an "Unavailable" label is visible

**Given** `GET /api/tables` is called to load the grid data
**When** the Route Handler responds
**Then** the response includes all tables with `zone_id`, `zone_name`, `status`, and active `session_id` (if occupied); response time is under 300ms on the restaurant LAN

---

### Story 3.3: Implement Open Table Session

As a waiter,
I want to open a new order session on an available table with a single tap,
So that I can start taking an order immediately without any setup steps.

**Acceptance Criteria:**

**Given** a waiter taps an "open" table card
**When** the tap is registered
**Then** `POST /api/tables/:tableId/sessions` is called *(amended 2026-09-06: accepts an optional `additionalTableIds` array for a merged seating — all tables must share a zone, see Story 3.8)*; a new `order_sessions` row is created with `table_id` (the primary table), `opened_by_staff_id` (from `x-staff-id` header), and `opened_at`, **plus one `order_session_tables` row per table in the group**; `closed_at` is left NULL, which is what marks the session open; `tables.status` updates to `occupied` for every table in the group

**Given** the session is created successfully
**When** the Route Handler returns
**Then** the waiter is navigated to the order entry screen for that table; the `ContextHeader` breadcrumb updates to reflect the selected table; a `table:status_changed` Socket.io event is emitted to all connected clients

**Given** two waiters tap the same "open" table simultaneously
**When** both `POST /api/tables/:tableId/sessions` requests arrive concurrently
**Then** exactly one session is created; the second request receives HTTP 409 with `{ success: false, error: { code: "TABLE_ALREADY_OCCUPIED" } }`; no duplicate session rows exist — enforced by the existing partial unique index `idx_order_sessions_one_open_per_table` on `table_id WHERE closed_at IS NULL`, not by application logic

**Given** a waiter attempts to open a session on an already "occupied" table
**When** `POST /api/tables/:tableId/sessions` is called
**Then** HTTP 409 is returned with `{ success: false, error: { code: "TABLE_ALREADY_OCCUPIED" } }`; no new session is created

**Given** a waiter attempts to open a session on an `unavailable` table
**When** `POST /api/tables/:tableId/sessions` is called
**Then** HTTP 422 is returned with `{ success: false, error: { code: "TABLE_NOT_AVAILABLE" } }`; no session is created

**Given** the `order_session` row that was just created
**When** inspected in the database
**Then** `opened_by_staff_id` matches the `x-staff-id` header from the request; `closed_at` is NULL; `closed_by_staff_id` is NULL

> **Schema note (corrected 2026-08-21):** `order_sessions` has **no `status` column**. An open session is one whose `closed_at IS NULL` — that is also what the partial unique index keys on. Earlier drafts of these ACs referred to `status: "active"`, which does not exist; implementing against it would fail at the first insert. Table availability is a separate column, `tables.status`, whose values are `open | occupied | unavailable` (there is no `closed`).

---

### Story 3.4: Implement Occupied Tables Summary View

As a waiter,
I want to see a summary of all currently occupied tables and their active orders,
So that I can check what's open across the restaurant without navigating to each table individually.

**Acceptance Criteria:**

**Given** a waiter navigates to the occupied tables summary view
**When** the view loads
**Then** all tables with `status: "occupied"` are listed using `TableCard` components; each card additionally shows: time since session opened, number of items ordered so far, and the zone the table belongs to; load time is under 1 second on the restaurant LAN

**Given** the occupied tables summary view is displayed
**When** a table session is closed on another device
**Then** that table's card is removed from the summary within 2 seconds via Socket.io `table:status_changed` event

**Given** the occupied tables summary view is displayed
**When** a new table session is opened on another device
**Then** that table's card appears in the summary within 2 seconds via Socket.io `table:status_changed` event

**Given** a waiter taps an occupied table card in the summary view
**When** the tap is registered
**Then** the waiter is navigated to the order entry screen for that table's active session; the `ContextHeader` breadcrumb updates to the selected table

**Given** no tables are currently occupied
**When** the summary view renders
**Then** an empty state message is displayed (e.g., "No tables currently open"); no error or blank screen is shown

**Given** `GET /api/sessions/active` is called to load the summary
**When** the Route Handler responds
**Then** it returns all active sessions with `table_id`, `zone_name`, `opened_at`, and item count; response time is under 300ms on the restaurant LAN

---

### Story 3.5: Implement Zone Map Toggle (Feature-Flagged)

As an owner,
I want to optionally enable a visual floor plan view of zones alongside the chip-filter grid,
So that staff can orient themselves spatially if the restaurant layout benefits from a map view.

**Acceptance Criteria:**

**Given** `zone_map_enabled` is `false` in `tenant_config` (the default for Carpe Diem v1)
**When** a waiter views the main table screen
**Then** no map or floor plan view is rendered; the zone chip filter grid is the only navigation method; no toggle button or map-related UI is visible

**Given** `zone_map_enabled` is set to `true` in `tenant_config`
**When** a waiter views the main table screen
**Then** a toggle control appears allowing switching between "Grid" and "Map" views; both views use the same live table status data; switching is instant with no additional network request

**Given** the map view is active and `zone_map_enabled` is `true`
**When** a waiter views the floor plan
**Then** each zone is represented as a tappable region; tapping a zone filters to that zone's tables (same behaviour as tapping a `ZoneChipBar` chip); table status colour indicators are visible on the map

**Given** `zone_map_enabled` is toggled from `true` to `false` in `tenant_config`
**When** a waiter next loads the screen
**Then** the map toggle and map view disappear; the chip filter grid is shown; no error occurs

**Given** the feature flag system reads `zone_map_enabled`
**When** the value is read
**Then** it is read from the `tenant_config` table at request time, not hardcoded; changing the value in the database takes effect without a code deployment

---
### Story 3.6: Implement Close Table Without Payment

> **Added 2026-09-06** by `sprint-change-proposal-2026-09-06.md`. Raised from the running application: a table could be occupied but never released. The only close in the entire plan was a side effect of full payment (Story 6.5), and that path is gated on a settled bill — which a session with no items can never produce. Mis-taps, parties leaving before ordering, and walkouts all left a table permanently occupied.

As a waiter,
I want to release a table that was opened by mistake or whose party left without ordering or paying,
So that the floor plan stays true and a wrong tap is not permanent.

**Acceptance Criteria:**

**Given** a waiter is on the order screen for an open session with no submitted items
**When** they tap "Close table" and choose the reason `abandoned`
**Then** `POST /api/tables/:tableId/sessions/close` is called with `{ reason: "abandoned" }`; the `order_sessions` row has `closed_at` and `closed_by_staff_id` set; **`released_at` is set on every `order_session_tables` row for the session and every table in the group returns to `open`** *(amended 2026-09-06 for merged tables, Story 3.8)*; a `table:status_changed` event is emitted per affected table and every connected device updates within 2 seconds

**Given** the session being closed has submitted items
**When** the waiter chooses the reason `abandoned`
**Then** HTTP 409 is returned with `{ success: false, error: { code: "SESSION_HAS_ITEMS" } }` — a session with orders in it is a walkout or a bill, never an abandonment; the reason must be `walkout`, which requires the confirmation below

**Given** a waiter closes a session with submitted items as `walkout`
**When** the close is submitted
**Then** an explicit confirmation is required before the request is sent, stating the unpaid total; the session closes; the unpaid amount is recorded so it is not silently lost from revenue

**Given** any session is closed without payment
**When** the close transaction commits
**Then** an append-only `order_events` row is written with `event_type: 'SESSION_CLOSED'`, the acting `staff_id`, and `notes` carrying the reason; this happens in the same transaction as the close, so a closed session always has its audit record

**Given** a session is opened
**When** the `order_sessions` row is created
**Then** an append-only `order_events` row is written with `event_type: 'SESSION_OPENED'` and the acting `staff_id`, in the same transaction — closing the existing gap where sessions are created with no audit event at all despite the enum value existing (retrofit to Story 3.3's endpoint)

**Given** two devices attempt to close the same session simultaneously
**When** both requests arrive concurrently
**Then** exactly one succeeds; the second receives HTTP 409 with `{ code: "SESSION_ALREADY_CLOSED" }`; the close is conditional on `closed_at IS NULL` within the transaction, so the database decides the winner rather than application logic — the same principle as Story 3.3's open path

**Given** a kitchen staff member attempts to close a session
**When** `POST /api/tables/:tableId/sessions/close` is called
**Then** HTTP 403 is returned — closing is a write beneath `/api/tables`, already restricted to owner + waiter by the method-scoped policy added in Story 3.3

> **Schema note:** No migration is required. `SESSION_OPENED` and `SESSION_CLOSED` already exist as distinct values in `orderEventTypeEnum` (separate from `SESSION_SETTLED`), and `order_sessions` already carries `closed_at` and `closed_by_staff_id`. The data model anticipated a close that is not a settlement; only the epics failed to spec it.

> **Shared service:** the close logic belongs in one place. Story 6.5's settled auto-close calls the same service with reason `settled`, so a settled close and an unpaid close produce identical session and audit records, differing only in reason.

---

### Story 3.7: Implement Table Availability (Out of Service / Return to Service)

> **Added 2026-09-06** by `sprint-change-proposal-2026-09-06-merge-and-availability.md`. `tables.status` has an `unavailable` value that only the seed ever set — no route could change it, so a waiter finding a broken sun bed could not stop guests being seated there, and nobody could put it back.

As a waiter,
I want to take a broken or unusable table out of service immediately,
So that guests are not seated at it while I find someone to fix it.

As an owner,
I want to be the only person who can return a table to service,
So that a table is not made bookable again before the problem is actually resolved.

**Acceptance Criteria:**

**Given** a waiter or owner selects a table with no open session
**When** `POST /api/tables/:tableId/out-of-service` is called with `{ reason: string }`
**Then** `tables.status` becomes `unavailable`; the reason is stored; a `table:status_changed` event is emitted and every device updates within 2 seconds; HTTP 200 is returned

**Given** a table has an open session
**When** taking it out of service is attempted
**Then** HTTP 409 is returned with `{ success: false, error: { code: "TABLE_HAS_OPEN_SESSION" } }` — close or settle the session first; a table with guests at it cannot silently vanish from the floor plan

**Given** an owner selects a table that is out of service
**When** `POST /api/config/tables/:tableId/return-to-service` is called
**Then** `tables.status` returns to `open`; the stored reason is cleared; a `table:status_changed` event is emitted; HTTP 200 is returned

**Given** a waiter or kitchen staff member attempts to return a table to service
**When** `POST /api/config/tables/:tableId/return-to-service` is called
**Then** HTTP 403 is returned — enforced by the existing `{ prefix: '/api/config', roles: ['owner'] }` policy, which is why this route is namespaced under config rather than under `/api/tables`

**Given** a waiter selects an unavailable table on the floor screen
**When** the action strip renders
**Then** it shows the table state and the stored reason with **no** return-to-service control; an owner in the same position sees the control. Hiding the button is courtesy — the 403 above is the enforcement

**Given** any availability change
**When** the transaction commits
**Then** an append-only audit row records the acting staff member, the direction of the change, the reason, and a timestamp — `tables.status` changes are currently unrecorded, so nobody can answer "who took table 6 out and why"

> **Routing note:** return-to-service is deliberately `/api/config/...` and out-of-service is `/api/tables/...`. The two existing policies then produce the asymmetry with **no `permissions.ts` change at all**. Prefix matching cannot distinguish `/api/tables/:id/x` from `/api/tables/:id/y` because the dynamic segment defeats longest-prefix specialisation — the namespace is what carries the permission.

> **Schema note:** storing the reason needs a column (`tables.unavailable_reason text`, nullable) — the only schema change in this story, and it is additive.

---

### Story 3.8: Implement Within-Zone Table Merging

> **Added 2026-09-06** by the same proposal. The PRD names merged tables as a core differentiator (`prd.md:38-40`) but no FR, story or schema support existed — `order_sessions.table_id` was single-valued, so one order across two tables was not merely unbuilt, it was inexpressible. Scope confirmed with Teran: merging happens **within a zone**, not across.

As a waiter,
I want to seat one party across two or more tables in the same zone and take a single order for them,
So that a group that needs more space is still one order, one ticket and one bill.

**Acceptance Criteria:**

**Given** a waiter selects an open table and taps "Merge"
**When** the merge mode is active
**Then** the action strip shows the anchor table, an instruction to tap tables to add, and Cancel / Done; tapping a table toggles it into the group with a clear visual state. Merging is an **explicit mode** — single-tap never changes meaning outside it, because a tap that sometimes selects and sometimes adds produces wrong merges during service, and a wrong merge puts one party's items on another party's bill

**Given** a merge group is confirmed on tables with no open session
**When** `POST /api/tables/:tableId/sessions` is called with `{ additionalTableIds: [...] }`
**Then** one `order_sessions` row is created and one `order_session_tables` row per table; every table's status becomes `occupied`; a `table:status_changed` event is emitted **per table**; HTTP 201 is returned

**Given** a merge is attempted across zones
**When** the request is submitted
**Then** HTTP 422 is returned with `{ code: "CROSS_ZONE_MERGE" }`; all tables in a group must share a `zone_id`

**Given** a waiter merges an additional table into a table that already has an open session
**When** `POST /api/tables/:tableId/merge` is called with `{ tableIds: [...] }`
**Then** the named tables join the existing session; they become `occupied`; the order, its items and its audit trail are untouched

**Given** both tables in a merge attempt already have open sessions
**When** the merge is submitted
**Then** HTTP 409 is returned with `{ code: "BOTH_TABLES_OCCUPIED" }` — combining two live orders is retroactive item re-assignment, which is a Growth-tier feature (`prd.md:113`) and requires deciding whose items are whose

**Given** a table belongs to a merged group
**When** its card renders on the floor screen
**Then** it displays as occupied, shows the group it belongs to (e.g. `BB1 + BB3`), and shares the group's elapsed time and totals — a waiter glancing at the second table must not see an unexplained occupied table

**Given** a waiter un-merges a table from an open group
**When** `POST /api/tables/:tableId/unmerge` is called
**Then** `released_at` is set on that `order_session_tables` row; the table returns to `open`; the session and its order continue on the remaining tables; if the released table was the primary, another table in the group is promoted

**Given** a merged session is closed or settled
**When** the close transaction commits
**Then** `released_at` is set on **every** table in the group and all of them return to `open`

**Given** an order is submitted from a merged session
**When** the ticket is generated
**Then** it names every table in the session (FR18, amended 2026-09-06) — a runner with one table name and two possible destinations cannot deliver

**Given** any merge or un-merge
**When** the transaction commits
**Then** an append-only audit row records the acting staff member, the tables affected, and the direction

> **Schema — the one structural change:**
> ```sql
> order_session_tables (
>   session_id  uuid not null references order_sessions(id),
>   table_id    uuid not null references tables(id),
>   attached_at timestamptz not null default now(),
>   released_at timestamptz,
>   primary key (session_id, table_id)
> )
> create unique index idx_one_open_session_per_table
>   on order_session_tables (table_id) where released_at is null;
> ```
> This index **replaces** `idx_order_sessions_one_open_per_table`. The old one cannot express the invariant once tables live in a join table: a partial index cannot reach into another table to ask whether the session is open. Putting `released_at` on the join row makes the constraint self-contained and gives un-merge for free.
>
> `order_sessions.table_id` is retained as the **primary** table for breadcrumbs, labels and ticket headers. The join table holds every table including the primary. Migration backfills one join row per existing session.

> **Why one session rather than linked sessions:** orders, bills, payments and the audit trail already hang off `session_id`. One session means every one of them works unchanged — Epic 6 in particular needs no new concept, and the PRD's "merged tables settle individually" is delivered by the existing split-by-person. Linked sessions would mean fanning out across a group on every read, in application code, forever.

---


## Epic 4: Order Entry & Multi-Destination Routing

**Goal:** Implement the complete order entry flow — menu browsing and search, seat slot management, adding items with modifiers, and submitting orders that automatically route to the correct production destination.

### Story 4.1: Build OrderActionStrip Component

As a developer,
I want the OrderActionStrip component built with all 5 states and their corresponding actions,
So that the order entry screen has a tested, state-driven action bar ready to wire up.

**Acceptance Criteria:**

**Given** the `OrderActionStrip` component receives state `"empty"`
**When** a waiter views the order screen with no items staged
**Then** the strip renders full-width at the bottom of the screen; no primary action button is active; an instructional label (e.g., "Add items to begin") is visible; the strip occupies its reserved space so menu content above does not reflow

**Given** the `OrderActionStrip` component receives state `"items-added"`
**When** a waiter has staged one or more items but not yet submitted
**Then** a "Submit Order" primary action button is visible and tappable; a secondary "Clear" option is available; item count or summary is displayed on the strip

**Given** the `OrderActionStrip` component receives state `"submitted"`
**When** the current round has been submitted to production
**Then** an "Add More Items" button is visible (opens a new ordering round); a "Generate Bill" button is visible; no "Submit Order" button is shown

**Given** the `OrderActionStrip` component receives state `"settling"`
**When** bill settlement is in progress
**Then** neither "Add More Items" nor "Submit Order" is available; the strip indicates the session is in settlement; no order actions can be taken from this strip

**Given** the `OrderActionStrip` component receives state `"closed"`
**When** all bills are paid and the session is closed
**Then** the strip shows a "Session Closed" label; no action buttons are rendered; the strip is visually distinct (muted background)

**Given** the `OrderActionStrip` in `[data-context="waiter"]`
**When** any of its action buttons are measured
**Then** all touch targets are ≥ 56×56px; the strip spans the full width of the viewport

**Given** any state transition of the `OrderActionStrip`
**When** the `state` prop changes
**Then** the transition is immediate; the correct buttons appear and disappear per the state table above

---

### Story 4.2: Implement Menu Browse & Search

As a waiter,
I want to browse the menu by category and search by item name,
So that I can find any item quickly regardless of whether I know where it lives in the menu.

**Acceptance Criteria:**

**Given** a waiter opens the menu on an active table session
**When** the menu loads
**Then** all menu categories are displayed as tappable section headers; items within each category are listed below their header; load time is under 1 second on the restaurant LAN

**Given** the menu is displayed
**When** a waiter taps a category header
**Then** the view scrolls to or expands that category's items; items in other categories remain accessible without navigating away

**Given** a waiter types a partial item name into the search field
**When** the input changes
**Then** the menu filters to show only items whose name contains the search string (case-insensitive); filtering is instant (client-side, no additional network request); category headers for matching items remain visible

**Given** a menu item with `available: false`
**When** it appears in browse or search results
**Then** the item is visible with a visual "Unavailable" indicator (greyed out or struck through); its add button is disabled; tapping it produces no action

**Given** `GET /api/menu` is called to load menu data
**When** the Route Handler responds
**Then** it returns all categories and items with `id`, `name`, `price` (integer paisa), `available`, `production_destination`, and `portion_count`; response time is under 300ms on the restaurant LAN

**Given** a Socket.io `menu:itemUpdated` event is received (e.g., item 86'd by a manager)
**When** TanStack Query processes the event
**Then** it invalidates and refetches only the affected item's availability state; the menu re-renders without a full page reload

---

### Story 4.3: Implement Seat Slot Management

As a waiter,
I want to create named seat slots on a table before taking orders,
So that I can track which items belong to which person from the moment of order entry.

**Acceptance Criteria:**

**Given** a waiter opens a new table session
**When** the order screen loads
**Then** one default seat slot ("Seat 1") exists automatically; no additional action is required to begin ordering for a single-guest table

**Given** a waiter taps "Add Seat"
**When** the action is confirmed
**Then** a new seat slot is created with a sequential label (Seat 2, Seat 3, etc.); `POST /api/sessions/:sessionId/seats` is called; the new seat appears immediately in the seat slot selector

**Given** multiple seat slots exist on a session
**When** a waiter views the seat slot selector
**Then** all seat slots are displayed as a horizontally scrollable chip row; the active seat slot is highlighted; tapping a chip sets it as the active seat for subsequent item additions

**Given** `POST /api/sessions/:sessionId/seats` is called
**When** the Route Handler processes the request
**Then** a new `seat_slot` row is created with `session_id`, `seat_label`, and `created_at`; HTTP 201 is returned with the new seat's `id` and `seat_label`

**Given** a session has seat slots
**When** the session is loaded by any device
**Then** all existing seat slots are visible and selectable; seat slots persist across device refreshes and reconnections

**Given** a session has exactly one seat slot remaining
**When** a waiter attempts to delete it
**Then** deletion is rejected; at least one seat slot must always exist on an active session

---

### Story 4.4: Implement Add Item to Order with Modifiers & Seat Assignment

As a waiter,
I want to add menu items to the current order round with optional modifiers and seat assignment,
So that the kitchen and bar receive exactly what each guest wants, attributed to the right seat.

**Acceptance Criteria:**

**Given** a waiter taps an available menu item
**When** the tap is registered
**Then** the item is staged in the current order round assigned to the currently active seat slot; a modifier/special instruction entry is reachable in at most 2 taps from the item list (NFR-P6)

**Given** a waiter enters modifier text (e.g., "no ice", "extra spicy")
**When** they confirm the modifier
**Then** the modifier text is stored on the staged order item; it is visible in the staged items list alongside the item name; the total taps from item selection to modifier confirmed is ≤ 2

**Given** a waiter stages an item with no modifier entry
**When** they add the item
**Then** the item is added with an empty modifier field; no modifier prompt blocks the flow; the item appears in the staged list immediately

**Given** multiple seat slots exist on the session
**When** a waiter stages an item
**Then** the item is assigned to whichever seat slot chip is currently active; changing the active seat chip before tapping an item assigns subsequent items to the new seat

**Given** the waiter taps Remove on a staged item
**When** the action is confirmed
**Then** the item is removed from the staged round; the staged items list updates immediately; no database write occurs for staged (not yet submitted) items

**Given** a previously submitted order round exists on the session
**When** a waiter taps "Add More Items" on the `OrderActionStrip`
**Then** a new empty ordering round opens; previously submitted items appear as read-only history above the new round's staging area; the `OrderActionStrip` transitions to `"items-added"` once the first item is staged

**Given** an item is staged for a seat slot that no longer exists
**When** the waiter attempts to submit
**Then** submission is blocked with an inline error "Seat [N] no longer exists — please reassign this item"; no order event is written

---

### Story 4.5: Implement Order Submission & Multi-Destination Routing

As a waiter,
I want to submit the staged order in a single action that simultaneously routes items to every applicable production destination,
So that the kitchen and bar receive their tickets the moment I tap submit — no separate steps per destination.

**Acceptance Criteria:**

**Given** a waiter taps "Submit Order" on the `OrderActionStrip`
**When** `POST /api/sessions/:sessionId/orders` is called
**Then** all staged items for the current round are written as `order_event` rows atomically in a single database transaction; each row includes `session_id`, `seat_slot_id`, `menu_item_id`, `modifier_text`, `staff_id` (from `x-staff-id` header), `round_number`, and `submitted_at`; HTTP 201 is returned on success

**Given** the order events are written
**When** the Route Handler processes routing
**Then** items with `production_destination: "kitchen"` trigger a KOT; items with `production_destination: "pizza_kitchen"` trigger a KOT-P; items with `production_destination: "bar"` trigger a BOT; all destinations are dispatched in the single submission — one tap, all destinations

**Given** the order is submitted
**When** Socket.io events are emitted
**Then** the `kitchen` room receives an `order:submitted` event with KOT payload; the `bar` room receives an `order:submitted` event with BOT payload; the originating session room receives an `order:confirmed` event; all events are emitted before the HTTP response is returned

**Given** two waiters submit items to the same session concurrently
**When** both `POST /api/sessions/:sessionId/orders` requests arrive simultaneously
**Then** both sets of order events are written correctly; no item is lost or duplicated; the database transaction prevents partial writes (NFR-D3)

**Given** the submission succeeds
**When** the `OrderActionStrip` receives the confirmation
**Then** it transitions from `"items-added"` to `"submitted"` state; the staged items list clears; submitted items appear in read-only order history

**Given** the Route Handler encounters a database error mid-transaction
**When** the transaction rolls back
**Then** HTTP 500 is returned; no `order_event` rows are written for that round; no Socket.io events are emitted; the waiter sees an error message and can retry

**Given** the submitted order contains an item that became unavailable between staging and submission
**When** the Route Handler validates items before writing
**Then** HTTP 422 is returned with `{ success: false, error: { code: "ITEM_UNAVAILABLE", itemId: "..." } }`; no order events are written; the waiter is prompted to remove the unavailable item and resubmit

---

## Epic 5: Ticket Output — ESC/POS Printing & KDS Display

**Goal:** Implement the full ticket generation and delivery pipeline — KOT, KOT-P, and BOT tickets printed to ESC/POS thermal printers via TCP and displayed on KDS screens. Printer failures surface immediately; no ticket is ever silently dropped.

### Story 5.1: Build KOTTicket Component

As a developer,
I want the KOTTicket component built with all its display states,
So that the KDS screen has a tested, accessible ticket card ready to compose.

**Acceptance Criteria:**

**Given** the `KOTTicket` component is rendered with ticket data
**When** a kitchen or bar staff member views it
**Then** the card displays: ticket type label (KOT / KOT-P / BOT) prominently; **every table identifier in the session** (e.g. `BB1 + BB3` for a merged group — amended 2026-09-06); all seat slot assignments with their items; item names and quantities per seat; submitted timestamp in human-readable format (e.g., "2:34 PM")

**Given** the `KOTTicket` component in its default (new) state
**When** it is rendered
**Then** the card uses a neutral or brand colour indicating a new, unacknowledged ticket; no status badge is shown beyond the ticket type label

**Given** the `KOTTicket` component in `"in-progress"` state
**When** it is rendered
**Then** a visible "In Progress" badge appears; the card background shifts to a distinct colour (e.g., `status-occupied` amber) to differentiate from new tickets

**Given** the `KOTTicket` component in `"completed"` state
**When** it is rendered
**Then** a "Done" badge is visible; the card is visually de-emphasised (greyed out or reduced opacity) indicating it no longer requires attention

**Given** the `KOTTicket` component
**When** a screen reader announces it
**Then** the accessible name includes ticket type, table identifier, and current status (e.g., "KOT — Table 4 — In Progress")

**Given** the `KOTTicket` rendered in `[data-context="kitchen"]`
**When** the action buttons ("In Progress", "Done") are measured
**Then** all touch targets are ≥ 44×44px

**Given** multiple items assigned to different seats on the same ticket
**When** the `KOTTicket` component renders them
**Then** items are visually grouped by seat slot with the seat label as a sub-header; items across different seats are clearly separated

---

### Story 5.2: Implement ESC/POS Ticket Generation & TCP Printing

As the system,
I want to generate correctly formatted ESC/POS ticket bytes and send them to the configured thermal printer via TCP immediately upon order submission,
So that kitchen and bar staff have a physical ticket in hand within 3 seconds of the waiter tapping Submit.

**Acceptance Criteria:**

**Given** an `order:submitted` event is triggered (from Story 4.5)
**When** the ticket generation pipeline runs server-side within the Route Handler
**Then** separate ticket payloads are generated per production destination present in the submission: one KOT for all kitchen items, one KOT-P for all pizza kitchen items, one BOT for all bar items; a destination with no items receives no ticket

**Given** a ticket payload is generated
**When** the ESC/POS byte sequence is assembled
**Then** the printed ticket contains: ticket type label (KOT / KOT-P / BOT) in large bold text at top; table identifier; seat slot sub-headers with their assigned items; item name and quantity per line; modifier text (if any) on the line immediately below the item; submitted timestamp; a paper cut command at the end

**Given** the station configuration has `output_mode: "print"` for the target printer
**When** the ESC/POS bytes are ready
**Then** a TCP connection is opened to `PRINTER_IP:9100` using Node.js `net` module; the bytes are written to the socket; the connection is closed after the write completes or times out

**Given** the TCP connection to the printer does not respond within 5 seconds
**When** the timeout fires
**Then** the connection attempt is aborted; a `printer:alert` Socket.io event is emitted to all connected clients with `{ printerName, ticketType, tableId, error: "TIMEOUT" }`; the ticket data is not silently discarded — the alert includes enough context to reprint manually

**Given** the TCP connection to the printer fails (connection refused, network unreachable)
**When** the error is caught
**Then** a `printer:alert` Socket.io event is emitted with `{ printerName, ticketType, tableId, error: "CONNECTION_FAILED" }`; the application continues operating; other destinations' tickets are still sent regardless of one printer's failure

**Given** a `printer:alert` event is received by any connected client
**When** the client displays the alert
**Then** a persistent, visible error banner appears (not an auto-dismissing toast) indicating which printer failed and for which table; the banner remains until dismissed by a staff member

**Given** a station configured with `connection_mode: "usb"`
**When** the system sends a ticket to that station
**Then** the USB print path is invoked instead of TCP; `PRINTER_IP` is ignored for USB-mode stations; the printer receives the same ESC/POS byte sequence as TCP mode

**Given** the full order submission flow including ticket printing
**When** measured under normal LAN conditions
**Then** from the waiter tapping Submit to the printer receiving all bytes is under 3 seconds (NFR-P1)

---

### Story 5.3: Implement KDS Display Screen & Ticket Status

As a kitchen or bar staff member,
I want incoming order tickets to appear on a dedicated display screen and be markable in-progress or completed,
So that I can manage production flow without relying on paper tickets when KDS mode is enabled for my station.

**Acceptance Criteria:**

**Given** a station with `output_mode: "kds"` in `station_configs`
**When** a kitchen or bar staff member opens the KDS screen for that station
**Then** all active (not completed) tickets for that station's production destination are displayed using `KOTTicket` components in reverse-chronological order (newest at top)

**Given** the KDS screen is open for a kitchen station
**When** a new order is submitted containing kitchen items
**Then** a new `KOTTicket` card appears at the top of the KDS screen within 2 seconds via Socket.io `order:submitted` event; no page refresh is required

**Given** the KDS screen is open for a bar station
**When** a new order is submitted containing bar items
**Then** a new `KOTTicket` card appears on the bar KDS screen; kitchen tickets do not appear on the bar screen and vice versa

**Given** a kitchen staff member taps "In Progress" on a `KOTTicket` card
**When** `PATCH /api/tickets/:ticketId/status` is called with `{ status: "in_progress" }`
**Then** the ticket's status is updated in the database; the `KOTTicket` card transitions to `"in-progress"` state on all KDS screens displaying that ticket via Socket.io `ticket:status_changed` event

**Given** a kitchen staff member taps "Done" on a `KOTTicket` card
**When** `PATCH /api/tickets/:ticketId/status` is called with `{ status: "completed" }`
**Then** the ticket's status is updated; the card transitions to `"completed"` state; after a brief display period (e.g., 10 seconds) the completed ticket moves to a dismissible "Recent" section rather than disappearing immediately

**Given** a station with `output_mode: "print"` in `station_configs`
**When** a kitchen or bar staff member opens the KDS screen URL
**Then** the screen displays a notice "This station is set to print mode — KDS display is not active"; no ticket cards are shown; no Socket.io subscription is established for that station

**Given** the KDS screen has been open for an extended period
**When** a new `order:submitted` event arrives
**Then** the new ticket still appears correctly without a page refresh; Socket.io handles reconnection transparently

---

## Epic 6: Bill Settlement & Payment Recording

**Goal:** Implement the complete billing and payment flow — consolidated bill generation, mid-settlement drag-and-drop person split, per-seat-slot settlement, payment recording (cash/card/split), and automatic table session closure when all bills are settled.

### Story 6.1: Build SplitBillCanvas Component

As a developer,
I want the SplitBillCanvas drag-and-drop component built with real-time per-person totals and full keyboard accessibility,
So that the mid-settlement person split screen has a tested, accessible canvas ready to wire up.

**Acceptance Criteria:**

**Given** the `SplitBillCanvas` component is rendered with a list of order items and a list of persons
**When** a waiter views it
**Then** an "Unassigned" pool displays all items not yet assigned to a person; each person has a visible drop zone column with their label; a running total (in LKR, converted from paisa for display only) is shown beneath each person's column

**Given** a waiter drags an item from the Unassigned pool to a person's column
**When** the drag is in progress (item held over a column)
**Then** the target column is visually highlighted; the per-person running total for that column updates in real time to reflect the item's price being added

**Given** a waiter drops an item onto a person's column
**When** the drop is confirmed
**Then** the item moves from the Unassigned pool to that person's column; the person's running total permanently reflects the addition; the sum of all person totals always equals the sum of all item prices

**Given** the `SplitBillCanvas` component
**When** a user navigates with keyboard only (Tab to focus items, Space to pick up / drop)
**Then** items can be fully assigned to persons using keyboard alone; the drag state is announced via `aria-live` (e.g., "Item Grilled Chicken picked up — press Tab to select destination, Space to drop")

**Given** the whole-item constraint
**When** a waiter attempts to assign a fractional quantity of an item to different persons
**Then** fractional assignment is not possible; each item is assigned as a whole unit to one person only

**Given** all items are assigned to persons (Unassigned pool is empty)
**When** the waiter reviews the canvas
**Then** a "Generate Bills" action becomes active; the action is disabled while any item remains in the Unassigned pool

**Given** a waiter drags an item from a person's column back to the Unassigned pool
**When** the drop is confirmed
**Then** the item returns to Unassigned; the person's running total decreases accordingly

---

### Story 6.2: Implement Consolidated Bill Generation

As a waiter,
I want to generate a single consolidated bill for all items at a table with one action,
So that I can present the full total to a party settling together without any split configuration.

**Acceptance Criteria:**

**Given** a waiter taps "Generate Bill" on the `OrderActionStrip` (state: `"submitted"`)
**When** `POST /api/sessions/:sessionId/bills` is called with `{ type: "consolidated" }`
**Then** a `bill` record is created with `session_id`, `type: "consolidated"`, `staff_id` (from `x-staff-id` header), `created_at`, and `status: "open"`; HTTP 201 is returned with the bill data

**Given** the consolidated bill is generated
**When** the bill data is returned
**Then** it includes all `order_event` rows for the session as line items; each line item shows `item_name`, `quantity`, `unit_price` (integer paisa), and `modifier_text`; any comp records are listed as negative line items with reason codes; a `subtotal` integer (sum of all prices minus comps, in paisa) is included; no float arithmetic is used at any layer

**Given** a comp has been applied to an item in this session
**When** the consolidated bill is generated
**Then** the comp appears as a negative paisa line item with the comp reason code; the subtotal reflects the reduction; the original order item line is unchanged

**Given** the bill is generated
**When** the `OrderActionStrip` state updates
**Then** it transitions to `"settling"` state; "Generate Bill" and "Add More Items" are no longer available

**Given** a waiter attempts to generate a consolidated bill on a session that already has an open bill
**When** `POST /api/sessions/:sessionId/bills` is called
**Then** HTTP 409 is returned with `{ success: false, error: { code: "BILL_ALREADY_OPEN" } }`; no duplicate bill is created

**Given** `GET /api/bills/:billId` is called to retrieve a bill
**When** the Route Handler responds
**Then** all monetary values are returned as integers (paisa); the display layer converts to LKR only for rendering; the API never returns a float for any monetary value

---

### Story 6.3: Implement Mid-Settlement Person Split

As a waiter,
I want to initiate a mid-settlement split that assigns items to individual persons and generates a separate bill for each,
So that a party can each pay for exactly what they ordered without pre-assigning seats.

**Acceptance Criteria:**

**Given** a waiter taps "Split Bill" from the bill generation options
**When** the split flow opens
**Then** the `SplitBillCanvas` component is displayed with all session items in the Unassigned pool; 2 persons are pre-created by default; the waiter can add more persons before or during assignment

**Given** the waiter assigns items across persons using the `SplitBillCanvas`
**When** per-person totals update on each drag
**Then** the calculation completes within 200ms of each assignment; the total of all person totals always equals the session grand total

**Given** all items are assigned and the waiter taps "Generate Bills"
**When** `POST /api/sessions/:sessionId/bills/split` is called with the assignment map `{ personId: [orderEventId, ...] }`
**Then** the full flow from tapping Generate Bills to receiving all per-person bill records is under 2 seconds (NFR-P3)

**Given** `POST /api/sessions/:sessionId/bills/split` is processed
**When** the Route Handler writes to the database
**Then** one `bill` record is created per person with `type: "split"`, `session_id`, `person_label`, and `staff_id`; all writes are in a single database transaction

**Given** the split bills are generated
**When** the response is returned
**Then** each person's bill contains only items assigned to them; any comps on their items appear as negative line items; each person's subtotal is in integer paisa; the sum of all person subtotals equals the session subtotal

**Given** the waiter adds a person to the canvas but assigns no items to them
**When** the waiter taps "Generate Bills"
**Then** generation is blocked with an inline error "Person [N] has no items assigned"; the waiter must assign items or remove the empty person before proceeding

---

### Story 6.4: Implement Per-Seat-Slot Independent Billing

As a waiter,
I want to generate and settle a bill for a specific seat slot while other seats at the same table remain open,
So that guests who need to leave early can pay and go without waiting for the whole table.

**Acceptance Criteria:**

**Given** a session has multiple seat slots
**When** a waiter selects a specific seat slot and taps "Bill This Seat"
**Then** `POST /api/sessions/:sessionId/seats/:seatId/bill` is called; a `bill` record is created with `type: "seat"`, `session_id`, `seat_slot_id`, and `staff_id`; the bill contains only order items assigned to that seat slot

**Given** the seat bill is generated
**When** it is returned to the client
**Then** it includes the seat's itemized line items, any applied comps, and the seat subtotal in integer paisa; the `OrderActionStrip` for that seat's context transitions to `"settling"` state

**Given** a seat bill exists with `status: "open"`
**When** the remaining seat slots continue ordering
**Then** the table session remains open; other seats can still add items, submit orders, and generate their own bills independently; the settled seat's items are excluded from any subsequent bill generation for remaining seats

**Given** a seat slot's bill is paid
**When** the payment is recorded
**Then** that seat slot's status updates to `"closed"`; if other seats are still open, the table session status remains `"occupied"`; the table only auto-closes when all seat bills are settled

**Given** a waiter attempts to generate a seat bill for a seat that is already billed
**When** `POST /api/sessions/:sessionId/seats/:seatId/bill` is called
**Then** HTTP 409 is returned with `{ success: false, error: { code: "SEAT_ALREADY_BILLED" } }`; no duplicate bill is created

**Given** a seat slot has no items assigned to it
**When** a waiter attempts to generate a seat bill for it
**Then** HTTP 422 is returned with `{ success: false, error: { code: "SEAT_HAS_NO_ITEMS" } }`; no bill is created

---

### Story 6.5: Implement Payment Recording & Session Auto-Close

As a waiter,
I want to record cash, card, or split payments against any open bill,
So that every payment is captured and the table closes automatically when fully settled.

**Acceptance Criteria:**

**Given** a waiter taps "Record Payment" on an open bill
**When** `POST /api/bills/:billId/payments` is called with `{ method: "cash", amount: <integer paisa> }`
**Then** a `payment_record` row is created with `bill_id`, `method: "cash"`, `amount` (integer paisa), `staff_id` (from `x-staff-id` header), and `recorded_at`; if the amount equals or exceeds the bill subtotal, the bill status updates to `"settled"`

**Given** a waiter records a card payment
**When** `POST /api/bills/:billId/payments` is called with `{ method: "card", amount: <integer paisa> }`
**Then** a `payment_record` row is created with `method: "card"`; bill settlement logic is identical to cash

**Given** a waiter records a split payment
**When** `POST /api/bills/:billId/payments` is called with `{ method: "split", cashAmount: <integer paisa>, cardAmount: <integer paisa> }`
**Then** two `payment_record` rows are created — one cash, one card — both with the same `bill_id` and `staff_id`; the sum of both amounts is compared against the bill subtotal for settlement

**Given** a staff member with role `"staff"` records payment for any open bill
**When** `POST /api/bills/:billId/payments` is called
**Then** the payment is accepted; role `"staff"` has full payment recording permission; no manager or owner role is required (FR31)

**Given** two staff members attempt to record payment against the same bill simultaneously
**When** both requests arrive concurrently
**Then** both payment records are written in a serialised transaction; the bill is not double-settled; the final bill status reflects the correct total received (NFR-D3)

**Given** the last open bill in a session is marked `"settled"`
**When** the payment Route Handler checks remaining open bills
**Then** it calls the shared session-close service introduced in Story 3.6 with reason `settled`, which sets `closed_at` and `closed_by_staff_id` (there is no `status` column — see the schema note on Story 3.3), writes the `SESSION_CLOSED` audit event, and emits `table:status_changed`; `tables.status` returns to `open` on all connected devices within 2 seconds. The close is **not** reimplemented here — a settled close and an unpaid close must produce identical session and audit records, differing only in reason. *(Amended 2026-09-06 by sprint-change-proposal-2026-09-06.md.)*

**Given** any payment amount written to the database
**When** the `payment_record` row is inspected
**Then** the `amount` column is an integer (paisa); no float or decimal is stored; the row is append-only and cannot be modified or deleted after creation

---

## Epic 7: Audit Trail & Dispute Resolution

**Goal:** Implement the complete audit trail surface — per-order item history with dispute timeline, manager/owner comp recording with reason codes, item reassignment correction, and the full cross-staff audit trail view. This is CDRMS's core accountability differentiator.

### Story 7.1: Build DisputeTimeline Component

As a developer,
I want the DisputeTimeline component built with a clear per-item chronological audit display,
So that staff can present a transparent, readable order history to a customer during a billing dispute without leaving the app.

**Acceptance Criteria:**

**Given** the `DisputeTimeline` component is rendered with a list of audit events for an order
**When** a staff member views it
**Then** each event is displayed as a timeline entry in chronological order (oldest at top); each entry shows: item name, quantity, ordering round number, seat slot label, staff display name, and exact timestamp (e.g., "2:47:32 PM")

**Given** the `DisputeTimeline` displays a comp event for an item
**When** the comp entry renders
**Then** it is visually distinguished from order entries (different colour or icon); it shows the reason code, comping staff member's name, and timestamp; it does not replace or obscure the original order entry for that item

**Given** the `DisputeTimeline` component is shown to a customer during a dispute
**When** the customer views it
**Then** the layout is clean and legible at arm's length on a tablet; no internal system IDs (UUIDs, database keys) are visible; only human-readable labels are displayed

**Given** the `DisputeTimeline` component receives an empty event list
**When** it renders
**Then** an empty state message is shown (e.g., "No history available"); no error or blank space appears

**Given** the `DisputeTimeline` rendered in `[data-context="waiter"]`
**When** any interactive elements are measured
**Then** all touch targets are ≥ 56×56px

**Given** the `DisputeTimeline` component
**When** a screen reader reads the timeline
**Then** each entry is announced with item name, staff name, round, seat, and time in a logical reading order; decorative elements do not confuse assistive technology

---

### Story 7.2: Implement Per-Order Item History View

As a waiter,
I want to view the complete item-level audit history for any active or past order,
So that I can show a customer exactly who entered each item, in which round, and at what time when a dispute arises.

**Acceptance Criteria:**

**Given** a waiter is on the order screen for an active table session
**When** they tap "View Order History"
**Then** the `DisputeTimeline` component renders with all `order_event` rows for that session in chronological order; each event shows: item name, quantity, round number, seat slot label, staff display name (not ID), and exact timestamp

**Given** a session has multiple ordering rounds
**When** the order history is displayed
**Then** round boundaries are visually indicated (e.g., a "Round 2" separator); items within each round are grouped together

**Given** a comp has been applied to an item in the session
**When** the order history is displayed
**Then** the comp entry appears after the original order entry for that item; it shows the reason code and comping staff member's name; both entries are visible simultaneously

**Given** `GET /api/sessions/:sessionId/history` is called
**When** the Route Handler responds
**Then** it returns all `order_event` rows joined with staff display names, seat labels, and associated `comp_record` rows; no raw UUIDs are exposed; response time is under 500ms on the restaurant LAN

**Given** a staff member with role `"staff"` calls `GET /api/sessions/:sessionId/history`
**When** the middleware checks the role
**Then** access is granted; any authenticated staff member can view the history for any session

**Given** any `order_event` row in the database
**When** any process attempts to `UPDATE` or `DELETE` it
**Then** the PostgreSQL RULE from Story 1.3 rejects the operation; immutability is enforced at the database layer, not just the application layer (NFR-S3, NFR-D1)

---

### Story 7.3: Implement Comp Recording & Item Reassignment

As a manager or owner,
I want to comp a specific order item with a mandatory reason code,
So that losses are recorded transparently in the audit trail without altering the original order history.

**Acceptance Criteria:**

**Given** a manager or owner selects an item from the order history
**When** they tap "Comp Item"
**Then** a reason code selector appears with predefined codes (e.g., "Customer Complaint", "Quality Issue", "Staff Error", "Goodwill") plus an optional free-text notes field; submission is blocked until a reason code is selected

**Given** a manager or owner submits a comp with a selected reason code
**When** `POST /api/order-events/:eventId/comp` is called with `{ reasonCode, notes?, staffId: <from x-staff-id header> }`
**Then** a new `comp_record` row is created with `order_event_id`, `reason_code`, `notes`, `staff_id`, `amount` (item unit price in paisa), and `created_at`; HTTP 201 is returned; the original `order_event` row is not modified in any way (FR48)

**Given** the comp record is created
**When** the order history view refreshes
**Then** the comp entry appears in the `DisputeTimeline` below the original item entry; any bill for that session reflects the comp as a negative line item on next retrieval

**Given** a staff member with role `"staff"` attempts to call `POST /api/order-events/:eventId/comp`
**When** the middleware checks the role
**Then** HTTP 403 is returned; comp recording requires role `"manager"` or `"owner"`

**Given** a `comp_record` row is written to the database
**When** any process attempts to `UPDATE` or `DELETE` it
**Then** the PostgreSQL RULE rejects the operation; the record is append-only (NFR-D1)

**Given** a waiter is in the mid-settlement split view and an item has been mis-assigned to the wrong person
**When** the waiter drags the item to the correct person's column
**Then** the item assignment updates in the canvas; no `comp_record` is created; a `dispute_record` is written with `type: "reassignment"`, original person, new person, and acting `staff_id`; the original `order_event` row is not modified (FR47a)

**Given** a `dispute_record` row of type `"reassignment"` is written
**When** any process attempts to `UPDATE` or `DELETE` it
**Then** the PostgreSQL RULE rejects the operation; the record is append-only (NFR-D1)

---

### Story 7.4: Implement Full Audit Trail View

As a manager or owner,
I want to view a filterable audit trail of all staff activity across any time period,
So that I can investigate discrepancies, verify staff actions, and produce accountability records without relying on paper.

**Acceptance Criteria:**

**Given** a manager or owner navigates to the Audit Trail view
**When** the view loads
**Then** all `order_event`, `payment_record`, `comp_record`, and `dispute_record` rows are presented in reverse-chronological order; each entry shows: event type, item or action description, staff display name, table identifier, and exact timestamp; the default view shows today's records and loads in under 1 second

**Given** the audit trail view is displayed
**When** the manager filters by date range
**Then** only records with `created_at` within the selected range are shown; the filter is applied server-side; queries for ranges up to 30 days return within 1 second

**Given** the audit trail view is displayed
**When** the manager filters by staff member
**Then** only records where `staff_id` matches the selected staff member are displayed; the filter can be combined with the date range filter

**Given** the audit trail view is displayed
**When** the manager filters by event type (orders / payments / comps / disputes)
**Then** only records of the selected types are shown; multiple types can be selected simultaneously

**Given** `GET /api/audit-trail` is called with query parameters `{ from, to, staffId?, eventTypes? }`
**When** the Route Handler responds
**Then** it returns filtered records with staff display names resolved; response time is under 1 second for 30-day ranges; no raw database keys are exposed

**Given** a staff member with role `"staff"` attempts to access the Audit Trail view
**When** the middleware checks the role
**Then** HTTP 403 is returned; the audit trail is restricted to `"manager"` and `"owner"` roles only

**Given** the audit trail displayed in the view
**When** any record is inspected at any role level
**Then** no update or delete action is available in the UI; the view is strictly read-only; underlying records remain protected by the PostgreSQL RULE from Story 1.3

---

## Epic 8: Inventory Management

**Goal:** Implement real-time portion tracking — owners and managers set portion counts, counts decrement atomically on each order, items auto-flag as unavailable at zero, and manual override is available at any time.

### Story 8.1: Implement Portion Count Management

As an owner or manager,
I want to set and reset portion counts for any menu item,
So that the system knows how many servings are available for each item at the start of and during a service.

**Acceptance Criteria:**

**Given** an owner or manager opens a menu item's settings
**When** they view the Portion Count field
**Then** the current `portion_count` value is displayed (or "Unlimited" if tracking is disabled); the field is editable by owner and manager roles only

**Given** an owner or manager enters a new portion count and saves
**When** `PATCH /api/menu-items/:itemId/portion-count` is called with `{ portionCount: number }`
**Then** the `portion_count` column is updated in the database; if the new count is greater than zero and the item was previously unavailable due to depletion, the item's `available` flag is reset to `true`; HTTP 200 is returned with the updated item

**Given** an owner or manager sets `portionCount` to `null`
**When** the update is saved
**Then** portion tracking is disabled for that item; the item's availability is no longer affected by order volume; the item displays as "Unlimited" in the management screen

**Given** an owner or manager taps "Reset All Portions" at the start of service
**When** `POST /api/inventory/reset` is called with `{ itemIds: [...], portionCounts: {...} }`
**Then** all specified items' `portion_count` values are updated in a single transaction; items with a positive new count that were previously unavailable are reset to `available: true`; a `menu:itemUpdated` Socket.io event is emitted for each affected item so all connected devices reflect the reset immediately

**Given** a staff member with role `"staff"` attempts to call `PATCH /api/menu-items/:itemId/portion-count`
**When** the middleware checks the role
**Then** HTTP 403 is returned; portion count management requires role `"manager"` or `"owner"`

**Given** a portion count is set to a negative number
**When** the Route Handler validates the input
**Then** HTTP 422 is returned with `{ success: false, error: { code: "INVALID_PORTION_COUNT" } }`; the update is rejected

---

### Story 8.2: Implement Atomic Portion Decrement & Auto-Unavailable Flag

As the system,
I want to atomically decrement a menu item's portion count each time it is ordered and automatically mark it unavailable when the count reaches zero,
So that concurrent orders from multiple waiters never oversell a depleted item.

**Acceptance Criteria:**

**Given** an order is submitted containing a menu item with `portion_count > 0`
**When** the order write transaction from Story 4.5 executes
**Then** the item's `portion_count` is decremented by the ordered quantity within the same transaction using an atomic `UPDATE menu_items SET portion_count = portion_count - $qty WHERE id = $id AND portion_count >= $qty`; the decrement and the `order_event` write are committed together or both rolled back

**Given** an order is submitted and the decrement succeeds with `portion_count` still above zero
**When** the transaction commits
**Then** the item's `available` flag remains `true`; no Socket.io availability event is emitted

**Given** an order is submitted and the decrement causes `portion_count` to reach exactly zero
**When** the transaction commits
**Then** the item's `available` flag is set to `false` in the same transaction; a `menu:itemUpdated` Socket.io event is emitted to all connected clients with `{ itemId, available: false, portionCount: 0 }`; all connected menu views reflect the item as unavailable within 2 seconds without a page refresh

**Given** two waiters simultaneously submit orders that together would exhaust the remaining portion count
**When** both `UPDATE` statements execute concurrently
**Then** PostgreSQL row-level locking ensures only the order(s) that fit within the available count succeed; the order that would exceed the count receives a constraint violation; that submission returns HTTP 422 with `{ success: false, error: { code: "ITEM_UNAVAILABLE", itemId: "..." } }`; the portion count never goes below zero (NFR-D4)

**Given** a menu item with `portion_count = null` (unlimited)
**When** that item is ordered
**Then** no decrement is performed; the item's `available` flag is unaffected; the order proceeds normally

**Given** a menu item whose `portion_count` has reached zero
**When** a waiter attempts to add it to an order
**Then** the item is shown as "Unavailable" in the menu; its add button is disabled; the waiter cannot stage it

---

### Story 8.3: Implement Manual Availability Toggle (86 an Item)

As an owner or manager,
I want to manually toggle a menu item's availability on or off at any time regardless of its portion count,
So that I can immediately 86 an item that has run out, is not ready, or should not be ordered for any operational reason.

**Acceptance Criteria:**

**Given** an owner or manager views the menu management screen
**When** they tap the availability toggle on any menu item
**Then** `PATCH /api/menu-items/:itemId/availability` is called with `{ available: boolean }`; the item's `available` flag is updated; HTTP 200 is returned with the updated item state

**Given** the availability toggle is set to `false` (item 86'd)
**When** the update commits
**Then** a `menu:itemUpdated` Socket.io event is emitted to all connected clients with `{ itemId, available: false }`; all connected waiter menu views reflect the item as unavailable within 2 seconds; the item's add button is disabled on all devices without a page refresh

**Given** the availability toggle is set to `true` (item restored)
**When** the update commits
**Then** a `menu:itemUpdated` Socket.io event is emitted with `{ itemId, available: true }`; all connected waiter menu views reflect the item as available within 2 seconds; if the item has `portion_count > 0` or null, it becomes orderable immediately

**Given** an item with `portion_count = 0` is manually toggled to `available: true`
**When** the update is saved
**Then** the `available` flag is set to `true` regardless of `portion_count`; the item becomes orderable; if ordered, Story 8.2's decrement logic immediately sets it back to unavailable since the count is zero

**Given** a staff member with role `"staff"` attempts to call `PATCH /api/menu-items/:itemId/availability`
**When** the middleware checks the role
**Then** HTTP 403 is returned; manual availability toggling requires role `"manager"` or `"owner"`

**Given** an item's `available` flag is set to `false` by either auto-depletion (Story 8.2) or manual toggle
**When** the owner dashboard inventory alert panel renders (Epic 9)
**Then** the item appears in the inventory alert list; the alert distinguishes between "Depleted" (portion_count = 0) and "Manually Unavailable" (available = false with portion_count > 0 or null)

---

## Epic 9: Owner Dashboard & Reporting

**Goal:** Implement the owner-facing analytics dashboard — real-time revenue chart, cash reconciliation gap, comp log, inventory alerts, long-open table warnings, and manager shift summary. Accessible remotely via Tailscale.

### Story 9.1: Implement Owner Dashboard Shell & Dark Theme

As a developer,
I want the owner dashboard shell implemented with the dark theme and chart-first layout,
So that all data panels in subsequent stories have a correctly structured, visually distinct container to slot into.

**Acceptance Criteria:**

**Given** an owner or manager navigates to the dashboard route
**When** the page loads
**Then** the root `<html>` element carries `data-context="owner"`; the dashboard background is `neutral-900` (#0F172A); all text and UI elements use dark-surface colour variants from the design token system (UX-DR22)

**Given** the dashboard renders with `[data-context="owner"]`
**When** any waiter-context styles are inspected
**Then** waiter-specific styles (56×56px touch targets, `brand-700` outdoor contrast) do not apply; the owner context is visually distinct from `[data-context="waiter"]` and `[data-context="kitchen"]`

**Given** the dashboard layout structure
**When** a developer inspects the component hierarchy
**Then** the layout follows a chart-first arrangement: the revenue chart occupies the primary top position spanning full width; supporting cards (cash reconciliation, comp log, inventory alerts, long-open tables) are arranged below in a responsive grid

**Given** the dashboard shell with no data panels yet loaded
**When** each panel slot renders
**Then** each slot displays a loading skeleton at the correct size and position; the layout does not reflow when real data replaces the skeletons

**Given** the dashboard route
**When** accessed by a staff member with role `"staff"` or `"kitchen"`
**Then** HTTP 403 is returned; the dashboard is accessible to `"manager"` and `"owner"` roles only

---

### Story 9.2: Implement Real-Time Revenue Chart

As an owner,
I want to see today's revenue trend charted by hour alongside yesterday's for comparison, updating in real time as payments are recorded,
So that I can see how the current service is tracking against the previous day without running a manual report.

**Acceptance Criteria:**

**Given** an owner opens the dashboard
**When** the revenue chart loads
**Then** a Recharts line or bar chart renders with two data series: "Today" and "Yesterday"; the x-axis shows hours (e.g., 10:00 AM through current time); the y-axis shows revenue in LKR (converted from paisa for display only); the chart is configured for the dark surface (neutral-900 background, light-coloured axes and labels)

**Given** the revenue chart is displayed
**When** a new payment is recorded on any device
**Then** the "Today" series updates within 5 seconds via Socket.io `payment:recorded` event invalidating the TanStack Query cache; no manual refresh is required

**Given** `GET /api/dashboard/revenue` is called
**When** the Route Handler responds
**Then** hourly revenue buckets are returned as integer paisa arrays (e.g., `[{ hour: 10, total: 45000 }, ...]`); no float arithmetic is used; response time is under 300ms on the restaurant LAN

**Given** the dashboard page load
**When** measured from navigation to chart visible with data
**Then** the total load time is under 1 second on the restaurant LAN (NFR-P2)

**Given** the running total revenue figure displayed alongside the chart
**When** a payment is recorded
**Then** the figure updates in real time; it is displayed in LKR with appropriate formatting (e.g., "LKR 12,450.00"); no raw paisa integer is shown to the user

**Given** no payments have been recorded today
**When** the revenue chart renders
**Then** the "Today" series shows a flat zero line; the "Yesterday" series shows prior day data normally; an empty state label is visible for today

---

### Story 9.3: Implement Cash Reconciliation, Comp Log, Inventory Alerts & Long-Open Tables

As an owner,
I want to see cash reconciliation gaps, comps, inventory alerts, and overdue tables as supporting cards on the dashboard,
So that I have a complete operational picture at a glance without navigating to separate screens.

**Acceptance Criteria:**

**Given** the cash reconciliation card on the dashboard
**When** it renders
**Then** it shows: "Expected Cash" (sum of all cash payment records for the current shift); "Recorded Cash" (same total from the system); if they differ, a prominent red gap indicator with the difference amount is displayed; if they match, a green "Balanced" indicator is shown (FR50)

**Given** the cash reconciliation gap is non-zero
**When** the owner views the card
**Then** the gap amount is shown in LKR with a visual flag (red border, alert icon); no float is shown — display is rounded to the nearest rupee or shows exact paisa breakdown

**Given** the comp log table on the dashboard
**When** it renders for the current shift
**Then** it lists all `comp_record` rows created during the shift with columns: item name, amount (LKR), reason code, staff display name, and timestamp; the table is scrollable if more than 5 entries; the total comped amount for the shift is shown as a summary row (FR51)

**Given** the inventory alert list on the dashboard
**When** it renders
**Then** it shows all menu items with `available: false`; each entry distinguishes between "Depleted" (portion_count = 0) and "Manually Unavailable"; the list updates in real time via Socket.io `menu:itemUpdated` events (FR52)

**Given** no inventory alerts exist
**When** the inventory alert list renders
**Then** a "All items available" empty state is shown; no blank card appears

**Given** the long-open tables card on the dashboard
**When** it renders
**Then** it lists all active sessions where `opened_at` is older than `tenant_config.long_open_threshold_minutes`; each entry shows: table identifier, zone, time open (e.g., "47 min"), and the staff member who opened the session (FR60)

**Given** `GET /api/dashboard/summary` is called
**When** the Route Handler responds
**Then** it returns cash reconciliation totals, comp log entries, inventory alert list, and long-open session list in a single response; all monetary values are integers (paisa); response time is under 500ms on the restaurant LAN

**Given** a new comp is recorded
**When** the dashboard comp log updates
**Then** the new entry appears within 5 seconds via TanStack Query invalidation triggered by a Socket.io `comp:recorded` event; the shift comp total updates accordingly

---

### Story 9.4: Implement Manager Shift Summary & Remote Access

As a manager,
I want to view a shift-level summary of revenue, comps, and payment gaps,
So that I have a concise end-of-shift picture of financial performance without owner-level access to all dashboard data.

**Acceptance Criteria:**

**Given** a manager navigates to the dashboard
**When** the shift summary view loads
**Then** the manager sees: total shift revenue in LKR, total comped amount, cash vs card payment breakdown, and any cash reconciliation gap flagged if non-zero; data covers the current shift from opening to now (FR54)

**Given** a manager views the shift summary
**When** the data is inspected
**Then** the manager does not see the full revenue trend chart (today vs yesterday) — that is owner-only; the manager sees shift aggregate figures only; role-based data scoping is enforced server-side, not just UI-hidden

**Given** `GET /api/dashboard/shift-summary` is called with a `"manager"` role header
**When** the Route Handler responds
**Then** it returns: `shiftRevenue`, `totalComps`, `cashTotal`, `cardTotal`, `cashGap`; all values are integers (paisa); no hourly breakdown or yesterday comparison is included

**Given** an owner accesses the dashboard from a device connected via Tailscale VPN
**When** they navigate to the dashboard URL using the server's Tailscale IP
**Then** the dashboard loads correctly with all data panels populated; authentication via PIN and session cookie works identically to LAN access; no special device configuration is required (FR53, NFR-I4)

**Given** an owner attempts to access the dashboard from a public internet IP (not Tailscale)
**When** the request arrives at the server
**Then** the server does not respond; no public port is exposed; the dashboard is unreachable outside Tailscale or the restaurant LAN

**Given** the dashboard is accessed over Tailscale
**When** page load time is measured
**Then** load time may exceed 1 second due to WAN latency; the NFR-P2 1-second requirement applies to LAN access only; Tailscale access is acceptable at up to 3 seconds for initial load

---

## Epic 10: System Configuration & Staff Management

**Goal:** Implement all owner/manager configuration surfaces — staff account CRUD, zone and table layout, full menu management, per-station ticket output mode, tenant feature flags, and brand customization.

### Story 10.1: Build HamburgerDrawer Component

As a developer,
I want the HamburgerDrawer off-canvas navigation component built with all management section links,
So that every configuration screen in this epic has a consistent, accessible entry point without polluting the waiter order flow.

**Acceptance Criteria:**

**Given** an owner or manager views any screen with the `ContextHeader`
**When** they tap the hamburger icon in the header
**Then** the `HamburgerDrawer` opens as an off-canvas overlay; it does not push or reflow the main content behind it; no bottom tab bar is used anywhere in the application

**Given** the `HamburgerDrawer` is open for a manager or owner
**When** they view its contents
**Then** it lists navigation links to all management sections: Staff Accounts, Zones & Tables, Menu Management, Station Config, Feature Flags & Branding; each link has ≥ 44×44px touch targets

**Given** the `HamburgerDrawer` is open in `[data-context="waiter"]`
**When** a waiter views the drawer contents
**Then** management section links are not visible or are restricted to their role; the drawer shows only waiter-appropriate items

**Given** the `HamburgerDrawer` is open
**When** the user taps outside the drawer or presses Escape
**Then** the drawer closes; focus returns to the hamburger icon that triggered it

**Given** the `HamburgerDrawer`
**When** a screen reader navigates to it
**Then** it is announced as a navigation landmark; focus is trapped within the drawer while open; the close button is the first or last focusable element

**Given** the `HamburgerDrawer` rendered in `[data-context="owner"]`
**When** it opens
**Then** the drawer background and text colours are legible against the neutral-900 dashboard surface using dark-surface token variants

---

### Story 10.2: Implement Staff Account Management

As an owner,
I want to create, edit, and deactivate staff accounts with assigned roles and PINs,
So that I can control exactly who can access the system and what each person is permitted to do.

**Acceptance Criteria:**

**Given** an owner navigates to Staff Accounts via the `HamburgerDrawer`
**When** the staff list loads
**Then** all staff accounts are listed with: display name, role badge, and active/inactive status; load time is under 1 second on the restaurant LAN

**Given** an owner taps "Add Staff" and submits the form with `{ name, role, pin }`
**When** `POST /api/staff` is called
**Then** the PIN is hashed with bcrypt (cost 10) server-side before storage; the plaintext PIN is never written to the database, logged, or returned in any response; a new `staff` row is created with `name`, `role`, `pin_hash`, `active: true`, and `created_at`; HTTP 201 is returned

**Given** an owner submits a new or changed PIN for any staff member
**When** the PIN is validated before saving
**Then** it is rejected with HTTP 409 and the message "That PIN is already in use" if any other **active** staff member in the tenant already holds it; the check is performed by comparing the candidate PIN against every active `pin_hash` with bcrypt, because salted hashes cannot be compared directly and a unique index on `pin_hash` would not work

> **Added 2026-09-06 by the Story 3.3 code review.** A PIN is the entire credential — the login request carries no staff id or selector, and `POST /api/auth/login` loops every active staff member and takes the first bcrypt match. Two staff sharing a PIN therefore attributes every action by the second to the first, silently and permanently, which defeats the append-only audit trail this product is built around. Fixing PIN length at 4 digits (FR38, amended the same day) shrank the space to 10,000 values and raised the collision probability roughly 100x: negligible at 3 staff, better than even odds that some pair collides at around 25. The comparison costs one bcrypt call per active staff member, which is the same cost the login route already pays on every sign-in, and it happens only when a PIN is set.

**Given** the create form is submitted
**When** the `role` field is inspected
**Then** it accepts only: `"staff"`, `"manager"`, `"owner"`, `"kitchen"`; any other value returns HTTP 422

**Given** an owner edits a staff member's details
**When** `PATCH /api/staff/:staffId` is called with updated fields
**Then** only provided fields are updated; if a new PIN is included, it is re-hashed before storage; the old PIN hash is replaced; HTTP 200 is returned with the updated record (PIN hash excluded from response)

**Given** an owner deactivates a staff account
**When** `PATCH /api/staff/:staffId` is called with `{ active: false }`
**Then** `active` is set to `false`; all existing sessions for that staff member are immediately invalidated; the staff member cannot authenticate until reactivated; the `staff` row is not deleted (preserving audit trail integrity)

**Given** an owner attempts to deactivate the only remaining active owner account
**When** the deactivation is submitted
**Then** HTTP 422 is returned with `{ success: false, error: { code: "CANNOT_DEACTIVATE_LAST_OWNER" } }`; the account remains active

**Given** a staff member with role `"manager"` or `"staff"` attempts to call `POST /api/staff`
**When** the middleware checks the role
**Then** HTTP 403 is returned; staff account management is restricted to `"owner"` role only

---

### Story 10.3: Implement Zone, Table & Station Configuration

As an owner,
I want to configure the restaurant's zone names, table layout, and per-station ticket output mode,
So that the system accurately reflects the physical layout and production setup of the restaurant.

**Acceptance Criteria:**

**Given** an owner navigates to Zones & Tables via the `HamburgerDrawer`
**When** the configuration screen loads
**Then** all existing zones are listed with their names and table counts; an "Add Zone" button is visible; existing zones and tables are editable

**Given** an owner creates a new zone
**When** `POST /api/zones` is called with `{ name: string }`
**Then** a new `zone` row is created; HTTP 201 is returned; the new zone appears immediately in the waiter's `ZoneChipBar` on next load

**Given** an owner adds a table to a zone
**When** `POST /api/zones/:zoneId/tables` is called with `{ identifier: string }`
**Then** a new `table` row is created with `zone_id` and `identifier`; HTTP 201 is returned; the new table appears in the waiter's table grid on next load

**Given** an owner edits a zone name or table identifier
**When** `PATCH /api/zones/:zoneId` or `PATCH /api/tables/:tableId` is called
**Then** the name or identifier is updated; the change is reflected in the waiter's UI on next load; active sessions on affected tables are not disrupted

> **Amended 2026-09-06.** Two notes for whoever builds this story. (1) **Table availability is NOT owned here** — taking a table out of service and returning it are Story 3.7, and return-to-service is namespaced under `/api/config` so the existing owner-only policy enforces it. (2) `PATCH /api/tables/:tableId` as written sits under the `/api/tables` prefix, which is `owner + waiter` for every write — so this rename route is currently **waiter-reachable**, against `prd.md:341-357` reserving configuration for owner. Move it under `/api/config/tables/:tableId` or give it explicit owner-only enforcement. A dynamic path segment defeats longest-prefix specialisation, so the namespace is what carries the permission.

**Given** an owner attempts to delete a zone or table that has an active session
**When** the deletion is submitted
**Then** HTTP 409 is returned with `{ success: false, error: { code: "TABLE_HAS_ACTIVE_SESSION" } }`; the zone or table is not deleted while sessions exist

**Given** an owner navigates to Station Config
**When** the configuration screen loads
**Then** all configured stations are listed with their current `output_mode` (print or kds), `connection_mode` (TCP or USB), and `printer_ip` (if TCP)

**Given** an owner changes a station's `output_mode` from `"print"` to `"kds"` and saves
**When** `PATCH /api/station-configs/:stationId` is called with `{ outputMode: "kds" }`
**Then** the station config is updated; new orders submitted after the change display on the KDS screen instead of printing; previously printed tickets are unaffected

---

### Story 10.4: Implement Menu Management

As an owner,
I want to add, edit, and remove menu items with their categories, prices, and production destinations,
So that the system's menu accurately reflects what the restaurant serves and where each item is produced.

**Acceptance Criteria:**

**Given** an owner navigates to Menu Management via the `HamburgerDrawer`
**When** the menu editor loads
**Then** all categories are listed with their items; each item shows: name, price (in LKR, converted from paisa for display), production destination, and availability status; load time is under 1 second on the restaurant LAN

**Given** an owner taps "Add Item" and submits with `{ name, categoryId, price, productionDestination, available }`
**When** `POST /api/menu-items` is called
**Then** `price` is stored as integer paisa (UI collects LKR and converts: `Math.round(lkr * 100)`); `productionDestination` accepts only `"kitchen"`, `"pizza_kitchen"`, or `"bar"`; a new `menu_item` row is created; HTTP 201 is returned; the item appears in the waiter's menu on next load

**Given** an owner edits an existing item's price
**When** `PATCH /api/menu-items/:itemId` is called with `{ price: <integer paisa> }`
**Then** the price is updated; the new price applies to all future orders; existing generated bills are not retroactively changed

**Given** an owner changes an item's production destination
**When** `PATCH /api/menu-items/:itemId` is called with `{ productionDestination: "bar" }`
**Then** the destination is updated; future orders of that item route to the bar; existing submitted `order_event` rows retain the destination recorded at time of order

**Given** an owner taps "Remove Item"
**When** `DELETE /api/menu-items/:itemId` is called
**Then** the item is soft-deleted (`deleted: true`) rather than hard-deleted; it no longer appears in the waiter's menu; existing `order_event` rows referencing that item retain their data

**Given** a staff member with role `"manager"` or `"staff"` attempts to call `POST /api/menu-items` or `DELETE /api/menu-items/:itemId`
**When** the middleware checks the role
**Then** HTTP 403 is returned; full menu management (add/remove) is restricted to `"owner"`

---

### Story 10.5: Implement Tenant Feature Flags & Brand Customization

As an owner,
I want to toggle feature flags and customise the brand colour of the system,
So that I can enable or disable optional capabilities and match the system's appearance to the restaurant's identity.

**Acceptance Criteria:**

**Given** an owner navigates to Feature Flags & Branding via the `HamburgerDrawer`
**When** the configuration screen loads
**Then** all configurable feature flags are listed with their current values and controls: `zone_map_enabled` (toggle), `long_open_threshold_minutes` (number input), `financial_action_reauth` (toggle), `auth_mode` (dropdown), `session_timeout_minutes` (number input)

**Given** an owner toggles a feature flag and saves
**When** `PATCH /api/tenant-config` is called with the updated flag values
**Then** the `tenant_config` row is updated; the change takes effect on the next request that reads the flag — no code deployment or server restart is required (FR59)

**Given** the brand customization section renders
**When** an owner views it
**Then** 8–10 curated brand colour presets are displayed as colour swatches; the currently active preset is highlighted; a "Custom Colour" option with a hex input field is also available (UX-DR20)

**Given** an owner selects a brand colour preset or enters a custom hex
**When** `PATCH /api/tenant-config` is called with `{ brandColor: "#RRGGBB" }`
**Then** the hex value is validated server-side for WCAG AA compliance (contrast ratio ≥ 4.5:1 against white); if it passes, `brand_color` is saved and the CSS custom property `--color-brand` updates on next page load

**Given** an owner enters a custom hex colour that fails WCAG AA validation
**When** `PATCH /api/tenant-config` is called
**Then** HTTP 422 is returned with `{ success: false, error: { code: "INSUFFICIENT_CONTRAST", contrastRatio: 3.2 } }`; the brand colour is not saved; an inline error explains the WCAG AA requirement

**Given** a valid custom hex colour is saved
**When** the update is stored
**Then** all 9 scale variants (`brand-50` through `brand-900`) are derived from the base colour; the derived `brand-600` interactive colour is separately validated for WCAG AA before saving

---

## Epic 11: Vendor Support APIs & Infrastructure

**Goal:** Implement the per-deployment vendor support layer — vendor-authenticated diagnostic endpoint, log streaming, remote container restart, backup automation and on-demand backup API, and Uptime Kuma proactive alerting. The vendor platform (a separate future project) consumes these APIs to provide a unified multi-restaurant management dashboard.

### Story 11.1: Implement Vendor Auth & Diagnostic Health Endpoint

As the vendor platform,
I want a protected diagnostic endpoint on each CDRMS deployment authenticated by vendor-only credentials,
So that the vendor platform can query the full health state of any restaurant's system without using restaurant staff credentials.

**Acceptance Criteria:**

**Given** `GET /vendor/health` is called without vendor credentials
**When** the Route Handler checks authentication
**Then** HTTP 401 is returned; no diagnostic data is exposed; the endpoint does not acknowledge its own existence to unauthenticated callers

**Given** `GET /vendor/health` is called with a valid vendor Bearer token (from `VENDOR_API_KEY` env var)
**When** the Route Handler runs all diagnostic checks
**Then** HTTP 200 is returned with a JSON payload containing:
- `internet`: `"reachable"` or `"unreachable"` (ping to external IP with 3s timeout)
- `app`: `"ok"` (endpoint responding is sufficient)
- `db`: `"connected"` or `"error"` (live pool query)
- `printer`: `"reachable"` or `"unreachable"` per configured printer (TCP connect to `PRINTER_IP:9100` with 3s timeout)
- `disk`: `{ used_gb, free_gb, percent_used }` from the host volume
- `memory`: `{ used_mb, free_mb, percent_used }` from the host
- `containers`: array of `{ name, status, uptime_seconds }` for all Docker Compose services
- `last_backup_at`: ISO timestamp of the most recent successful backup file, or `null` if none

**Given** the vendor credentials stored in the deployment
**When** they are inspected
**Then** `VENDOR_API_KEY` is set as an environment variable; it is completely separate from the `sessions` table and all restaurant staff authentication; no restaurant role can authenticate to `/vendor/health` using their PIN or session cookie (NFR-V2)

**Given** one diagnostic check fails (e.g., printer unreachable)
**When** `GET /vendor/health` responds
**Then** the overall response still returns HTTP 200 with all check results; the failing check shows its error state; the vendor platform receives the full picture regardless of partial failure

**Given** `GET /vendor/health` is accessed from a non-Tailscale public IP
**When** the request arrives
**Then** the Docker network configuration ensures the port is not reachable from the public internet (NFR-V1); access is only possible via Tailscale or the restaurant LAN

---

### Story 11.2: Implement Log Streaming & Remote Container Restart API

As the vendor platform,
I want to stream live application error logs and trigger container restarts from each CDRMS deployment,
So that I can diagnose issues in real time and recover a stuck deployment without SSH access.

**Acceptance Criteria:**

**Given** `GET /vendor/logs` is called with valid vendor credentials
**When** the connection is established
**Then** the endpoint responds with `Content-Type: text/event-stream` (Server-Sent Events); application error log lines are streamed in real time as they are written; each event includes the log line text and a timestamp; the connection remains open until the client disconnects

**Given** the log stream is active with no new log lines for 30 seconds
**When** the keep-alive interval fires
**Then** a comment line (`: ping`) is sent to prevent connection timeout; the stream does not close

**Given** `GET /vendor/logs` is called without vendor credentials
**When** the Route Handler checks authentication
**Then** HTTP 401 is returned; no log data is streamed

**Given** `POST /vendor/containers/app/restart` is called with valid vendor credentials
**When** the Route Handler processes the request
**Then** the Portainer API is called to restart the `app` container; HTTP 202 is returned immediately with `{ status: "restart_initiated" }`; the restart completes within 30 seconds under normal conditions (NFR-V3)

**Given** `POST /vendor/containers/all/restart` is called with valid vendor credentials
**When** the Route Handler processes the request
**Then** the Portainer API is called to restart all services in the Docker Compose stack; HTTP 202 is returned immediately; the operation completes within 30 seconds (NFR-V3)

**Given** the Portainer API is unreachable when a restart is triggered
**When** the Route Handler handles the error
**Then** HTTP 503 is returned with `{ success: false, error: { code: "PORTAINER_UNREACHABLE" } }`; no partial restart is attempted

**Given** operational order, payment, or staff data
**When** the log stream or restart API is active
**Then** no operational data (order contents, payment amounts, staff PINs) is included in log output or restart payloads transmitted to the vendor (NFR-V4)

---

### Story 11.3: Implement Backup Automation & On-Demand Backup API

As the vendor platform,
I want automated daily backups running on each CDRMS deployment and an API to trigger and download backups on demand,
So that data is protected automatically and I can retrieve a backup for recovery or audit without SSH access.

**Acceptance Criteria:**

**Given** the Docker Compose stack is running
**When** the system clock reaches 03:00 local time
**Then** `backup.sh` executes automatically; it runs `pg_dump` against the local PostgreSQL instance; the output file is written to a host-mounted volume as `backup_YYYY-MM-DD_HH-MM-SS.sql.gz`

**Given** a backup file is written
**When** it is inspected
**Then** it is a valid, restorable `pg_dump` file; it is gzip-compressed; the filename includes the timestamp of the backup run

**Given** backup files accumulate over time
**When** `backup.sh` runs
**Then** it deletes backup files older than 30 days from the backup volume before writing the new file; no more than 31 files exist in the backup directory at any time

**Given** `GET /vendor/backups` is called with valid vendor credentials
**When** the Route Handler responds
**Then** it returns a JSON array of available backup files with `{ filename, size_bytes, created_at }` sorted newest first; response time is under 500ms

**Given** `POST /vendor/backups/trigger` is called with valid vendor credentials
**When** the Route Handler processes the request
**Then** `backup.sh` is invoked immediately; HTTP 202 is returned with `{ status: "backup_initiated" }`; the backup file is written to the backup volume within 60 seconds for a typical database size

**Given** `GET /vendor/backups/:filename` is called with valid vendor credentials and a valid filename
**When** the Route Handler serves the file
**Then** the backup file is streamed as a binary download with `Content-Type: application/gzip` and `Content-Disposition: attachment`; the file is served over the Tailscale connection; no backup data is routed through any external service (NFR-V4)

**Given** `GET /vendor/backups/:filename` is called with a filename that does not exist
**When** the Route Handler checks
**Then** HTTP 404 is returned; the filename is validated against a strict pattern before any file access to prevent directory traversal

---

### Story 11.4: Configure Uptime Kuma Monitoring & Alerting

As the vendor,
I want Uptime Kuma to continuously monitor each CDRMS deployment's health endpoint and alert me within 2 minutes of any failure,
So that I know about restaurant system problems proactively before the restaurant staff have to call me.

**Acceptance Criteria:**

**Given** the Uptime Kuma service is running (from Story 1.4)
**When** it is configured for this deployment
**Then** a monitor is set up targeting `GET /api/health` with a polling interval of 60 seconds; the monitor is named with the restaurant's identifier for easy identification in the vendor's alert feed

**Given** the Uptime Kuma monitor polls `GET /api/health`
**When** the endpoint returns HTTP 200 with `status: "ok"`
**Then** Uptime Kuma records the check as UP; no alert is sent

**Given** the Uptime Kuma monitor polls `GET /api/health`
**When** the endpoint returns HTTP 503, times out, or is unreachable
**Then** Uptime Kuma records the check as DOWN; a Telegram notification is sent to the configured vendor alert channel within 2 minutes of the first failed check (NFR-V5)

**Given** the Telegram notification is sent
**When** the vendor receives it
**Then** it includes: restaurant name, deployment identifier, failure type, timestamp of first failure, and a link to the Uptime Kuma status page for that monitor

**Given** the monitored endpoint recovers after a DOWN period
**When** Uptime Kuma detects the recovery
**Then** a Telegram recovery notification is sent; the message indicates the system is back UP and includes the duration of the outage

**Given** the Uptime Kuma configuration
**When** it is inspected
**Then** all Uptime Kuma data is stored in its own named volume, not in the PostgreSQL instance; Uptime Kuma is isolated from the restaurant's operational database

**Given** Uptime Kuma is running and configured
**When** the vendor platform aggregates status across multiple restaurant deployments
**Then** each deployment's Uptime Kuma operates independently; a failure in one deployment does not affect monitoring of other deployments


