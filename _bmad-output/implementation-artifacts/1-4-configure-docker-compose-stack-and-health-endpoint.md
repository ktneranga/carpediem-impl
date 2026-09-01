# Story 1.4: Configure Docker Compose Stack & Health Endpoint

- **Epic:** 1 — Project Foundation & Infrastructure
- **Story ID:** 1.4
- **Story Key:** 1-4-configure-docker-compose-stack-and-health-endpoint
- **Status:** review
- **Created:** 2026-06-21

---

## Story

**As a** system operator,
**I want** the application deployable as a self-contained Docker Compose stack with a working health endpoint,
**So that** the restaurant runs on a local server that starts reliably, survives restarts without data loss, and can be monitored by Uptime Kuma.

---

## Acceptance Criteria

**AC-1: Docker Compose service count and port configuration**
**Given** `docker-compose.yml` in the repository root
**When** a developer inspects it
**Then** exactly 5 services are defined: `app` (Next.js, port 3000 exposed), `db` (postgres:17-alpine, port 5432 internal only), `portainer` (port 9000), `uptime-kuma` (port 3001), `watchtower`; all services have `restart: unless-stopped`

**AC-2: Stack starts cleanly**
**Given** the Docker Compose stack
**When** `docker compose up -d` runs on a machine with Docker installed
**Then** all 5 services start and the Next.js app responds on port 3000 within 60 seconds

**AC-3: Data survives restart**
**Given** the stack running with data written to the database
**When** the `app` container is stopped and restarted
**Then** the PostgreSQL data volume is intact; no previously written data is lost; the app connects to the existing database on restart

**AC-4: Named volume (not bind mount)**
**Given** the `db` service configuration
**When** the volume configuration is inspected
**Then** the PostgreSQL data directory is mounted as a named Docker volume (not a bind mount); running `docker compose down` without `--volumes` leaves the data volume intact

**AC-5: Health endpoint — DB connected**
**Given** the Next.js application running
**When** `GET /api/health` is called
**Then** HTTP 200 is returned with a JSON body containing `status: "ok"`, `db: "connected"`, and `uptime` in seconds; response time is under 500ms

**AC-6: Health endpoint — DB unreachable**
**Given** the database is unreachable
**When** `GET /api/health` is called
**Then** HTTP 503 is returned with `status: "degraded"` and `db: "error"` in the JSON body

**AC-7: Portainer and Uptime Kuma Tailscale-only**
**Given** `portainer` and `uptime-kuma` running
**When** accessed from the restaurant LAN (non-Tailscale)
**Then** both services are inaccessible; they are reachable only via Tailscale IP

**AC-8: LAN-only operation (offline-safe)**
**Given** the application container running
**When** the host's internet connection is severed after initial setup
**Then** the Next.js app continues to serve all requests normally; no operational feature degrades

---

## Tasks / Subtasks

- [x] Task 1 — Create `public/.gitkeep` (AC: 2)
  - `public/` directory does not exist yet. Next.js requires it at root. The Dockerfile `COPY --from=builder /app/public ./public` will fail silently or error if the directory is absent. Create `public/.gitkeep` now so the directory is tracked by git and present during `next build`.

- [x] Task 2 — Move `tsx` from devDependencies to dependencies in `package.json` (AC: 2)
  - `tsx` is the production runtime executor for `server.ts` (via `pnpm start` → `tsx server.ts`). It is currently in `devDependencies` — semantically incorrect. Move it to `dependencies`. One-line change in `package.json`.

- [x] Task 3 — Create `docker/scripts/healthcheck.sh` (AC: 2, 5)
  - Script used by the Docker `HEALTHCHECK` instruction to verify the app is healthy.
  - Content: `wget -q -O /dev/null http://localhost:3000/api/health || exit 1`
  - `wget` is available in Alpine by default; do not use `curl` (not in Alpine base image).
  - `chmod +x` is applied in the Dockerfile; the file itself does not need execute bit in the repo.

