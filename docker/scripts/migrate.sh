#!/bin/sh
set -e

echo "[migrate] Applying database migrations..."
pnpm db:migrate
echo "[migrate] Migrations complete."
