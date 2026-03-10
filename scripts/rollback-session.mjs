#!/usr/bin/env node
// Roll back the most recent wake session's KV changes.
//
// Usage:
//   node scripts/rollback-session.mjs              # roll back last session (with confirmation)
//   node scripts/rollback-session.mjs --dry-run    # show what would be undone
//   node scripts/rollback-session.mjs --yes        # skip confirmation prompt

import { Miniflare } from "miniflare";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const KV_NAMESPACE_ID = "05720444f9654ed4985fb67af4aea24d";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const autoYes = args.includes("--yes");

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok'); } }",
  kvPersist: resolve(root, ".wrangler/shared-state/v3/kv"),
  kvNamespaces: { KV: KV_NAMESPACE_ID },
});

const kv = await mf.getKVNamespace("KV");

// ── Helpers ───────────────────────────────────────────────

async function kvGet(key) {
  try { return await kv.get(key, "json"); }
  catch { try { return await kv.get(key, "text"); } catch { return null; } }
}

async function kvGetWithMeta(key) {
  try {
    const { value, metadata } = await kv.getWithMetadata(key, "json");
    return { value, metadata };
  } catch {
    try {
      const { value, metadata } = await kv.getWithMetadata(key, "text");
      return { value, metadata };
    } catch {
      return { value: null, metadata: null };
    }
  }
}

async function kvPut(key, value, metadata = {}) {
  const val = typeof value === "string" ? value : JSON.stringify(value);
  await kv.put(key, val, { metadata });
}

function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => {
    rl.question(question, answer => {
      rl.close();
      res(answer.trim().toLowerCase());
    });
  });
}

function summarize(value) {
  if (value === null || value === undefined) return "null";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

// ── Load session info ─────────────────────────────────────

const sessionIds = await kvGet("cache:session_ids");
if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
  console.error("No sessions found in cache:session_ids. Nothing to roll back.");
  await mf.dispose();
  process.exit(1);
}

const targetId = sessionIds[sessionIds.length - 1];
const prevId = sessionIds.length >= 2 ? sessionIds[sessionIds.length - 2] : null;

console.log(`\nTarget session: ${targetId}`);
if (prevId) console.log(`Previous session: ${prevId}`);
console.log();

// ── Load karma ────────────────────────────────────────────

const karma = await kvGet(`karma:${targetId}`);
if (!Array.isArray(karma)) {
  console.error(`No karma log found for session ${targetId}. Cannot determine what to undo.`);
  await mf.dispose();
  process.exit(1);
}

// ── Build rollback plan ───────────────────────────────────

const plan = { deletes: [], restores: [], warnings: [] };

// 1. Session artifacts to delete
plan.deletes.push(`karma:${targetId}`);
plan.deletes.push(`reflect:0:${targetId}`);

// Check for deep reflections at any depth
const reflectList = await kv.list({ prefix: `reflect:`, limit: 500 });
for (const k of reflectList.keys) {
  const match = k.name.match(/^reflect:(\d+):(.+)$/);
  if (match && match[2] === targetId && !plan.deletes.includes(k.name)) {
    plan.deletes.push(k.name);
  }
}

// 2. Reverse privileged writes (in reverse order for correct sequencing)
const privilegedWrites = karma
  .filter(e => e.event === "privileged_write")
  .reverse();

for (const pw of privilegedWrites) {
  if (pw.old_value === null || pw.old_value === undefined) {
    // Key didn't exist before — delete it
    plan.deletes.push(pw.key);
  } else {
    plan.restores.push({
      key: pw.key,
      value: pw.old_value,
      reason: "privileged_write reversal",
    });
  }
}

// 3. Mutation candidates created this session — restore snapshots, delete record
const mutationApplied = karma.filter(e => e.event === "mutation_applied");
for (const ma of mutationApplied) {
  const candidateKey = `mutation_candidate:${ma.mutation_id}`;
  const candidate = await kvGet(candidateKey);
  if (candidate?.snapshots) {
    for (const [key, snapshot] of Object.entries(candidate.snapshots)) {
      if (snapshot.value === null) {
        plan.deletes.push(key);
      } else {
        plan.restores.push({
          key,
          value: snapshot.value,
          metadata: snapshot.metadata,
          reason: `mutation ${ma.mutation_id} snapshot restore`,
        });
      }
    }
  }
  // The candidate record itself should already be in privileged_write reversals,
  // but ensure it's deleted
  if (!plan.deletes.includes(candidateKey)) {
    plan.deletes.push(candidateKey);
  }
}

// 4. Staged mutations created this session
const mutationStaged = karma.filter(e => e.event === "mutation_staged");
for (const ms of mutationStaged) {
  const key = `mutation_staged:${ms.mutation_id}`;
  if (!plan.deletes.includes(key)) {
    plan.deletes.push(key);
  }
}

// 5. Decrement session_counter
const currentCounter = await kvGet("session_counter");
if (typeof currentCounter === "number" && currentCounter > 0) {
  plan.restores.push({
    key: "session_counter",
    value: currentCounter - 1,
    reason: "decrement session counter",
  });
}

