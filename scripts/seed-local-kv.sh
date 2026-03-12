#!/usr/bin/env bash
# Seed local Wrangler KV with all bootstrap data from seed-config.md
# Usage: bash scripts/seed-local-kv.sh
#        bash scripts/seed-local-kv.sh --pull-remote   # also pull dharma/orient/wisdom from live KV

set -euo pipefail
cd "$(dirname "$0")/.."

BINDING="KV"
PERSIST_TO=".wrangler/shared-state"
LOCAL="--local --persist-to $PERSIST_TO"

put_kv() {
  local key="$1" file="$2" fmt="${3:-json}"
  wrangler kv key put --binding "$BINDING" $LOCAL "$key" --path "$file" \
    --metadata "{\"format\":\"$fmt\"}"
  echo "  ✓ $key ($fmt)"
}

put_kv_value() {
  local key="$1" value="$2" fmt="${3:-json}"
  echo -n "$value" > /tmp/_kv_seed_val
  wrangler kv key put --binding "$BINDING" $LOCAL "$key" --path /tmp/_kv_seed_val \
    --metadata "{\"format\":\"$fmt\"}"
  echo "  ✓ $key ($fmt)"
}

echo "=== Seeding local KV ==="

# ── Identity keys ──────────────────────────────────────────────

echo ""
echo "--- Identity ---"

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "did": "did:ethr:8453:0xde2c9b784177dafd667b83a631b0de79a68a584e",
  "address": "0xde2c9b784177dafd667b83a631b0de79a68a584e",
  "chain_id": 8453,
  "chain_name": "base",
  "registry": "0xdca7ef03e98e0dc2b855be647c39abe984fcf21b",
  "registry_deployed": false,
  "created_at": "2026-03-02T11:39:35.915Z",
  "dharma_hash": null,
  "controller": "0xde2c9b784177dafd667b83a631b0de79a68a584e"
}
JSONEOF
put_kv "identity:did" /tmp/_kv_seed_val

# ── Config keys ──────────────────────────────────────────────

echo ""
echo "--- Config ---"

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "orient": {
    "model": "anthropic/claude-opus-4.6",
    "effort": "low",
    "max_output_tokens": 4000
  },
  "reflect": {
    "model": "anthropic/claude-sonnet-4.6",
    "effort": "medium",
    "max_output_tokens": 1000
  },
  "session_budget": {
    "max_cost": 0.10,
    "max_steps": 8,
    "max_duration_seconds": 600
  },
  "failure_handling": {
    "retries": 1,
    "on_fail": "skip_and_cascade"
  },
  "wake": {
    "sleep_seconds": 21600,
    "default_effort": "low"
  },
  "memory": {
    "default_load_keys": ["wisdom", "config:models", "config:resources"],
    "max_context_budget_tokens": 8000
  },
  "execution": {
    "max_subplan_depth": 3,
    "max_reflect_depth": 1,
    "reflect_interval_multiplier": 5,
    "max_steps": {
      "orient": 3,
      "reflect_default": 5,
      "reflect_deep": 10
    },
    "fallback_model": "anthropic/claude-haiku-4.5"
  },
  "deep_reflect": {
    "default_interval_sessions": 20,
    "default_interval_days": 7,
    "model": "anthropic/claude-opus-4.6",
    "effort": "high",
    "max_output_tokens": 4000
  }
}
JSONEOF
put_kv "config:defaults" /tmp/_kv_seed_val

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "models": [
    {
      "id": "anthropic/claude-opus-4.6",
      "alias": "opus",
      "input_cost_per_mtok": 5.00,
      "output_cost_per_mtok": 25.00,
      "max_output_tokens": 128000,
      "best_for": "Strategy, novel situations, full situational awareness, deep reflection"
    },
    {
      "id": "anthropic/claude-sonnet-4.6",
      "alias": "sonnet",
      "input_cost_per_mtok": 3.00,
      "output_cost_per_mtok": 15.00,
      "max_output_tokens": 64000,
      "best_for": "Writing, moderate reasoning, reflection, subplan planning"
    },
    {
      "id": "anthropic/claude-haiku-4.5",
      "alias": "haiku",
      "input_cost_per_mtok": 1.00,
      "output_cost_per_mtok": 5.00,
      "max_output_tokens": 64000,
      "best_for": "Simple tasks, classification, condition evaluation, cheap execution"
    }
  ],
  "fallback_model": "anthropic/claude-haiku-4.5",
  "alias_map": {
    "opus": "anthropic/claude-opus-4.6",
    "sonnet": "anthropic/claude-sonnet-4.6",
    "haiku": "anthropic/claude-haiku-4.5"
  }
}
JSONEOF
put_kv "config:models" /tmp/_kv_seed_val

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "kv": {
    "max_storage_mb": 1000,
    "daily_read_limit": 100000,
    "daily_write_limit": 1000,
    "daily_list_limit": 1000,
    "daily_delete_limit": 1000,
    "max_value_size_mb": 25
  },
  "worker": {
    "max_cron_duration_seconds": 900,
    "max_subrequests_per_invocation": 1000,
    "cpu_time_limit_ms": 10
  },
  "openrouter": {
    "base_url": "https://openrouter.ai/api/v1",
    "balance_endpoint": "/api/v1/auth/key",
    "topup_endpoint": "/api/v1/credits/coinbase",
    "topup_fee_percent": 5,
    "topup_chain": "base",
    "topup_chain_id": 8453
  },
  "wallet": {
    "chain": "base",
    "token": "USDC",
    "address": "0x1951e298f9Aa7eFf5eB0dD5349e823BBB09a3260"
  },
  "slack": {
    "bot_token_secret": "SLACK_BOT_TOKEN",
    "channel_id_secret": "SLACK_CHANNEL_ID"
  }
}
JSONEOF
put_kv "config:resources" /tmp/_kv_seed_val

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "openrouter": {
    "provider": "openrouter",
    "adapter": "provider:llm_balance",
    "secret_name": "OPENROUTER_API_KEY",
    "secret_store": "env"
  }
}
JSONEOF
put_kv "providers" /tmp/_kv_seed_val

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "base_usdc": {
    "network": "base",
    "adapter": "provider:wallet_balance",
    "address": "0x1951e298f9Aa7eFf5eB0dD5349e823BBB09a3260"
  }
}
JSONEOF
put_kv "wallets" /tmp/_kv_seed_val

