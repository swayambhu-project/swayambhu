// Swayambhu Wake Hook
// Session control flow — the entire policy layer that governs what happens
// when the brainstem wakes up. Stored in KV as hook:wake:code, loaded and
// executed by the kernel in a Worker Loader isolate.
//
// Every kernel method is called via K (the KernelRPC binding).
// Every policy method is a local function call.
//
// Named exports for testing, default export for Worker Loader.

// ── Constants (mirrored from kernel for local checks) ──────

const SYSTEM_KEY_PREFIXES = [
  'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
  'mutation_staged:', 'mutation_candidate:', 'hook:',
];
const SYSTEM_KEY_EXACT = ['providers', 'wallets', 'wisdom'];
const DANGER_SIGNALS = ["fatal_error", "orient_parse_error", "all_providers_failed"];

function isSystemKey(key) {
  if (SYSTEM_KEY_EXACT.includes(key)) return true;
  return SYSTEM_KEY_PREFIXES.some(p => key.startsWith(p));
}

// ── Mutation tracking (hook-local state) ───────────────────

let activeStaged = [];
let activeCandidates = [];

function _trackAdd(list, id) {
  const arr = list === 'activeStaged' ? activeStaged : activeCandidates;
  if (!arr.includes(id)) arr.push(id);
}

function _trackRemove(list, id) {
  if (list === 'activeStaged') {
    activeStaged = activeStaged.filter(x => x !== id);
  } else {
    activeCandidates = activeCandidates.filter(x => x !== id);
  }
}

function generateMutationId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Wake flow ──────────────────────────────────────────────

export async function wake(K, input) {
  // Load hook-local state eagerly
  let defaults = await K.getDefaults();
  let modelsConfig = await K.getModelsConfig();
  let dharma = await K.getDharma();
  let toolRegistry = await K.getToolRegistry();
  const sessionId = await K.getSessionId();

  // Build shared state object passed to sub-functions
  const state = {
    defaults, modelsConfig, dharma, toolRegistry, sessionId,
    async refreshDefaults() {
      state.defaults = await K.getDefaults();
      defaults = state.defaults;
    },
    async refreshModels() {
      state.modelsConfig = await K.getModelsConfig();
      modelsConfig = state.modelsConfig;
    },
    async refreshToolRegistry() {
      state.toolRegistry = await K.getToolRegistry();
      toolRegistry = state.toolRegistry;
    },
  };

  try {
    // 0. Check if it's actually time to wake up
    const wakeConfig = await K.kvGet("wake_config");
    if (wakeConfig?.next_wake_after) {
      if (Date.now() < new Date(wakeConfig.next_wake_after).getTime()) {
        return { skipped: true, reason: "not_time_yet" };
      }
    }

    // 1. Crash detection
    const crashData = await detectCrash(K);

    // 1a-pre. Initialize mutation tracking from targeted prefix scans
    const [stagedList, candidateList] = await Promise.all([
      K.kvList({ prefix: "mutation_staged:", limit: 200 }),
      K.kvList({ prefix: "mutation_candidate:", limit: 200 }),
    ]);
    activeStaged = stagedList.keys.map(k => k.name.slice("mutation_staged:".length));
    activeCandidates = candidateList.keys.map(k => k.name.slice("mutation_candidate:".length));

    // 1a-cache. Cache full KV index for dashboard (avoids list() calls from API)
    const allKeys = await K.kvList({ limit: 1000 });
    await K.kvPutSafe("cache:kv_index", allKeys.keys.map(k => ({
      key: k.name, metadata: k.metadata
    })));

    // 1b. Circuit breaker
    await runCircuitBreaker(K);

    // 2. Load ground truth
    const [balances, kvUsage] = await Promise.all([
      getBalances(K, state),
      getKVUsage(K),
    ]);

    // 3. Load core state from KV
    defaults = await K.kvGet("config:defaults");
    state.defaults = defaults;
    const lastReflect = await K.kvGet("last_reflect");

    // 4. Merge with defaults
    const config = await K.mergeDefaults(defaults, wakeConfig);

    // 4a. Cache immutable/stable values
    modelsConfig = await K.kvGet("config:models");
    state.modelsConfig = modelsConfig;
    dharma = await K.kvGet("dharma");
    state.dharma = dharma;
    toolRegistry = await K.kvGet("config:tool_registry");
    state.toolRegistry = toolRegistry;

    // 5. Check if reflection is due
    const reflectDepth = await highestReflectDepthDue(K, state);

    // 6. Evaluate tripwires
    const effort = evaluateTripwires(config, { balances, kvUsage });

    // 7. Load context keys
    const loadKeys = lastReflect?.next_orient_context?.load_keys
      || defaults?.memory?.default_load_keys
      || [];
    const additionalContext = await K.loadKeys(loadKeys);

    // 8. Build context
    const context = {
      balances, kvUsage, lastReflect, additionalContext,
      effort, reflectDepth,
      crashData,
    };

    // 10. Record session start
    await K.karmaRecord({
      event: "session_start",
      session_id: sessionId,
      effort,
      crash_detected: !!crashData,
    });

    // 11. Run session or reflect
    if (reflectDepth > 0) {
      await runReflect(K, state, reflectDepth, context);
    } else {
      await runSession(K, state, context, config);
    }

    return { ok: true };

  } catch (err) {
    await K.karmaRecord({
      event: "fatal_error",
      error: err.message,
      stack: err.stack,
    });
    return { ok: false, error: err.message };
  }
}

