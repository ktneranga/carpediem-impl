# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
# Pinned to the version the lockfile is made with: an unpinned pnpm changed
# behaviour under us (pnpm 11 stops on unapproved build scripts).
RUN npm install -g pnpm@11.8.0

# ── deps: install ALL dependencies (dev+prod) ────────────────────────────────
# drizzle-kit (devDep) runs migrations at container start via migrate.sh
# cross-env (devDep) is called by pnpm start
# tsx is now in dependencies (production server runtime)
FROM base AS deps
WORKDIR /app
# pnpm-workspace.yaml carries `allowBuilds` (esbuild, sharp, unrs-resolver):
# without it pnpm refuses their install scripts and the build fails.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Slow links (a restaurant's or a home connection): wait longer per package and
# retry, and keep pnpm's store in a BuildKit cache so a retry or the next build
# reuses what was already downloaded.
ENV npm_config_fetch_timeout=300000     npm_config_fetch_retries=5     npm_config_fetch_retry_maxtimeout=120000
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store     pnpm install --frozen-lockfile --network-concurrency=8

# ── builder: compile Next.js application ─────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ── runner: production image ──────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# pg_dump for the vendor database export (spec-11-1-vendor-access-export).
# Version 17, the same as the db service's postgres:17 image: pg_dump refuses
# a server newer than itself.
RUN apk add --no-cache postgresql17-client

# All deps (includes devDeps for drizzle-kit and cross-env)
COPY --from=deps /app/node_modules ./node_modules

# Compiled Next.js app (route handlers and all server-side imports are bundled here)
COPY --from=builder /app/.next ./.next

# Static assets
COPY --from=builder /app/public ./public

# Custom server entry point (NOT compiled by next build)
COPY server.ts ./

# drizzle-kit config + migration SQL files (applied at container start)
COPY drizzle.config.ts ./
COPY src/server/db/ ./src/server/db/

# pnpm scripts (db:migrate, start) and entrypoint scripts
COPY package.json ./
COPY docker/ ./docker/

RUN chmod +x docker/scripts/migrate.sh docker/scripts/healthcheck.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD sh docker/scripts/healthcheck.sh

# Run migrations then start the server
CMD ["sh", "-c", "sh docker/scripts/migrate.sh && pnpm start"]
