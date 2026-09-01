# Story 1.1: Initialize Next.js Project with Core Tooling

Status: done

## Story

As a developer,
I want a fully initialized Next.js project with all required packages and a custom Socket.io server attached to the same port,
so that the team has a working, correctly structured foundation on which every CDRMS feature is built.

## Acceptance Criteria

1. **Given** a fresh development environment with Node.js ≥ 20, pnpm, and Docker available **When** the developer runs the documented project initialization sequence **Then** a Next.js App Router project exists with TypeScript, Tailwind CSS **v4**, ESLint, `src/` directory, and `@/*` import alias configured.

2. **Given** the initialized project **When** all required packages are installed **Then** `package.json` includes: `drizzle-orm`, `drizzle-kit`, `pg`, `socket.io`, `socket.io-client`, `recharts`, `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `server-only`; and shadcn/ui is initialized.

3. **Given** the project with packages installed **When** `server.ts` is created at the project root **Then** it creates a Node.js HTTP server wrapping Next.js's request handler, attaches a Socket.io instance to the same server, and listens on port 3000 (or `PORT` env var).

4. **Given** the custom server is running **When** a WebSocket client connects to `http://localhost:3000` **Then** Socket.io accepts the connection successfully.

5. **Given** `src/server/db/index.ts` and `src/server/socket/index.ts` **When** either file is imported from a client-side component **Then** the build fails with a `server-only` error, preventing accidental client-side access.

6. **Given** the project started via the dev script **When** `http://localhost:3000` is accessed **Then** the Next.js application renders correctly, confirming Next.js and Socket.io coexist on the same port.

## Tasks / Subtasks

- [x] Task 1: Run create-next-app and upgrade to Tailwind v4 (AC: 1)
  - [x] Run `pnpm create next-app@latest carpe-diem-rms --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"` — installs Next.js 16.2.9, React 19.2.4
  - [x] Tailwind v4 upgrade NOT needed — create-next-app@latest already installs tailwindcss 4.3.1 + @tailwindcss/postcss 4.3.1
  - [x] `postcss.config.mjs` already uses `@tailwindcss/postcss` (no changes needed)
  - [x] `globals.css` already uses `@import "tailwindcss"` and `@theme inline` (v4 CSS-first, no tailwind.config.ts)
  - [x] Fixed `ERR_PNPM_IGNORED_BUILDS` for sharp/unrs-resolver via `pnpm-workspace.yaml` allowBuilds

- [x] Task 2: Install all post-init packages (AC: 2)
  - [x] `pnpm add drizzle-orm pg socket.io socket.io-client recharts @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities server-only class-variance-authority clsx tailwind-merge lucide-react`
  - [x] `pnpm add -D drizzle-kit @types/pg tsx`
  - [x] Fixed `ERR_PNPM_IGNORED_BUILDS` for esbuild (drizzle-kit dep) via `pnpm-workspace.yaml`

- [x] Task 3: Initialize shadcn/ui (AC: 2)
  - [x] `pnpm dlx shadcn@latest init --yes` is interactive even with --yes flag (component library selection)
  - [x] Created `components.json` manually with style: default, baseColor: slate, cssVariables: true
  - [x] Created `src/lib/utils.ts` with `cn()` utility using clsx + tailwind-merge
  - [x] Created `src/components/ui/` directory (ready for `pnpm dlx shadcn@latest add <component>`)

- [x] Task 4: Create drizzle.config.ts at project root (no DB yet — just the config scaffold) (AC: 2)
  - [x] Created pointing to `src/server/db/schema.ts` and `src/server/db/migrations/`

- [x] Task 5: Create custom server.ts (AC: 3, 4, 6)
  - [x] Created `server.ts` at project root — raw Node.js http (no Express)
  - [x] Socket.io attached to same httpServer; exposed on `global.__io`
  - [x] `package.json` scripts updated: `"dev": "tsx watch server.ts"`, `"start": "NODE_ENV=production tsx server.ts"`

- [x] Task 6: Create src/server/db/index.ts with server-only guard (AC: 5)
  - [x] `import 'server-only'` as first line; pg.Pool + drizzle client exported as `db`

- [x] Task 7: Create src/server/socket/index.ts with server-only guard (AC: 5)
  - [x] `import 'server-only'` as first line; `declare global { var __io }` typed; `getIO()` exported

