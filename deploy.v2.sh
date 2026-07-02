#!/usr/bin/env bash
# Safe ship for VERSION 2 → a SEPARATE Cloudflare Worker `hn-lens-v2` (own KV).
# The frozen V1 (worker `hn-lens`, git tag `v1`) is never touched by this.
# verify → deploy (wrangler.v2.toml) → smoke (live v2 URL) → checkpoint.
# Usage: npm run ship:v2 ["checkpoint message"]   (or: bash deploy.v2.sh "msg")
set -euo pipefail
cd "$(dirname "$0")"

V2_URL="https://hn-lens-v2.zack-chen.workers.dev"

echo "▸ typecheck"
npm run -s typecheck

echo "▸ node --check (front-end)"
node --check public/app.js
node --check public/pixel.js

echo "▸ deploy (hn-lens-v2)"
export $(grep -v '^#' .env | xargs)
npx wrangler deploy --config wrangler.v2.toml

echo "▸ smoke (live v2)"
if ! bash scripts/smoke.sh "$V2_URL"; then
  echo "⚠ v2 smoke FAILED after deploy — investigate $V2_URL" >&2
  exit 1
fi

echo "▸ checkpoint"
sprite-env checkpoints create --comment "${1:-deploy v2 via deploy.v2.sh}" >/dev/null && echo "  checkpoint created"

echo "✓ shipped v2 → $V2_URL"
