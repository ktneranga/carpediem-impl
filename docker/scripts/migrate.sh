#!/bin/sh
set -e

echo "[migrate] Applying database migrations..."
# Direct binary, not `pnpm db:migrate`: pnpm 11 re-checks (and tries to
# reinstall) dependencies before every script, which fails in this image.
./node_modules/.bin/drizzle-kit migrate
echo "[migrate] Migrations complete."
