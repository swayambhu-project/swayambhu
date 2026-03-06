# Claude Code Project Notes

## Environment Setup

Before running Swayambhu, source the local env file:

```bash
source .env
```

This loads `OPENROUTER_API_KEY` needed for LLM access.

## Local Dev Startup

### Shared state

All local workers and the seed script must use the same `--persist-to` path
so they share one KV store. The canonical path is `.wrangler/shared-state`
(relative to repo root). The seed script already has this baked in.

### Full reset & start (from repo root)

```bash
# 1. Kill any running workers
taskkill //F //IM workerd.exe

# 2. Clear local state (wait a few seconds after killing workers)
rm -rf .wrangler/shared-state

# 3. Seed local KV (fast — ~2s)
node scripts/seed-local-kv.mjs

# 4. Switch to cheap model for basic testing
bash scripts/switch-model.sh deepseek/deepseek-v3.2

# 5. Start brainstem (port 8787)
source .env
npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state

# 6. Start dashboard API (port 8790, in a second terminal)
cd dashboard-api
npx wrangler dev --port 8790 --persist-to ../.wrangler/shared-state

# 7. Trigger a wake cycle
curl http://localhost:8787/__scheduled
```

### Ports

| Service        | Port | Notes                                    |
|----------------|------|------------------------------------------|
| Brainstem      | 8787 | `--test-scheduled` enables `/__scheduled` |
| Dashboard API  | 8790 | SPA hardcodes this for localhost          |
| Dashboard SPA  | 3000 | Static file server (or open index.html)   |

### Dashboard auth

The operator key for local dev is `test` (set in `dashboard-api/.dev.vars`).
Enter it in the dashboard login prompt.

## Testing

### Unit tests

```bash
npm test          # vitest — all unit tests, no network, no Workers runtime
```

Tests cover:
- `tests/brainstem.test.js` — kernel logic (85 tests)
- `tests/wake-hook.test.js` — wake flow, reflect, mutations (48 tests)
- `tests/tools.test.js` — tool/provider execute(), module structure (38 tests)

Shared mocks in `tests/helpers/`: `mock-kv.js` (KV store), `mock-kernel.js`
(KernelRPC mock).

### Integration testing (dev mode)

After seeding + starting wrangler dev, trigger a wake cycle:

```bash
curl http://localhost:8787/__scheduled
```

Watch stderr for tagged output: `[KARMA]`, `[TOOL]`, `[LLM]`, `[HOOK]`.

### Switching models

The seed script seeds canonical production models (Claude). Use the switch
script to swap all roles to a cheaper model for basic dev testing:

```bash
# Switch to DeepSeek V3.2 (~30x cheaper) for basic testing
bash scripts/switch-model.sh deepseek/deepseek-v3.2

# Switch back when testing reflect/mutation logic
bash scripts/switch-model.sh anthropic/claude-sonnet-4.6
```

Patches KV in-place (no re-seed needed). Restart wrangler dev to pick up.

**Use cheap models for:** tool wiring, orient flow, KV ops, prompt rendering,
budget enforcement, basic wake cycles.

**Use real models for:** reflection hierarchy, mutation protocol, deep reflect,
anything needing structured JSON adherence.

## Code Layout

### Tools and providers

Tool code lives in `tools/*.js`, provider adapters in `providers/*.js`.
Single source of truth — dev imports them directly, seed script reads
them into KV for prod. **No `export default`** in these files (required
for `wrapAsModule` compatibility).

### Key scripts

| Script | Purpose |
|--------|---------|
| `source .env && bash scripts/dev-start.sh` | Full reset: seed, cheap models, start all, trigger wake |
| `source .env && bash scripts/dev-start.sh --prod` | Same, but keeps production models |
| `node scripts/seed-local-kv.mjs` | Fast seed (~2s) — uses Miniflare API directly |
| `bash scripts/seed-local-kv.sh` | Slow seed — uses wrangler CLI, supports `--pull-remote` |
| `bash scripts/switch-model.sh <model>` | Swap all LLM roles to a single model in KV |
| `node scripts/read-kv.mjs [key-or-prefix]` | Inspect local KV (list keys, read values) |

## Development Philosophy

This is v0.1 — no backwards compatibility needed. Feel free to change data
formats, KV schemas, karma structures, API shapes, etc. without migration
or fallback logic. Old local data can always be wiped with a re-seed.

### Why `--persist-to`?

Wrangler's `--local` flag and `wrangler dev` use different storage backends
by default (`blobs/` vs `miniflare-*.sqlite`). Using `--persist-to` on both
the seed script and all `wrangler dev` instances forces them to the same
SQLite store, so seeded keys are visible to running workers.