// ── Crash detection ─────────────────────────────────────────

export async function detectCrash(K) {
  const stale = await K.kvGet("kernel:active_session");
  if (!stale) return null;

  const deadKarma = await K.kvGet(`karma:${stale}`);
  return {
    dead_session_id: stale,
    karma: deadKarma,
    last_entry: Array.isArray(deadKarma) ? deadKarma[deadKarma.length - 1] : null,
  };
}

// ── Normal session ──────────────────────────────────────────

export async function runSession(K, state, context, config) {
  const { defaults, dharma, modelsConfig } = state;

  const orientPrompt = await K.kvGet("prompt:orient");
  const resources = await K.kvGet("config:resources");

  const systemPrompt = await K.buildPrompt(orientPrompt, {
    dharma,
    models: modelsConfig,
    resources,
    config,
  });

  const initialContext = buildOrientContext(context);

  const orientModel = await K.resolveModel(
    config.orient?.model || defaults.orient.model
  );

  const tools = await K.buildToolDefinitions();

  const output = await K.runAgentLoop({
    systemPrompt,
    initialContext,
    tools,
    model: orientModel,
    effort: context.effort || config.orient?.effort || defaults.orient.effort,
    maxTokens: config.orient?.max_output_tokens || defaults.orient.max_output_tokens,
    maxSteps: getMaxSteps(state, 'orient'),
    step: 'orient',
  });

  // Apply KV operations (gated by protection)
  if (output.kv_operations?.length) {
    for (const op of output.kv_operations) {
      await applyKVOperation(K, op);
    }
  }

  // Session reflect — skip if budget exhausted
  if (!output.budget_exceeded) {
    await executeReflect(K, state, { model: defaults.reflect.model });
  }

  await writeSessionResults(K, output, config);
}

export function buildOrientContext(context) {
  return JSON.stringify({
    balances: context.balances,
    kv_usage: context.kvUsage,
    last_reflect: context.lastReflect,
    additional_context: context.additionalContext,
    effort: context.effort,
    crash_data: context.crashData,
  });
}

// ── Reflect ─────────────────────────────────────────────────

