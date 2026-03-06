# Testing Strategy

## Layers

### Layer 0: Unit tests (`npm test`)

Fast, no network, no Workers runtime. Uses vitest with mock KV and mock fetch.

**What's tested:**
- Kernel logic (brainstem.test.js): parseAgentOutput, buildPrompt, budget
  enforcement, karma recording, tool definitions, session management
- Wake hook (wake-hook.test.js): orient context, reflect scheduling, mutation
  protocol, circuit breaker, tripwire evaluation
- Tools (tools.test.js): each tool's execute() with mock context, module
  structure validation, wrapAsModule compatibility

**What it catches:** Logic bugs, regressions, contract violations between
kernel and hook, broken tool modules.

**Run:** `npm test`

### Layer 1: Dev integration (`wrangler dev -c wrangler.dev.toml`)

Real LLM calls via OpenRouter, inline tool execution (no isolates), real KV.

**What's tested:**
- Full wake cycle: orient → tool calls → reflect → session results
- Tool execution with real network (Telegram, web fetch, balance checks)
- KV read/write through actual Wrangler miniflare

**What it catches:** Prompt bugs, LLM interaction issues, tool context
wiring, KV serialization problems.

**Run:**
```bash
bash scripts/seed-local-kv.sh
source .env
npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state
curl http://localhost:8787/__scheduled
```

### Layer 2: Prod integration (`wrangler dev` with `wrangler.toml`)

Full isolates via Worker Loader, provider cascade, hook dispatch through
KernelRPC. Closest to production.

**What's tested:**
- Worker Loader isolate creation and module wrapping
- ScopedKV via WorkerEntrypoint RPC
- Provider cascade (tier 1 → tier 2 → tier 3 fallback)
- KernelRPC bridge between hook isolate and kernel

**What it catches:** Isolate-specific bugs, module wrapping issues, RPC
serialization problems, provider cascade failures.

**Run:**
```bash
bash scripts/seed-local-kv.sh
source .env
npx wrangler dev --test-scheduled --persist-to .wrangler/shared-state
curl http://localhost:8787/__scheduled
```

## Test helpers

Shared mocks live in `tests/helpers/`:

- `mock-kv.js` — `makeKVStore(initial)`: in-memory KV with get/put/delete/list
- `mock-kernel.js` — `makeMockK(kvInit, opts)`: full KernelRPC mock with
  KV, karma, agent loop, and state getters

## Adding tests

- Tool tests go in `tests/tools.test.js`
- Kernel tests go in `tests/brainstem.test.js`
- Wake hook tests go in `tests/wake-hook.test.js`
- Use shared helpers from `tests/helpers/` for mocks
