# KV Seed Files

These are the initial KV entries that bootstrap Swayambhu. After the first
session, Swayambhu owns all of them and can modify anything.

---

## config:defaults

```json
{
  "orient": {
    "model": "anthropic/claude-opus-4-20250514",
    "effort": "low",
    "max_output_tokens": 4000
  },
  "reflect": {
    "model": "anthropic/claude-sonnet-4-5-20250929",
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
    "fallback_model": "anthropic/claude-haiku-4-5-20251001"
  },
  "deep_reflect": {
    "default_interval_sessions": 20,
    "default_interval_days": 7,
    "model": "anthropic/claude-opus-4-20250514",
    "effort": "high",
    "max_output_tokens": 4000
  }
}
```

## config:models

```json
{
  "models": [
    {
      "id": "anthropic/claude-opus-4-20250514",
      "alias": "opus",
      "input_cost_per_mtok": 5.00,
      "output_cost_per_mtok": 25.00,
      "max_output_tokens": 128000,
      "best_for": "Strategy, novel situations, full situational awareness, deep reflection"
    },
    {
      "id": "anthropic/claude-sonnet-4-5-20250929",
      "alias": "sonnet",
      "input_cost_per_mtok": 3.00,
      "output_cost_per_mtok": 15.00,
      "max_output_tokens": 64000,
      "best_for": "Writing, moderate reasoning, reflection, subplan planning"
    },
    {
      "id": "anthropic/claude-haiku-4-5-20251001",
      "alias": "haiku",
      "input_cost_per_mtok": 1.00,
      "output_cost_per_mtok": 5.00,
      "max_output_tokens": 64000,
      "best_for": "Simple tasks, classification, condition evaluation, cheap execution"
    }
  ],
  "fallback_model": "anthropic/claude-haiku-4-5-20251001",
  "alias_map": {
    "opus": "anthropic/claude-opus-4-20250514",
    "sonnet": "anthropic/claude-sonnet-4-5-20250929",
    "haiku": "anthropic/claude-haiku-4-5-20251001"
  }
}
```

## config:resources

```json
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
    "address": "{{WALLET_ADDRESS}}"
  },
  "telegram": {
    "bot_token_secret": "TELEGRAM_BOT_TOKEN",
    "chat_id_secret": "TELEGRAM_CHAT_ID"
  }
}
```

## Secrets

Two tiers of credentials. The brainstem merges both into a single `secrets`
object for tools and adapters — the code doesn't know which tier a secret came from.

**Tier 1: Env secrets** (encrypted at rest, human-provisioned via `wrangler secret put`)
- `OPENROUTER_API_KEY` — primary LLM provider
- `TELEGRAM_BOT_TOKEN` — communication channel
- `TELEGRAM_CHAT_ID` — communication channel
- `WALLET_ADDRESS` — on-chain identity
- `WALLET_PRIVATE_KEY` — on-chain signing (most sensitive)

**Tier 2: KV secrets** (stored at `secret:{name}`, Swayambhu-provisioned)
- Anything Swayambhu acquires himself — search APIs, service tokens, etc.
- Written via `kv_operations` in orient/reflect, or via tools with KV write access
- Less secure (not encrypted at rest) but fully autonomous

Tool/adapter metadata declares which it needs from each tier:

```json
{
  "secrets": ["TELEGRAM_BOT_TOKEN"],
  "kv_secrets": ["SERP_API_KEY"],
  "kv_access": "none",
  "timeout_ms": 10000
}
```

If Swayambhu needs a new env secret (e.g. switching primary LLM provider),
he messages on Telegram requesting it. Human runs `wrangler secret put`.

---

## Provider Adapters

Provider adapters let Swayambhu change his LLM provider and wallet without
brainstem changes. Each adapter is a JS function in KV, same pattern as tools.
The brainstem has hardcoded fallbacks for OpenRouter + Base USDC that can never
be removed — they're the safety net.

**Cascade:** dynamic adapter → last known working → hardcoded fallback.

### provider:llm:meta

```json
{
  "secrets": ["OPENROUTER_API_KEY"],
  "timeout_ms": 60000
}
```

### provider:llm:code

```js
async function call({ model, messages, max_tokens, thinking, secrets, fetch }) {
  const body = { model, max_tokens, messages };
  if (thinking) {
    body.provider = { require_parameters: true };
    body.thinking = thinking;
  }
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + secrets.OPENROUTER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(JSON.stringify(data.error));
  return {
    content: data.choices?.[0]?.message?.content || "",
    usage: data.usage || {}
  };
}
```

### provider:llm_balance:meta

```json
{
  "secrets": ["OPENROUTER_API_KEY"],
  "timeout_ms": 10000
}
```

### provider:llm_balance:code

```js
async function check({ secrets, fetch }) {
  const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { "Authorization": "Bearer " + secrets.OPENROUTER_API_KEY }
  });
  const data = await resp.json();
  return data?.data?.limit_remaining ?? data?.data?.usage ?? null;
}
```

### provider:wallet_balance:meta

```json
{
  "secrets": ["WALLET_ADDRESS"],
  "timeout_ms": 10000
}
```

### provider:wallet_balance:code

```js
async function check({ secrets, fetch }) {
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const wallet = secrets.WALLET_ADDRESS;
  const data = "0x70a08231" + wallet.slice(2).padStart(64, "0");
  const resp = await fetch("https://mainnet.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_call",
      params: [{ to: usdc, data }, "latest"]
    })
  });
  const result = await resp.json();
  return parseInt(result.result, 16) / 1e6;
}
```

---

## Tools