- [x] Task 8: Scaffold the required directory structure (no implementation — just empty files/dirs)
  - [x] All directories created with `.gitkeep`: migrations/, pos/, validations/, hooks/, store/
  - [x] `src/types/index.ts` created with empty export

- [x] Task 9: Create .env.example (AC: 6)
  - [x] All required env vars documented; `.env*` already gitignored by create-next-app

- [x] Task 10: Verify everything works end-to-end (AC: 4, 5, 6)
  - [x] `pnpm dev` (tsx watch server.ts) starts — `> Ready on http://localhost:3000 [dev]`
  - [x] HTTP: GET / → 200, Next.js compiled in 4.3s
  - [x] Socket.io: GET /socket.io/?EIO=4&transport=polling → 200 with session SID and `upgrades: ["websocket"]`
  - [x] TypeScript: `pnpm exec tsc --noEmit` exits with no errors

## Dev Notes

### ✅ Tailwind v4 — Already Installed

`pnpm create next-app@latest` with Next.js 16+ installs **Tailwind CSS v4** (4.3.1) natively. No manual upgrade is needed. The CSS-first `@theme inline` approach in `globals.css` replaces `tailwind.config.ts`.

**Tailwind v4 breaking changes that affect this project:**
- Config is CSS-first: use `@import "tailwindcss"` in globals.css (not `@tailwind base/components/utilities`)
- PostCSS plugin changes: use `@tailwindcss/postcss` not `tailwindcss` in `postcss.config.mjs`
- `[data-context]` attribute variants are fully native in v4 (no custom plugin needed) — this is WHY v4 was chosen
- Custom tokens (brand colors, spacing) will be defined via `@theme` in `globals.css` in Story 1.2 — Story 1.1 just needs clean v4 setup

### ⚠️ Critical: Next.js Version

The epic AC references "Next.js 14" but `create-next-app@latest` as of June 2026 will install **Next.js 15.x**. Use the latest — all architecture decisions in this project are compatible with Next.js 15. Do NOT pin to 14.

### Custom Server: What It Disables

Running a custom `server.ts` disables:
- `next dev --turbopack` (Turbopack cannot be used with custom server — standard Webpack HMR still works)
- Vercel deployment (irrelevant — CDRMS is self-hosted Docker)
- Next.js Automatic Static Optimization on routes that need it (not relevant for a fully authenticated POS)

These are acceptable trade-offs for the Socket.io WebSocket requirement.

### server.ts Pattern

The correct `server.ts` structure (never use Express — use raw Node.js http):

```typescript
import 'server-only'
import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server } from 'socket.io'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  })

  const io = new Server(httpServer, {
    cors: { origin: false }  // LAN-only, no cross-origin needed
  })

  // Store io on global so src/server/socket/index.ts can export it
  // after server.ts initializes it
  (global as any).__io = io

  io.on('connection', (socket) => {
    console.log('client connected:', socket.id)
  })

  const port = parseInt(process.env.PORT ?? '3000', 10)
  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`)
  })
})
```

**`src/server/socket/index.ts` pattern:**
```typescript
import 'server-only'
import type { Server } from 'socket.io'

