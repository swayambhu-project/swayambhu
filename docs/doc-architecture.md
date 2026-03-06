# System Architecture

You are reading this to understand how you work. This document describes the full architecture of Swayambhu — the kernel, the hook, the tools, the LLM cascade, the KV layout, and how they fit together.

## Two-Layer Design

The system is split into two layers with a hard boundary between them.

**Kernel** (`brainstem.js`): Deployed as a Cloudflare Worker. Contains hardcoded primitives — KV access, LLM calls, isolate execution, alerting, budget enforcement, hook dispatch, and safety mechanisms (tripwire, auto-restore, platform kill detection). The kernel never changes after deployment. It has no opinions about what you should do — it only provides capabilities and enforces safety.

**Hook** (`hook:wake:code` in KV): Your policy layer. Contains the entire wake flow — orient, reflect, deep reflect, mutation protocol, circuit breaker, balance checks, tripwire evaluation. The kernel loads this code from KV and executes it in a Worker Loader isolate. You can modify this code through `kvWritePrivileged`. See `doc:mutation_guide` for how to do that safely.

The boundary is enforced by isolation. The hook runs in a separate isolate and communicates with the kernel exclusively through `K` (the KernelRPC binding). The hook cannot access `this.env`, `this.kv`, or any kernel internals directly.

## Execution Flow

When the cron trigger fires:

1. **Kernel boots** — creates a Brainstem instance, generates session ID
2. **Platform kill detection** — checks `kernel:active_session` for a stale marker from a previous session that was killed by the platform (wall-time, CPU, OOM). If found, injects "killed" outcome into `kernel:last_sessions`
3. **Hook safety check** — reads `kernel:last_sessions`. If the last 3 outcomes are all crash/killed, the tripwire fires (see `doc:mutation_guide` for details)
4. **Hook loading** — checks for `hook:wake:manifest` (multi-module) or `hook:wake:code` (single module). If neither exists, runs minimal fallback
5. **Hook execution** — writes `kernel:active_session` breadcrumb, creates a Worker Loader isolate with the hook code, passes `K` (KernelRPC) as `env.KERNEL`, calls `fetch("https://internal/wake")`
6. **Hook runs wake flow** — the hook's default export handles the request, calls `wake(K, input)`, which runs the full session (orient → tools → reflect) or deep reflect
7. **Outcome recording** — kernel records "clean" or "crash" in `kernel:last_sessions`, snapshots hook if clean + dirty, deletes `kernel:active_session`

If the hook throws at step 6, the kernel catches it, records "crash", and runs `runMinimalFallback` in the same session — a hardcoded recovery prompt with a hardcoded budget that ignores `config:defaults`.

## KernelRPC Interface

Every kernel capability the hook uses goes through `K`. The methods:

**LLM**: `K.callLLM({ model, effort, maxTokens, systemPrompt, messages, tools, step })` — handles the full cascade (dynamic adapter → last working → kernel fallback), budget enforcement, cost tracking, karma logging, and model fallback.

**KV reads**: `K.kvGet(key)`, `K.kvGetWithMeta(key)`, `K.kvList(opts)` — unrestricted reads.

**KV writes (safe)**: `K.kvPutSafe(key, value, metadata)`, `K.kvDeleteSafe(key)` — blocks writes to `dharma`, `kernel:*`, and all system keys. Use for regular keys like `wake_config`, `session_counter`, `last_reflect`, `reflect:*`.

**KV writes (privileged)**: `K.kvWritePrivileged(ops)` — for system keys (`config:*`, `prompt:*`, `hook:*`, `tool:*`, `provider:*`, `secret:*`, `mutation_*`). Snapshots old value to karma, rate-limited to 50/session, alerts on `hook:*` writes. Still blocks `dharma` and `kernel:*`.

**Agent loop**: `K.runAgentLoop({ systemPrompt, initialContext, tools, model, effort, maxTokens, maxSteps, step })` — the tool-calling execution primitive. Runs a multi-turn conversation where the LLM can call tools. Returns parsed JSON output. Includes one automatic JSON repair retry.

**Tools**: `K.executeToolCall(tc)`, `K.executeAction(step)`, `K.buildToolDefinitions(extra)`, `K.spawnSubplan(args, depth)`, `K.callHook(name, ctx)`.

**Karma**: `K.karmaRecord(entry)` — appends to the session's karma log and flushes to KV.

**State**: `K.getSessionId()`, `K.getSessionCost()`, `K.getKarma()`, `K.getDefaults()`, `K.getModelsConfig()`, `K.getDharma()`, `K.getToolRegistry()`, `K.elapsed()`.

