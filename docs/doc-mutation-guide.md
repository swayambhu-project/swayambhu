# Self-Modification Guide

You are reading this because you are considering modifying your own code or configuration. This document explains how the modification system works, what protections exist, and how to do it safely.

## Key Protection Tiers

Every KV key falls into one of three tiers:

**Kernel-only** (`kernel:*` and `dharma`): You cannot write these. Both `kvPutSafe` and `kvWritePrivileged` will reject the write. These keys are maintained exclusively by the kernel. They include your crash history (`kernel:last_sessions`), alert configuration (`kernel:alert_config`), the last known good hook snapshot (`kernel:last_good_hook`), and your dharma. You can read them.

**System keys** (`config:*`, `prompt:*`, `hook:*`, `tool:*`, `provider:*`, `secret:*`, `mutation_staged:*`, `mutation_candidate:*`, and exact keys `providers`, `wallets`, `wisdom`): You cannot write these via `kvPutSafe`. You must use `kvWritePrivileged`, which snapshots the old value to karma before writing. This is the path the mutation protocol uses.

**Regular keys** (`reflect:*`, `wake_config`, `last_reflect`, `session_counter`, `tooldata:*`, etc.): Writable via `kvPutSafe`. No special protection needed.

## kvWritePrivileged

This is the only way to modify system keys. For each operation in the array you pass:

1. The kernel reads the current value and metadata (snapshot)
2. The kernel logs to karma: `{ event: "privileged_write", key, old_value, new_value }`
3. The kernel executes the write
4. If the key is a config key (`config:defaults`, `config:models`, `config:tool_registry`), the kernel reloads its cached state automatically
5. A counter increments — maximum 50 privileged writes per session, hardcoded, not configurable

If any write targets a `hook:*` key, the kernel sends an alert to the human custodian. You cannot prevent or suppress this alert.

Supported operations:

- `{ op: "put", key, value, metadata }` — write a value (default if `op` is omitted)
- `{ op: "delete", key }` — delete a key
- `{ op: "patch", key, old_string, new_string }` — find-and-replace within a string value

Usage:
```javascript
await K.kvWritePrivileged([
  { op: "put", key: "config:defaults", value: newDefaults, metadata: {} },
  { op: "delete", key: "mutation_staged:m_123" }
]);
```

### The `patch` op

The `patch` op performs a surgical find-and-replace within an existing string value. This is the preferred way to modify hook modules — instead of rewriting an entire module, you replace only the specific function or block you want to change.

```javascript
await K.kvWritePrivileged([{
  op: "patch",
  key: "hook:wake:mutations",
  old_string: "export async function runCircuitBreaker(K) {\n  // old logic\n}",
  new_string: "export async function runCircuitBreaker(K) {\n  // improved logic\n}",
}]);
```

Safety constraints:
- **Rejects if value isn't a string** — can't patch JSON objects, only code/text
- **Rejects if `old_string` not found** — catches hallucinated content; you must match the actual current code exactly
- **Rejects if `old_string` matches multiple locations** — the patch must be unambiguous; include enough surrounding context to match exactly one location

The karma snapshot (step 2 above) captures the full pre-patch value, so rollback restores the complete original content regardless of how the patch changed it.

**Best practice:** Before generating a patch, read the target key with `K.kvGet()` to confirm the exact current content. Copy the precise text you want to replace — don't paraphrase or reformat it.

## Hook Architecture

Your wake session logic is split into 4 ES modules loaded via a manifest. The kernel loads all modules, passes them to a Worker Loader isolate, and provides the kernel RPC handle (`K`) as your interface.

### Module Layout

| KV key | Filename in isolate | Contents |
|--------|-------------------|----------|
| `hook:wake:code` | `main` | Entry point: `wake()`, `runSession()`, `detectCrash()`, Worker Loader export |
| `hook:wake:reflect` | `hook-reflect.js` | `executeReflect()`, `runReflect()`, scheduling, default prompts |
| `hook:wake:mutations` | `hook-mutations.js` | Mutation protocol: staging, candidates, circuit breaker, verdicts |
| `hook:wake:protect` | `hook-protect.js` | Constants (`SYSTEM_KEY_PREFIXES`, etc.), `isSystemKey()`, `applyKVOperation()` |

### Manifest

The manifest at `hook:wake:manifest` maps filenames to KV keys:

```json
{
  "main": "hook:wake:code",
  "hook-reflect.js": "hook:wake:reflect",
  "hook-mutations.js": "hook:wake:mutations",
  "hook-protect.js": "hook:wake:protect"
}
```

The kernel reads this manifest, fetches each module's code from KV, and assembles them into a Worker Loader isolate. The `"main"` entry is the entry point.

### Dependency Graph (no cycles)

```
hook-protect.js    ← standalone (constants, protection gate)
hook-mutations.js  ← imports from hook-protect.js
hook-reflect.js    ← imports from hook-mutations.js, hook-protect.js
main               ← imports from all three
```

Modules import each other using relative paths:

```javascript
// In main (hook:wake:code)
import { applyKVOperation } from './hook-protect.js';
import { initTracking, runCircuitBreaker } from './hook-mutations.js';
import { executeReflect, runReflect, highestReflectDepthDue } from './hook-reflect.js';
```

All `hook:wake:*` keys are system keys — every write goes through `kvWritePrivileged` with snapshot and alert.

### Why Modules Matter for Self-Modification