export async function executeReflect(K, state, step) {
  const { defaults, dharma } = state;
  const sessionId = await K.getSessionId();

  const reflectPrompt = await K.kvGet("prompt:reflect");
  const stagedMutations = await loadStagedMutations(K);

  const systemKeyPatterns = {
    prefixes: SYSTEM_KEY_PREFIXES,
    exact: SYSTEM_KEY_EXACT,
  };

  const systemPrompt = await K.buildPrompt(
    reflectPrompt || defaultReflectPrompt(),
    { dharma, systemKeyPatterns }
  );

  const karma = await K.getKarma();
  const sessionCost = await K.getSessionCost();

  const initialContext = JSON.stringify({
    karma,
    sessionCost,
    stagedMutations,
  });

  const model = await K.resolveModel(
    step.model || defaults.reflect.model
  );

  const output = await K.runAgentLoop({
    systemPrompt,
    initialContext,
    tools: [],
    model,
    effort: step.effort || defaults.reflect.effort,
    maxTokens: step.max_output_tokens || defaults.reflect.max_output_tokens,
    maxSteps: 1,
    step: "reflect",
  });

  // Detect parse failure
  if (output.raw !== undefined) {
    await K.kvPutSafe("last_reflect", {
      raw: output.raw,
      parse_error: true,
      session_id: sessionId,
    });
    await K.kvPutSafe(`reflect:0:${sessionId}`, {
      raw: output.raw,
      parse_error: true,
      depth: 0,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  await K.kvPutSafe("last_reflect", {
    ...output,
    session_id: sessionId,
  });

  await K.kvPutSafe(`reflect:0:${sessionId}`, {
    reflection: output.session_summary || output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 0,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  });

  if (output.kv_operations) {
    for (const op of output.kv_operations) {
      await applyKVOperation(K, op);
    }
  }

  if (output.mutation_verdicts) {
    await processReflectVerdicts(K, output.mutation_verdicts);
  }

  if (output.mutation_requests) {
    for (const req of output.mutation_requests) {
      await stageMutation(K, req, sessionId);
    }
  }

  if (output.next_wake_config) {
    const wakeConf = { ...output.next_wake_config };
    if (wakeConf.sleep_seconds) {
      wakeConf.next_wake_after = new Date(
        Date.now() + wakeConf.sleep_seconds * 1000
      ).toISOString();
    }
    await K.kvPutSafe("wake_config", wakeConf);
  }
}

// ── Deep reflection (recursive, depth-aware) ────────────────

export async function runReflect(K, state, depth, context) {
  const { dharma, defaults } = state;
  const sessionId = await K.getSessionId();

  const prompt = await loadReflectPrompt(K, state, depth);
  const initialCtx = await gatherReflectContext(K, state, depth, context);
  const belowPrompt = await loadBelowPrompt(K, depth);

  const systemPrompt = await K.buildPrompt(prompt, {
    dharma,
    depth,
    belowPrompt,
    ...initialCtx.templateVars,
  });

  // Reflect uses tools for investigation but NOT spawn_subplan
  const allTools = await K.buildToolDefinitions();
  const tools = allTools.filter(t => t.function.name !== 'spawn_subplan');

  const model = await K.resolveModel(getReflectModel(state, depth));
  const maxSteps = getMaxSteps(state, 'reflect', depth);

  const output = await K.runAgentLoop({
    systemPrompt,
    initialContext: initialCtx.userMessage,
    tools,
    model,
    effort: defaults?.deep_reflect?.effort || 'high',
    maxTokens: defaults?.deep_reflect?.max_output_tokens || 4000,
    maxSteps,
    step: `reflect_depth_${depth}`,
  });

  await applyReflectOutput(K, state, depth, output, context);

  // Cascade — run next depth down
  if (depth > 1) {
    await runReflect(K, state, depth - 1, context);
  }
}

export async function gatherReflectContext(K, state, depth, context) {
  const { defaults, modelsConfig } = state;

  const wisdom = await K.kvGet("wisdom");
  const stagedMutations = await loadStagedMutations(K);
  const candidateMutations = await loadCandidateMutations(K);
  const systemKeyPatterns = {
    prefixes: SYSTEM_KEY_PREFIXES,
    exact: SYSTEM_KEY_EXACT,
  };

  const templateVars = {
    wisdom,
    currentDefaults: defaults,
    models: modelsConfig,
    stagedMutations,
    candidateMutations,
    systemKeyPatterns,
  };

  let userMessage;

  if (depth === 1) {
    const karmaList = await K.kvList({ prefix: "karma:", limit: 20 });
    const karmaKeys = karmaList.keys
      .map(k => k.name)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 10);
    const recentKarma = await K.loadKeys(karmaKeys);
    const orientPrompt = await K.kvGet("prompt:orient");
    const sessionHistory = await K.kvGet("session_history");

    templateVars.recentKarma = recentKarma;
    templateVars.orientPrompt = orientPrompt;
    templateVars.sessionHistory = sessionHistory;

    userMessage = JSON.stringify({
      depth,
      balances: context.balances,
      kv_usage: context.kvUsage,
      effort: context.effort,
      crash_data: context.crashData,
      staged_mutations: stagedMutations,
      candidate_mutations: candidateMutations,
    });
  } else {
    const belowOutputs = await loadReflectHistory(K, depth - 1, 10);
    const belowPromptText = await loadBelowPrompt(K, depth);

    templateVars.belowOutputs = belowOutputs;

    userMessage = JSON.stringify({
      depth,
      below_outputs: belowOutputs,
      below_prompt: belowPromptText,
      staged_mutations: stagedMutations,
      candidate_mutations: candidateMutations,
    });
  }

  return { userMessage, templateVars };
}

export async function applyReflectOutput(K, state, depth, output, context) {
  const sessionId = await K.getSessionId();

  // 1. KV operations (gated by protection)
  if (output.kv_operations?.length) {
    for (const op of output.kv_operations) {
      await applyKVOperation(K, op);
    }
  }

  // 2. Verdicts BEFORE new requests — clears conflicts first
  if (output.mutation_verdicts) {
    await processDeepReflectVerdicts(K, output.mutation_verdicts);
  }

  // 3. New mutation requests — applied directly as candidates
  if (output.mutation_requests) {
    for (const req of output.mutation_requests) {
      await applyDirectAsCandidate(K, req, sessionId);
    }
  }

  // 4. Schedule
  const schedule = output.next_reflect || output.next_deep_reflect;
  if (schedule) {
    const sessionCount = await K.getSessionCount();
    await K.kvPutSafe(`reflect:schedule:${depth}`, {
      ...schedule,
      last_reflect: new Date().toISOString(),
      last_reflect_session: sessionCount,
    });
    if (depth === 1) {
      await K.kvPutSafe("deep_reflect_schedule", {
        ...schedule,
        last_deep_reflect: new Date().toISOString(),
        last_deep_reflect_session: sessionCount,
      });
    }
  }

  // 5. Store output as reflect:{depth}:{sessionId}
  await K.kvPutSafe(`reflect:${depth}:${sessionId}`, {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  });

  // 6. Only depth 1: write last_reflect and wake_config
  if (depth === 1) {
    await K.kvPutSafe("last_reflect", {
      session_summary: output.reflection,
      note_to_future_self: output.note_to_future_self,
      was_deep_reflect: true,
      depth,
      session_id: sessionId,
    });

    const wakeConf = output.next_wake_config || {};
    if (wakeConf.sleep_seconds) {
      wakeConf.next_wake_after = new Date(
        Date.now() + wakeConf.sleep_seconds * 1000
      ).toISOString();
    }
    await K.kvPutSafe("wake_config", wakeConf);
  }

  // 7. Refresh defaults after every depth (cascade visibility)
  await state.refreshDefaults();

  // 8. Karma
  await K.karmaRecord({
    event: "reflect_complete",
    depth,
    session_id: sessionId,
  });
}

// ── Reflect hierarchy helpers ──────────────────────────────

export async function loadReflectPrompt(K, state, depth) {
  const specific = await K.kvGet(`prompt:reflect:${depth}`);
  if (specific) return specific;
  if (depth === 1) {
    const legacy = await K.kvGet("prompt:deep");
    if (legacy) return legacy;
  }
  return defaultDeepReflectPrompt(depth);
}

export async function loadBelowPrompt(K, depth) {
  if (depth === 1) return K.kvGet("prompt:orient");
  return K.kvGet(`prompt:reflect:${depth - 1}`);
}

export async function loadReflectHistory(K, depth, count = 10) {
  const result = await K.kvList({ prefix: `reflect:${depth}:`, limit: count + 10 });
  const keys = result.keys
    .map(k => k.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, count);
  return K.loadKeys(keys);
}

export function getReflectModel(state, depth) {
  const { defaults } = state;
  const perLevel = defaults?.reflect_levels?.[depth];
  if (perLevel?.model) return perLevel.model;
  return defaults?.deep_reflect?.model || defaults?.orient?.model;
}

export function getMaxSteps(state, role, depth) {
  const { defaults } = state;
  if (role === 'orient') return defaults?.execution?.max_steps?.orient || 3;
  const perLevel = defaults?.reflect_levels?.[depth];
  if (perLevel?.max_steps) return perLevel.max_steps;
  return depth === 1
    ? (defaults?.execution?.max_steps?.reflect_default || 5)
    : (defaults?.execution?.max_steps?.reflect_deep || 10);
}

// ── Reflect scheduling ───────────────────────────────────

export async function isReflectDue(K, state, depth) {
  const { defaults } = state;

  const schedule = await K.kvGet(`reflect:schedule:${depth}`)
    || (depth === 1 ? await K.kvGet("deep_reflect_schedule") : null);

  const sessionCount = await K.getSessionCount();

  if (schedule) {
    const sessionsSince = sessionCount - (schedule.last_deep_reflect_session || schedule.last_reflect_session || 0);
    const daysSince = schedule.last_deep_reflect || schedule.last_reflect
      ? (Date.now() - new Date(schedule.last_deep_reflect || schedule.last_reflect).getTime()) / 86400000
      : Infinity;
    const maxSessions = schedule.after_sessions
      || defaults?.deep_reflect?.default_interval_sessions || 20;
    const maxDays = schedule.after_days
      || defaults?.deep_reflect?.default_interval_days || 7;
    return sessionsSince >= maxSessions || daysSince >= maxDays;
  }

  // Cold-start fallback — exponential interval
  const baseInterval = defaults?.deep_reflect?.default_interval_sessions || 20;
  const multiplier = defaults?.execution?.reflect_interval_multiplier || 5;
  const threshold = baseInterval * Math.pow(multiplier, depth - 1);
  return sessionCount >= threshold;
}

export async function highestReflectDepthDue(K, state) {
  const maxDepth = state.defaults?.execution?.max_reflect_depth || 1;
  for (let d = maxDepth; d >= 1; d--) {
    if (await isReflectDue(K, state, d)) return d;
  }
  return 0;
}

// ── Mutation protocol ──────────────────────────────────────

export function evaluatePredicate(value, predicate, expected) {
  switch (predicate) {
    case "exists": return value !== null && value !== undefined;
    case "equals": return value === expected;
    case "gt": return typeof value === "number" && value > expected;
    case "lt": return typeof value === "number" && value < expected;
    case "matches": return typeof value === "string" && new RegExp(expected).test(value);
    case "type": return typeof value === expected;
    default: return false;
  }
}

export async function evaluateCheck(K, check) {
  try {
    switch (check.type) {
      case "kv_assert": {
        let value = await K.kvGet(check.key);
        if (check.path && value != null) {
          value = check.path.split(".").reduce((o, k) => o?.[k], value);
        }
        const passed = evaluatePredicate(value, check.predicate, check.expected);
        return { passed, detail: `${check.key}${check.path ? '.' + check.path : ''} ${check.predicate} ${JSON.stringify(check.expected)} → actual: ${JSON.stringify(value)}` };
      }
      case "tool_call": {
        const result = await K.executeAction({
          tool: check.tool,
          input: check.input || {},
          id: `check_${check.tool}`,
        });
        if (check.assert) {
          const passed = evaluatePredicate(result, check.assert.predicate, check.assert.expected);
          return { passed, detail: `${check.tool} result ${check.assert.predicate} ${JSON.stringify(check.assert.expected)} → actual: ${JSON.stringify(result)}` };
        }
        return { passed: true, detail: `${check.tool} executed successfully` };
      }
      default:
        return { passed: false, detail: `unknown check type: ${check.type}` };
    }
  } catch (err) {
    return { passed: false, detail: `check error: ${err.message}` };
  }
}

export async function evaluateChecks(K, checks) {
  const results = [];
  for (const check of checks) {
    results.push(await evaluateCheck(K, check));
  }
  return {
    all_passed: results.every(r => r.passed),
    results,
  };
}

export async function stageMutation(K, request, sessionId) {
  if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
    await K.karmaRecord({ event: "mutation_invalid", reason: "missing required fields (claims, ops, checks)" });
    return null;
  }
  const id = generateMutationId();
  await K.kvWritePrivileged([{
    op: "put",
    key: `mutation_staged:${id}`,
    value: {
      id,
      claims: request.claims,
      ops: request.ops,
      checks: request.checks,
      staged_at: new Date().toISOString(),
      staged_by_session: sessionId,
    },
  }]);
  _trackAdd('activeStaged', id);
  await K.karmaRecord({ event: "mutation_staged", mutation_id: id, claims: request.claims });
  return id;
}

export async function applyStagedAsCandidate(K, mutationId) {
  const record = await K.kvGet(`mutation_staged:${mutationId}`);
  if (!record) throw new Error(`No staged mutation: ${mutationId}`);

  const targetKeys = record.ops.map(op => op.key);
  const conflict = await findCandidateConflict(K, targetKeys);
  if (conflict) {
    await K.karmaRecord({ event: "mutation_conflict", mutation_id: mutationId, conflicting_mutation: conflict.id, overlapping_keys: conflict.keys });
    throw new Error(`Conflict with candidate ${conflict.id} on keys: ${conflict.keys.join(", ")}`);
  }

  // Snapshot current values before applying
  const snapshots = {};
  for (const key of targetKeys) {
    const { value, metadata } = await K.kvGetWithMeta(key);
    snapshots[key] = { value: value !== null ? value : null, metadata };
  }

  // Apply ops via privileged writes
  const writeOps = record.ops.map(op => ({
    op: op.op || "put",
    key: op.key,
    value: op.value,
    metadata: op.metadata,
  }));
  await K.kvWritePrivileged(writeOps);

  // Write candidate record
  await K.kvWritePrivileged([{
    op: "put",
    key: `mutation_candidate:${mutationId}`,
    value: {
      ...record,
      snapshots,
      activated_at: new Date().toISOString(),
    },
  }]);

  // Delete staged record
  await K.kvWritePrivileged([{ op: "delete", key: `mutation_staged:${mutationId}` }]);
  _trackRemove('activeStaged', mutationId);
  _trackAdd('activeCandidates', mutationId);

  // Refresh defaults if ops touch config:defaults
  if (targetKeys.some(k => k === "config:defaults")) {
    // Config auto-refreshed by kernel after privileged write
  }

  await K.karmaRecord({ event: "mutation_applied", mutation_id: mutationId, target_keys: targetKeys });
  return mutationId;
}

export async function applyDirectAsCandidate(K, request, sessionId) {
  if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
    await K.karmaRecord({ event: "mutation_invalid", reason: "missing required fields (claims, ops, checks)" });
    return null;
  }
  const id = generateMutationId();
  const targetKeys = request.ops.map(op => op.key);

  const conflict = await findCandidateConflict(K, targetKeys);
  if (conflict) {
    await K.karmaRecord({ event: "mutation_conflict", mutation_id: id, conflicting_mutation: conflict.id, overlapping_keys: conflict.keys });
    return null;
  }

  const snapshots = {};
  for (const key of targetKeys) {
    const { value, metadata } = await K.kvGetWithMeta(key);
    snapshots[key] = { value: value !== null ? value : null, metadata };
  }

  // Apply ops via privileged writes
  const writeOps = request.ops.map(op => ({
    op: op.op || "put",
    key: op.key,
    value: op.value,
    metadata: op.metadata,
  }));
  await K.kvWritePrivileged(writeOps);

  // Write candidate record
  await K.kvWritePrivileged([{
    op: "put",
    key: `mutation_candidate:${id}`,
    value: {
      id,
      claims: request.claims,
      ops: request.ops,
      checks: request.checks,
      snapshots,
      staged_by_session: sessionId,
      activated_at: new Date().toISOString(),
    },
  }]);
  _trackAdd('activeCandidates', id);

  await K.karmaRecord({ event: "mutation_applied", mutation_id: id, target_keys: targetKeys });
  return id;
}