- [x] Task 4 — Create `docker/Dockerfile` (multi-stage) (AC: 2, 3, 4, 8)
  - 4 stages: base → deps → builder → runner. See Dev Notes for exact structure and rationale.
  - Runner CMD: `sh -c "sh docker/scripts/migrate.sh && pnpm start"`
  - Include `HEALTHCHECK` instruction using `docker/scripts/healthcheck.sh`.

- [x] Task 5 — Create `.dockerignore` at repo root (AC: 2)
  - Exclude: `node_modules/`, `.next/`, `.git/`, `.env.local`, `*.log`, `Dockerfile`, `docker-compose*.yml`

- [x] Task 6 — Create `docker-compose.yml` at repo root (AC: 1, 2, 3, 4, 7)
  - 5 services with all specified constraints. See Dev Notes for exact service config.
  - `app` uses `depends_on: db: condition: service_healthy`.
  - `portainer` and `uptime-kuma` bound to `127.0.0.1` for Tailscale-only access.
  - Named volume `pgdata` for PostgreSQL data; `docker compose down` without `--volumes` preserves it.

- [x] Task 7 — Create `docker-compose.override.yml` for development (Architecture AR4)
  - Enables hot-reload by mounting source into the builder-stage container and overriding CMD to `pnpm dev`.
  - This file is automatically picked up by `docker compose up` in development; it does NOT affect production deployments.

- [x] Task 8 — Create `src/app/api/health/route.ts` (AC: 5, 6)
  - Next.js App Router Route Handler. `GET` only.
  - Runs `SELECT 1` via drizzle `db` to verify DB connectivity.
  - 200 response: `{ status: "ok", db: "connected", uptime: Math.floor(process.uptime()) }`
  - 503 response: `{ status: "degraded", db: "error" }` — catch ALL DB errors, no unhandled throws.
  - No authentication on this route (used by Uptime Kuma and Watchtower as a public gate).

- [x] Task 9 — Update `.env.example` (AC: 2)
  - Add `POSTGRES_PASSWORD=` with comment: `# Docker db service password — also embedded in DATABASE_URL for docker-compose.yml`

### Review Findings

_Second review pass, 2026-08-21, after the AC-7 resolution._

- [ ] [Review][Decision] **`docker-compose.override.yml` auto-loads — a restaurant server could silently run dev mode in production** [`docker-compose.override.yml`] — Docker Compose applies `docker-compose.override.yml` automatically with no flag. If a restaurant server has the repository checked out and someone runs `docker compose up -d`, the override wins: the app builds from source and starts with `pnpm dev` instead of pulling the published image and running the production server. This was latent before, but Story 1.5 made the consequence worse — production is now meant to pull an image, and the override silently reverts that. Options: A) rename to `compose.dev.yml` and require `-f compose.dev.yml` locally; B) ship only `docker-compose.yml` to servers, never the repo; C) accept and document, relying on deployment discipline.
- [ ] [Review][Patch] **CRITICAL — the documented ufw rules do not protect Docker-published ports** [`docker/FIREWALL.md:23-31`] — Docker writes its own iptables rules into the `DOCKER` chain, which is evaluated before ufw's `INPUT` chain. A port published by Docker is therefore reachable regardless of `ufw deny`. The entire mitigation for binding Portainer and Uptime Kuma to all interfaces is ineffective as written, leaving full container control reachable from restaurant Wi-Fi. Rules must go in the `DOCKER-USER` chain (or use `ufw-docker`). The verification steps already in FIREWALL.md would catch this, but the rules being verified are wrong.
- [ ] [Review][Patch] **`portainer/portainer-ce:latest` uses a mutable tag** [`docker-compose.yml:52`] — the container holding the Docker socket tracks a floating tag. Pin it. (Same finding recorded on Story 1.5; fix once.)

#### Original findings (2026-06-21)


