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

### Waking Swayambhu (preserve state)

When you want to restart workers (e.g., after code changes) without wiping
KV state, use `wake-now.sh`. It kills stale workers, resets the sleep timer
so the wake isn't skipped, starts fresh workers, and triggers `/__scheduled`.

```bash
source .env && bash scripts/wake-now.sh
```

### IMPORTANT: `taskkill //F //IM workerd.exe` kills ALL workers

This kills both brainstem (8787) and dashboard API (8790). After killing
workers, always restart BOTH. Don't forget the dashboard.

### Port conflict footgun

When you kill a stale worker and start a new one, the new worker may silently
bind to a different port (e.g., 8788 instead of 8787) if the old port hasn't
freed yet. Then `curl localhost:8787` hits the *old* stale process, not your
new code. `wake-now.sh` avoids this by polling until ports are actually free
before starting new workers.

### Ports

| Service        | Port | Notes                                    |
|----------------|------|------------------------------------------|
| Brainstem      | 8787 | `--test-scheduled` enables `/__scheduled` |
| Dashboard API  | 8790 | SPA hardcodes this for localhost          |
| Dashboard SPA  | 3001 | `dev-serve.mjs` — no-cache static server  |

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

### Wake hook (modular)

The wake hook is split into 4 ES modules loaded via manifest:

| Source file | KV key | Contents |
|-------------|--------|----------|
| `hook-main.js` | `hook:wake:code` | Entry point: `wake()`, `runSession()`, `detectCrash()`, Worker Loader export |
| `hook-reflect.js` | `hook:wake:reflect` | `executeReflect()`, `runReflect()`, scheduling, default prompts |
| `hook-mutations.js` | `hook:wake:mutations` | Mutation protocol: staging, candidates, circuit breaker, verdicts |
| `hook-protect.js` | `hook:wake:protect` | Constants, `isSystemKey()`, `applyKVOperation()` |

Manifest at `hook:wake:manifest` maps filenames to KV keys. The kernel
loads all modules and passes them to Worker Loader. Dependency graph
(no cycles): protect ← mutations ← reflect ← main.

Mutations support a `patch` op (`{ op: "patch", key, old_string, new_string }`)
for surgical find-and-replace edits within a KV value. Rejects if old_string
is missing or ambiguous. Rollback restores the full pre-patch snapshot.

### Yamas and Niyamas (operating principles)

`yama:*` (outer world) and `niyama:*` (inner world) keys in KV. Kernel-injected
into every LLM prompt after dharma. Mutable via `kvWritePrivileged` but with
kernel-enforced friction: requires `deliberation` field (min 200 chars for yamas,
100 for niyamas) and a `yama_capable/niyama_capable` model. Audit trail at
`{key}:audit`.

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
| `source .env && bash scripts/wake-now.sh` | Light restart: kill workers, reset sleep timer, start, trigger wake (no state wipe) |
| `node scripts/seed-local-kv.mjs` | Fast seed (~2s) — uses Miniflare API directly |
| `bash scripts/seed-local-kv.sh` | Slow seed — uses wrangler CLI, supports `--pull-remote` |
| `bash scripts/switch-model.sh <model>` | Swap all LLM roles to a single model in KV |
| `node scripts/read-kv.mjs [key-or-prefix]` | Inspect local KV (list keys, read values) |
| `node scripts/rollback-session.mjs` | Undo last session's KV changes (`--dry-run` to preview, `--yes` to skip confirm) |

## Working Style — MANDATORY

**Do NOT make code changes without explicit approval.** When the user asks
a question or raises an issue, respond with your analysis, thoughts, and
proposed approach first. Wait for the user to say "yes", "do it", "go ahead",
or otherwise clearly approve before writing or editing any files. This
applies to ALL changes — even small ones, even "obvious" fixes. The only
exception is when the user gives an explicit instruction to implement
something (e.g. "Implement the following plan:" or "add X to Y").

## Development Philosophy

This is v0.1 — no backwards compatibility needed. Feel free to change data
formats, KV schemas, karma structures, API shapes, etc. without migration
or fallback logic. Old local data can always be wiped with a re-seed.

### Why `--persist-to`?

Wrangler's `--local` flag and `wrangler dev` use different storage backends
by default (`blobs/` vs `miniflare-*.sqlite`). Using `--persist-to` on both
the seed script and all `wrangler dev` instances forces them to the same
SQLite store, so seeded keys are visible to running workers.