export async function promoteCandidate(K, mutationId) {
  await K.kvWritePrivileged([{ op: "delete", key: `mutation_candidate:${mutationId}` }]);
  _trackRemove('activeCandidates', mutationId);
  await K.karmaRecord({ event: "mutation_promoted", mutation_id: mutationId });
}

export async function rollbackCandidate(K, mutationId, reason) {
  const record = await K.kvGet(`mutation_candidate:${mutationId}`);
  if (!record) return;

  // Restore snapshotted values via privileged writes
  const restoreOps = [];
  for (const [key, snapshot] of Object.entries(record.snapshots || {})) {
    if (snapshot.value === null) {
      restoreOps.push({ op: "delete", key });
    } else {
      restoreOps.push({ op: "put", key, value: snapshot.value, metadata: snapshot.metadata || {} });
    }
  }
  if (restoreOps.length) await K.kvWritePrivileged(restoreOps);

  await K.kvWritePrivileged([{ op: "delete", key: `mutation_candidate:${mutationId}` }]);
  _trackRemove('activeCandidates', mutationId);
  await K.karmaRecord({ event: "mutation_rolled_back", mutation_id: mutationId, reason });
}

export async function findCandidateConflict(K, targetKeys) {
  for (const id of activeCandidates) {
    const record = await K.kvGet(`mutation_candidate:${id}`);
    if (!record?.snapshots) continue;
    const overlap = targetKeys.filter(k => k in record.snapshots);
    if (overlap.length > 0) return { id: record.id, keys: overlap };
  }
  return null;
}

