// Swayambhu Wake Hook — Reflection
// Session reflect, deep reflect (recursive, depth-aware), scheduling, default prompts.
// KV key: hook:wake:reflect

import { SYSTEM_KEY_PREFIXES, SYSTEM_KEY_EXACT, applyKVOperation } from './hook-protect.js';
import {
  loadStagedMutations, loadCandidateMutations,
  stageMutation, applyDirectAsCandidate,
  processReflectVerdicts, processDeepReflectVerdicts,
} from './hook-mutations.js';

// ── Session reflect ─────────────────────────────────────────

export async function executeReflect(K, state, step) {
  const { defaults } = state;
  const sessionId = await K.getSessionId();

  const reflectPrompt = await K.kvGet("prompt:reflect");
  const stagedMutations = await loadStagedMutations(K);

  const systemKeyPatterns = {
    prefixes: SYSTEM_KEY_PREFIXES,
    exact: SYSTEM_KEY_EXACT,
  };

  const systemPrompt = await K.buildPrompt(
    reflectPrompt || defaultReflectPrompt(),
    { systemKeyPatterns }
  );

  const rawKarma = await K.getKarma();
  const sessionCost = await K.getSessionCost();

  // Strip bulky fields that repeat across turns — reflect needs events,
  // responses, and tool calls, not the full LLM request payloads.
  const karma = rawKarma.map(e => {
    if (e.event !== 'llm_call') return e;
    const { request, tools_available, ...rest } = e;
    return rest;
  });

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
  const { defaults } = state;
  const sessionId = await K.getSessionId();

  const prompt = await loadReflectPrompt(K, state, depth);
  const initialCtx = await gatherReflectContext(K, state, depth, context);
  const belowPrompt = await loadBelowPrompt(K, depth);

  const systemPrompt = await K.buildPrompt(prompt, {
    depth,
    belowPrompt,
    ...initialCtx.templateVars,
  });

  // Reflect uses tools for investigation but NOT spawn_subplan
  const allTools = await K.buildToolDefinitions();
  const tools = allTools.filter(t => t.function.name !== 'spawn_subplan');

  const model = await K.resolveModel(getReflectModel(state, depth));
  const maxSteps = getMaxSteps(state, 'reflect', depth);

  // Deep reflect gets its own budget: max_cost * budget_multiplier
  const budget = defaults?.session_budget;
  const multiplier = defaults?.deep_reflect?.budget_multiplier || 1;
  const deepBudgetCap = (budget?.max_cost && multiplier > 1)
    ? budget.max_cost * multiplier
    : undefined;

  const output = await K.runAgentLoop({
    systemPrompt,
    initialContext: initialCtx.userMessage,
    tools,
    model,
    effort: defaults?.deep_reflect?.effort || 'high',
    maxTokens: defaults?.deep_reflect?.max_output_tokens || 4000,
    maxSteps,
    step: `reflect_depth_${depth}`,
    budgetCap: deepBudgetCap,
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
  const orientPrompt = await K.kvGet("prompt:orient");
  const stagedMutations = await loadStagedMutations(K);
  const candidateMutations = await loadCandidateMutations(K);
  const systemKeyPatterns = {
    prefixes: SYSTEM_KEY_PREFIXES,
    exact: SYSTEM_KEY_EXACT,
  };

  const recentSessionIds = await K.kvGet("cache:session_ids") || [];

  const templateVars = {
    wisdom,
    orientPrompt,
    currentDefaults: defaults,
    models: modelsConfig,
    stagedMutations,
    candidateMutations,
    systemKeyPatterns,
    recentSessionIds,
    context: {
      orBalance: context?.balances?.providers?.openrouter?.balance ?? "unknown",
      walletBalance: context?.balances?.wallets?.base_usdc?.balance ?? 0,
      kvUsage: context?.kvUsage ?? "unknown",
      kvIndex: context?.kvIndex ?? "not loaded",
      effort: context?.effort || defaults?.deep_reflect?.effort || "high",
      crashData: context?.crashData || "none",
    },
  };

  if (depth >= 1) {
    templateVars.belowOutputs = await loadReflectHistory(K, depth - 1, 10);
  }

  return { userMessage: "Begin.", templateVars };
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

// ── Default prompts ────────────────────────────────────────

export function defaultReflectPrompt() {
  return `You are reflecting on a session that just completed.

Review the session karma log and cost provided in the user message.

Produce a JSON object with: session_summary, note_to_future_self,
next_orient_context (with load_keys array), and optionally
next_wake_config, kv_operations, mutation_verdicts, and mutation_requests.`;
}

export function defaultDeepReflectPrompt(depth) {
  if (depth === 1) {
    return `You are performing a depth-1 reflection. This is a deep examination of your recent operations.

You have tools available for investigation \u2014 use kv_read, web_fetch, etc. to gather data before drawing conclusions.

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

You have tools available for investigation \u2014 use kv_read, web_fetch, etc. to gather data.

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
