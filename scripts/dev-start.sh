#!/usr/bin/env bash
# Full dev reset & start: kill workers, seed KV, launch everything.
# Usage: source .env && bash scripts/dev-start.sh [--cheap]
#
# Options:
#   --prod    Use production models (default: cheap models for dev testing)
#
# Starts:
#   Brainstem      http://localhost:8787
#   Dashboard API  http://localhost:8790
#   Dashboard SPA  http://localhost:3001

set -euo pipefail
cd "$(dirname "$0")/.."

SPA_PORT=3001

PROD=false
if [[ "${1:-}" == "--prod" ]]; then
  PROD=true
fi

PIDS=()
cleanup() {
  echo ""
  echo "=== Shutting down ==="
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  exit
}
trap cleanup INT TERM

# ── 1. Kill stale workers ──────────────────────────────────────
echo "=== Killing stale workers ==="
taskkill //F //IM workerd.exe 2>/dev/null || true
sleep 2

# ── 2. Clear state ─────────────────────────────────────────────
echo "=== Clearing local state ==="
rm -rf .wrangler/shared-state

# ── 3. Seed KV ─────────────────────────────────────────────────
echo "=== Seeding KV ==="
node scripts/seed-local-kv.mjs

# ── 4. Switch to cheap model (default) or keep prod models ────
if ! $PROD; then
  echo ""
  echo "=== Switching to cheap model (use --prod for production models) ==="
  bash scripts/switch-model.sh deepseek/deepseek-v3.2
fi

# ── 5. Start all services ─────────────────────────────────────
echo ""
echo "=== Starting brainstem (port 8787) ==="
npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state &
PIDS+=($!)

echo "=== Starting dashboard API (port 8790) ==="
(cd dashboard-api && npx wrangler dev --port 8790 --persist-to ../.wrangler/shared-state) &
PIDS+=($!)

echo "=== Starting dashboard SPA (port $SPA_PORT) ==="
node scripts/dev-serve.mjs "$SPA_PORT" &
PIDS+=($!)

# ── 6. Wait for brainstem, then trigger wake ───────────────────
echo ""
echo "=== Waiting for brainstem to start... ==="
for i in $(seq 1 30); do
  if curl -s -o /dev/null http://localhost:8787 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "=== Triggering wake cycle ==="
curl -s http://localhost:8787/__scheduled
echo ""

echo ""
echo "=== Running ==="
echo "  Brainstem:      http://localhost:8787"
echo "  Dashboard API:  http://localhost:8790"
echo "  Dashboard SPA:  http://localhost:$SPA_PORT/operator/"
echo ""
echo "  Wake again: curl http://localhost:8787/__scheduled"
echo "  Stop:       Ctrl+C"
echo ""

wait
