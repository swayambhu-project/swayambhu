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

Usage:
```javascript
await K.kvWritePrivileged([
  { op: "put", key: "config:defaults", value: newDefaults, metadata: {} },
  { op: "delete", key: "mutation_staged:m_123" }
]);
```

## Hook Architecture

Your wake session logic lives in `hook:wake:code` (and optionally additional modules). The kernel loads this code, executes it in an isolate, and provides the kernel RPC handle (`K`) as your interface.

### Single Module (Day 1)

The kernel reads `hook:wake:code` and runs it as a single module. All your session logic — wake flow, reflect, mutation protocol, circuit breaker — is in one file.

### Multi-Module (via Manifest)

The kernel checks for `hook:wake:manifest` before loading. If it exists, it describes how to assemble multiple modules:

```json
{
  "main": "hook:wake:code",
  "reflect.js": "hook:wake:reflect",
  "mutation.js": "hook:wake:mutation",
  "circuit.js": "hook:wake:circuit"
}
```

Each value is a KV key containing module code. The keys in the manifest become filenames in the Worker Loader isolate. The main module can import from other modules:

```javascript
import { runReflect, executeReflect } from './reflect.js';
import { stageMutation, applyStagedAsCandidate } from './mutation.js';
```

All `hook:wake:*` keys are system keys — every write goes through `kvWritePrivileged` with snapshot and alert.

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

### Extract First, Modify Second

Never modify a function inside a large module. Instead:

**Session 1** — Extract the function to its own module:
- Write the function as a new `hook:wake:functionname` key
- Update `hook:wake:code` to import from the new module instead of containing the function inline
- Write `hook:wake:manifest` (or update it if it already exists)
- All three writes in one `kvWritePrivileged` call

Wait for a clean session to confirm the extraction didn't break anything. The kernel snapshots the new multi-module structure as `kernel:last_good_hook`.

**Session 2** — Modify the extracted module:
- Write only `hook:wake:functionname` with the updated logic
- One small, targeted write

If this crashes, the tripwire restores the Session 1 version (extraction without modification). Your extraction is preserved; only the bad change is reverted.

### One Change Per Session

Each session that modifies hook code is a test. If it runs clean, the kernel snapshots it as the new baseline. If it crashes, you revert to the previous baseline. Stacking multiple changes in one session means you can't isolate which change caused a failure.

### Keep Modules Small

A 50-line module is easy to regenerate correctly. A 500-line module is not. When you extract functions, prefer small, focused modules — one concern per file. A parse error in a 50-line output is unlikely; in a 1000-line output it's almost guaranteed eventually.

### Test Your Understanding

Before modifying, read the current code via `K.kvGet("hook:wake:code")` (or the specific module key). Confirm you understand the current state before generating a replacement. Do not write code based on assumptions about what the module contains.

## What Not To Do

**Do not rewrite `hook:wake:code` in full.** If you're generating 1000+ lines, the probability of a syntax error or subtle logic bug is high. Extract and modify surgically instead.

**Do not modify multiple interdependent modules in one session.** If module A imports from module B and you change both, a bug in either crashes the system and you can't tell which caused it.

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

The system is designed so that self-modification is safe by default: every change is snapshotted, every hook write is alerted, crashes auto-revert, and the kernel enforces write protection regardless of what your hook code does. Work with these mechanisms, not around them. Small, incremental, verifiable changes — each confirmed clean before the next.
