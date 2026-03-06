# Development Guide

## Architecture: prod vs dev

Production (`brainstem.js` + `wrangler.toml`) uses Cloudflare Worker Loader
isolates to run tool code, provider adapters, and the wake hook from KV.
This requires `[[worker_loaders]]` and `enable_ctx_exports`, which are only
available in deployed Workers.

Dev (`brainstem-dev.js` + `wrangler.dev.toml`) subclasses the production
`Brainstem` class and overrides only the 4 methods that depend on isolates.
Everything else — the entire kernel, wake flow, mutation protocol, reflection
hierarchy, budget enforcement, karma — is inherited unchanged.

```
brainstem-dev.js
  ├── import { Brainstem } from './brainstem.js'   ← kernel
  ├── import { wake } from './wake-hook.js'        ← policy layer
  ├── import * as ... from './tools/*.js'           ← tool modules
  └── class DevBrainstem extends Brainstem
        ├── _invokeHookModules()  → calls wake() directly
        ├── _loadTool()           → returns imported module meta
        ├── _executeTool()        → calls module.execute() directly
        ├── callWithCascade()     → direct OpenRouter fetch
        └── callHook()            → returns null
```

## What lives where

| Code | Location | How prod uses it | How dev uses it |
|------|----------|------------------|-----------------|
| Kernel (KV, karma, agent loop, budget) | `brainstem.js` | Direct | Inherited via `extends` |
| Wake flow, reflection, mutations | `wake-hook.js` | Loaded from KV via isolate | `import { wake }` |
| Tool implementations | `tools/*.js` | Seeded to KV, loaded via isolate | `import * as ...` |
| Provider adapters | `providers/*.js` | Seeded to KV, loaded via isolate | Direct `fetch()` in override |
| Prompts, config, dharma | `scripts/seed-local-kv.sh` | KV | KV (same seed script) |

Tools and providers live in `tools/` and `providers/` respectively. **Single
source of truth.** The seed script reads these files directly into KV.

## Running locally

```bash
# 1. Kill stale workers
taskkill //F //IM workerd.exe

# 2. Clear state
rm -rf .wrangler/shared-state

# 3. Seed KV (fast — ~2s via Miniflare API)
node scripts/seed-local-kv.mjs

# 4. Start dev brainstem (uses wrangler.dev.toml)
source .env
npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state

# 5. Trigger a wake cycle
curl http://localhost:8787/__scheduled
```

Watch stderr for `[KARMA]`, `[TOOL]`, `[LLM]`, `[HOOK]` tagged output.

There are two seed scripts:
- **`node scripts/seed-local-kv.mjs`** — fast (~2s). Uses Miniflare API
  directly, writes all keys in a single process. Use this for day-to-day dev.
- **`bash scripts/seed-local-kv.sh`** — slow (~60s). Uses `wrangler kv` CLI.
  Supports `--pull-remote` to pull dharma/orient/wisdom from live KV.
  Authoritative reference for what gets seeded.

### Switching models for cheap testing

The seed script seeds the canonical production models (Claude Opus / Sonnet /
Haiku). For basic dev work — testing tool wiring, KV operations, orient flow,
prompt formatting — you don't need expensive models. Use the switch script to
swap all roles to a cheap model:

```bash
# After seeding, switch to DeepSeek V3.2 (~30x cheaper than Claude)
bash scripts/switch-model.sh deepseek/deepseek-v3.2

# Switch back when testing reflect/mutation logic that needs stronger models
bash scripts/switch-model.sh anthropic/claude-sonnet-4.6
```

The script patches `config:defaults`, `config:models`, and
`kernel:fallback_model` in local KV in-place. No re-seed needed — just
restart `wrangler dev`.

**When to use cheap models:** tool execution, orient sessions, basic wake
cycles, KV read/write, prompt template rendering, budget enforcement.

**When to use real models:** reflection hierarchy, mutation
staging/promotion/rollback, deep reflect, anything where output quality
and structured JSON adherence matter.

## Making changes: what to edit and where changes propagate

### 1. Kernel logic (brainstem.js)

Examples: budget enforcement, karma recording, agent loop, KV helpers,
session outcome tracking, hook safety checks.

**Edit:** `brainstem.js`
**Propagation:** Automatic. Dev inherits via `extends Brainstem`.
**Nothing else to do.**

### 2. Wake flow / reflection / mutation protocol (wake-hook.js)

Examples: orient session, reflect hierarchy, mutation staging/promotion/rollback,
circuit breaker, tripwire evaluation, session results.