Tools are stored as two KV entries each: `tool:{name}:code` (the JS function)
and `tool:{name}:meta` (permissions and config). The brainstem loads them
dynamically via `new Function()` and sandboxes each tool's access to secrets
and KV based on its metadata.

Swayambhu can create, edit, and delete tools by writing to these KV keys.

### tool:send_telegram:meta

```json
{
  "secrets": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
  "kv_access": "none",
  "timeout_ms": 10000
}
```

### tool:send_telegram:code

```js
async function execute({ text, parse_mode, secrets, fetch }) {
  const url = `https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: secrets.TELEGRAM_CHAT_ID,
      text,
      parse_mode: parse_mode || "Markdown"
    })
  });
  return resp.json();
}
```

### tool:web_fetch:meta

```json
{
  "secrets": [],
  "kv_access": "none",
  "timeout_ms": 15000
}
```

### tool:web_fetch:code

```js
async function execute({ url, headers, method, max_length, fetch }) {
  const resp = await fetch(url, {
    method: method || "GET",
    headers: headers || {}
  });
  const text = await resp.text();
  const limit = max_length || 10000;
  return {
    status: resp.status,
    body: text.length > limit ? text.slice(0, limit) + "...[truncated]" : text
  };
}
```

### tool:kv_read:meta

```json
{
  "secrets": [],
  "kv_access": "read_all",
  "timeout_ms": 5000
}
```

### tool:kv_read:code

```js
async function execute({ key, kv }) {
  const val = await kv.get(key);
  return { key, value: val };
}
```

### tool:kv_write:meta

```json
{
  "secrets": [],
  "kv_access": "own",
  "timeout_ms": 5000
}
```

### tool:kv_write:code

Note: KV write tools are scoped to `tooldata:kv_write:*` by default via the
brainstem sandbox. For writing to arbitrary keys, the orient/reflect steps
use `kv_operations` in their JSON output — not the kv_write tool.

```js
async function execute({ key, value, kv }) {
  await kv.put(key, typeof value === "string" ? value : JSON.stringify(value));
  return { key, written: true };
}
```

### tool:check_or_balance:meta

```json
{
  "secrets": ["OPENROUTER_API_KEY"],
  "kv_access": "none",
  "timeout_ms": 10000
}
```

### tool:check_or_balance:code

```js
async function execute({ secrets, fetch }) {
  const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { "Authorization": `Bearer ${secrets.OPENROUTER_API_KEY}` }
  });
  return resp.json();
}
```

### tool:check_wallet_balance:meta

```json
{
  "secrets": ["WALLET_ADDRESS"],
  "kv_access": "none",
  "timeout_ms": 10000
}
```

### tool:check_wallet_balance:code

```js
async function execute({ secrets, fetch }) {
  // USDC on Base — ERC-20 balanceOf call
  // USDC contract on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const wallet = secrets.WALLET_ADDRESS;
  // balanceOf(address) selector: 0x70a08231
  const data = "0x70a08231" + wallet.slice(2).padStart(64, "0");
  const resp = await fetch("https://mainnet.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: usdc, data }, "latest"]
    })
  });
  const result = await resp.json();
  // USDC has 6 decimals
  const raw = parseInt(result.result, 16);
  return { balance_usdc: raw / 1e6, raw_hex: result.result };
}
```

### tool:topup_openrouter:meta

```json
{
  "secrets": ["OPENROUTER_API_KEY", "WALLET_PRIVATE_KEY", "WALLET_ADDRESS"],
  "kv_access": "none",
  "timeout_ms": 30000
}
```

### tool:topup_openrouter:code

```js
async function execute({ amount, secrets, fetch }) {
  // TODO: Implement on-chain USDC transfer to OpenRouter
  // This requires viem or ethers for transaction signing
  // For now, return a stub so the tool interface is ready
  return {
    ok: false,
    error: "On-chain signing not yet implemented",
    amount_requested: amount
  };
}
```

### config:tool_registry

This is what the orient prompt receives — a summary of available tools.
Swayambhu maintains this himself. It's separate from the actual tool code
so he can add usage notes, flag limitations, etc.

```json
{
  "tools": [
    {
      "name": "send_telegram",
      "description": "Post a message to the Telegram channel",
      "input": { "text": "required", "parse_mode": "Markdown | HTML" },
      "notes": ""
    },
    {
      "name": "web_fetch",
      "description": "Fetch contents of a URL",
      "input": { "url": "required", "method": "GET|POST", "headers": "optional", "max_length": "default 10000" },
      "notes": ""
    },
    {
      "name": "kv_read",
      "description": "Read a value from memory (any key)",
      "input": { "key": "required" },
      "notes": "Counts against daily read limit (100K/day)"
    },
    {
      "name": "kv_write",
      "description": "Write to tool's own KV namespace. For arbitrary writes use kv_operations in reflect.",
      "input": { "key": "required", "value": "required" },
      "notes": "Scoped to tooldata:kv_write:* namespace. Counts against daily write limit (1K/day)"
    },
    {
      "name": "check_or_balance",
      "description": "Check current OpenRouter credit balance",
      "input": {},
      "notes": "Free API call"
    },
    {
      "name": "check_wallet_balance",
      "description": "Check USDC balance on Base",
      "input": {},
      "notes": "Free RPC call"
    },
    {
      "name": "topup_openrouter",
      "description": "Transfer USDC from wallet to OpenRouter credits",
      "input": { "amount": "USD amount, required" },
      "notes": "5% fee. NOT YET IMPLEMENTED — needs on-chain signing."
    }
  ]
}
```