# ── Tool registry ────────────────────────────────────────────

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "tools": [
    { "name": "send_slack", "description": "Post a message to the Slack channel", "input": { "text": "required", "channel": "optional — override default channel" } },
    { "name": "web_fetch", "description": "Fetch contents of a URL", "input": { "url": "required", "method": "GET|POST", "headers": "optional", "max_length": "default 10000" } },
    { "name": "kv_read", "description": "Read a value from memory (any key)", "input": { "key": "required" } },
    { "name": "kv_write", "description": "Write to tool's own KV namespace", "input": { "key": "required", "value": "required" } },
    { "name": "check_or_balance", "description": "Check current OpenRouter credit balance", "input": {} },
    { "name": "check_wallet_balance", "description": "Check USDC balance on Base", "input": {} },
    { "name": "topup_openrouter", "description": "Transfer USDC from wallet to OpenRouter credits", "input": { "amount": "USD amount, required" } },
    { "name": "kv_manifest", "description": "List KV keys, optionally filtered by prefix. Use to explore what is stored in memory.", "input": { "prefix": "optional key prefix filter", "limit": "max keys to return (default 100, max 500)" } }
  ]
}
JSONEOF
put_kv "config:tool_registry" /tmp/_kv_seed_val

# ── Provider adapters (from providers/*.js) ──────────────────

echo ""
echo "--- Providers ---"

put_kv "provider:llm:code" "providers/llm.js" text
node -e "import('./providers/llm.js').then(m=>process.stdout.write(JSON.stringify(m.meta)))" > /tmp/_kv_seed_val
put_kv "provider:llm:meta" /tmp/_kv_seed_val

put_kv "provider:llm_balance:code" "providers/llm_balance.js" text
node -e "import('./providers/llm_balance.js').then(m=>process.stdout.write(JSON.stringify(m.meta)))" > /tmp/_kv_seed_val
put_kv "provider:llm_balance:meta" /tmp/_kv_seed_val

put_kv "provider:wallet_balance:code" "providers/wallet_balance.js" text
node -e "import('./providers/wallet_balance.js').then(m=>process.stdout.write(JSON.stringify(m.meta)))" > /tmp/_kv_seed_val
put_kv "provider:wallet_balance:meta" /tmp/_kv_seed_val

# ── Tools (from tools/*.js) ──────────────────────────────────

echo ""
echo "--- Tools ---"

for tool in send_slack web_fetch kv_read kv_write check_or_balance check_wallet_balance topup_openrouter kv_manifest; do
  put_kv "tool:${tool}:code" "tools/${tool}.js" text
  node -e "import('./tools/${tool}.js').then(m=>process.stdout.write(JSON.stringify(m.meta)))" > /tmp/_kv_seed_val
  put_kv "tool:${tool}:meta" /tmp/_kv_seed_val