export async function loadStagedMutations(K) {
  const result = {};
  for (const id of activeStaged) {
    const record = await K.kvGet(`mutation_staged:${id}`);
    if (!record) continue;
    const checkResults = await evaluateChecks(K, record.checks || []);
    result[record.id] = { record, check_results: checkResults };
  }
  return result;
}

export async function loadCandidateMutations(K) {
  const result = {};
  for (const id of activeCandidates) {
    const record = await K.kvGet(`mutation_candidate:${id}`);
    if (!record) continue;
    const checkResults = await evaluateChecks(K, record.checks || []);
    result[record.id] = { record, check_results: checkResults };
  }
  return result;
}

export async function processReflectVerdicts(K, verdicts) {
  for (const v of verdicts || []) {
    switch (v.verdict) {
      case "withdraw":
        await K.kvWritePrivileged([{ op: "delete", key: `mutation_staged:${v.mutation_id}` }]);
        _trackRemove('activeStaged', v.mutation_id);
        await K.karmaRecord({ event: "mutation_withdrawn", mutation_id: v.mutation_id });
        break;
      case "modify": {
        const record = await K.kvGet(`mutation_staged:${v.mutation_id}`);
        if (record) {
          await K.kvWritePrivileged([{
            op: "put",
            key: `mutation_staged:${v.mutation_id}`,
            value: {
              ...record,
              ...(v.updated_ops ? { ops: v.updated_ops } : {}),
              ...(v.updated_checks ? { checks: v.updated_checks } : {}),
              ...(v.updated_claims ? { claims: v.updated_claims } : {}),
              modified_at: new Date().toISOString(),
            },
          }]);
          await K.karmaRecord({ event: "mutation_modified", mutation_id: v.mutation_id });
        }
        break;
      }
    }
  }
}

