#!/usr/bin/env bash
# Switch all LLM models to a single model for testing.
# Usage: bash scripts/switch-model.sh deepseek/deepseek-v3.2
#        bash scripts/switch-model.sh anthropic/claude-sonnet-4.6
#
# Patches config:defaults and config:models in local KV in-place.
# Run AFTER seed-local-kv.sh. No need to re-seed.

set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="${1:?Usage: switch-model.sh <model-id>}"
BINDING="KV"
PERSIST_TO=".wrangler/shared-state"
LOCAL="--local --persist-to $PERSIST_TO"

echo "Switching all models to: $MODEL"

# ── Patch config:defaults ──────────────────────────────────────
# Read current, patch model fields, write back

node -e "
const model = process.argv[1];
const defaults = JSON.parse(process.argv[2]);
defaults.orient.model = model;
defaults.reflect.model = model;
defaults.deep_reflect.model = model;
defaults.execution.fallback_model = model;
process.stdout.write(JSON.stringify(defaults, null, 2));
" "$MODEL" "$(wrangler kv key get --binding "$BINDING" $LOCAL "config:defaults" 2>/dev/null)" \
  > /tmp/_kv_switch_val

wrangler kv key put --binding "$BINDING" $LOCAL "config:defaults" \
  --path /tmp/_kv_switch_val --metadata '{"format":"json"}'
echo "  ✓ config:defaults"

# ── Patch config:models ────────────────────────────────────────

node -e "
const model = process.argv[1];
const alias = model.split('/').pop().replace(/-/g, '_');
const cfg = JSON.parse(process.argv[2]);
// Update every model entry to point to the new model, with matching alias
cfg.models = cfg.models.map(m => ({ ...m, id: model, alias }));
cfg.fallback_model = model;
// Rebuild alias_map: keep existing aliases, all point to new model
const aliasMap = {};
for (const key of Object.keys(cfg.alias_map || {})) aliasMap[key] = model;
aliasMap[alias] = model;
cfg.alias_map = aliasMap;
process.stdout.write(JSON.stringify(cfg, null, 2));
" "$MODEL" "$(wrangler kv key get --binding "$BINDING" $LOCAL "config:models" 2>/dev/null)" \
  > /tmp/_kv_switch_val

wrangler kv key put --binding "$BINDING" $LOCAL "config:models" \
  --path /tmp/_kv_switch_val --metadata '{"format":"json"}'
echo "  ✓ config:models"

# ── Patch kernel:fallback_model ────────────────────────────────

echo -n "\"$MODEL\"" > /tmp/_kv_switch_val
wrangler kv key put --binding "$BINDING" $LOCAL "kernel:fallback_model" \
  --path /tmp/_kv_switch_val --metadata '{"format":"json"}'
echo "  ✓ kernel:fallback_model"

rm -f /tmp/_kv_switch_val
echo ""
echo "Done. All roles now use: $MODEL"
echo "No re-seed needed. Restart wrangler dev to pick up changes."
