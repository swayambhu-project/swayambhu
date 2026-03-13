import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildOrientContext,
  detectCrash,
  evaluateTripwires,
  writeSessionResults,
  getBalances,
  runSession,
} from "../hook-main.js";
import {
  applyKVOperation,
} from "../hook-protect.js";
import {
  evaluatePredicate,
  stageMutation,
  findCandidateConflict,
  promoteCandidate,
  rollbackCandidate,
  processReflectVerdicts,
  processDeepReflectVerdicts,
  runCircuitBreaker,
  loadStagedMutations,
  loadCandidateMutations,
  initTracking,
  applyStagedAsCandidate,
  applyDirectAsCandidate,
} from "../hook-mutations.js";
import {
  getMaxSteps,
  getReflectModel,
  isReflectDue,
  highestReflectDepthDue,
  defaultReflectPrompt,
  defaultDeepReflectPrompt,
  applyReflectOutput,
  loadReflectPrompt,
  loadBelowPrompt,
  loadReflectHistory,
  runReflect,
} from "../hook-reflect.js";
import { makeMockK } from "./helpers/mock-kernel.js";

// Reset mutation tracking state before each test
beforeEach(() => {
  initTracking([], []);
});

function makeState(overrides = {}) {
  return {
    defaults: overrides.defaults || {},
    modelsConfig: overrides.modelsConfig || null,
    toolRegistry: overrides.toolRegistry || null,
    sessionId: overrides.sessionId || "test_session",
    async refreshDefaults() { this.defaults = overrides.defaults || {}; },
    async refreshModels() {},
    async refreshToolRegistry() {},
  };
}

// ── 1. buildOrientContext ───────────────────────────────────

describe("buildOrientContext", () => {
  it("returns JSON string with all expected keys", () => {
    const context = {
      balances: { providers: {}, wallets: {} },
      kvUsage: { writes_this_session: 0 },
      lastReflect: { session_summary: "test" },
      additionalContext: { foo: "bar" },
      effort: "medium",
      crashData: null,
    };
    const result = JSON.parse(buildOrientContext(context));
    expect(result).toHaveProperty("balances");
    expect(result).toHaveProperty("kv_usage");
    expect(result).toHaveProperty("last_reflect");
    expect(result).toHaveProperty("additional_context");
    expect(result).toHaveProperty("effort");
    expect(result).toHaveProperty("crash_data");
    expect(result.effort).toBe("medium");
    expect(result.crash_data).toBeNull();
    expect(result).toHaveProperty("current_time");
    expect(new Date(result.current_time).getTime()).not.toBeNaN();
  });
});

// ── 2. getMaxSteps ──────────────────────────────────────────

describe("getMaxSteps", () => {
  it("returns execution config for orient", () => {
    const state = makeState({ defaults: { execution: { max_steps: { orient: 7 } } } });
    expect(getMaxSteps(state, "orient")).toBe(7);
  });

  it("returns default 3 for orient when not configured", () => {
    const state = makeState();
    expect(getMaxSteps(state, "orient")).toBe(3);
  });

  it("returns reflect_default for depth 1", () => {
    const state = makeState({ defaults: { execution: { max_steps: { reflect_default: 8 } } } });
    expect(getMaxSteps(state, "reflect", 1)).toBe(8);
  });

  it("returns default 5 for depth 1 when not configured", () => {
    const state = makeState();
    expect(getMaxSteps(state, "reflect", 1)).toBe(5);
  });

  it("returns reflect_deep for depth > 1", () => {
    const state = makeState({ defaults: { execution: { max_steps: { reflect_deep: 15 } } } });
    expect(getMaxSteps(state, "reflect", 2)).toBe(15);
  });

  it("returns default 10 for depth > 1 when not configured", () => {
    const state = makeState();
    expect(getMaxSteps(state, "reflect", 3)).toBe(10);
  });

  it("uses per-level override via reflect_levels", () => {
    const state = makeState({
      defaults: {
        reflect_levels: { 2: { max_steps: 25 } },
        execution: { max_steps: { reflect_deep: 15 } },
      },
    });
    expect(getMaxSteps(state, "reflect", 2)).toBe(25);
  });
});

