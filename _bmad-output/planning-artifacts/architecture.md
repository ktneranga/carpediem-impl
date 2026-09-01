---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
workflowType: 'architecture'
lastStep: 8
status: 'complete'
completedAt: '2026-05-23'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
  - _bmad-output/planning-artifacts/research/market-restaurant-mgmt-software-sri-lanka-research-2026-05-14.md
  - _bmad-output/planning-artifacts/research/technical-tech-stack-restaurant-management-system-research-2026-05-16.md
  - _bmad-output/planning-artifacts/research/technical-targeted-restaurant-update-delivery-docker-watchtower-research-2026-05-17.md
workflowType: 'architecture'
project_name: 'carpe-diem-restaurant'
user_name: 'Teran'
date: '2026-05-23'
---

# Architecture Decision Document — Carpe Diem Restaurant Management System

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

---

## Project Context Analysis

### Requirements Overview

65 functional requirements across 11 categories, 31 non-functional requirements across 7 domains.

| Category | FR Count | Architectural Weight |
|---|---|---|
| Order Entry & Routing | 8 | High — multi-destination, multi-seat, open-tab model |
| Ticket Output (Print/Display) | 7 | High — ESC/POS TCP integration, failure alerting |
| Bill Generation & Settlement | 7 | High — drag-and-drop split engine, real-time totals |
| Auth & RBAC | 7 | High — 4 session modes, per-action attribution |
| Audit Trail & Disputes | 5 | High — append-only at DB level, immutable |
| Owner Dashboard & Reporting | 7 | Medium — real-time revenue, cash gap, remote access |
| Zone & Table Management | 5 | Medium — WebSocket sync across all devices |
| Payment Recording | 5 | Medium — cash/card/split, triggers table close |
| Inventory Management | 5 | Medium — atomic decrements, concurrent safety |
| System Configuration | 5 | Medium — feature flags, zone/menu/staff management |
| Vendor Operations | 7 | Medium — /vendor/health, Portainer, Uptime Kuma |

**Critical NFRs driving architecture:**

- **NFR-P1:** Order submission + ticket print ≤ 3 seconds — constrains WebSocket + printer pipeline latency budget
- **NFR-R1:** Zero internet dependency for all core operations — LAN-first, no cloud relay in the hot path
- **NFR-D1 + NFR-S3:** Append-only records at database level — no UPDATE/DELETE on audit tables, ever
- **NFR-D3 + NFR-D4:** Atomic concurrent writes — race conditions on inventory and table status are prohibited
- **NFR-SC1:** Each restaurant is a completely isolated Docker Compose stack

### Scale & Complexity

- **Primary domain:** Full-stack TypeScript PWA — multi-device, real-time, hardware integration
- **Complexity level:** Medium-high (PRD classified "medium" but ESC/POS integration + real-time multi-device sync + drag-and-drop split engine + vendor ops plane pushes this upward)
- **Estimated architectural subsystems:** ~9 distinct services/components

### Technical Constraints & Dependencies

| Constraint | Source | Architectural Impact |
|---|---|---|
| LAN-only hot path | NFR-R1 | WebSocket server must run locally; no cloud relay for real-time events |
| Docker Compose isolated deployment | NFR-SC1 | All services containerized; env-var driven config per tenant |
| PostgreSQL local volume | NFR-R3 | Database never touched on app container updates; migrations auto-apply on startup |
| ESC/POS TCP printing from Node.js | FR14–FR18 | Browser cannot print ESC/POS; server handles raw TCP to printer on port 9100 |
| Append-only audit trail | NFR-D1, NFR-S3 | Core tables are insert-only; corrections are new records, never edits |
| Tailscale-only remote access | NFR-S5, NFR-V1 | No public ports exposed; all remote access routed through Tailscale mesh |
| No card data transited or stored | Domain compliance | PCI-DSS scope eliminated; application records payment outcome only |
| No customer PII collected | Domain compliance | All orders are table-scoped and anonymous |

### Cross-Cutting Concerns

Seven concerns affect every layer of the implementation:

1. **Authentication & per-action audit attribution** — every write action stores its own `staff_id` attributed to whoever authenticated for that specific action, not inherited from session. Affects every API route handler.

2. **Append-only audit trail** — every order entry, modification, payment, comp, and dispute generates an immutable append-only record. Schema must be designed insert-only for audit tables from day one.

3. **Real-time state sync** — table occupancy, order state, inventory counts, and KOT/BOT ticket visibility must be consistent across all active devices simultaneously. Drives a WebSocket pub/sub architecture.

4. **Feature flags** — `auth_mode`, `kds_display_enabled`, `per_station_printers`, `ticket_output_mode` are read from the PostgreSQL config table and drive conditional code paths throughout the entire stack.

5. **Multi-destination ticket routing** — every order item carries a production destination (Kitchen / Pizza Kitchen / Bar). Routing logic runs at order submission and drives ticket generation, print queue, and KDS display simultaneously.

6. **ESC/POS print pipeline** — order submission → item routing → ticket generation → TCP print is a single transactional pipeline. Failure at any stage must surface as a visible alert; a failed print is never silently dropped.

7. **Tenant isolation** — single-tenant-per-stack model means no shared state; config, env vars, and feature flags are applied consistently per deployment via Docker environment variables and the PostgreSQL config table.

---

## Starter Template Evaluation

### Primary Technology Domain

Full-stack TypeScript PWA — Next.js App Router, local PostgreSQL (Docker container), LAN-first deployment. Single codebase serving three device contexts: waiter tablet, owner mobile, kitchen display.

### Starter Options Considered

| Starter | Key Decisions | Fit for CDRMS |
|---|---|---|
| **create-next-app** | TS, Tailwind, App Router, ESLint, Turbopack | ✅ Clean slate, full control |
| **create-t3-app** | tRPC v11 + Drizzle + Auth.js v5 + Tailwind | ⚠️ Auth.js is OAuth-only — wrong fit for PIN auth; tRPC doesn't cover WebSocket hot path |
| **ixartz Next.js Boilerplate** | Next.js 16, Tailwind 4, Drizzle, Vitest, Playwright | ⚠️ Good DX but opinionated structure may conflict with `[data-context]` PWA patterns |

### Selected Starter: create-next-app

**Rationale:** Clean baseline with full control over additions. T3's Auth.js assumption conflicts directly with custom PIN session model. tRPC's query/mutation pattern does not serve the WebSocket real-time hot path — we would be working around it rather than with it.

**Initialization command:**

```bash
pnpm create next-app@latest carpe-diem-rms \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir \
  --import-alias "@/*"
```

**Post-init additions:**

