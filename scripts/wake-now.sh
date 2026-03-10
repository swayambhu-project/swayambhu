#!/usr/bin/env bash
# Wake Swayambhu without resetting state.
# Kills stale workers, resets sleep timer, starts fresh, triggers wake.
# Usage: source .env && bash scripts/wake-now.sh

set -euo pipefail
cd "$(dirname "$0")/.."

SPA_PORT=3001

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

# ── 2. Wait for ports to free ──────────────────────────────────
echo "=== Waiting for ports 8787/8790 to free ==="
for i in $(seq 1 15); do
  if ! (netstat -ano 2>/dev/null | grep -E ':(8787|8790)\s' | grep -q 'LISTENING'); then
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "ERROR: ports still in use after 15s — something else is holding them"
    exit 1
  fi
  sleep 1
done

# ── 3. Reset wake timer (while workers are stopped) ────────────
echo "=== Resetting wake timer ==="
node scripts/reset-wake-timer.mjs

# ── 4. Start services ─────────────────────────────────────────
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

# ── 5. Wait for brainstem + dashboard API to be ready ──────────
echo ""
echo "=== Waiting for services to start... ==="
for i in $(seq 1 30); do
  brainstem_up=false
  dashboard_up=false
  curl -s -o /dev/null http://localhost:8787 2>/dev/null && brainstem_up=true
  curl -s -o /dev/null http://localhost:8790 2>/dev/null && dashboard_up=true
  if $brainstem_up && $dashboard_up; then
    echo "  brainstem + dashboard API ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: services did not start within 30s"
    $brainstem_up || echo "  brainstem: NOT READY"
    $dashboard_up || echo "  dashboard API: NOT READY"
    cleanup
  fi
  sleep 1
done

# ── 6. Verify wake timer was reset ────────────────────────────
echo "=== Verifying wake timer ==="
wake_check=$(curl -s -H "X-Operator-Key: test" http://localhost:8790/health 2>/dev/null || echo '{}')
if echo "$wake_check" | grep -q "next_wake_after"; then
  wake_time=$(echo "$wake_check" | node --input-type=module -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const h=JSON.parse(d); console.log(h.wakeConfig?.next_wake_after||'none'); }
      catch { console.log('unknown'); }
    });
  ")
  echo "  next_wake_after: $wake_time"
fi

# ── 7. Trigger wake ───────────────────────────────────────────
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