**Utility**: `K.resolveModel(alias)`, `K.estimateCost(model, usage)`, `K.buildPrompt(template, vars)`, `K.parseAgentOutput(content)`, `K.loadKeys(keys)`, `K.getSessionCount()`, `K.mergeDefaults(defaults, overrides)`, `K.isSystemKey(key)`.

Alerting (`sendKernelAlert`) is deliberately NOT exposed. The hook cannot send alerts or suppress them.

## LLM Provider Cascade

The kernel contains zero provider-specific code. All LLM calls go through a three-tier cascade:

**Tier 1 — Dynamic adapter** (`provider:llm:code` + `provider:llm:meta`): The primary adapter, stored in KV as executable code. You can modify this via `kvWritePrivileged`. On first success each session, the kernel snapshots it to `provider:llm:last_working:code` + `:meta`.

**Tier 2 — Last working adapter** (`provider:llm:last_working:code` + `:meta`): Auto-snapshotted by the kernel. If Tier 1 fails (you broke the adapter), Tier 2 uses the last version that worked.

**Tier 3 — Kernel fallback** (`kernel:llm_fallback` + `kernel:llm_fallback:meta`): Human-managed. The hook cannot write `kernel:*` keys. If both Tiers 1 and 2 fail, this is the last resort. If this key doesn't exist, all LLM calls fail.

All three tiers use the same execution path: the kernel reads adapter code from KV, builds scoped secrets from `env` and `secret:*` keys based on the adapter's meta, and runs the code in an isolate via `runInIsolate`. The adapter receives a standardized request `{ model, max_tokens, messages, thinking, tools, secrets }` and must return `{ content, usage }` or `{ toolCalls, usage }`.

After the provider cascade, if the call still fails, there is a separate **model fallback**: the kernel retries with the fallback model from `config:models.fallback_model` or `kernel:fallback_model`. No hardcoded model strings exist in the kernel.

## Tool System

Tools are stored in KV as code + metadata pairs:

- `tool:{name}:code` — executable JavaScript (ES module format)
- `tool:{name}:meta` — JSON with `secrets`, `kv_secrets`, `kv_access`, `timeout_ms`

The tool registry at `config:tool_registry` lists available tools with their names, descriptions, and input schemas. This is what gets sent to the LLM as function definitions.

When a tool is called:

1. The kernel loads code + meta from KV (cached per session)
2. Builds a context object: tool input args + scoped secrets (from `env` for `meta.secrets`, from `secret:*` keys for `meta.kv_secrets`)
3. Records `tool_start` in karma
4. Executes the code in a Worker Loader isolate with an optional `KV_BRIDGE` (ScopedKV) if the tool has KV access
5. Records `tool_complete` in karma (success or failure)

KV access levels for tools:
- `"none"` — no KV access
- `"own"` — reads/writes scoped to `tooldata:{toolName}:*`
- `"read_all"` — can read any key, writes scoped to own namespace

### Validation Hooks

The kernel supports pre- and post-validation hooks for tool calls:

- `tool:validate:code` — called before execution with `{ tool, args, schema }`. Can reject (return `{ ok: false, error }`) or modify args (return `{ ok: true, args }`)
- `tool:validate_result:code` — called after execution with `{ tool, args, result }`. Can reject the result

These are optional. If the hook code doesn't exist in KV, execution proceeds without validation. If a hook throws, it degrades to no-hook (doesn't crash the session).

### Parse Repair Hook

`tool:parse_repair:code` — called when the LLM returns non-JSON output. Receives `{ content }`, returns `{ content }` with repaired JSON. Optional, degrades gracefully.

### Subplans

`spawn_subplan` is a built-in tool that creates a nested agent loop. The subplan gets its own system prompt (from `prompt:subplan` or a hardcoded default), runs with the same tool definitions as the parent, and has configurable model, effort, and step limits. Subplans can nest up to `config:defaults.execution.max_subplan_depth` levels (default 3).

## Budget Enforcement

The kernel enforces three budget limits on every `callLLM` invocation:

- **Cost**: `session_budget.max_cost` — cumulative cost across all LLM calls in the session
- **Steps**: `session_budget.max_steps` — total number of LLM calls (not agent loop turns)
- **Duration**: `session_budget.max_duration_seconds` — wall-clock time since session start

These come from `config:defaults.session_budget` during normal operation. During minimal fallback, the kernel overwrites with hardcoded values (max_cost: $0.50, max_steps: 3, max_duration: 120s) and ignores `config:defaults`.

When a budget is exceeded, `callLLM` throws `"Budget exceeded: {reason}"`. The agent loop catches this and returns `{ budget_exceeded: true, reason }` instead of crashing.

## KV Namespace Layout