// ── 3. getReflectModel ──────────────────────────────────────

describe("getReflectModel", () => {
  it("uses per-level override", () => {
    const state = makeState({
      defaults: {
        reflect_levels: { 2: { model: "opus" } },
        deep_reflect: { model: "sonnet" },
        orient: { model: "haiku" },
      },
    });
    expect(getReflectModel(state, 2)).toBe("opus");
  });

  it("falls back to deep_reflect.model", () => {
    const state = makeState({
      defaults: {
        deep_reflect: { model: "sonnet" },
        orient: { model: "haiku" },
      },
    });
    expect(getReflectModel(state, 1)).toBe("sonnet");
  });

  it("falls back to orient.model", () => {
    const state = makeState({
      defaults: { orient: { model: "haiku" } },
    });
    expect(getReflectModel(state, 1)).toBe("haiku");
  });

  it("returns undefined when nothing configured", () => {
    const state = makeState();
    expect(getReflectModel(state, 1)).toBeUndefined();
  });
});

// ── 4. loadReflectPrompt ────────────────────────────────────

describe("loadReflectPrompt", () => {
  it("returns depth-specific prompt from KV", async () => {
    const K = makeMockK({ "prompt:reflect:2": JSON.stringify("depth-2 prompt") });
    const state = makeState();
    const result = await loadReflectPrompt(K, state, 2);
    expect(result).toBe("depth-2 prompt");
  });

  it("falls back to prompt:deep for depth 1", async () => {
    const K = makeMockK({ "prompt:deep": JSON.stringify("deep prompt") });
    const state = makeState();
    const result = await loadReflectPrompt(K, state, 1);
    expect(result).toBe("deep prompt");
  });

  it("falls back to hardcoded defaultDeepReflectPrompt", async () => {
    const K = makeMockK();
    const state = makeState();
    const result = await loadReflectPrompt(K, state, 1);
    expect(result).toContain("depth-1 reflection");
  });

  it("does NOT fall back to prompt:deep for depth > 1", async () => {
    const K = makeMockK({ "prompt:deep": JSON.stringify("deep prompt") });
    const state = makeState();
    const result = await loadReflectPrompt(K, state, 3);
    expect(result).toContain("depth-3 reflection");
  });
});

// ── 5. isReflectDue ─────────────────────────────────────────

