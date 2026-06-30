#!/usr/bin/env bash
# Safe ship: verify → deploy → smoke (live) → checkpoint.
# Refuses to deploy if typecheck or syntax checks fail. Usage: bash deploy.sh ["checkpoint message"]
set -euo pipefail
cd "$(dirname "$0")"

echo "▸ typecheck"
npm run -s typecheck

echo "▸ node --check (front-end)"
node --check public/app.js
node --check public/pixel.js

echo "▸ deploy"
export $(grep -v '^#' .env | xargs)
npx wrangler deploy

echo "▸ smoke (live)"
if ! bash scripts/smoke.sh; then
  echo "⚠ smoke FAILED after deploy — investigate the live site." >&2
  exit 1
fi

echo "▸ checkpoint"
sprite-env checkpoints create --comment "${1:-deploy via deploy.sh}" >/dev/null && echo "  checkpoint created"

echo "✓ shipped"
