# Infrastructure Migration Guide

What's Cloudflare-specific in brainstem.js and what would change for a
platform migration (e.g., Node.js on Linux).

## CF-Specific Code

### Worker Loader (`env.LOADER`)

Used in `executeHook()` and `runInIsolate()` to dynamically load and execute
JS modules in sandboxed isolates. The `[[worker_loaders]]` binding is declared
in `wrangler.toml`.

**Migration:** Replace with Node.js `vm` module, `worker_threads`, or a
container-based sandbox. The callback passed to `LOADER.get()` returns a
config object (modules, env bindings) — the replacement needs to accept the
same shape and provide the module with its `env` object.

### KV Namespace (`env.KV` / `this.kv`)

All persistent state — config, tools, hooks, karma logs, session data — is
stored in CF KV. Used throughout via `this.kv.get()`, `this.kv.put()`,
`this.kv.list()`, `this.kv.delete()`, and `this.kv.getWithMetadata()`.

**Migration:** Replace with any key-value store (Redis, SQLite, DynamoDB).
The API surface is small: `get(key, format)`, `put(key, value, { metadata })`,
`list({ prefix })`, `delete(key)`, `getWithMetadata(key, format)`. Write an
adapter matching this interface.

### WorkerEntrypoint Classes (`KernelRPC`, `ScopedKV`)

These extend `WorkerEntrypoint` from `cloudflare:workers` and provide RPC
bridges between the host kernel and loaded isolates. The host's
`ExecutionContext` (`ctx.exports`) references them as loopback bindings.

- `KernelRPC` — lets the wake hook call kernel primitives (LLM, KV, tools)
- `ScopedKV` — lets tool isolates access KV with namespace scoping

**Migration:** Replace with direct function calls, IPC, or a local RPC
mechanism. The key constraint is that isolate-loaded code cannot receive
JS functions via JSON, so some form of message-passing or RPC stub is needed.

### `scheduled()` Handler

The `export default { scheduled() }` pattern is the CF cron trigger entry
point, declared in `wrangler.toml` under `[triggers]`.

**Migration:** Replace with OS cron, systemd timer, or a scheduler library.
The handler receives `(event, env, ctx)` — `event` has `scheduledTime` and
`cron`, `env` has bindings, `ctx` has `waitUntil()` and `exports`.

### `wrangler.toml`

Declares all CF bindings:
- `[[kv_namespaces]]` — KV namespace binding
- `[[worker_loaders]]` — dynamic isolate loader
- `[triggers]` — cron schedule
- `[vars]` — environment variables
- Entrypoint class exports for RPC

**Migration:** Replace with environment config (`.env`, config file, or
container env vars). Binding declarations become constructor params or
dependency injection.

## What's Portable (No Changes Needed)

- **wake-hook.js** — pure policy logic, communicates via `env.KERNEL` RPC
- **LLM calls** — standard HTTP to OpenRouter (`callLLM`, `callWithCascade`)
- **Agent loop** — `runAgentLoop`, `executeToolCall`, `spawnSubplan`
- **Karma logging** — just appends to a KV key (swap the KV layer)
- **Tool context building** — `buildToolContext`, `buildToolDefinitions`
- **Budget enforcement** — pure JS cost/step/duration checks
- **Hook safety** — tripwire logic, session history tracking
- **Prompt building** — `buildPrompt`, template interpolation
- **All business logic** — model resolution, cost estimation, config merging

## Migration Checklist

1. Implement a KV adapter (get/put/list/delete/getWithMetadata)
2. Implement an isolate runner (vm/worker_threads/container)
3. Replace `WorkerEntrypoint` classes with local RPC stubs
4. Replace `scheduled()` with a cron/timer entry point
5. Convert `wrangler.toml` bindings to env config
6. Seed the KV store with existing data (`scripts/seed-local-kv.sh`)