// 6. Pop last entry from cache:session_ids
const newSessionIds = sessionIds.slice(0, -1);
plan.restores.push({
  key: "cache:session_ids",
  value: newSessionIds,
  reason: "remove rolled-back session",
});

// 7. Pop first entry from kernel:last_sessions (the one just added)
const lastSessions = await kvGet("kernel:last_sessions");
if (Array.isArray(lastSessions) && lastSessions.length > 0) {
  const first = lastSessions[0];
  if (first.id === targetId) {
    plan.restores.push({
      key: "kernel:last_sessions",
      value: lastSessions.slice(1),
      reason: "remove rolled-back session from history",
    });
  }
}

// 8. Delete cache:kv_index (will be rebuilt next wake)
plan.deletes.push("cache:kv_index");

// 9. Restore last_reflect from previous session's reflect:0:{prevId}
if (prevId) {
  const prevReflect = await kvGet(`reflect:0:${prevId}`);
  if (prevReflect) {
    plan.restores.push({
      key: "last_reflect",
      value: { ...prevReflect, session_id: prevId },
      reason: "restore previous session's reflect",
    });
  }
}

// 10. Clean up last_danger if set by this session
const lastDanger = await kvGet("last_danger");
if (lastDanger?.session_id === targetId) {
  plan.deletes.push("last_danger");
}

// 11. Warn about orphan sessions that left last_danger
if (lastDanger && lastDanger.session_id !== targetId) {
  const orphanId = lastDanger.session_id;
  const inSessionIds = sessionIds.includes(orphanId);
  const orphanKarma = await kvGet(`karma:${orphanId}`);
  if (!inSessionIds && orphanKarma) {
    plan.warnings.push(
      `Orphan session ${orphanId} left last_danger (event: ${lastDanger.event}) ` +
      `but is not in cache:session_ids. This will trigger the circuit breaker on ` +
      `the next wake. Consider deleting last_danger and karma:${orphanId} manually.`
    );
  } else if (lastDanger) {
    plan.warnings.push(
      `last_danger exists from session ${orphanId} (event: ${lastDanger.event}). ` +
      `Not from the session being rolled back — leaving it in place.`
    );
  }
}

// 12. Warn about agent KV ops (unprotected key writes via applyKVOperation)
const agentKVWrites = [];
for (const entry of karma) {
  if (entry.event === "tool_execution" && entry.tool === "kv_write" && entry.input?.key) {
    agentKVWrites.push(entry.input.key);
  }
}
if (agentKVWrites.length > 0) {
  plan.warnings.push(
    `Agent wrote to ${agentKVWrites.length} unprotected key(s) via kv_write tool ` +
    `(no old_value recorded, cannot auto-restore):\n` +
    agentKVWrites.map(k => `    ${k}`).join("\n")
  );
}

// Deduplicate deletes
plan.deletes = [...new Set(plan.deletes)];

// Deduplicate restores (last entry for each key wins — it was added last = most correct)
const restoreMap = new Map();
for (const r of plan.restores) {
  restoreMap.set(r.key, r);
}
plan.restores = [...restoreMap.values()];

// Remove from deletes any key that also appears in restores (restore takes priority)
const restoreKeys = new Set(plan.restores.map(r => r.key));
plan.deletes = plan.deletes.filter(k => !restoreKeys.has(k));

// ── Print plan ────────────────────────────────────────────

console.log("=== Rollback Plan ===\n");

if (plan.deletes.length > 0) {
  console.log(`DELETE ${plan.deletes.length} key(s):`);
  for (const key of plan.deletes) {
    console.log(`  - ${key}`);
  }
  console.log();
}

if (plan.restores.length > 0) {
  console.log(`RESTORE ${plan.restores.length} key(s):`);
  for (const r of plan.restores) {
    console.log(`  - ${r.key}  (${r.reason})`);
    if (!dryRun) continue;
    console.log(`    → ${summarize(r.value)}`);
  }
  console.log();
}

if (plan.warnings.length > 0) {
  console.log("WARNINGS:");
  for (const w of plan.warnings) {
    console.log(`  ⚠ ${w}`);
  }
  console.log();
}

const totalOps = plan.deletes.length + plan.restores.length;
console.log(`Total: ${totalOps} operation(s)\n`);

if (dryRun) {
  console.log("Dry run — no changes applied.");
  await mf.dispose();
  process.exit(0);
}

if (totalOps === 0) {
  console.log("Nothing to do.");
  await mf.dispose();
  process.exit(0);
}

// ── Confirm ───────────────────────────────────────────────

if (!autoYes) {
  const answer = await confirm("Apply rollback? [y/N] ");
  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted.");
    await mf.dispose();
    process.exit(0);
  }
}

// ── Apply ─────────────────────────────────────────────────

console.log("Applying rollback...\n");

for (const key of plan.deletes) {
  await kv.delete(key);
  console.log(`  deleted: ${key}`);
}

for (const r of plan.restores) {
  await kvPut(r.key, r.value, r.metadata || {});
  console.log(`  restored: ${r.key}`);
}

console.log(`\nRollback complete. Session ${targetId} has been undone.`);

await mf.dispose();