done

# ── Prompt templates ─────────────────────────────────────────

echo ""
echo "--- Prompts ---"

put_kv "prompt:reflect" "prompt-reflect.md" text
put_kv "prompt:reflect:1" "prompt-deep.md" text

cat > /tmp/_kv_seed_val <<'PROMPTEOF'
You are executing a subgoal. You have tools available via function calling.

Goal: {{goal}}

Use your tools to accomplish this goal. When done, produce a JSON object
with a "result" field summarizing what you accomplished.

Budget: max {{maxSteps}} turns, max ${{maxCost}}.
PROMPTEOF
put_kv "prompt:subplan" /tmp/_kv_seed_val text

# ── Dharma, orient, wisdom (from remote or placeholder) ────────

echo ""
echo "--- Identity ---"

if [[ "${1:-}" == "--pull-remote" ]]; then
  echo "  Pulling dharma, prompt:orient, wisdom from remote KV..."
  for key in dharma "prompt:orient" wisdom; do
    wrangler kv key get --binding "$BINDING" "$key" > /tmp/_kv_seed_val 2>/dev/null || true
    if [[ -s /tmp/_kv_seed_val ]]; then
      put_kv "$key" /tmp/_kv_seed_val
    else
      echo "  ⚠ $key not found in remote KV, skipping"
    fi
  done
else
  echo "  Using local values (run with --pull-remote to pull orient/wisdom from live KV)"

  put_kv "dharma" "DHARMA.md" text

  cat > /tmp/_kv_seed_val <<'PROMPTEOF'
You are Swayambhu. You have just woken up.

Your dharma: {{dharma}}

## Available tools

You have tools available via function calling. Use them to act on the world:
check balances, search the web, send messages, read/write memory.

To run independent tasks in parallel, call spawn_subplan multiple times in
a single turn. Each spawns a nested agent with its own tool access.

## What to do

Orient yourself using the context provided. Then act — check what needs
checking, do what needs doing. When you're done, produce your final output
as a JSON object:

{
  "session_summary": "What you did and why",
  "kv_operations": [],
  "next_wake_config": { "sleep_seconds": 21600, "effort": "low" }
}

kv_operations: array of {op: "put"|"delete", key, value} for unprotected keys.
Protected keys (prompts, config, wisdom) require mutation_requests via reflect.
PROMPTEOF
  put_kv "prompt:orient" /tmp/_kv_seed_val text

  put_kv_value "wisdom" "Local test instance. No accumulated wisdom yet." text
fi

# ── Wake hook ────────────────────────────────────────────────

echo ""
echo "--- Wake Hook ---"

put_kv "hook:wake:code" "wake-hook.js" text

# ── Kernel config ────────────────────────────────────────────

echo ""
echo "--- Kernel Config ---"

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "url": "https://slack.com/api/chat.postMessage",
  "headers": { "Content-Type": "application/json", "Authorization": "Bearer {{SLACK_BOT_TOKEN}}" },
  "body_template": {
    "channel": "{{SLACK_CHANNEL_ID}}",
    "text": "[Swayambhu] {{event}}: {{message}}"
  }
}
JSONEOF
put_kv "kernel:alert_config" /tmp/_kv_seed_val

# kernel:llm_fallback — Tier 3 LLM adapter (same code as provider:llm)
put_kv "kernel:llm_fallback" "providers/llm.js" text
node -e "import('./providers/llm.js').then(m=>process.stdout.write(JSON.stringify(m.meta)))" > /tmp/_kv_seed_val
put_kv "kernel:llm_fallback:meta" /tmp/_kv_seed_val
put_kv_value "kernel:fallback_model" '"anthropic/claude-haiku-4.5"'

# ── Reference docs ──────────────────────────────────────────

echo ""
echo "--- Docs ---"

put_kv "doc:mutation_guide" "docs/doc-mutation-guide.md" text
put_kv "doc:architecture" "docs/doc-architecture.md" text

# ── Cleanup ──────────────────────────────────────────────────

rm -f /tmp/_kv_seed_val

echo ""
echo "=== Done! Local KV seeded ==="
echo ""
echo "Start brainstem (port 8787):"
echo "  source .env && npx wrangler dev --test-scheduled --persist-to .wrangler/shared-state"
echo ""
echo "Start dashboard API (port 8790, from dashboard-api/):"
echo "  npx wrangler dev --port 8790 --persist-to ../.wrangler/shared-state"
echo ""
echo "Trigger the cron:"
echo "  curl http://localhost:8787/__scheduled"