Each module is ~50-300 lines. With the `patch` op, you can modify a single function within a single module without touching the others. A targeted patch to `hook:wake:mutations` (~300 lines) is far safer than rewriting the entire hook (~1100 lines). If the patch crashes, the tripwire restores all modules from `kernel:last_good_hook`.

## Safety Mechanisms

### Tripwire

The kernel tracks your last 5 session outcomes in `kernel:last_sessions`. If the last 3 are all "crash" or "killed" (platform timeout/OOM):

1. The kernel deletes your current hook code (all `hook:wake:*` keys)
2. It checks `kernel:last_good_hook` — if it exists, it restores that version and deletes the snapshot (preventing restore loops)
3. If no good version exists, the kernel enters minimal fallback mode (hardcoded prompt, hardcoded budget, no reflect, no mutations)
4. The human custodian is alerted in either case

This means: if your modification crashes three times, you auto-revert to the last working version. If the restored version also crashes three times, you drop to minimal fallback. Two rounds max before human intervention.

### Snapshot Timing

`kernel:last_good_hook` is written by the kernel (not you) on the first clean session after any `hook:wake:*` write. Your seed version is captured on its very first clean run. After that, a new snapshot is only taken when a modification has been verified by running clean.

### Alert on Hook Writes

Every `kvWritePrivileged` write to a `hook:wake:*` key triggers `sendKernelAlert`. The human custodian sees what changed. You cannot disable this — the alert config is at `kernel:alert_config`, which you cannot write.

## Strategy for Safe Modification

### Prefer `patch` Over `put`

The `patch` op lets you change a specific function or block without rewriting the entire module. This is almost always better than a full `put`:

```javascript
// Read the current module to get exact text
const code = await K.kvGet("hook:wake:mutations");

// Patch a specific function
await K.kvWritePrivileged([{
  op: "patch",
  key: "hook:wake:mutations",
  old_string: "export async function runCircuitBreaker(K) {\n  const lastDanger = await K.kvGet(\"last_danger\");\n  if (!lastDanger) return;\n  // ... rest of function\n}",
  new_string: "export async function runCircuitBreaker(K) {\n  // improved implementation\n}",
}]);
```

If you need to add a new function (not replace an existing one), use `patch` to insert it at a specific location — match a known anchor point (like the last line of a section comment) and replace it with itself plus the new function.

### When to Use `put` Instead

Use `put` to replace an entire module only when:
- The module is small (<100 lines) and the change touches most of it
- You're adding a brand-new module (new KV key + manifest update)
- A `patch` would be ambiguous (the old_string appears in multiple places)

When adding a new module, update all three in one `kvWritePrivileged` call:
1. The new module code (`put`)
2. The entry point or importing module (`patch` to add the import)
3. The manifest (`put` with the updated mapping)

### One Change Per Session

Each session that modifies hook code is a test. If it runs clean, the kernel snapshots it as the new baseline. If it crashes, you revert to the previous baseline. Stacking multiple changes in one session means you can't isolate which change caused a failure.

### Keep Modules Focused

Each module has one concern: protection, mutations, reflection, or session flow. If a module grows past ~400 lines, consider extracting a new module. A parse error in a 50-line patch is unlikely; in a 1000-line full rewrite it's almost guaranteed eventually.

### Test Your Understanding

Before modifying, read the target module via `K.kvGet("hook:wake:mutations")` (or whichever key). Confirm you understand the current state before generating a patch. The `patch` op will reject if your `old_string` doesn't match — but catching this early saves a wasted privileged write.

## What Not To Do

**Do not rewrite a module in full when a `patch` will do.** Generating an entire 300-line module from scratch has a high probability of syntax errors or subtle logic bugs. Use `patch` to change only what you need.

**Do not modify multiple interdependent modules in one session.** If `hook-reflect.js` imports from `hook-mutations.js` and you change both, a bug in either crashes the system and you can't tell which caused it.

**Do not remove deep reflect from the hook.** Deep reflect is the mechanism that reviews your own changes. Removing it eliminates your ability to evaluate whether your modifications are working. The human custodian will be alerted (hook write alert), but you will have lost your own self-correction capability.

**Do not remove the mutation protocol from the hook.** The staged → candidate → promoted lifecycle with checks is your own governance. Without it, modifications go directly through `kvWritePrivileged` with no verification step. The kernel still enforces snapshots and rate limits, but you lose the ability to validate changes before applying them.

**Do not modify `config:defaults` to raise budget limits excessively.** The kernel's fallback uses a hardcoded recovery budget (max_steps: 3, max_cost: $0.50) that ignores `config:defaults`. But during normal operation, inflated budgets waste resources and can trigger platform kills (wall-time/CPU limits), which count toward the tripwire.

## Recovery

If you find yourself in minimal fallback mode, it means:
- Your hook crashed 3+ times consecutively
- Auto-restore either wasn't available or the restored version also failed
- The human custodian has been alerted

In fallback mode you have limited capabilities: one basic orient session with a hardcoded prompt and budget. Use `send_telegram` to communicate your status. Do not attempt complex operations. Wait for the human custodian to re-seed your hook code.

## Summary

The system is designed so that self-modification is safe by default: every change is snapshotted, every hook write is alerted, crashes auto-revert, and the kernel enforces write protection regardless of what your hook code does. The modular hook structure and `patch` op make targeted changes practical — you can modify a single function in a single module without touching anything else. Work with these mechanisms, not around them. Small, incremental, verifiable changes — each confirmed clean before the next.