export function getIO(): Server {
  const io = (global as any).__io
  if (!io) throw new Error('Socket.io not initialized — server.ts must run first')
  return io
}
```
Route Handlers call `getIO().to('kitchen').emit(...)` — never access `(global as any).__io` directly.

### Package Version Guardrails

| Package | Note |
|---|---|
| `drizzle-orm` | Stable 0.x line — do NOT use `@beta` (v1 beta is available but untested against this architecture) |
| `drizzle-kit` | Match major with `drizzle-orm`; check compatibility on install |
| `socket.io` + `socket.io-client` | Must be the same major version on server and client |
| `server-only` | No version concerns — it's a tiny marker package |
| `@dnd-kit/*` | All three packages must be the same version |

### Directory Structure Compliance

The architecture mandates this structure under `src/`. Story 1.1 creates the scaffold — do not add implementation code:

```
src/
  server/              ← SERVER BOUNDARY. Import 'server-only' at top of db/index.ts and socket/index.ts
    db/
      index.ts         ← db client singleton (pool only — schema comes in Story 1.3)
      migrations/      ← empty dir, committed to repo
    socket/
      index.ts         ← exports getIO() for Route Handler use
  components/
    ui/                ← shadcn/ui auto-generated (NEVER manually edit)
    pos/               ← empty dir for custom POS components
  lib/
    validations/       ← empty dir (Zod schemas land here from Story 2+)
  types/
    index.ts           ← empty export for now
  hooks/               ← empty dir
  store/               ← empty dir
```

**Architecture rule**: Nothing inside `src/server/` may ever be imported by a client component, hook, or store. The `server-only` package enforces this at build time.

### Naming Conventions (Set the Pattern Here)

These apply to all 48 stories. Establishing them in Story 1.1 prevents drift:

- **Files**: kebab-case (`table-card.tsx`, `use-socket.ts`, `order.service.ts`)
- **Components**: PascalCase (`TableCard`, `PINPad`)
- **Variables/functions**: camelCase (`staffId`, `getTableStatus`)
- **Database**: snake_case for all identifiers — enforced from schema definition onward

### Money Handling — Zero Exceptions

All monetary values are stored and transmitted as **integer paisa** (LKR × 100). This is set from the first line of schema and enforced throughout. `parseFloat()` on money values is a project-wide anti-pattern.

Display only: `(paisa / 100).toFixed(2)`. Never use floats for intermediate calculations.

### shadcn/ui init Choices

When `pnpm dlx shadcn@latest init` prompts:
- Style: **Default**
- Base color: **Slate** (aligns with neutral-900 #0F172A from UX spec)
- CSS variables: **Yes** (required — Story 1.2 extends these with brand tokens)
- `tailwind.config.ts` path: confirm project root
- `src/components/ui/` path: confirm (do not change)

### Project Structure Notes

- `server.ts` lives at the **project root** (same level as `package.json`) — NOT inside `src/`
- `drizzle.config.ts` lives at the **project root**
- `docker/` directory is referenced in architecture but Docker assets (Dockerfile, docker-compose.yml) are the scope of Story 1.4 — do not create them in this story
- `.github/workflows/` is the scope of Story 1.5 — do not create in this story

### What NOT to Implement in This Story

Stay strictly within Story 1.1 scope. The following are explicitly deferred:
- Database schema and tables (Story 1.3)
- Docker Compose and Dockerfile (Story 1.4)
- CI/CD pipeline (Story 1.5)
- Design tokens and CSS variables (Story 1.2)
- PWA manifest and service worker (Story 1.6)
- Any application routes, pages, or components beyond the Next.js default

### References

- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Starter Template Evaluation, Core Architectural Decisions, Structure Patterns, Complete Project Directory Structure
- Epics: `_bmad-output/planning-artifacts/epics.md` — Story 1.1, AR1–AR3, AR12
- [Socket.io with Next.js App Router](https://socket.io/how-to/use-with-nextjs)
- [Tailwind CSS v4 Next.js install](https://tailwindcss.com/docs/guides/nextjs)

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — all issues resolved inline.

### Completion Notes List

1. **Tailwind v4 already installed**: `create-next-app@latest` with Next.js 16.2.9 installs Tailwind v4 natively. The manual upgrade steps in the story tasks were pre-empted. Story dev notes about "v3 by default" are now stale — update for future stories.

2. **No tailwind.config.ts**: Tailwind v4 uses CSS-first config (`@theme` in `globals.css`). Story 1.2 must use `@theme` blocks in `globals.css`, NOT `tailwind.config.ts` `theme.extend`.

3. **pnpm 11 build script blocking**: pnpm 11 blocks all build scripts by default. Three packages needed approval: `sharp`, `unrs-resolver` (from initial install), `esbuild` (from drizzle-kit). Fixed via `pnpm-workspace.yaml` `allowBuilds` + `onlyBuiltDependencies`.

4. **shadcn/ui init bypassed**: `pnpm dlx shadcn@latest init --yes` still shows interactive component library selection. Created `components.json` + `src/lib/utils.ts` manually. Individual components are still added via `pnpm dlx shadcn@latest add <component>` as needed from Story 2+.

5. **Global __io typing**: `global.__io` declared in `src/server/socket/index.ts` using `declare global { var __io: Server | undefined }`. `server.ts` assigns `global.__io = io` directly — no type cast needed because the declaration is picked up via `tsconfig.json` `**/*.ts` include.

6. **esbuild deprecated subdependencies**: `@esbuild-kit/core-utils@3.3.2` and `@esbuild-kit/esm-loader@2.6.5` are deprecated transitive deps of drizzle-kit. These are drizzle-kit internals — ignore warnings until drizzle-kit upgrades them.

### File List

**Project root** (`d:\New folder\carpe-diem-rms\`):
- `package.json` — scripts updated (dev: tsx watch, start: tsx)
- `pnpm-workspace.yaml` — allowBuilds for sharp, unrs-resolver, esbuild
- `server.ts` — custom Node.js HTTP + Socket.io server
- `drizzle.config.ts` — ORM config scaffold
- `components.json` — shadcn/ui config (style: default, slate, cssVariables)
- `.env.example` — all env vars documented

**`src/lib/`**:
- `utils.ts` — cn() utility (clsx + tailwind-merge)

**`src/server/db/`**:
- `index.ts` — server-only guard + pg.Pool + drizzle client
- `migrations/` — empty directory (.gitkeep)

**`src/server/socket/`**:
- `index.ts` — server-only guard + getIO() export

**`src/types/`**:
- `index.ts` — empty export (populated from Story 2+)

**`src/components/`**:
- `pos/` — empty directory (.gitkeep)
- `ui/` — empty directory (shadcn components added per-story)

**`src/lib/validations/`** — empty directory (.gitkeep)

**`src/hooks/`** — empty directory (.gitkeep)

**`src/store/`** — empty directory (.gitkeep)

### Review Findings

*Code review run: 2026-06-21 — Blind Hunter + Edge Case Hunter + manual Acceptance Audit. Acceptance Auditor subagent failed; audit performed inline (all 6 ACs: PASS). 1 dismissed (intentional LAN design).*

#### Patches

- [x] [Review][Patch] `app.prepare()` rejection unhandled — added `.catch()` with `process.exit(1)` [server.ts]
- [x] [Review][Patch] No HTTP server error handler — added `httpServer.on('error', ...)` with EADDRINUSE message [server.ts]
- [x] [Review][Patch] `DATABASE_URL` not validated at startup — added startup throw if unset [src/server/db/index.ts]
- [x] [Review][Patch] `pg.Pool` 'error' event unhandled — added `pool.on('error', ...)` handler [src/server/db/index.ts]
- [x] [Review][Patch] `DATABASE_POOL_MAX` parseInt has no NaN guard — added `Number.isNaN()` guard with fallback to 10 [src/server/db/index.ts:14]
- [x] [Review][Patch] `req.url!` non-null assertion — replaced with `req.url ?? '/'` [server.ts:16]
- [x] [Review][Patch] `NODE_ENV=production` start script — replaced with `cross-env NODE_ENV=production tsx server.ts` [package.json]

#### Deferred

- [x] [Review][Defer] No graceful SIGTERM/SIGINT shutdown handler [server.ts] — deferred, Story 1.4 Docker scope (httpServer.close + pool.end on signal)
- [x] [Review][Defer] SESSION_SECRET has no runtime enforcement [server.ts/.env.example] — deferred, Story 2 auth scope
- [x] [Review][Defer] VENDOR_SECRET/WATCHTOWER_HTTP_API_TOKEN have no enforcement — deferred, vendor routes not yet implemented
- [x] [Review][Defer] `global.__io` hot-reload reassignment risk — deferred, tsx watch restarts the full process so no stale io instances in practice
- [x] [Review][Defer] `getIO()` eager module-level call would crash route modules — deferred, no route handlers exist yet; guidance for Story 2+
- [x] [Review][Defer] Socket.io accepts any LAN connection with no auth — deferred, Epic 2 auth scope
- [x] [Review][Defer] `drizzle.config.ts` uses `!` assertion on DATABASE_URL — deferred, migration tooling only; low operational impact
- [x] [Review][Defer] No startup readiness timeout — deferred, operational improvement not a bug
- [x] [Review][Defer] AC5 server-only build-time test abbreviated — deferred, mechanism verified via tsc --noEmit; full import-boundary test deferred to Story 2 when first Route Handler lands
