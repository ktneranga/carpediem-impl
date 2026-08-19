FROM node:22-alpine AS base
RUN npm install -g pnpm

# ── deps: install ALL dependencies (dev+prod) ────────────────────────────────
# drizzle-kit (devDep) runs migrations at container start via migrate.sh
# cross-env (devDep) is called by pnpm start
# tsx is now in dependencies (production server runtime)
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

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