- [x] [Review][Decision] AC-7 Tailscale access: **RESOLVED — Option A chosen by Teran 2026-08-21.** Portainer and Uptime Kuma now bind to all interfaces (`9000:9000`, `3001:3001`); access is restricted by Tailscale ACLs plus a mandatory host firewall rule documented in `docker/FIREWALL.md`. Original finding: `127.0.0.1` binding prevents Tailscale peers from reaching Portainer/Uptime-Kuma — Binding to loopback makes services unreachable from ALL remote addresses including Tailscale VPN peers (Tailscale traffic arrives on the ts0 interface, not loopback). AC-7 requires these be reachable via Tailscale IP. Options: A) Bind to `0.0.0.0` and rely on Tailscale ACLs/firewall rules to block non-Tailscale LAN traffic; B) Use `tailscale serve` as a localhost-to-Tailscale proxy (requires Tailscale sidecar or host config); C) Defer — document as an operational step in deployment guide, accept `0.0.0.0` in compose and note firewall requirement.
- [x] [Review][Decision] AR9 Watchtower deployment gate: **RESOLVED — Option A chosen by Teran 2026-08-21.** No change in Story 1.4. The health-gate responsibility moves to Story 1.5 (CI/CD), where GitHub Actions will check `/api/health` on the deployed instance before tagging an image as stable. The `/api/health` endpoint delivered by this story is the prerequisite. Original finding: `/api/health` endpoint exists but Watchtower has no native app health URL gate — AR9 says `/api/health` is used as a "Watchtower deployment gate." Watchtower does not call an application health endpoint before rolling out an update. Options: A) This will be implemented in Story 1.5 CI/CD pipeline (GitHub Actions checks `/api/health` on the deployed instance before tagging as stable); B) Use `docker-rollout` plugin which respects Docker HEALTHCHECK before proceeding; C) Accept that "Watchtower deployment gate" means the HEALTHCHECK instruction (already configured) and close the finding.
- [x] [Review][Patch] **RESOLVED 2026-08-21** — changed to `PORTAINER_URL=http://portainer:9000` (Docker network service name). Original finding: `PORTAINER_URL` hardcodes `localhost` — unreachable from app container [`docker-compose.yml:19`] — `PORTAINER_URL=http://localhost:9000` resolves to the app container's own loopback, not the Portainer service. If any code calls this URL, it gets connection refused. Fix: change to `http://portainer:9000` (Docker network service name).
- [x] [Review][Defer] `SESSION_SECRET` has no default or validation guard — silently empty if operator omits it [`docker-compose.yml:15`] — deferred; auth session validation is Epic 2 concern, not Story 1.4
- [x] [Review][Defer] `WATCHTOWER_HTTP_API_TOKEN` can be empty, leaving Watchtower API unauthenticated [`docker-compose.yml:68`] — deferred; Watchtower is on `internal` Docker network only; mitigated by network isolation
- [x] [Review][Defer] `pg_isready` healthcheck passes before WAL recovery completes on hard shutdown [`docker-compose.yml:37`] — deferred; edge case for a low-write-volume LAN POS; fix if it causes real startup failures
- [x] [Review][Defer] Watchtower-triggered restart drops active Socket.io sessions mid-service [`docker-compose.yml:58`] — deferred; architectural limitation of rolling updates; operational mitigation: push updates after service hours
- [x] [Review][Defer] No SIGTERM handler in `server.ts` — in-flight requests dropped on container stop [`server.ts`] — deferred; pre-existing from Story 1.1, not introduced by Story 1.4
- [x] [Review][Defer] Migration race on crash-restart — drizzle-kit advisory lock may be held by a killed session [`docker/scripts/migrate.sh`] — deferred; unlikely for single-tenant POS; drizzle-kit's lock releases on connection close

---

## Dev Notes

### System Context