export async function processDeepReflectVerdicts(K, verdicts) {
  for (const v of verdicts || []) {
    switch (v.verdict) {
      case "apply":
        try { await applyStagedAsCandidate(K, v.mutation_id); }
        catch (err) { await K.karmaRecord({ event: "mutation_apply_failed", mutation_id: v.mutation_id, error: err.message }); }
        break;
      case "reject":
        await K.kvWritePrivileged([{ op: "delete", key: `mutation_staged:${v.mutation_id}` }]);
        _trackRemove('activeStaged', v.mutation_id);
        await K.karmaRecord({ event: "mutation_rejected", mutation_id: v.mutation_id, reason: v.reason });
        break;
      case "withdraw":
        await K.kvWritePrivileged([{ op: "delete", key: `mutation_staged:${v.mutation_id}` }]);
        _trackRemove('activeStaged', v.mutation_id);
        await K.karmaRecord({ event: "mutation_withdrawn", mutation_id: v.mutation_id });
        break;
      case "modify": {
        const record = await K.kvGet(`mutation_staged:${v.mutation_id}`);
        if (record) {
          await K.kvWritePrivileged([{
            op: "put",
            key: `mutation_staged:${v.mutation_id}`,
            value: {
              ...record,
              ...(v.updated_ops ? { ops: v.updated_ops } : {}),
              ...(v.updated_checks ? { checks: v.updated_checks } : {}),
              ...(v.updated_claims ? { claims: v.updated_claims } : {}),
              modified_at: new Date().toISOString(),
            },
          }]);
          await K.karmaRecord({ event: "mutation_modified", mutation_id: v.mutation_id });
        }
        break;
      }
      case "promote":
        await promoteCandidate(K, v.mutation_id);
        break;
      case "rollback":
        await rollbackCandidate(K, v.mutation_id, v.reason || "deep_reflect_verdict");
        break;
      case "defer":
        await K.karmaRecord({ event: "mutation_deferred", mutation_id: v.mutation_id, reason: v.reason });
        break;
    }
  }
}