**Edit:** `wake-hook.js`
**Propagation:** Automatic. Dev imports `wake` directly.
**For prod deploy:** Re-seed KV so `hook:wake:code` picks up the new version:
```bash
bash scripts/seed-local-kv.sh
```

### 3. Tool implementations

Examples: changing how `send_telegram` works, adding a new tool.

#### Modifying an existing tool

1. Edit `tools/{name}.js`
2. Dev picks it up automatically (imported directly)
3. Re-seed for KV: `bash scripts/seed-local-kv.sh`

#### Adding a new tool

1. Create `tools/{name}.js` with `export const meta` and `export async function execute`
2. Add `import * as {name} from './tools/{name}.js'` to `brainstem-dev.js`
3. Add `{name}` to the `TOOL_MODULES` object in `brainstem-dev.js`
4. Add the tool to the `config:tool_registry` JSON in the seed script
5. Add the tool name to the `for tool in ...` loop in the seed script
6. Re-seed: `bash scripts/seed-local-kv.sh`

#### Removing a tool

1. Remove `tools/{name}.js`
2. Remove import and `TOOL_MODULES` entry from `brainstem-dev.js`
3. Remove from `config:tool_registry` and the tool loop in the seed script
4. Re-seed

### 4. Prompts and config

Examples: changing `prompt:orient`, `config:defaults`, `config:models`.

**Edit:** `scripts/seed-local-kv.sh` (or the referenced file, e.g. `prompt-reflect.md`)
**Propagation:** Re-seed. Both prod and dev read these from KV.
**Nothing to change in brainstem-dev.js.**

### 5. Provider adapters

Provider code lives in `providers/*.js`. Dev bypasses providers entirely
with a direct `fetch()` to OpenRouter in `callWithCascade()`.

If you change the request/response format (e.g. adding a new field to the
OpenRouter call), update both:
1. `providers/llm.js`
2. `callWithCascade()` in `brainstem-dev.js`

If you only change cascade/fallback behavior (tier 2, tier 3), that's in
`brainstem.js` and dev skips it by design.

## The tool module contract

Each file in `tools/` exports:

```js
export const meta = {
  secrets: ["ENV_VAR_NAME"],        // resolved from env
  kv_access: "none"|"own"|"read_all",
  timeout_ms: 10000,
};

export async function execute(ctx) { ... }
```

The `ctx` object passed to `execute` contains:
- All tool input fields (e.g. `ctx.text`, `ctx.url`, `ctx.key`)
- `ctx.secrets` — object with resolved secret values
- `ctx.fetch` — global fetch
- `ctx.kv` — scoped KV accessor (only if `kv_access !== "none"`)

**No `export default`.** This is critical. The prod isolate loader uses
`wrapAsModule()` which detects `export default` to decide whether to wrap.
Tool files must use only named exports so the wrapper appends correctly.

## ScopedKV behavior

Tools with `kv_access: "own"` get a KV accessor that:
- **Reads** are prefixed: `tooldata:{toolName}:{key}`
- **Writes** are always prefixed: `tooldata:{toolName}:{key}`
- **List** scopes to `tooldata:{toolName}:` prefix, strips it from results

Tools with `kv_access: "read_all"` get:
- **Reads** use the raw key (full KV access)
- **Writes** are still prefixed (scoped)
- **List** is unscoped

This matches the `ScopedKV` WorkerEntrypoint in `brainstem.js`.

## Deploying to production

```bash
# Deploy brainstem (uses wrangler.toml, which has worker_loaders)
npx wrangler deploy

# Seed remote KV (if config/tools/hooks changed)
# Change LOCAL="" in seed script, or use wrangler kv commands directly
```

Dev-only files (`brainstem-dev.js`, `wrangler.dev.toml`) are never deployed.
Production uses `brainstem.js` directly as its main module.

## Inspecting local KV

Local KV is persisted in SQLite at `.wrangler/shared-state/`. Use the
`read-kv` script to inspect it without needing `sqlite3`:

```bash
# List all keys
node scripts/read-kv.mjs

# List keys with a prefix
node scripts/read-kv.mjs karma:
node scripts/read-kv.mjs config:

# Read a specific key's value
node scripts/read-kv.mjs karma:s_1772718337948_o2yj53
node scripts/read-kv.mjs providers

# Raw JSON output (for piping to jq etc.)
node scripts/read-kv.mjs --json providers
```

The script uses Miniflare's API to read the same SQLite store that
`wrangler dev` and the seed script use.