- **LAN-first POS**: No internet dependency at runtime. `next build` works offline because `@fontsource-variable/inter` (not `next/font/google`) is used — confirmed in Story 1.1.
- **Custom server**: `server.ts` is NOT compiled by `next build`. It is the HTTP server entry point for both Next.js (App Router) and Socket.io, and must exist in the production image at runtime, executed by `tsx`.
- **Migration approach**: `drizzle-kit migrate` (CLI) runs before the app starts on every container start. This is the production migration strategy (AR5). Migrations are idempotent — already-applied migrations are tracked in `drizzle.__drizzle_migrations` and skipped.

### Dockerfile — Critical Guidance

**File location**: `docker/Dockerfile` (architecture spec). The `docker-compose.yml` sets `build.context: .` (repo root) and `build.dockerfile: docker/Dockerfile`.

**Why ALL deps are installed (not just prod):**
- `tsx` — needed to run `server.ts` at runtime via `pnpm start`
- `drizzle-kit` — needed to run `pnpm db:migrate` in `migrate.sh` at container start
- `cross-env` — invoked by `pnpm start` (`cross-env NODE_ENV=production tsx server.ts`)

`ENV NODE_ENV=production` in the Dockerfile makes `cross-env` a no-op (env var already set), but `cross-env` must exist in node_modules to avoid "command not found". All three are devDependencies installed via `pnpm install --frozen-lockfile`.

**Exact Dockerfile structure:**
```dockerfile
FROM node:22-alpine AS base
RUN npm install -g pnpm

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY server.ts drizzle.config.ts package.json ./
COPY src/server/db/ ./src/server/db/
COPY docker/ ./docker/

RUN chmod +x docker/scripts/migrate.sh docker/scripts/healthcheck.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD sh docker/scripts/healthcheck.sh

CMD ["sh", "-c", "sh docker/scripts/migrate.sh && pnpm start"]
```

**Why this exact runner file set — do NOT deviate:**

| File/Dir | Why needed in runner |
|---|---|
| `node_modules/` | All runtime deps: next, socket.io, tsx, drizzle-kit, cross-env |
| `.next/` | Compiled Next.js app. Route handlers (including /api/health) and ALL their imports are bundled here. Do NOT copy `src/app/` — it is already in `.next/`. |
| `public/` | Static assets served by Next.js. Must exist (Task 1 creates `public/.gitkeep`). |
| `server.ts` | Custom HTTP/Socket.io server entry. NOT in `.next/`. |
| `drizzle.config.ts` | drizzle-kit reads this to find migration files (`out: './src/server/db/migrations'`). |
| `src/server/db/` | Contains `migrations/*.sql` (applied at startup) and `schema.ts` (drizzle-kit may read). |
| `docker/` | Contains `migrate.sh` and `healthcheck.sh`. |
| `package.json` | pnpm needs this to resolve `db:migrate` and `start` scripts. |

**`src/app/` is NOT needed in runner.** `next build` compiles all App Router code — pages, layouts, route handlers, and their server-side imports (including `src/server/db/index.ts`) — into `.next/server/chunks/`. Copying `src/app/` would be dead weight.

**`pnpm-lock.yaml` is NOT needed in runner.** pnpm only needs it during `pnpm install`, which runs in the `deps` stage. The runner stage uses the pre-installed `node_modules/`.

### docker-compose.yml — Critical Guidance

**File location**: Repo root — NOT `docker/docker-compose.yml`. The architecture directory listing shows `docker/docker-compose.yml` but AC-1 explicitly states "repository root". AC takes precedence.

**DATABASE_URL construction**: The `app` service uses `@db:5432` (Docker bridge network hostname), not `@localhost:5432`. The password is shared between `db.POSTGRES_PASSWORD` and the `DATABASE_URL` via `${POSTGRES_PASSWORD}` — Docker Compose reads this from a `.env` file at the project root (separate from `.env.local` used by Next.js dev server).