// ── Circuit breaker ────────────────────────────────────────

export async function runCircuitBreaker(K) {
  const lastDanger = await K.kvGet("last_danger");
  if (!lastDanger) return;

  for (const id of [...activeCandidates]) {
    const record = await K.kvGet(`mutation_candidate:${id}`);
    if (!record?.activated_at) continue;

    if (lastDanger.t >= new Date(record.activated_at).getTime()) {
      await rollbackCandidate(K, record.id, "circuit_breaker");
      await K.karmaRecord({ event: "circuit_breaker_fired", mutation_id: record.id });
    }
  }
}

// ── Protection gate ────────────────────────────────────────

export async function applyKVOperation(K, op) {
  const key = op.key;

  // Truncate value for karma logging (avoid bloating the log)
  const valueSummary = op.value != null
    ? (typeof op.value === 'string'
        ? (op.value.length > 500 ? op.value.slice(0, 500) + '…' : op.value)
        : JSON.stringify(op.value).slice(0, 500))
    : undefined;

  if (isSystemKey(key)) {
    await K.karmaRecord({
      event: "mutation_blocked",
      key,
      op: op.op,
      reason: "system_key",
      attempted_value: valueSummary,
    });
    return;
  }

  // Agent keys: check KV-native metadata for unprotected flag
  const { metadata } = await K.kvGetWithMeta(key);
  if (!metadata?.unprotected) {
    await K.karmaRecord({
      event: "mutation_blocked",
      key,
      op: op.op,
      reason: "protected_key",
      attempted_value: valueSummary,
    });
    return;
  }

  await applyKVOperationDirect(K, op);
}

async function applyKVOperationDirect(K, op) {
  switch (op.op) {
    case "put":
      await K.kvPutSafe(op.key, op.value, op.metadata);
      break;
    case "delete":
      await K.kvDeleteSafe(op.key);
      break;
    case "rename": {
      const { value, metadata } = await K.kvGetWithMeta(op.key);
      if (value !== null) {
        await K.kvPutSafe(op.value, value, metadata);
        await K.kvDeleteSafe(op.key);
      }
      break;
    }
  }
}

// ── Session results ────────────────────────────────────────