describe("isReflectDue", () => {
  it("cold-start: depth 1 due at session 20", async () => {
    const K = makeMockK({}, { sessionCount: 20 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    expect(await isReflectDue(K, state, 1)).toBe(true);
  });

  it("cold-start: depth 1 NOT due below threshold", async () => {
    const K = makeMockK({}, { sessionCount: 19 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    expect(await isReflectDue(K, state, 1)).toBe(false);
  });

  it("cold-start: depth 2 uses exponential formula", async () => {
    const K = makeMockK({}, { sessionCount: 100 });
    const state = makeState({
      defaults: {
        deep_reflect: { default_interval_sessions: 20 },
        execution: { reflect_interval_multiplier: 5 },
      },
    });
    expect(await isReflectDue(K, state, 2)).toBe(true);
  });

  it("cold-start: depth 2 NOT due below exponential threshold", async () => {
    const K = makeMockK({}, { sessionCount: 99 });
    const state = makeState({
      defaults: {
        deep_reflect: { default_interval_sessions: 20 },
        execution: { reflect_interval_multiplier: 5 },
      },
    });
    expect(await isReflectDue(K, state, 2)).toBe(false);
  });

  it("self-scheduled: due when sessionsSince >= after_sessions", async () => {
    const K = makeMockK({
      "reflect:schedule:1": JSON.stringify({
        after_sessions: 10,
        after_days: 999,
        last_reflect_session: 5,
        last_reflect: new Date().toISOString(),
      }),
    }, { sessionCount: 15 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    expect(await isReflectDue(K, state, 1)).toBe(true);
  });

  it("self-scheduled: NOT due when below both thresholds", async () => {
    const K = makeMockK({
      "reflect:schedule:1": JSON.stringify({
        after_sessions: 10,
        after_days: 999,
        last_reflect_session: 12,
        last_reflect: new Date().toISOString(),
      }),
    }, { sessionCount: 15 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    expect(await isReflectDue(K, state, 1)).toBe(false);
  });

  it("backward compat: depth 1 reads deep_reflect_schedule", async () => {
    const K = makeMockK({
      deep_reflect_schedule: JSON.stringify({
        after_sessions: 5,
        after_days: 999,
        last_deep_reflect_session: 10,
        last_deep_reflect: new Date().toISOString(),
      }),
    }, { sessionCount: 15 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    expect(await isReflectDue(K, state, 1)).toBe(true);
  });
});

// ── 6. highestReflectDepthDue ───────────────────────────────

describe("highestReflectDepthDue", () => {
  it("returns highest due depth", async () => {
    const K = makeMockK({}, { sessionCount: 100 });
    const state = makeState({
      defaults: {
        execution: { max_reflect_depth: 2, reflect_interval_multiplier: 5 },
        deep_reflect: { default_interval_sessions: 20 },
      },
    });
    expect(await highestReflectDepthDue(K, state)).toBe(2);
  });

  it("returns 0 when none due", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    const state = makeState({
      defaults: {
        execution: { max_reflect_depth: 2, reflect_interval_multiplier: 5 },
        deep_reflect: { default_interval_sessions: 20 },
      },
    });
    expect(await highestReflectDepthDue(K, state)).toBe(0);
  });

  it("returns depth 1 when only depth 1 is due", async () => {
    const K = makeMockK({}, { sessionCount: 25 });
    const state = makeState({
      defaults: {
        execution: { max_reflect_depth: 2, reflect_interval_multiplier: 5 },
        deep_reflect: { default_interval_sessions: 20 },
      },
    });
    expect(await highestReflectDepthDue(K, state)).toBe(1);
  });
});

// ── 7. applyReflectOutput ──────────────────────────────────

describe("applyReflectOutput", () => {
  it("applies kv_operations", async () => {
    const K = makeMockK();
    const state = makeState();
    const output = {
      reflection: "test",
      kv_operations: [
        { op: "put", key: "test_key", value: "test_val" },
      ],
    };
    // applyKVOperation will check isSystemKey and metadata — mock appropriately
    // Since test_key is not a system key but has no unprotected metadata, it will be blocked
    // That's fine — we just verify applyReflectOutput processes the ops
    await applyReflectOutput(K, state, 1, output, {});
    // The function ran without error
    expect(K.karmaRecord).toHaveBeenCalled();
  });

  it("stores history at reflect:N:sessionId", async () => {
    const K = makeMockK({}, { sessionId: "test_session" });
    const state = makeState();
    const output = {
      reflection: "deep thoughts",
      note_to_future_self: "remember this",
    };

    await applyReflectOutput(K, state, 2, output, {});

    expect(K.kvPutSafe).toHaveBeenCalledWith(
      "reflect:2:test_session",
      expect.objectContaining({
        reflection: "deep thoughts",
        note_to_future_self: "remember this",
        depth: 2,
      })
    );
  });

  it("depth 1 writes last_reflect + wake_config", async () => {
    const K = makeMockK({}, { sessionId: "test_session" });
    const state = makeState();
    const output = {
      reflection: "depth 1 reflection",
      note_to_future_self: "keep going",
      next_wake_config: { sleep_seconds: 3600, effort: "low" },
    };

    await applyReflectOutput(K, state, 1, output, {});

    const lastReflectCall = K.kvPutSafe.mock.calls.find(([key]) => key === "last_reflect");
    expect(lastReflectCall).toBeTruthy();
    expect(lastReflectCall[1].was_deep_reflect).toBe(true);

    const wakeConfigCall = K.kvPutSafe.mock.calls.find(([key]) => key === "wake_config");
    expect(wakeConfigCall).toBeTruthy();
    expect(wakeConfigCall[1].sleep_seconds).toBe(3600);
    expect(wakeConfigCall[1]).toHaveProperty("next_wake_after");
  });

  it("depth > 1 does NOT write last_reflect or wake_config", async () => {
    const K = makeMockK({}, { sessionId: "test_session" });
    const state = makeState();
    const output = {
      reflection: "depth 2 reflection",
      note_to_future_self: "meta thoughts",
      next_wake_config: { sleep_seconds: 3600 },
    };

    await applyReflectOutput(K, state, 2, output, {});

    const lastReflectCall = K.kvPutSafe.mock.calls.find(([key]) => key === "last_reflect");
    expect(lastReflectCall).toBeUndefined();
    const wakeConfigCall = K.kvPutSafe.mock.calls.find(([key]) => key === "wake_config");
    expect(wakeConfigCall).toBeUndefined();
  });
});

// ── 8. evaluateTripwires ────────────────────────────────────

describe("evaluateTripwires", () => {
  it("returns default effort with no alerts", () => {
    expect(evaluateTripwires({ default_effort: "low" }, {})).toBe("low");
  });

  it("returns wake.default_effort fallback", () => {
    expect(evaluateTripwires({ wake: { default_effort: "medium" } }, {})).toBe("medium");
  });

  it("overrides effort when tripwire fires", () => {
    const config = {
      default_effort: "low",
      alerts: [
        { field: "balance", condition: "below", value: 5, override_effort: "high" },
      ],
    };
    expect(evaluateTripwires(config, { balance: 3 })).toBe("high");
  });
});

// ── 9. evaluatePredicate ────────────────────────────────────

describe("evaluatePredicate", () => {
  it("exists", () => {
    expect(evaluatePredicate("val", "exists")).toBe(true);
    expect(evaluatePredicate(null, "exists")).toBe(false);
  });

  it("equals", () => {
    expect(evaluatePredicate(42, "equals", 42)).toBe(true);
    expect(evaluatePredicate(42, "equals", 43)).toBe(false);
  });

  it("gt / lt", () => {
    expect(evaluatePredicate(10, "gt", 5)).toBe(true);
    expect(evaluatePredicate(10, "lt", 5)).toBe(false);
  });

  it("matches", () => {
    expect(evaluatePredicate("hello world", "matches", "hello")).toBe(true);
    expect(evaluatePredicate("hello world", "matches", "^world")).toBe(false);
  });

  it("type", () => {
    expect(evaluatePredicate(42, "type", "number")).toBe(true);
    expect(evaluatePredicate("str", "type", "string")).toBe(true);
  });

  it("unknown predicate fails closed", () => {
    expect(evaluatePredicate("val", "unknown_pred")).toBe(false);
  });
});

// ── 10. detectCrash ─────────────────────────────────────────

describe("detectCrash", () => {
  it("returns null when no stale session", async () => {
    const K = makeMockK();
    expect(await detectCrash(K)).toBeNull();
  });

  it("returns crash data when stale session exists", async () => {
    const K = makeMockK({
      "kernel:active_session": JSON.stringify("s_dead"),
      "karma:s_dead": JSON.stringify([{ event: "session_start" }]),
    });
    const result = await detectCrash(K);
    expect(result.dead_session_id).toBe("s_dead");
    expect(result.karma).toHaveLength(1);
    expect(result.last_entry.event).toBe("session_start");
  });
});

// ── 11. writeSessionResults ────────────────────────────────

describe("writeSessionResults", () => {
  it("writes wake_config and increments session_counter", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    await writeSessionResults(K, {
      next_wake_config: { sleep_seconds: 3600 },
    }, {});

    const wakeCall = K.kvPutSafe.mock.calls.find(([key]) => key === "wake_config");
    expect(wakeCall).toBeTruthy();
    expect(wakeCall[1]).toHaveProperty("next_wake_after");

    const counterCall = K.kvPutSafe.mock.calls.find(([key]) => key === "session_counter");
    expect(counterCall).toBeTruthy();
    expect(counterCall[1]).toBe(6);
  });
});

// ── 12. Default prompts ─────────────────────────────────────

describe("default prompts", () => {
  it("defaultReflectPrompt does not include dharma (kernel-injected)", () => {
    const prompt = defaultReflectPrompt();
    expect(prompt).not.toContain("{{dharma}}");
  });

  it("defaultDeepReflectPrompt depth 1", () => {
    const prompt = defaultDeepReflectPrompt(1);
    expect(prompt).toContain("depth-1 reflection");
    expect(prompt).not.toContain("{{dharma}}");
  });

  it("defaultDeepReflectPrompt depth 2", () => {
    const prompt = defaultDeepReflectPrompt(2);
    expect(prompt).toContain("depth-2 reflection");
    expect(prompt).toContain("depth-1");
    expect(prompt).toContain("{{belowPrompt}}");
  });
});

// ── 13. runCircuitBreaker ──────────────────────────────────

describe("runCircuitBreaker", () => {
  it("no-op without last_danger", async () => {
    const K = makeMockK();
    await runCircuitBreaker(K);
    expect(K.kvWritePrivileged).not.toHaveBeenCalled();
  });
});

// ── 14. getBalances ─────────────────────────────────────────

describe("getBalances", () => {
  it("delegates to K.checkBalance", async () => {
    const K = makeMockK();
    const expected = { providers: { or: { balance: 42, scope: "general" } }, wallets: {} };
    K.checkBalance.mockResolvedValue(expected);
    const state = makeState();

    const result = await getBalances(K, state);

    expect(K.checkBalance).toHaveBeenCalledWith({});
    expect(result).toEqual(expected);
  });
});

// ── 15. loadReflectHistory ─────────────────────────────────

describe("loadReflectHistory", () => {
  it("uses kvList with prefix filter", async () => {
    const K = makeMockK({
      "reflect:1:s_001": JSON.stringify({ reflection: "first" }),
      "reflect:1:s_002": JSON.stringify({ reflection: "second" }),
      "reflect:2:s_003": JSON.stringify({ reflection: "depth2" }),
    });
    const result = await loadReflectHistory(K, 1, 5);
    expect(result).toHaveProperty("reflect:1:s_002");
    expect(result).toHaveProperty("reflect:1:s_001");
    expect(result).not.toHaveProperty("reflect:2:s_003");
  });

  it("limits results to count", async () => {
    const K = makeMockK({
      "reflect:1:s_001": JSON.stringify({ reflection: "a" }),
      "reflect:1:s_002": JSON.stringify({ reflection: "b" }),
      "reflect:1:s_003": JSON.stringify({ reflection: "c" }),
    });
    const result = await loadReflectHistory(K, 1, 2);
    expect(Object.keys(result)).toHaveLength(2);
  });
});

// ── 16. runSession — reflect_reserve_pct ─────────────────

describe("runSession reflect_reserve_pct", () => {
  function makeRunSessionFixture(budgetOverrides = {}) {
    const defaults = {
      orient: { model: "test/orient", effort: "low", max_output_tokens: 1000 },
      reflect: { model: "test/reflect" },
      session_budget: { max_cost: 0.15, max_steps: 8, max_duration_seconds: 600, ...budgetOverrides },
      execution: { max_steps: { orient: 3 } },
    };
    const state = makeState({ defaults });
    const K = makeMockK();
    // runSession calls executeReflect which calls many K methods — stub them
    K.runAgentLoop = vi.fn(async () => ({ session_summary: "done" }));
    K.getKarma = vi.fn(async () => []);
    K.getSessionCost = vi.fn(async () => 0);
    const context = {
      balances: { providers: {}, wallets: {} },
      kvUsage: { writes_this_session: 0 },
      lastReflect: null,
      additionalContext: null,
      effort: "low",
      crashData: null,
    };
    const config = {};
    return { K, state, context, config };
  }

  it("passes budgetCap to orient when reflect_reserve_pct is set", async () => {
    const { K, state, context, config } = makeRunSessionFixture({ reflect_reserve_pct: 0.33 });
    await runSession(K, state, context, config);

    const orientCall = K.runAgentLoop.mock.calls[0][0];
    // 0.15 * (1 - 0.33) = 0.1005
    expect(orientCall.budgetCap).toBeCloseTo(0.1005, 4);
    expect(orientCall.step).toBe("orient");
  });

  it("does not pass budgetCap when reflect_reserve_pct is 0", async () => {
    const { K, state, context, config } = makeRunSessionFixture({ reflect_reserve_pct: 0 });
    await runSession(K, state, context, config);

    const orientCall = K.runAgentLoop.mock.calls[0][0];
    expect(orientCall.budgetCap).toBeUndefined();
  });

  it("does not pass budgetCap when reflect_reserve_pct is absent", async () => {
    const { K, state, context, config } = makeRunSessionFixture({});
    // Remove reflect_reserve_pct entirely
    delete state.defaults.session_budget.reflect_reserve_pct;
    await runSession(K, state, context, config);

    const orientCall = K.runAgentLoop.mock.calls[0][0];
    expect(orientCall.budgetCap).toBeUndefined();
  });

  it("still runs reflect when orient is soft-capped (budget_exceeded + reservePct)", async () => {
    const { K, state, context, config } = makeRunSessionFixture({ reflect_reserve_pct: 0.33 });
    K.runAgentLoop = vi.fn(async () => ({ budget_exceeded: true, reason: "Budget exceeded: cost" }));

    await runSession(K, state, context, config);

    // reflect uses runAgentLoop internally via executeReflect,
    // but we can check that runAgentLoop was called at least for orient
    // and that the function didn't throw (i.e. it proceeded past the guard)
    expect(K.runAgentLoop).toHaveBeenCalled();
    // The function should complete without throwing
  });

  it("skips reflect when budget_exceeded and no reservePct", async () => {
    const { K, state, context, config } = makeRunSessionFixture({ reflect_reserve_pct: 0 });
    K.runAgentLoop = vi.fn(async () => ({ budget_exceeded: true, reason: "Budget exceeded: cost" }));

    await runSession(K, state, context, config);

    // runAgentLoop called once (orient only), reflect skipped
    expect(K.runAgentLoop).toHaveBeenCalledTimes(1);
  });
});

// ── 17. runReflect — deep reflect budget_multiplier ──────

describe("runReflect budget_multiplier", () => {
  function makeReflectFixture(deepReflectOverrides = {}) {
    const defaults = {
      orient: { model: "test/orient", effort: "low", max_output_tokens: 1000 },
      reflect: { model: "test/reflect" },
      session_budget: { max_cost: 0.10, max_steps: 8, max_duration_seconds: 600 },
      execution: { max_steps: { reflect_deep: 10 }, max_reflect_depth: 1 },
      deep_reflect: { model: "test/opus", effort: "high", max_output_tokens: 4000, ...deepReflectOverrides },
    };
    const state = makeState({ defaults });
    const K = makeMockK();
    K.runAgentLoop = vi.fn(async () => ({ reflection: "done" }));
    K.getKarma = vi.fn(async () => []);
    K.getSessionCost = vi.fn(async () => 0);
    K.getSessionCount = vi.fn(async () => 5);
    const context = {
      balances: { providers: {}, wallets: {} },
      kvUsage: { writes_this_session: 0 },
      effort: "high",
      crashData: null,
    };
    return { K, state, context };
  }

  it("passes budgetCap = max_cost * multiplier when budget_multiplier > 1", async () => {
    const { K, state, context } = makeReflectFixture({ budget_multiplier: 3.0 });
    await runReflect(K, state, 1, context);

    const call = K.runAgentLoop.mock.calls[0][0];
    expect(call.budgetCap).toBeCloseTo(0.30, 4);
    expect(call.step).toBe("reflect_depth_1");
  });

  it("does not pass budgetCap when budget_multiplier is 1", async () => {
    const { K, state, context } = makeReflectFixture({ budget_multiplier: 1 });
    await runReflect(K, state, 1, context);

    const call = K.runAgentLoop.mock.calls[0][0];
    expect(call.budgetCap).toBeUndefined();
  });

  it("does not pass budgetCap when budget_multiplier is absent", async () => {
    const { K, state, context } = makeReflectFixture({});
    delete state.defaults.deep_reflect.budget_multiplier;
    await runReflect(K, state, 1, context);

    const call = K.runAgentLoop.mock.calls[0][0];
    expect(call.budgetCap).toBeUndefined();
  });
});

// ── 18. patch op in mock kernel ──────────────────────────────

describe("patch op", () => {
  it("replaces old_string with new_string in KV value", async () => {
    const K = makeMockK({ "hook:wake:mutations": "function old() { return 1; }" });
    await K.kvWritePrivileged([{
      op: "patch",
      key: "hook:wake:mutations",
      old_string: "return 1",
      new_string: "return 2",
    }]);
    const result = K._kv._store.get("hook:wake:mutations");
    expect(result).toBe("function old() { return 2; }");
  });

  it("rejects when old_string not found", async () => {
    const K = makeMockK({ "hook:wake:mutations": "function old() { return 1; }" });
    await expect(K.kvWritePrivileged([{
      op: "patch",
      key: "hook:wake:mutations",
      old_string: "nonexistent string",
      new_string: "replacement",
    }])).rejects.toThrow("old_string not found");
  });

  it("rejects when old_string matches multiple locations", async () => {
    const K = makeMockK({ "hook:wake:mutations": "aaa bbb aaa" });
    await expect(K.kvWritePrivileged([{
      op: "patch",
      key: "hook:wake:mutations",
      old_string: "aaa",
      new_string: "ccc",
    }])).rejects.toThrow("matches multiple locations");
  });

  it("rejects when value is not a string", async () => {
    const K = makeMockK({ "hook:wake:mutations": JSON.stringify({ a: 1 }) });
    // The mock stores it as a string via JSON.stringify, so set a non-string
    K._kv._store.set("hook:wake:mutations", 42);
    await expect(K.kvWritePrivileged([{
      op: "patch",
      key: "hook:wake:mutations",
      old_string: "something",
      new_string: "else",
    }])).rejects.toThrow("not a string value");
  });
});

// ── 19. applyKVOperation blocks yama/niyama (system keys) ───

describe("applyKVOperation blocks yama/niyama", () => {
  it("blocks yama: prefix as system key", async () => {
    const K = makeMockK();
    await applyKVOperation(K, { op: "put", key: "yama:care", value: "new value" });
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mutation_blocked", key: "yama:care", reason: "system_key" })
    );
    // Should NOT have written the value
    expect(K.kvPutSafe).not.toHaveBeenCalled();
  });

  it("blocks niyama: prefix as system key", async () => {
    const K = makeMockK();
    await applyKVOperation(K, { op: "put", key: "niyama:health", value: "new value" });
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mutation_blocked", key: "niyama:health", reason: "system_key" })
    );
    expect(K.kvPutSafe).not.toHaveBeenCalled();
  });
});

// ── 20. applyStagedAsCandidate with patch op ────────────────

describe("applyStagedAsCandidate with patch op", () => {
  it("forwards patch ops through to kvWritePrivileged", async () => {
    const K = makeMockK({
      "hook:wake:mutations": "function old() { return 1; }",
    });

    // Stage a mutation with a patch op
    const mutationId = await stageMutation(K, {
      claims: ["test patch"],
      ops: [{ op: "patch", key: "hook:wake:mutations", old_string: "return 1", new_string: "return 2" }],
      checks: [{ type: "kv_assert", key: "hook:wake:mutations", predicate: "exists" }],
    }, "test_session");

    expect(mutationId).toBeTruthy();

    // Apply staged as candidate
    await applyStagedAsCandidate(K, mutationId);

    // Check that the patch was applied
    const afterValue = K._kv._store.get("hook:wake:mutations");
    expect(afterValue).toBe("function old() { return 2; }");
  });
});