**Tailscale-only access (AC-7)**: Portainer and Uptime Kuma are bound to `127.0.0.1:PORT` (loopback), not `0.0.0.0:PORT`. Binding to loopback makes them unreachable from the restaurant LAN. Tailscale peers access these services by VPN-tunneling to the host's Tailscale IP, which routes to localhost — so `127.0.0.1:9000` is accessible via Tailscale but not via the LAN IP.

**Complete service configuration:**

```yaml
services:
  app:
    build:
      context: .
      dockerfile: docker/Dockerfile
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD:-changeme}@db:5432/cdrms
      - NODE_ENV=production
      - PORT=3000
      - SESSION_SECRET=${SESSION_SECRET}
      - PRINTER_IP=${PRINTER_IP:-}
      - PRINTER_PORT=${PRINTER_PORT:-9100}
      - VENDOR_SECRET=${VENDOR_SECRET:-}
      - WATCHTOWER_HTTP_API_TOKEN=${WATCHTOWER_HTTP_API_TOKEN:-}
      - PORTAINER_URL=http://localhost:9000
      - RESTAURANT_NAME=${RESTAURANT_NAME:-Carpe Diem}
      - TIMEZONE=${TIMEZONE:-Asia/Colombo}
    depends_on:
      db:
        condition: service_healthy
    networks:
      - internal

  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_DB=cdrms
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-changeme}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d cdrms"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - internal
    # port 5432 NOT in ports: section — internal only (satisfies AC-1)

  portainer:
    image: portainer/portainer-ce:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:9000:9000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer_data:/data
    networks:
      - internal

  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"
    volumes:
      - uptime_kuma_data:/app/data
    networks:
      - internal

  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    environment:
      - WATCHTOWER_POLL_INTERVAL=300
      - WATCHTOWER_HTTP_API_TOKEN=${WATCHTOWER_HTTP_API_TOKEN:-}
      - WATCHTOWER_HTTP_API_METRICS=true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - internal

volumes:
  pgdata:
  portainer_data:
  uptime_kuma_data:

networks:
  internal:
    driver: bridge
```

### docker-compose.override.yml — Dev Guidance

This file is merged automatically by `docker compose` during development (Docker Compose loads override files by convention). It does NOT affect production deployments (where `docker compose -f docker-compose.yml up -d` is used explicitly).

```yaml
services:
  app:
    build:
      target: builder
    command: pnpm dev
    volumes:
      - .:/app
      - /app/node_modules
      - /app/.next
    environment:
      - NODE_ENV=development
```

The volume mounts override the COPY instructions from the runner stage: live source code is used, enabling hot-reload via `pnpm dev`.

### Health Endpoint — Implementation Notes

**File**: `src/app/api/health/route.ts`

**Import pattern:**
```typescript
import { NextResponse } from 'next/server'
import { db } from '@/server/db'
import { sql } from 'drizzle-orm'
```

`db` imports from `@/server/db/index.ts` which has `import 'server-only'` at the top. This is valid in a Route Handler — Route Handlers run exclusively on the server.

**Response shape (must be exact — Watchtower and Uptime Kuma parse this):**
```typescript
// 200 OK
{ status: "ok", db: "connected", uptime: 123 }

// 503 Service Unavailable
{ status: "degraded", db: "error" }
```

**DB check**: `await db.execute(sql\`SELECT 1\`)`. The Pool from `pg` is already initialized on import. One round-trip to the DB; returns the connection immediately. Well under 500ms on loopback (localhost Docker network).

**Error handling**: Wrap the entire DB call in try/catch. Catch ANY error (connection refused, timeout, auth failure, pool exhausted). Never let an error escape the handler — a thrown error from a Route Handler returns 500, not 503.

**No timeout needed**: The `pg.Pool` default `query_timeout` from the pool config (or Postgres default 0 = no timeout) applies. For health checks, this is acceptable — if the DB is up, it responds in <1ms on loopback. If it's down, the TCP connection is refused instantly.