export async function writeSessionResults(K, plan, config) {
  if (plan.next_wake_config) {
    const wakeConf = { ...plan.next_wake_config };
    if (wakeConf.sleep_seconds) {
      wakeConf.next_wake_after = new Date(
        Date.now() + wakeConf.sleep_seconds * 1000
      ).toISOString();
    }
    await K.kvPutSafe("wake_config", wakeConf);
  }

  const count = await K.getSessionCount();
  await K.kvPutSafe("session_counter", count + 1);

  // Cache session ID list for dashboard
  const sessionIds = await K.kvGet("cache:session_ids") || [];
  sessionIds.push(await K.getSessionId());
  await K.kvPutSafe("cache:session_ids", sessionIds);
}

// ── Helpers ────────────────────────────────────────────────

export async function getBalances(K, state) {
  const [providers, wallets] = await Promise.all([
    K.kvGet("providers"),
    K.kvGet("wallets"),
  ]);

  const balances = { providers: {}, wallets: {} };

  for (const [name, config] of Object.entries(providers || {})) {
    if (!config.adapter) continue;
    try {
      balances.providers[name] = await K.executeAdapter(config.adapter, {});
    } catch { balances.providers[name] = null; }
  }

  for (const [name, config] of Object.entries(wallets || {})) {
    if (!config.adapter) continue;
    try {
      balances.wallets[name] = await K.executeAdapter(config.adapter, {});
    } catch { balances.wallets[name] = null; }
  }

  return balances;
}

export async function getKVUsage(K) {
  return { writes_this_session: 0 };
}

export function evaluateTripwires(config, liveData) {
  const alerts = config.alerts || [];
  let effort = config.default_effort || config.wake?.default_effort || "low";
  for (const alert of alerts) {
    const value = alert.field.split(".").reduce((o, k) => o?.[k], liveData) ?? null;
    if (value === null) continue;
    let fired = false;
    switch (alert.condition) {
      case "below": fired = value < alert.value; break;
      case "above": fired = value > alert.value; break;
      case "equals": fired = value === alert.value; break;
      case "changed": fired = true; break;
    }
    if (fired && alert.override_effort) {
      const levels = ["low", "medium", "high", "max"];
      if (levels.indexOf(alert.override_effort) > levels.indexOf(effort)) {
        effort = alert.override_effort;
      }
    }
  }
  return effort;
}

// ── Default prompts ────────────────────────────────────────

export function defaultReflectPrompt() {
  return `You are reflecting on a session that just completed.

Your dharma: {{dharma}}

Review the session karma log and cost provided in the user message.

Produce a JSON object with: session_summary, note_to_future_self,
next_orient_context (with load_keys array), and optionally
next_wake_config, kv_operations, mutation_verdicts, and mutation_requests.`;
}

export function defaultDeepReflectPrompt(depth) {
  if (depth === 1) {
    return `You are performing a depth-1 reflection. This is a deep examination of your recent operations.

Your dharma: {{dharma}}

You have tools available for investigation — use kv_read, web_fetch, etc. to gather data before drawing conclusions.

Your output is stored at reflect:1:{sessionId} and read by higher-depth reflections.

Examine your karma, your orient prompt, your patterns. Produce a JSON object:
{
  "reflection": "What you see when you look at yourself as a system",
  "note_to_future_self": "Orientation, not action items",
  "kv_operations": [],
  "mutation_requests": [],
  "mutation_verdicts": [],
  "next_reflect": { "after_sessions": 20, "after_days": 7, "reason": "..." },
  "next_wake_config": { "sleep_seconds": 21600, "effort": "low" }
}

mutation_requests go through applyDirectAsCandidate. mutation_verdicts for staged/candidate mutations.
Required: reflection, note_to_future_self. Everything else optional.`;
  }

  return `You are performing a depth-${depth} reflection. You examine the outputs of depth-${depth - 1} reflections.

Your dharma: {{dharma}}

You have tools available for investigation — use kv_read, web_fetch, etc. to gather data.

Your output is stored at reflect:${depth}:{sessionId}.

## One-level-below write discipline
You can only propose mutations targeting prompt:reflect:${depth - 1} (the prompt for the level below you).

Below-level prompt: {{belowPrompt}}

Examine the depth-${depth - 1} outputs for patterns, drift, and alignment. Produce a JSON object:
{
  "reflection": "What you see in the level-below patterns",
  "note_to_future_self": "Orientation for next depth-${depth} reflection",
  "kv_operations": [],
  "mutation_requests": [],
  "mutation_verdicts": [],
  "next_reflect": { "after_sessions": 100, "after_days": 30, "reason": "..." }
}

Required: reflection, note_to_future_self. Everything else optional.`;
}

// ── Worker Loader default export ───────────────────────────

export default {
  async fetch(request, env) {
    const K = env.KERNEL;
    const input = await request.json();
    const result = await wake(K, input);
    return Response.json(result);
  },
};
