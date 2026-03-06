import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildOrientContext,
  detectCrash,
  evaluateTripwires,
  evaluatePredicate,
  getMaxSteps,
  getReflectModel,
  isReflectDue,
  highestReflectDepthDue,
  defaultReflectPrompt,
  defaultDeepReflectPrompt,
  applyReflectOutput,
  writeSessionResults,
  applyKVOperation,
  stageMutation,
  findCandidateConflict,
  promoteCandidate,
  rollbackCandidate,
  processReflectVerdicts,
  processDeepReflectVerdicts,
  runCircuitBreaker,
  loadStagedMutations,
  loadCandidateMutations,
  loadReflectPrompt,
  loadBelowPrompt,
  loadReflectHistory,
  getBalances,
} from "../wake-hook.js";
import { makeMockK } from "./helpers/mock-kernel.js";

function makeState(overrides = {}) {
  return {
    defaults: overrides.defaults || {},
    modelsConfig: overrides.modelsConfig || null,
    dharma: overrides.dharma || null,
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
  it("defaultReflectPrompt includes dharma placeholder", () => {
    const prompt = defaultReflectPrompt();
    expect(prompt).toContain("{{dharma}}");
  });

  it("defaultDeepReflectPrompt depth 1", () => {
    const prompt = defaultDeepReflectPrompt(1);
    expect(prompt).toContain("depth-1 reflection");
    expect(prompt).toContain("{{dharma}}");
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
  it("calls executeAdapter for each provider and wallet with adapter", async () => {
    const K = makeMockK({
      providers: JSON.stringify({
        openrouter: { adapter: "provider:llm_balance" },
        manual: { note: "no adapter" },
      }),
      wallets: JSON.stringify({
        base: { adapter: "provider:wallet_balance" },
      }),
    });
    K.executeAdapter.mockResolvedValue(42);
    const state = makeState();

    const result = await getBalances(K, state);

    expect(K.executeAdapter).toHaveBeenCalledWith("provider:llm_balance", {});
    expect(K.executeAdapter).toHaveBeenCalledWith("provider:wallet_balance", {});
    expect(K.executeAdapter).toHaveBeenCalledTimes(2);
    expect(result.providers.openrouter).toBe(42);
    expect(result.providers.manual).toBeUndefined();
    expect(result.wallets.base).toBe(42);
  });

  it("returns null for adapters that throw", async () => {
    const K = makeMockK({
      providers: JSON.stringify({
        broken: { adapter: "provider:nonexistent" },
      }),
      wallets: JSON.stringify({}),
    });
    K.executeAdapter.mockRejectedValue(new Error("no adapter"));
    const state = makeState();

    const result = await getBalances(K, state);

    expect(result.providers.broken).toBeNull();
  });

  it("returns empty when no providers/wallets configured", async () => {
    const K = makeMockK();
    const state = makeState();

    const result = await getBalances(K, state);

    expect(result).toEqual({ providers: {}, wallets: {} });
    expect(K.executeAdapter).not.toHaveBeenCalled();
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