**No authentication**: `/api/health` is a public endpoint. No session checking, no auth middleware. It must be accessible to Docker's internal health check, Uptime Kuma, and Watchtower without credentials.

### Existing Files — What This Story Touches

| File | Action | Notes |
|---|---|---|
| `package.json` | UPDATE | Move `tsx` from devDependencies to dependencies |
| `.env.example` | UPDATE | Add `POSTGRES_PASSWORD=` |
| `docker/scripts/migrate.sh` | UNCHANGED | Created in Story 1.3; called by CMD in Dockerfile |
| `src/server/db/index.ts` | UNCHANGED | DB pool already configured correctly from Story 1.1 |
| `drizzle.config.ts` | UNCHANGED | Already at repo root with correct config |

### Migration Flow Inside Container

On every `docker compose up` / container start:
1. `migrate.sh` runs: `pnpm db:migrate` → `drizzle-kit migrate`
2. drizzle-kit reads `drizzle.config.ts` → finds `out: './src/server/db/migrations'`
3. drizzle-kit connects to `DATABASE_URL` (the `@db:5432` connection from docker-compose env)
4. Checks `drizzle.__drizzle_migrations` table for applied migrations
5. Applies any un-applied: `0000_plain_eternity.sql`, `0001_append_only_rules.sql`, `0002_normal_speed_demon.sql`
6. On restart: all 3 are already applied → no-op. ✓

**Important**: The `db` service must be healthy before `migrate.sh` runs. This is guaranteed by `depends_on: db: condition: service_healthy` in docker-compose.yml — the `app` container does not start until `pg_isready` succeeds on the `db` container.

### Previous Story Learnings (1.3)

- `docker/scripts/migrate.sh` is complete and correct. Do not modify it.
- 3 migration files are committed and verified against postgres:17-alpine: `0000`, `0001`, `0002`.
- `drizzle.config.ts` is at repo root; reads `DATABASE_URL` from env; migrations in `./src/server/db/migrations`.
- All triggers use `CREATE OR REPLACE TRIGGER` — idempotent, re-runnable.
- Money stored as integer paisa — no decimal/float anywhere in schema.

### NFRs Delivered by This Story

| NFR | How satisfied |
|---|---|
| NFR-R1 (LAN-only) | All 5 services run locally; no cloud dep in hot path |
| NFR-R2 (99.5% uptime) | `restart: unless-stopped` on all services |
| NFR-R3 (Data through updates) | Named volume `pgdata`; `docker compose down` without `--volumes` preserves it |
| NFR-I3 (Watchtower) | `WATCHTOWER_POLL_INTERVAL=300` (5 min) |
| NFR-SC1 (Isolated stacks) | Self-contained Compose stack |

---

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### Completion Notes

**Review resolution pass — 2026-08-21**

- ✅ Resolved review finding [Patch]: `PORTAINER_URL` pointed at container loopback instead of the Portainer service.
- ✅ Resolved review finding [Decision]: AC-7 Tailscale reachability — Option A. Loopback binding removed; firewall becomes the access control and is documented as a provisioning prerequisite.
- ✅ Resolved review finding [Decision]: AR9 Watchtower deployment gate — Option A. Deferred to Story 1.5 with the responsibility explicitly assigned rather than left implied.

**Residual risk accepted with Option A.** Ports 9000 and 3001 are now reachable from the restaurant LAN, not only the tailnet. The host firewall is the only thing preventing a device on restaurant Wi-Fi from reaching Portainer and controlling every container. This risk is carried by a provisioning step (`docker/FIREWALL.md`) rather than by the compose file. A stricter alternative — binding to `${TAILSCALE_IP}` so it fails closed with no firewall dependency — was presented and not adopted for v1; it is recorded at the end of `docker/FIREWALL.md` for revisit if field provisioning errors occur.