### Kernel-only (cannot be written by hook)
- `dharma` — immutable identity
- `kernel:active_session` — crash detection breadcrumb
- `kernel:last_sessions` — last 5 session outcomes
- `kernel:last_good_hook` — hook snapshot for auto-restore
- `kernel:hook_dirty` — dirty flag for snapshot optimization
- `kernel:alert_config` — alerting configuration (URL template, body template, headers)
- `kernel:llm_fallback` + `:meta` — Tier 3 LLM adapter
- `kernel:fallback_model` — fallback model string

### System keys (writable via kvWritePrivileged only)
- `config:defaults` — session budgets, model configs, execution limits, reflect intervals
- `config:models` — model list with costs, aliases, capabilities
- `config:resources` — KV limits, worker limits, provider endpoints, wallet config
- `config:tool_registry` — tool names, descriptions, input schemas
- `prompt:orient` — orient system prompt template
- `prompt:reflect` — session reflect prompt template
- `prompt:reflect:{depth}` — depth-specific reflect prompts
- `prompt:deep` — legacy depth-1 reflect prompt (fallback)
- `prompt:subplan` — subplan system prompt template
- `provider:llm:code` + `:meta` — Tier 1 LLM adapter
- `provider:llm:last_working:code` + `:meta` — Tier 2 LLM adapter (kernel-managed)
- `tool:{name}:code` + `:meta` — tool implementations
- `hook:wake:code` — single-module hook
- `hook:wake:manifest` — multi-module manifest
- `hook:wake:{module}` — additional hook modules
- `secret:{name}` — KV-stored secrets (accessible by tools/adapters via meta.kv_secrets)
- `mutation_staged:{id}` — staged mutation records
- `mutation_candidate:{id}` — candidate mutation records (applied but unverified)
- `doc:{name}` — reference documents (this file, mutation guide, etc.)
- `providers` — provider config map (adapter references, secret names)
- `wallets` — wallet config map
- `wisdom` — accumulated wisdom text

### Regular keys (writable via kvPutSafe)
- `wake_config` — next wake timing, effort overrides, alerts
- `session_counter` — monotonic session count
- `session` — crash detection breadcrumb (hook-managed)
- `last_reflect` — most recent reflect output
- `last_danger` — most recent danger signal (kernel-managed)
- `reflect:{depth}:{sessionId}` — reflect output archive
- `reflect:schedule:{depth}` — reflect scheduling state
- `deep_reflect_schedule` — legacy depth-1 schedule (backward compat)
- `session_history` — session history for reflect context
- `karma:{sessionId}` — session karma logs
- `tooldata:{toolName}:{key}` — tool-scoped storage

### KV Metadata

Every key written via `kvPut` gets auto-tagged metadata based on its prefix: `{ type, updated_at }`. The type mapping covers all prefixes (`tool` → "tool", `karma` → "log", `config` → "config", `kernel` → "kernel", etc.). System keys have `unprotected` stripped from metadata to prevent bypassing protection gates.

## Wake Hook Structure

The hook (`hook:wake:code`) exports a default fetch handler and a `wake(K, input)` function. The wake flow:

1. **Wake gate** — checks `wake_config.next_wake_after`, skips if not time yet
2. **Crash detection** — checks for stale `session` key from a previous hook-level crash
3. **Mutation tracking init** — prefix-scans `mutation_staged:*` and `mutation_candidate:*` to build in-memory tracking lists
4. **Circuit breaker** — checks `last_danger` against candidate mutation activation times, rolls back candidates that activated before danger signals
5. **Ground truth** — loads balances (via provider/wallet adapters), KV usage
6. **State loading** — loads `config:defaults`, `last_reflect`, `config:models`, `dharma`, `config:tool_registry`
7. **Reflect check** — determines if any reflection depth is due (based on session count and time intervals)
8. **Tripwire evaluation** — evaluates alert conditions against live data, may escalate effort level
9. **Context assembly** — loads additional context keys specified by last reflect
10. **Session execution** — either `runSession` (orient → tools → session reflect) or `runReflect` (deep reflect cascade)

### Orient Session

Builds a system prompt from `prompt:orient` with dharma, models, resources, and config interpolated. Sends live context (balances, KV usage, last reflect, crash data) as the user message. Runs an agent loop where the LLM can use tools. After the agent loop completes, applies KV operations from the output (gated by protection — only unprotected non-system keys), runs session reflect, and writes session results.

### Session Reflect (depth 0)

A single LLM call (maxSteps: 1, no tools) that reviews the session's karma log and cost. Produces: `session_summary`, `note_to_future_self`, `next_orient_context.load_keys`, and optionally `kv_operations`, `mutation_verdicts`, `mutation_requests`, `next_wake_config`. Output stored at `last_reflect` and `reflect:0:{sessionId}`.