```bash
# UI component system
pnpm dlx shadcn@latest init

# Database ORM — Drizzle (lighter runtime than Prisma, strong append-only insert patterns)
pnpm add drizzle-orm pg
pnpm add -D drizzle-kit @types/pg

# Real-time sync
pnpm add socket.io socket.io-client

# Owner dashboard charts
pnpm add recharts

# Split bill drag-and-drop
pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

**Architectural decisions made by starter:**

| Area | Decision |
|---|---|
| Language | TypeScript strict mode |
| Router | Next.js App Router (RSC + Client Components) |
| Styling | Tailwind CSS v4 — `[data-context]` attribute variants work natively |
| Build tooling | Turbopack (dev), Next.js build (prod) |
| Linting | ESLint + typescript-eslint |
| Import aliases | `@/*` → `src/*` |
| Directory structure | `src/app/`, `src/components/`, `src/lib/`, `src/server/` |

**Note:** Database is plain PostgreSQL in a Docker container (`postgres:17-alpine`). Supabase is not used — hosted Supabase violates NFR-R1 (internet dependency) and NFR-S4 (local data residency). Self-hosted Supabase is 20+ services — unnecessary weight for a single-tenant Docker Compose stack.

**Decisions deferred to Step 4:**
- Database schema and migration strategy
- WebSocket architecture (Socket.io server placement)
- API layer pattern (Server Actions vs Route Handlers vs hybrid)
- Authentication session implementation
- Docker Compose service structure
- ESC/POS printing service architecture
- State management pattern

---

## Core Architectural Decisions

### Decision Priority Analysis

**Critical decisions (block implementation):**
- WebSocket server placement — Next.js custom server required; App Router alone cannot handle WS upgrade
- API layer pattern — Route Handlers for all order/payment writes (Socket.io emit co-location)
- Session storage — PostgreSQL sessions table + httpOnly cookie (stateless JWT ruled out; must support immediate invalidation)
- Append-only enforcement — dual-layer: application code + PostgreSQL RULE/trigger

**Important decisions (shape architecture):**
- State management — TanStack Query (server state) + Zustand (UI state) + Socket.io invalidation
- Migration strategy — Drizzle migrator runs on container startup, SQL files committed to repo
- ESC/POS service — native Node.js `net` TCP client inside Route Handler (no separate service)
- `[data-context]` implementation — set on `<html>` from session role in root layout (server-side)

**Deferred to post-MVP:**
- Redis caching — not needed at single-restaurant scale; TanStack Query + PostgreSQL sufficient
- Cloud backup — owner opt-in only; not in MVP scope
- Multi-restaurant vendor fleet dashboard — post-MVP SaaS phase

---

### Data Architecture

**ORM:** Drizzle ORM — connects from `app` container to `db` container over Docker internal network (`postgres://db:5432/cdrms`).

**Migration strategy:** `drizzle-orm/migrator` called in the app entrypoint before the HTTP server starts. Generated SQL migration files committed to the repo. No manual `drizzle-kit push` in production. Migrations are idempotent and applied automatically on every container start.

**Append-only enforcement (dual-layer):**
- Application layer: no `UPDATE` or `DELETE` is ever called on `order_events`, `payment_records`, `comp_records`, `dispute_records` tables in any codebase path
- Database layer: PostgreSQL `RULE` that `REJECT`s any UPDATE or DELETE on these tables — a bug or injection cannot bypass the constraint

**Caching strategy:** No Redis. Menu items and zone/table structure cached via TanStack Query (stale-while-revalidate). Order state and table occupancy are invalidated on Socket.io events — no polling. All persistence in local PostgreSQL.

**Atomic operations:** PostgreSQL transactions used for all inventory decrements and table status changes. `SELECT ... FOR UPDATE` on inventory rows during order submission prevents concurrent orders from driving a count below zero without triggering the unavailable flag (NFR-D4).

---

### Authentication & Security

**PIN hashing:** `bcrypt` at cost factor 10. Applied to all 4–6 digit PINs at rest. Plaintext PIN never persisted, logged, or transmitted (NFR-S1).

**Session storage:** PostgreSQL `sessions` table — not JWT. JWTs are stateless and cannot be invalidated immediately; the `session_short` auth mode requires expiry on idle timeout. Schema:
```
sessions(session_id UUID PK, staff_id FK, role, created_at, last_active_at, expires_at)
```
Stored in an `httpOnly; SameSite=Strict; Secure` cookie named `__cdrms_session`.

**Session middleware:** Next.js `middleware.ts` intercepts every request. Reads session cookie → validates `sessions` table → injects `x-staff-id` and `x-staff-role` headers. Route Handlers and Server Actions read from these headers. No repeated session DB lookup per action beyond the middleware pass.

**Financial reauth:** When `financial_action_reauth = true`, bill generation and payment Route Handlers require a fresh PIN in the request body, validated inline regardless of active session state. The `staff_id` stored on that action is the one who provided the fresh PIN.

**Vendor credentials:** Separate `vendor_credentials` table. `/vendor/*` routes handled by a separate middleware branch — completely isolated from staff session logic. Vendor auth token delivered via Tailscale-only route.

**No public ports:** Only port 3000 (app) is exposed on the LAN. Portainer (9000) and Uptime Kuma (3001) are bound to the Tailscale interface only. No public internet exposure (NFR-S5, NFR-V1).

---

### API & Communication Patterns

**API layer — Route Handlers as primary pattern:**
All order, payment, and real-time-adjacent write operations use Next.js Route Handlers (`src/app/api/`). Socket.io `emit()` is called inside the Route Handler immediately after the DB write — DB write and WebSocket broadcast are co-located in the same function.

Server Actions are used only for: owner configuration pages (menu management, zone setup, staff management). These never need WebSocket broadcast and benefit from RSC-native form handling.

**WebSocket architecture — Next.js custom server:**
Next.js App Router does not natively support WebSocket upgrade. Solution: a custom `server.ts` that creates the HTTP server for Next.js and attaches Socket.io to the same port (3000). One process, one container, one port.

```
client → WS connect (ws://[lan-ip]:3000) → Socket.io on custom server
client → HTTP request → Next.js App Router (same server)
Route Handler → io.emit('order:new', payload) → all subscribed clients
```

Socket.io rooms used for targeted broadcasts: `table:{tableId}`, `zone:{zoneId}`, `kitchen`, `bar`, `owner`.

**ESC/POS print pipeline:**
Node.js built-in `net` module — TCP client inside `POST /api/print` Route Handler. Connects to `{PRINTER_IP}:{PRINTER_PORT}` (env vars), writes raw ESC/POS bytes, closes connection. Timeout: 5 seconds. On failure: HTTP 503 returned to client + `printer:alert` Socket.io event emitted to all active devices (NFR-I2). A failed print is never silently dropped.

**Error handling standard:**
All Route Handlers return `{ success: boolean, data?: T, error?: { code: string, message: string } }`. Error codes are machine-readable constants (e.g., `PRINTER_TIMEOUT`, `ITEM_UNAVAILABLE`, `SESSION_EXPIRED`). Client-side error handling maps codes to user-facing messages in the UI layer.

---

### Frontend Architecture

**State management:**

| State type | Tool | Rationale |
|---|---|---|
| Server state (tables, orders, menu items) | TanStack Query | Cache + targeted invalidation on Socket.io events |
| Real-time events | Socket.io client | Calls `queryClient.invalidateQueries()` on relevant events |
| UI-only state (split bill canvas assignments, zone filter) | Zustand | Lightweight, no server round-trip; isolated to client session |
| Current staff session | React Context | Read from server on hydration via layout; rarely changes |

**PWA configuration:** `@ducanh2912/next-pwa` (actively maintained next-pwa fork). Service worker caches: menu items, zone/table structure, static assets (shell). Does not cache: order data, payment state. When Docker server is unreachable, app shows a graceful offline state — does not attempt to simulate functionality.

**`[data-context]` implementation:** Set as an attribute on `<html>` in the root layout, derived server-side from the authenticated staff role in the session cookie. Values: `waiter` | `owner` | `kitchen`. All Tailwind variant rules cascade from this root attribute. No client-side switching — context is fixed for the lifetime of the authenticated session.

**Component architecture:** shadcn/ui primitives as base. Seven custom POS components (TableCard, OrderActionStrip, KOTTicket, SplitBillCanvas, PINPad, DisputeTimeline, OwnerDashboard) built on top — defined in UX spec Step 11. No third-party POS component library.

---

### Infrastructure & Deployment

**Docker Compose service structure:**

```yaml
services:
  app:          # Next.js custom server + Socket.io    port 3000 (LAN)
  db:           # postgres:17-alpine                   port 5432 (internal only)
  portainer:    # portainer/portainer-ce               port 9000 (Tailscale only)
  uptime-kuma:  # louislam/uptime-kuma                 port 3001 (Tailscale only)
  watchtower:   # containrrr/watchtower                polls GHCR every 5 min
```

All services use `restart: unless-stopped`. PostgreSQL data mounted to a named host volume — never touched on app container updates (NFR-R3).

**CI/CD pipeline:** GitHub Actions → build Docker image on push to `main` → push to GHCR (GitHub Container Registry). Watchtower polls GHCR and pulls new image automatically. Zero-downtime deployment via `docker-rollout` + `/api/health` gate.

**Environment variables (per deployment):**
```
DATABASE_URL, PRINTER_IP, PRINTER_PORT, SESSION_SECRET,
VENDOR_SECRET, WATCHTOWER_HTTP_API_TOKEN, PORTAINER_URL,
TAILSCALE_AUTH_KEY, RESTAURANT_NAME, TIMEZONE
```

**Database backups:** Automated `pg_dump` triggered by a cron entry in the `db` container or a lightweight `backup` service, running at 03:00 local time (`TIMEZONE` env var). Compressed backup written to a host-mounted `/backups` volume. 30-day retention. On-demand backup triggered via Portainer API from the vendor support panel (FR-V4).

**Health check endpoint:** `GET /api/health` — returns JSON with app status, DB connection, printer reachability, memory usage, disk space. Used by Watchtower as deployment gate and by Uptime Kuma for proactive alerting. `/vendor/health` is the extended version with full diagnostic detail (FR-V1, FR-V2).

### Decision Impact Analysis

**Implementation sequence (order matters):**
1. Docker Compose stack + PostgreSQL container (foundation — everything else depends on it)
2. Drizzle schema + migrations (tables must exist before any app code runs)
3. Custom Next.js server + Socket.io attachment (required before any real-time feature)
4. Session middleware + PIN auth (required before any protected route)
5. Zone/table management + WebSocket sync (first real-time feature)
6. Order entry + multi-destination routing (core chain)
7. ESC/POS print pipeline (closes the KOT/BOT loop)
8. Bill generation + split bill canvas (settlement engine)
9. Payment recording + table close (completes the core chain)
10. Owner dashboard + vendor health endpoint (observability layer)

**Cross-component dependencies:**
- Socket.io rooms (`table:*`, `kitchen`, `bar`, `owner`) must be established before order submission is built
- `financial_action_reauth` middleware must be in place before bill generation and payment routes are built
- Append-only PostgreSQL RULE must be applied in the initial migration — not retroactively
- `[data-context]` attribute must be set in root layout before any component uses context-specific Tailwind variants

---

## Implementation Patterns & Consistency Rules

### Naming Patterns

**Database (PostgreSQL / Drizzle) — `snake_case` everywhere:**
```sql
-- Tables: plural snake_case
orders, order_items, order_events, staff_members, table_sessions, menu_items

-- Columns: snake_case
staff_id, created_at, last_active_at, portion_count, ticket_output_mode

-- Foreign keys: {table_singular}_id
staff_id, order_id, menu_item_id, table_session_id

-- Indexes: idx_{table}_{column(s)}
idx_order_items_order_id, idx_sessions_staff_id
```

**API endpoints — plural nouns, kebab-case, REST:**
```
GET  /api/tables
GET  /api/tables/:tableId/orders
POST /api/orders
POST /api/orders/:orderId/submit
POST /api/bills/:billId/payment
GET  /api/health
GET  /vendor/health          ← vendor namespace, not /api/
```

**TypeScript / React — standard JS conventions:**
```ts
// Variables & functions: camelCase
const staffId = ...
function getTableStatus() {}

// Components: PascalCase
function TableCard() {}

// Files: kebab-case
table-card.tsx, order-action-strip.tsx, use-socket.ts

// Types/Interfaces: PascalCase, no prefix/suffix
type Order = { ... }
interface StaffMember { ... }
type AuthMode = 'session_short' | 'session_persistent' | 'per_transaction' | 'per_action'

// Zod schemas: camelCase with Schema suffix
const createOrderSchema = z.object({ ... })
```

**Socket.io events — `domain:action`, past tense for broadcasts:**
```ts
// Server → client (broadcasts, past tense)
'order:submitted'       // new order entered
'table:opened'          // table session started
'table:closed'          // table session ended
'ticket:printed'        // ESC/POS confirmed
'printer:alert'         // printer failure
'inventory:depleted'    // item hit zero
'table:status_changed'  // occupancy change

// Client → server (commands, present tense)
'table:subscribe'       // client joins a room
'kitchen:subscribe'     // kitchen display subscribes
```

---

### Structure Patterns

**Project organisation — feature-based under `src/`:**
```
src/
  app/                          # Next.js App Router pages & API routes
    api/
      orders/route.ts
      tables/route.ts
      print/route.ts
      health/route.ts
    vendor/
      health/route.ts
    (waiter)/                   # waiter device route group
    (owner)/                    # owner device route group
    (kitchen)/                  # kitchen display route group
  components/
    ui/                         # shadcn/ui primitives (auto-generated, do not edit)
    pos/                        # custom POS components
      table-card.tsx
      order-action-strip.tsx
      pin-pad.tsx
      split-bill-canvas.tsx
      kot-ticket.tsx
  server/                       # SERVER-ONLY — never imported by client components
    db/
      schema.ts                 # Drizzle table definitions
      migrations/               # generated SQL files
      index.ts                  # db client singleton
    services/
      order.service.ts
      print.service.ts
      session.service.ts
    socket/
      index.ts                  # Socket.io server instance
      handlers/                 # event handler registration
  lib/                          # shared utilities (safe for client + server)
    validations/                # Zod schemas
    constants.ts
    utils.ts
  types/                        # shared TypeScript types
    index.ts
  hooks/                        # React hooks
    use-socket.ts
    use-table-status.ts
  store/                        # Zustand stores
    split-bill.store.ts
    ui.store.ts
```

**Test co-location — `.test.ts` next to source file:**
```
server/services/order.service.ts
server/services/order.service.test.ts
components/pos/pin-pad.tsx
components/pos/pin-pad.test.tsx
```

**`src/server/` is a hard boundary.** Nothing inside `src/server/` may be imported by any client component, hook, or store. The `server-only` npm package is added as a guard at the top of `src/server/db/index.ts` and `src/server/socket/index.ts`.

---

### Format Patterns

**API response envelope — always `{ success, data?, error? }`:**
```ts
// Success
{ success: true, data: { orderId: 'uuid', status: 'submitted' } }

// Error
{ success: false, error: { code: 'PRINTER_TIMEOUT', message: 'Printer did not respond within 5 seconds' } }
```

**Error codes — machine-readable string constants, never free-text:**
```
'PRINTER_TIMEOUT' | 'ITEM_UNAVAILABLE' | 'SESSION_EXPIRED' |
'INSUFFICIENT_PERMISSION' | 'TABLE_ALREADY_OCCUPIED' |
'INVALID_PIN' | 'ORDER_NOT_FOUND' | 'PAYMENT_ALREADY_RECORDED' |
'VALIDATION_ERROR' | 'INTERNAL_ERROR'
```

**Money — integer paisa, never float:**
```ts
// CORRECT — store and transmit as integer (LKR × 100)
{ amount: 24850 }   // = LKR 248.50

// WRONG
{ amount: 248.50 }  // floating point precision errors accumulate on totals
```
Display layer only: `(paisa / 100).toFixed(2)`. Never divide stored values for intermediate calculations.

**Dates — UTC ISO 8601 in JSON, local display via `Intl`:**
```ts
// API / DB storage: always UTC ISO string
{ createdAt: '2026-05-23T08:30:00.000Z' }

// Display only: convert using restaurant timezone from env
new Intl.DateTimeFormat('en-LK', { timeZone: process.env.TIMEZONE }).format(new Date(createdAt))
```

**DB → API field names:** Drizzle returns `snake_case`. A mapping layer in each service converts to `camelCase` before the Route Handler returns the response. API responses always use `camelCase` — raw DB column names never appear in responses.

---

### Communication Patterns

**Socket.io room subscription on connect:**
```ts
waiter:  socket.emit('table:subscribe', { tableId })   // joins 'table:{tableId}'
kitchen: socket.emit('kitchen:subscribe')               // joins 'kitchen'
bar:     socket.emit('bar:subscribe')                   // joins 'bar'
owner:   socket.emit('owner:subscribe')                 // joins 'owner'
```

**Event payload — always include `eventId`, `timestamp`, `staffId`, and primary entity ID:**
```ts
{
  eventId: 'uuid',
  timestamp: '2026-05-23T08:30:00.000Z',
  staffId: 'uuid',
  orderId: 'uuid',      // + domain-specific fields
}
```

**TanStack Query key convention — `[domain, id?]` arrays:**
```ts
['tables']                   // all tables
['tables', tableId]          // single table
['orders', tableId]          // orders for a table
['menu-items']               // full menu
['staff']                    // all staff
```
Socket.io handlers call `queryClient.invalidateQueries({ queryKey: ['tables'] })` — never manually patch cache entries.

**Zustand stores — state as nouns, actions as verbs:**
```ts
interface SplitBillStore {
  assignments: Record<string, string>      // itemId → personId
  assignItem: (itemId: string, personId: string) => void
  clearAssignments: () => void
}
```

---

### Process Patterns

**Validation — Zod at every API boundary before any DB interaction:**
```ts
const parsed = submitOrderSchema.safeParse(await req.json())
if (!parsed.success) {
  return Response.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, { status: 400 })
}
// DB interaction only after this point
```
Zod schemas in `src/lib/validations/` are shared between client (pre-submit feedback) and server (authoritative gate).

**Audit trail writes — `staffId` always explicit from middleware header:**
```ts
// CORRECT — taken from request header injected by session middleware
await db.insert(orderEvents).values({
  staffId: req.headers.get('x-staff-id'),
  eventType: 'ITEM_ADDED',
  ...
})

// WRONG — never derive staffId from a session object inside a service function
```

**Financial reauth — inline PIN check before DB write in bill/payment routes:**
```ts
const config = await getTenantConfig()
if (config.financialActionReauth) {
  const valid = await verifyPin(staffId, body.confirmationPin)
  if (!valid) return Response.json({ success: false, error: { code: 'INVALID_PIN' } }, { status: 401 })
}
// DB write proceeds only after successful reauth
```

**Error handling — try/catch in every Route Handler, no unhandled rejections:**
```ts
try {
  const result = await orderService.submit(parsed.data)
  return Response.json({ success: true, data: result })
} catch (err) {
  logger.error('order.submit.failed', { err, orderId: parsed.data.orderId })
  return Response.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Order submission failed' } }, { status: 500 })
}
```

**Loading states — TanStack Query `isPending` only, never manual boolean flags:**
```tsx
// CORRECT
const { data, isPending } = useQuery({ queryKey: ['tables'] })
if (isPending) return <TableGridSkeleton />

// WRONG — never manage loading state manually alongside TanStack Query
const [loading, setLoading] = useState(false)
```

---

### Enforcement Guidelines

**All agents MUST:**
- Use `snake_case` for all PostgreSQL identifiers; `camelCase` in TypeScript and API responses
- Return `{ success, data?, error? }` from every Route Handler — no raw response shortcuts
- Store all monetary values as integers (paisa) — convert to LKR only at display layer
- Pass `staffId` explicitly from `x-staff-id` header on every DB write — never infer from session context
- Call `queryClient.invalidateQueries()` on Socket.io events — never manually patch cache
- Never import from `src/server/` in any client component, hook, or store
- Run Zod validation before any DB interaction in Route Handlers
- Use `[domain, id?]` array format for all TanStack Query keys

**Anti-patterns — agents must never do these:**
- `UPDATE` or `DELETE` on `order_events`, `payment_records`, `comp_records`, `dispute_records`
- `parseFloat()` or arithmetic division on stored monetary amounts outside the display layer
- Deriving `staffId` from a session object inside a service — always accept as an explicit parameter
- Storing session data in `localStorage` — httpOnly cookie only
- Emitting a Socket.io event without `eventId`, `timestamp`, and a primary entity ID in the payload
- Using `console.error` in production code paths — use the structured logger

---

## Project Structure & Boundaries

### Requirements to Structure Mapping

| FR Category | Primary Location |
|---|---|
| Zone & Table Management (FR1–5) | `src/app/api/tables/`, `src/server/services/table.service.ts`, `src/components/pos/table-card.tsx` |
| Order Entry & Routing (FR6–13) | `src/app/api/orders/`, `src/server/services/order.service.ts`, `src/components/pos/order-action-strip.tsx` |
| Ticket Output (FR14–20) | `src/app/api/print/`, `src/server/services/print.service.ts`, `src/components/pos/kot-ticket.tsx`, `src/app/(kitchen)/` |
| Bill Generation & Settlement (FR21–27) | `src/app/api/bills/`, `src/server/services/bill.service.ts`, `src/components/pos/split-bill-canvas.tsx` |
| Payment Recording (FR28–32) | `src/app/api/bills/[billId]/payment/`, `src/server/services/payment.service.ts` |
| Inventory Management (FR33–37) | `src/app/api/inventory/`, `src/server/services/inventory.service.ts`, `src/app/(owner)/inventory/` |
| Auth & RBAC (FR38–44) | `src/middleware.ts`, `src/app/api/auth/`, `src/server/services/session.service.ts`, `src/components/pos/pin-pad.tsx` |
| Audit Trail & Disputes (FR44–48) | `src/server/services/audit.service.ts`, `src/app/api/audit/`, `src/components/pos/dispute-timeline.tsx` |
| Owner Dashboard (FR49–54) | `src/app/(owner)/dashboard/`, `src/server/services/dashboard.service.ts`, `src/components/pos/owner-dashboard.tsx` |
| System Configuration (FR55–59) | `src/app/(owner)/settings/`, `src/server/services/config.service.ts` |
| Vendor Operations (FR-V1–V7) | `src/app/vendor/`, `src/server/services/vendor.service.ts` |

### Complete Project Directory Structure

```
carpe-diem-rms/
├── package.json
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── drizzle.config.ts
├── server.ts                          # custom Next.js server — attaches Socket.io
│
├── docker/
│   ├── Dockerfile                     # multi-stage: deps → build → production
│   ├── docker-compose.yml             # app, db, portainer, uptime-kuma, watchtower
│   ├── docker-compose.override.yml    # dev: volume mounts, hot reload
│   ├── .env.example                   # all required env vars with inline docs
│   └── scripts/
│       ├── backup.sh                  # pg_dump + 30-day retention cleanup
│       ├── migrate.sh                 # drizzle migrator (container entrypoint)
│       └── healthcheck.sh             # Docker HEALTHCHECK instruction target
│
├── .github/
│   └── workflows/
│       └── build-and-push.yml         # main push → build image → push to GHCR
│
├── public/
│   ├── manifest.json                  # PWA manifest
│   └── icons/                         # PWA icons (192×192, 512×512)
│
└── src/
    ├── middleware.ts                   # session validation; injects x-staff-id, x-staff-role
    │
    ├── app/
    │   ├── layout.tsx                 # root layout — sets [data-context] from session role
    │   ├── globals.css
    │   │
    │   ├── api/
    │   │   ├── health/route.ts        # GET  — basic health (Watchtower gate)
    │   │   ├── auth/
    │   │   │   ├── login/route.ts     # POST — PIN verify, session create
    │   │   │   └── logout/route.ts    # POST — session invalidate
    │   │   ├── tables/
    │   │   │   ├── route.ts           # GET  — all tables + status
    │   │   │   └── [tableId]/
    │   │   │       ├── route.ts       # GET  — single table
    │   │   │       └── orders/route.ts# GET  — active orders on table
    │   │   ├── orders/
    │   │   │   ├── route.ts           # POST — create order session
    │   │   │   └── [orderId]/
    │   │   │       ├── route.ts       # GET  — order detail
    │   │   │       ├── items/route.ts # POST — add items to order
    │   │   │       └── submit/route.ts# POST — route to KOT/BOT + trigger print
    │   │   ├── bills/
    │   │   │   ├── route.ts           # POST — generate bill
    │   │   │   └── [billId]/
    │   │   │       ├── route.ts       # GET  — bill detail
    │   │   │       ├── split/route.ts # POST — item-to-person assignments
    │   │   │       └── payment/route.ts# POST — record payment, close if settled
    │   │   ├── print/route.ts         # POST — ESC/POS TCP print command
    │   │   ├── comps/route.ts         # POST — log comp with reason code
    │   │   ├── audit/route.ts         # GET  — audit trail (manager/owner)
    │   │   ├── inventory/
    │   │   │   ├── route.ts           # GET  — inventory state
    │   │   │   └── [itemId]/route.ts  # PATCH — adjust count, toggle availability
    │   │   ├── menu/
    │   │   │   ├── route.ts           # GET/POST — menu items
    │   │   │   └── [itemId]/route.ts  # PATCH/DELETE — edit item
    │   │   ├── staff/
    │   │   │   ├── route.ts           # GET/POST — staff list (owner only)
    │   │   │   └── [staffId]/route.ts # PATCH/DELETE — edit staff, set PIN
    │   │   └── config/route.ts        # GET/PATCH — tenant feature flags
    │   │
    │   ├── vendor/
    │   │   ├── health/route.ts        # GET  — full diagnostic dashboard (vendor auth)
    │   │   └── actions/
    │   │       ├── restart/route.ts   # POST — Portainer API container restart
    │   │       ├── backup/route.ts    # POST — on-demand pg_dump + download
    │   │       └── update/route.ts    # POST — Watchtower API update trigger
    │   │
    │   ├── (waiter)/
    │   │   ├── layout.tsx             # [data-context="waiter"]
    │   │   ├── page.tsx               # zone chip selector → table grid
    │   │   └── tables/[tableId]/
    │   │       ├── page.tsx           # order entry (items, seats, modifiers)
    │   │       └── settle/page.tsx    # bill generation + split bill canvas
    │   │
    │   ├── (owner)/
    │   │   ├── layout.tsx             # [data-context="owner"]
    │   │   ├── dashboard/page.tsx     # revenue, cash gap, comps, inventory alerts
    │   │   ├── inventory/page.tsx     # portion counts, manual adjustments
    │   │   ├── audit/page.tsx         # full audit trail with filters
    │   │   ├── menu/
    │   │   │   ├── page.tsx
    │   │   │   └── [itemId]/page.tsx
    │   │   ├── staff/
    │   │   │   ├── page.tsx
    │   │   │   └── [staffId]/page.tsx
    │   │   └── settings/page.tsx      # zones, auth mode, feature flags
    │   │
    │   ├── (kitchen)/
    │   │   ├── layout.tsx             # [data-context="kitchen"]
    │   │   └── page.tsx               # KDS — live KOT/BOT ticket feed
    │   │
    │   └── auth/
    │       └── login/page.tsx         # PIN entry (shared across roles)
    │
    ├── components/
    │   ├── ui/                        # shadcn/ui primitives (auto-generated, do not edit)
    │   ├── pos/
    │   │   ├── table-card.tsx         # FR1–5: table status + occupancy
    │   │   ├── table-card.test.tsx
    │   │   ├── order-action-strip.tsx # FR6–12: state-driven action bar
    │   │   ├── order-action-strip.test.tsx
    │   │   ├── pin-pad.tsx            # FR38–42: 80×80px PIN entry
    │   │   ├── pin-pad.test.tsx
    │   │   ├── split-bill-canvas.tsx  # FR22–24: @dnd-kit drag-and-drop
    │   │   ├── split-bill-canvas.test.tsx
    │   │   ├── kot-ticket.tsx         # FR19–20: KDS ticket display
    │   │   ├── kot-ticket.test.tsx
    │   │   ├── dispute-timeline.tsx   # FR45–47: per-item audit history
    │   │   ├── dispute-timeline.test.tsx
    │   │   ├── owner-dashboard.tsx    # FR49–54: Recharts composite dashboard
    │   │   ├── owner-dashboard.test.tsx
    │   │   ├── zone-chip-bar.tsx      # FR1: zone filter selector
    │   │   └── menu-search.tsx        # FR7: fuzzy item search
    │   └── layout/
    │       ├── context-header.tsx     # context-sensitive header + breadcrumb
    │       └── hamburger-drawer.tsx   # settings/management navigation drawer
    │
    ├── server/                        # SERVER-ONLY — 'server-only' package guard
    │   ├── db/
    │   │   ├── schema.ts              # all Drizzle table definitions
    │   │   ├── index.ts               # db client singleton
    │   │   └── migrations/            # generated SQL files (committed to repo)
    │   ├── services/
    │   │   ├── order.service.ts + .test.ts
    │   │   ├── bill.service.ts + .test.ts
    │   │   ├── payment.service.ts + .test.ts
    │   │   ├── print.service.ts + .test.ts    # ESC/POS TCP client
    │   │   ├── session.service.ts + .test.ts  # PIN bcrypt, session CRUD
    │   │   ├── audit.service.ts + .test.ts    # append-only event writes
    │   │   ├── inventory.service.ts + .test.ts# atomic decrement
    │   │   ├── dashboard.service.ts + .test.ts# revenue aggregation
    │   │   ├── config.service.ts + .test.ts   # tenant feature flags
    │   │   └── vendor.service.ts + .test.ts   # health checks, Portainer, backup
    │   └── socket/
    │       ├── index.ts               # Socket.io server instance + room setup
    │       └── handlers/
    │           ├── order.handler.ts   # order:submitted → kitchen + bar + owner rooms
    │           ├── table.handler.ts   # table:opened, table:closed, table:status_changed
    │           ├── printer.handler.ts # printer:alert on print failure
    │           └── inventory.handler.ts# inventory:depleted → owner room
    │
    ├── lib/
    │   ├── validations/               # Zod schemas — shared client + server
    │   │   ├── order.schema.ts
    │   │   ├── bill.schema.ts
    │   │   ├── payment.schema.ts
    │   │   ├── auth.schema.ts
    │   │   └── config.schema.ts
    │   ├── constants.ts               # error codes, event names, auth mode values
    │   ├── utils.ts                   # money formatting, date utils
    │   └── escpos.ts                  # ESC/POS byte command builders
    │
    ├── types/
    │   ├── index.ts                   # shared domain types
    │   └── db.ts                      # Drizzle inferred types
    │
    ├── hooks/
    │   ├── use-socket.ts              # Socket.io client — connect + room subscription
    │   ├── use-table-status.ts        # TanStack Query + socket invalidation
    │   ├── use-order.ts               # TanStack Query for active order
    │   ├── use-menu.ts                # TanStack Query for menu + availability
    │   └── use-session.ts             # current staff from React Context
    │
    └── store/
        ├── split-bill.store.ts        # Zustand: itemId → personId assignments
        └── ui.store.ts                # Zustand: zone filter, drawer open state
```

### Architectural Boundaries

**Server / Client boundary:**
- `src/server/` imports `server-only` at the top of `db/index.ts` and `socket/index.ts`
- Route Handlers call services; services call the DB client — never the reverse
- Components never import from `src/server/` — they call Route Handlers via fetch/TanStack Query

**Vendor boundary:**
- `/vendor/*` routes use a separate middleware branch checking `VENDOR_SECRET` header
- Restaurant staff session cookies are never checked on vendor routes
- Vendor routes reachable only via Tailscale — not exposed on the LAN

**Socket.io boundary:**
- Server instance lives in `src/server/socket/index.ts`
- Route Handlers import this instance to call `io.to(room).emit()`
- Client components access Socket.io only via `use-socket.ts` hook — never the server instance directly

### Core Data Flow — Order Submission

```
Waiter taps "Send Order"
  → POST /api/orders/:orderId/submit
  → middleware: validate session cookie → inject x-staff-id
  → submitOrderSchema.safeParse(body)
  → financial reauth check (if financialActionReauth = true)
  → order.service.submit(orderId, staffId)
      → inventory.service.decrementBatch()     [atomic transaction, SELECT FOR UPDATE]
      → audit.service.write('ITEMS_SUBMITTED') [append-only INSERT]
      → print.service.printTickets()            [TCP to PRINTER_IP:9100]
          → on timeout/fail: io.to('owner').emit('printer:alert', ...)
  → io.to('kitchen').emit('order:submitted', payload)
  → io.to('bar').emit('order:submitted', payload)
  → io.to('owner').emit('order:submitted', payload)
  → Response.json({ success: true, data: { orderId, ticketsPrinted } })

Client (waiter):
  → queryClient.invalidateQueries(['orders', tableId])
  → OrderActionStrip shows confirmation state

Client (kitchen display — receives 'order:submitted'):
  → queryClient.invalidateQueries(['kitchen-tickets'])
  → KOT card appears on KDS
```

---

## Architecture Validation Results

### Coherence Validation ✅

**Decision compatibility — all verified:**

| Pairing | Status | Note |
|---|---|---|
| Next.js 16 + Tailwind CSS v4 + shadcn/ui | ✅ | shadcn/ui updated for Tailwind v4 |
| Drizzle ORM + PostgreSQL 17 | ✅ | Native support |
| Socket.io + Next.js custom server | ✅ | Well-established pattern |
| TanStack Query + Zustand + React 18 | ✅ | No overlap in responsibility |
| @dnd-kit/core + React 18 | ✅ | Touch-native, no conflict |
| @ducanh2912/next-pwa + App Router | ✅ | Maintained fork targets App Router |
| Recharts + React 18 | ✅ | Stable |
| bcrypt + Node.js 20+ | ✅ | Native availability |
| Portainer + Uptime Kuma + Watchtower | ✅ | Standard self-hosted stack |

**Pool size correction applied (from validation):** `DATABASE_POOL_MAX=20` added to `.env.example`. Configure as `new pg.Pool({ max: parseInt(process.env.DATABASE_POOL_MAX ?? '10') })` in `src/server/db/index.ts`. Prevents connection exhaustion under NFR-P4 (10+ concurrent sessions).

**Pattern consistency:** `[data-context]` attribute works natively with Tailwind v4 arbitrary variants. Route Handler → Socket.io emit co-location is consistent throughout. TanStack Query key convention is uniform across all hooks. Append-only pattern enforced at both application and DB level independently.

**Structure alignment:** `src/server/` hard boundary, `/vendor/*` isolation, and implementation sequence are correctly ordered. No circular dependencies.

### Requirements Coverage Validation ✅

**Functional Requirements — all 65 FRs covered:**

| Category | Coverage | Primary location |
|---|---|---|
| FR1–5 Zone/Table | ✅ | `tables/` API, `table-card.tsx`, `(waiter)/page.tsx` |
| FR6–13 Order Entry | ✅ | `orders/` API, `order.service.ts`, `order-action-strip.tsx` |
| FR14–18 ESC/POS Print | ✅ | `print.service.ts`, `POST /api/print`, `printer.handler.ts` |
| FR19–20 KDS Display | ✅ | `kot-ticket.tsx`, `(kitchen)/page.tsx`, config flag |
| FR21–27 Bill/Settlement | ✅ | `bills/` API, `bill.service.ts`, `split-bill-canvas.tsx` |
| FR28–32 Payment | ✅ | `payment/route.ts`, `payment.service.ts` |
| FR33–37 Inventory | ✅ | `inventory/` API, `inventory.service.ts` (SELECT FOR UPDATE) |
| FR38–44 Auth/RBAC | ✅ | `middleware.ts`, `session.service.ts`, `pin-pad.tsx` |
| FR44–48 Audit Trail | ✅ | `audit.service.ts`, `GET /api/audit`, `dispute-timeline.tsx` |
| FR49–54 Owner Dashboard | ✅ | `dashboard.service.ts`, `owner-dashboard.tsx` |
| FR55–59 Configuration | ✅ | `config.service.ts`, `(owner)/settings/` |
| FR60 Long-open alerts | ✅ | `dashboard.service.ts` — `open_since` on table sessions |
| FR-V1–V7 Vendor Ops | ✅ | `vendor.service.ts`, `/vendor/*` routes |

**Non-Functional Requirements — all 31 NFRs covered:**

| NFR | Coverage |
|---|---|
| NFR-P1 (≤3s submission + print) | ✅ Server-side pipeline, LAN, print timeout 5s |
| NFR-P2 (≤1s table/menu load) | ✅ TanStack Query cache + LAN |
| NFR-P3 (≤2s bill generation) | ✅ Local DB only, no external calls |
| NFR-P4–P5 (10+ sessions, 40+ orders) | ✅ PostgreSQL pool (max 20) + Socket.io |
| NFR-S1 (PIN hashed) | ✅ bcrypt cost 10 in session.service.ts |
| NFR-S2 (Auth gates all routes) | ✅ middleware.ts on all protected paths |
| NFR-S3 (Audit immutable) | ✅ PostgreSQL RULE + insert-only audit.service.ts |
| NFR-S4 (Local data only) | ✅ No external data transmission in any hot path |
| NFR-S5 (Tailscale-only remote) | ✅ Portainer/Kuma bound to Tailscale interface only |
| NFR-R1 (LAN-only hot path) | ✅ No cloud dependencies in order/payment/print path |
| NFR-R2 (99.5% uptime) | ✅ `restart: unless-stopped` Docker policy |
| NFR-R3 (Data through updates) | ✅ Named PostgreSQL volume, app container updated independently |
| NFR-R4 (Daily backup) | ✅ `backup.sh` cron + 30-day retention |
| NFR-D1–D4 (Append-only, atomic) | ✅ DB RULE + SELECT FOR UPDATE in inventory.service.ts |
| NFR-I1–I4 (Printer, Watchtower, Tailscale) | ✅ All integrated in Docker Compose |
| NFR-SC1–SC2 (Isolated deployments) | ✅ Separate Docker Compose stack per tenant |
| NFR-V1–V5 (Vendor ops) | ✅ Tailscale-only access, vendor credential isolation |

### Implementation Readiness Validation ✅

**Decision completeness:** All critical decisions documented with rationale. Technology stack fully specified. Integration patterns defined for all 4 external integrations (printer, Tailscale, GHCR, Portainer).

**Structure completeness:** Every file that needs to exist is named, annotated with its FR responsibility, and placed in the correct directory. All 11 FR categories map to specific files.

**Pattern completeness:** 8 mandatory rules + 6 anti-patterns defined. Naming conventions cover DB, API, TypeScript, and Socket.io events. Process patterns cover validation, audit attribution, financial reauth, error handling, and loading states.

### Gap Analysis Results

**Critical gaps: None.**

**Important gaps addressed:**
- PostgreSQL connection pool size: resolved in validation — `DATABASE_POOL_MAX=20` added to environment config and `src/server/db/index.ts`

**Deferred (not gaps):**
- Database schema internals (column definitions, indexes): implementation-level detail, correctly owned by Epics & Stories phase
- Tailscale node provisioning steps: deployment documentation, not architecture
- OpenAPI spec: post-MVP, larger team concern
- Database ERD: useful context for Epics & Stories phase, can be generated from schema.ts

### Architecture Completeness Checklist

**Requirements Analysis**
- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed (medium-high, ~9 subsystems)
- [x] Technical constraints identified (8 constraints documented)
- [x] Cross-cutting concerns mapped (7 concerns)

**Architectural Decisions**
- [x] Critical decisions documented with rationale (WebSocket placement, session model, API layer, append-only enforcement)
- [x] Technology stack fully specified with versions
- [x] Integration patterns defined (Socket.io, ESC/POS, Tailscale, Watchtower, Portainer)
- [x] Performance considerations addressed (pool size, 3s latency budget, SELECT FOR UPDATE)

**Implementation Patterns**
- [x] Naming conventions established (DB snake_case, API plural REST, TS camelCase, Socket.io domain:action)
- [x] Structure patterns defined (`src/server/` boundary, test co-location, `server-only` guard)
- [x] Communication patterns specified (Socket.io rooms, TanStack Query keys, Zustand store shape)
- [x] Process patterns documented (Zod validation, audit staffId, financial reauth, error envelope, loading states)

**Project Structure**
- [x] Complete directory structure defined (every file listed with FR annotation)
- [x] Component boundaries established (7 custom POS components, 2 layout components)
- [x] Integration points mapped (order submission data flow diagram)
- [x] Requirements to structure mapping complete (all 11 FR categories)

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION**

**Confidence level: High** — all 16 checklist items confirmed, zero critical gaps, one important gap resolved during validation.

**Key strengths:**
- Every FR and NFR has a named file or service responsible for it — no implementation ambiguity
- Append-only audit constraint enforced at two independent layers (application code + PostgreSQL RULE) — cannot be bypassed by a bug
- Implementation sequence (Step 4) correctly orders all dependencies — no agent can build a feature before its foundation exists
- `src/server/` hard boundary prevents accidental client-side exposure of DB credentials or Socket.io server instance
- Vendor ops plane is isolated at both route namespace and credential level — zero overlap with restaurant staff access

**Areas for future enhancement:**
- OpenAPI spec generation from Route Handlers (post-MVP, larger team)
- Database ERD diagram (useful when onboarding additional developers)
- Redis caching layer if PostgreSQL query load grows beyond single-restaurant scale (Phase 3 SaaS)

---

## Post-MVP: Multi-Tenant Cloud Sync Architecture

> **Status:** Not in MVP scope. Build after Carpe Diem v1 is live and stable. Designed to be additive — zero changes to the per-restaurant local stack.

### Context

Each CDRMS deployment is a fully isolated local Docker Compose stack. When selling to multiple restaurants, a central cloud hub is needed for:
- Vendor fleet dashboard (aggregate revenue, uptime, software versions across all restaurants)
- Opportunistic cloud backup (data durability beyond the local daily pg_dump)
- Config/menu template distribution (push updates to all restaurants from one place)
- Software update delivery (Watchtower + GHCR already handles this)

### Architecture Pattern: Local-First, Cloud-Synced

```
Restaurant A (local stack) ──┐
Restaurant B (local stack) ──┼──► Central Cloud Hub ──► Vendor Fleet Dashboard
Restaurant C (local stack) ──┘         │
                                        └──► Push config / menu templates back
```

Each restaurant remains the **source of truth**. The cloud hub is a read replica plus config distribution channel. No conflict resolution is needed because:
- The audit trail is append-only — sync is a one-way push of new rows tagged with `tenant_id`
- Restaurants never receive data that overwrites their operational state — only config updates

### What Gets Added

**Per-restaurant Docker Compose stack** — one new service:

```yaml
syncer:
  image: ghcr.io/{org}/cdrms-syncer:latest
  restart: unless-stopped
  environment:
    - DATABASE_URL=${DATABASE_URL}
    - CLOUD_HUB_URL=${CLOUD_HUB_URL}
    - CLOUD_API_KEY=${CLOUD_API_KEY}    # per-restaurant API key issued by vendor
    - SYNC_INTERVAL_SECONDS=300         # push every 5 min when internet available
```

The syncer:
1. Tracks a `last_synced_event_id` cursor in a local state file
2. On each interval: checks internet connectivity (ping cloud hub)
3. If connected: pushes all new rows from `order_events`, `payment_records`, `comp_records` since last cursor
4. Receives config updates (feature flags, menu templates) from cloud hub
5. If disconnected: skips silently — resumes from cursor on next interval

**Central cloud hub** — a small hosted service (Fly.io, Railway, or VPS):
- Thin Next.js API + PostgreSQL (hosted)
- Receives pushed event rows tagged with `tenant_id`
- Vendor fleet dashboard: revenue across all restaurants, online/offline status, app version per deployment
- Config API: push feature flag overrides or menu templates to specific restaurants or all
- Cloud backup: stores the daily pg_dump uploaded from each restaurant's `backup.sh`

### Opportunistic Cloud Backup

Extend the existing `docker/scripts/backup.sh` with a second step:

```bash
# Existing: local pg_dump
pg_dump $DATABASE_URL | gzip > /backups/cdrms-$(date +%Y%m%d).sql.gz

# New: upload to cloud storage when internet available
if curl -s --max-time 5 $CLOUD_HUB_URL/ping > /dev/null; then
  rclone copy /backups/cdrms-$(date +%Y%m%d).sql.gz r2:cdrms-backups/$RESTAURANT_NAME/
fi
```

Cloud storage target: **Cloudflare R2** (free up to 10 GB — sufficient for years of compressed pg_dumps from a single restaurant; S3-compatible API).

### Schema Additions Required

```sql
-- Already in schema (no change needed):
tenants(tenant_id, name, ...)   -- one row per restaurant

-- New: sync cursor tracking (added to per-restaurant schema)
sync_state(key TEXT PK, value TEXT, updated_at TIMESTAMPTZ)
-- e.g., key='last_synced_event_id', value='uuid-of-last-pushed-event'

-- New: env vars per deployment
CLOUD_HUB_URL=https://hub.cdrms.app
CLOUD_API_KEY=                    # issued per restaurant by vendor onboarding
```

### Implementation Sequence (Post-MVP)

1. Build central cloud hub API (thin Next.js + hosted PostgreSQL)
2. Build syncer service (Node.js script containerized separately)
3. Add `CLOUD_HUB_URL` + `CLOUD_API_KEY` to `.env.example` (commented out by default)
4. Add `syncer` service to `docker-compose.yml` (disabled by default via `profiles`)
5. Extend `backup.sh` with conditional cloud upload
6. Build vendor fleet dashboard on cloud hub

### Key Constraints

- Syncer must be **additive only** — never modifies per-restaurant operational data
- Cloud hub must be **stateless for operations** — restaurant continues fully if hub is unreachable
- API keys must be **per-restaurant** — one restaurant's key cannot read another's data
- All data in transit must be **encrypted in transit** (HTTPS to cloud hub, TLS on R2 uploads)

### Implementation Handoff

**First implementation priority:**
```bash
# Step 1 — project init
pnpm create next-app@latest carpe-diem-rms --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"

# Step 2 — Docker Compose stack (app + db + portainer + uptime-kuma + watchtower)
# Step 3 — Drizzle schema.ts + first migration
# Step 4 — custom server.ts with Socket.io attachment
# Step 5 — session middleware + PIN auth (src/middleware.ts + session.service.ts)
# Step 6 onwards — feature epics in implementation sequence order (Step 4 of this document)
```

**AI agent guidelines:**
- Follow all naming patterns in the Implementation Patterns section exactly — no local variations
- Check the implementation sequence before starting any feature epic
- `src/server/` is a hard boundary — enforce with the `server-only` npm package
- All monetary values are integers (paisa) at every layer except the display layer
- Every audit write must carry an explicit `staffId` from `x-staff-id` header — never inferred from session context
- Refer to this document for all architectural questions before making local decisions