**Validation note.** `docker compose config` and a scripted YAML assertion were both blocked by the environment sandbox. Verification was done by direct file inspection: 5 services present, all `restart: unless-stopped`, `portainer` → `9000:9000`, `uptime-kuma` → `3001:3001`, no remaining `127.0.0.1` binding (the only occurrence is inside an explanatory comment), `PORTAINER_URL=http://portainer:9000`. **AC-1 through AC-8 were not re-run live** — no containers were built or started in this pass. A `docker compose up -d` smoke test should be run before this story is closed.

**Original implementation — 2026-06-21**

All 9 tasks implemented. TypeScript check clean (exit 0), ESLint clean (exit 0).

- `public/.gitkeep` created so Dockerfile COPY of `public/` directory is valid
- `tsx` moved from devDependencies to dependencies — it runs `server.ts` at production runtime
- `docker/scripts/healthcheck.sh` uses `wget` (available in Alpine without extra packages)
- `docker/Dockerfile`: 4-stage multi-stage (base → deps → builder → runner). All deps installed (not prod-only) because drizzle-kit (devDep) runs migrations at container start. Runner CMD: `sh migrate.sh && pnpm start`
- `.dockerignore` excludes node_modules, .next, .git, .env.local, logs, compose files
- `docker-compose.yml` at repo root: 5 services, all `restart: unless-stopped`. `app` depends_on `db` with `service_healthy` condition. Portainer + Uptime Kuma bound to `127.0.0.1` (Tailscale-only). Named volume `pgdata` for PostgreSQL
- `docker-compose.override.yml` enables hot-reload dev mode — mounts source, overrides CMD to `pnpm dev`
- `src/app/api/health/route.ts`: `GET /api/health` — SELECT 1 via drizzle, returns 200/503 with exact required JSON shape
- `.env.example` updated with `POSTGRES_PASSWORD` and explanation comment

### Debug Log
- TypeScript: `npx tsc --noEmit` → exit 0 ✓
- ESLint: `npx eslint src/app/api/health/route.ts` → exit 0 ✓

### File List

- NEW: `public/.gitkeep`
- NEW: `docker/Dockerfile`
- NEW: `docker/scripts/healthcheck.sh`
- NEW: `docker-compose.yml`
- NEW: `docker-compose.override.yml`
- NEW: `.dockerignore`
- NEW: `src/app/api/health/route.ts`
- UPDATE: `package.json` (tsx: devDependencies → dependencies)
- UPDATE: `.env.example` (POSTGRES_PASSWORD added)
- NEW: `docker/FIREWALL.md` (review resolution — mandatory provisioning firewall rules for ports 9000/3001)
- UPDATE: `docker-compose.yml` (review resolution — PORTAINER_URL service name; portainer + uptime-kuma unbound from loopback)

### Change Log
- 2026-06-21: Story 1.4 implemented — Docker Compose stack (5 services), multi-stage Dockerfile, GET /api/health route handler, healthcheck script, tsx moved to production dependencies
- 2026-08-21: Addressed code review findings — 3 items resolved (1 patch, 2 decisions)
  - `PORTAINER_URL` changed from `http://localhost:9000` to `http://portainer:9000`. The previous value resolved to the app container's own loopback, so any call would have been refused.
  - AC-7 resolved via Option A. Portainer (`9000:9000`) and Uptime Kuma (`3001:3001`) unbound from `127.0.0.1` so Tailscale peers on the `tailscale0` interface can reach them. Access control moves to Tailscale ACLs plus a host firewall rule.
  - `docker/FIREWALL.md` added: mandatory ufw/firewalld rules, LAN-side and tailnet-side verification steps, and defence-in-depth notes. Referenced from inline warnings on both services in `docker-compose.yml`.
  - AR9 resolved via Option A — no code change. Watchtower has no native application health gate; that responsibility is assigned to Story 1.5 (CI/CD), where GitHub Actions will verify `/api/health` before tagging an image stable.