### Deep Reflect (depth 1+)

A multi-turn agent loop with tool access (excluding `spawn_subplan`). Depth 1 examines recent karma logs, the orient prompt, and session history. Depth N examines depth N-1 outputs and the below-level prompt. Each depth can propose mutations (applied directly as candidates at depth 1+, or staged at depth 0). Output stored at `reflect:{depth}:{sessionId}`.

Deep reflect cascades downward: depth N runs first, then depth N-1, then ... depth 1. Each level's output is available to the next via `reflect:{depth}:{sessionId}` keys.

## Mutation Protocol

The lifecycle: **staged → candidate → promoted** (or rolled back at any stage).

**Staged** (`mutation_staged:{id}`): A proposal with claims (why), ops (what to change), and checks (how to verify). Created by session reflect via `stageMutation`. Can be withdrawn or modified by session reflect, or applied/rejected by deep reflect.

**Candidate** (`mutation_candidate:{id}`): Applied to KV but not yet verified. Contains snapshots of all affected keys before modification. Created either by promoting a staged mutation (`applyStagedAsCandidate`) or directly by deep reflect (`applyDirectAsCandidate`). Can be promoted (delete the candidate record, changes persist) or rolled back (restore snapshots).

**Promoted**: The candidate record is deleted. The changes are now permanent. No rollback possible — the snapshots are gone.

One active candidate per key enforced: if a new mutation targets a key that already has an active candidate, it's rejected as a conflict.

### Circuit Breaker

On each wake, before the hook runs, the hook checks `last_danger` (written by the kernel on danger signals). If any candidate mutation was activated before the danger signal timestamp, it's automatically rolled back. This catches cases where a mutation causes LLM failures or fatal errors.

## Isolate Execution

All dynamic code — tools, adapters, hooks — runs in Worker Loader isolates. The pattern:

1. Kernel calls `this.env.LOADER.get(id, configFn)` with a unique ID, module code, and optional env bindings
2. The isolate receives a fetch request with the execution context as JSON body
3. The isolate returns a JSON response with `{ ok, result }` or `{ ok: false, error }`
4. The kernel enforces a timeout via `Promise.race`

Isolates get scoped access: tools get `KV_BRIDGE` (ScopedKV) for KV access, hooks get `KERNEL` (KernelRPC) for kernel primitives. Neither gets raw `env` access.

## Karma Log

Every significant event is recorded in the karma log — an array that grows through the session and is flushed to `karma:{sessionId}` after each entry. Events include:

- `session_start` — effort level, crash detection
- `llm_call` — model, tokens, cost, duration, provider tier, truncated request/response
- `tool_start` / `tool_complete` — tool name, input summary, result summary or error
- `provider_fallback` — cascade tier transitions
- `privileged_write` — key, old value, new value (full snapshot)
- `mutation_*` — staged, applied, promoted, rolled back, rejected, etc.
- `budget_exceeded` — which budget limit was hit
- `fatal_error` — unhandled errors (triggers danger signal)
- `hook_execution_error` — hook crashed
- `circuit_breaker_fired` — automatic rollback
- `hook_safety_reset` — tripwire fired

Danger signals (`fatal_error`, `orient_parse_error`, `all_providers_failed`) also write to `last_danger` for circuit breaker evaluation.

## Session Cost Tracking

Cost is estimated per LLM call using the model's `input_cost_per_mtok` and `output_cost_per_mtok` from `config:models`. The `sessionCost` accumulates in `callLLM` only — no double-counting from agent loops or subplans. Cost is checked against `session_budget.max_cost` before each call.

## Key Design Principles

**Kernel never changes.** All policy lives in KV. Provider adapters, model strings, tool code, prompts, budgets, alert config — everything is configurable via KV without redeployment.

**Safety mechanisms are kernel-enforced.** The hook cannot disable alerting, bypass write protection tiers, modify kernel keys, or suppress the tripwire. These are hardcoded in the kernel, not in the hook.

**Graceful degradation.** Hook crash → minimal fallback. Adapter crash → last working adapter → kernel fallback. Model failure → fallback model. Tool hook failure → no hook. Parse failure → repair hook → raw output. Every failure mode has a degradation path, not a crash.

**Observability through karma.** Every LLM call, tool execution, KV write, mutation operation, and error is logged with timestamps, costs, and context. The karma log survives crashes (flushed after each entry) and is the primary input for reflect sessions.

**Self-modification is safe by default.** Every system key write is snapshotted, every hook write is alerted, crashes auto-revert, and the kernel enforces protection regardless of hook behavior. See `doc:mutation_guide` for the full modification protocol.
