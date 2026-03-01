import { describe, it, expect, vi, beforeEach } from "vitest";
import { Brainstem } from "../brainstem.js";

// ── Test helpers ──────────────────────────────────────────────

function makeKVStore(initial = {}) {
  const store = new Map(Object.entries(initial));
  const metaStore = new Map();

  return {
    get: vi.fn(async (key, format) => {
      const val = store.get(key) ?? null;
      if (val === null) return null;
      if (format === "json") {
        return typeof val === "string" ? JSON.parse(val) : val;
      }
      return typeof val === "string" ? val : JSON.stringify(val);
    }),
    put: vi.fn(async (key, value, opts) => {
      store.set(key, value);
      if (opts?.metadata) metaStore.set(key, opts.metadata);
    }),
    delete: vi.fn(async (key) => {
      store.delete(key);
      metaStore.delete(key);
    }),
    list: vi.fn(async () => ({
      keys: [...store.keys()].map((name) => ({
        name,
        metadata: metaStore.get(name) || null,
      })),
    })),
    getWithMetadata: vi.fn(async (key, format) => {
      const val = store.get(key) ?? null;
      return { value: val, metadata: metaStore.get(key) || null };
    }),
    // Expose internals for assertions
    _store: store,
    _meta: metaStore,
  };
}

function makeEnv(kvInit = {}) {
  return { KV: makeKVStore(kvInit) };
}

function makeBrain(kvInit = {}, opts = {}) {
  const env = makeEnv(kvInit);
  const brain = new Brainstem(env);
  brain.defaults = opts.defaults || {};
  brain.toolRegistry = opts.toolRegistry || null;
  brain.modelsConfig = opts.modelsConfig || null;
  brain.soul = opts.soul || null;
  return { brain, env };
}

// ── 1. parseAgentOutput ─────────────────────────────────────

describe("parseAgentOutput", () => {
  it("returns parsed object for valid JSON", () => {
    const { brain } = makeBrain();
    const result = brain.parseAgentOutput('{"key":"value","n":42}');
    expect(result).toEqual({ key: "value", n: 42 });
  });

  it("returns { raw } for invalid JSON", () => {
    const { brain } = makeBrain();
    const result = brain.parseAgentOutput("not json at all");
    expect(result).toEqual({ raw: "not json at all" });
  });

  it("returns {} for empty/null content", () => {
    const { brain } = makeBrain();
    expect(brain.parseAgentOutput(null)).toEqual({});
    expect(brain.parseAgentOutput("")).toEqual({});
    expect(brain.parseAgentOutput(undefined)).toEqual({});
  });
});

// ── 2. buildOrientContext ───────────────────────────────────

describe("buildOrientContext", () => {
  it("returns JSON string with all expected keys", () => {
    const { brain } = makeBrain();
    const context = {
      balances: { providers: {}, wallets: {} },
      kvUsage: { writes_this_session: 0 },
      lastReflect: { session_summary: "test" },
      additionalContext: { foo: "bar" },
      kvIndex: [{ key: "a", metadata: null }],
      effort: "medium",
      crashData: null,
    };
    const result = JSON.parse(brain.buildOrientContext(context));
    expect(result).toHaveProperty("balances");
    expect(result).toHaveProperty("kv_usage");
    expect(result).toHaveProperty("last_reflect");
    expect(result).toHaveProperty("additional_context");
    expect(result).toHaveProperty("kv_index");
    expect(result).toHaveProperty("effort");
    expect(result).toHaveProperty("crash_data");
    expect(result.effort).toBe("medium");
    expect(result.crash_data).toBeNull();
  });
});

// ── 3. buildToolDefinitions ─────────────────────────────────

describe("buildToolDefinitions", () => {
  it("maps registry tools to OpenAI format", () => {
    const { brain } = makeBrain({}, {
      toolRegistry: {
        tools: [
          { name: "web_fetch", description: "Fetch a URL", input: { url: "The URL to fetch" } },
          { name: "kv_read", description: "Read KV", input: { key: "KV key" } },
        ],
      },
    });
    const defs = brain.buildToolDefinitions();
    expect(defs.length).toBe(3); // 2 tools + spawn_subplan
    expect(defs[0]).toEqual({
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to fetch" },
          },
        },
      },
    });
  });

  it("always includes spawn_subplan", () => {
    const { brain } = makeBrain({}, { toolRegistry: { tools: [] } });
    const defs = brain.buildToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].function.name).toBe("spawn_subplan");
  });

  it("handles missing/null registry", () => {
    const { brain } = makeBrain();
    brain.toolRegistry = null;
    const defs = brain.buildToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].function.name).toBe("spawn_subplan");
  });

  it("passes through extraTools", () => {
    const { brain } = makeBrain({}, { toolRegistry: { tools: [] } });
    const extra = { type: "function", function: { name: "custom" } };
    const defs = brain.buildToolDefinitions([extra]);
    expect(defs.length).toBe(2);
    expect(defs[1]).toBe(extra);
  });
});

// ── 4. getMaxSteps ──────────────────────────────────────────

describe("getMaxSteps", () => {
  it("returns execution config for orient", () => {
    const { brain } = makeBrain({}, {
      defaults: { execution: { max_steps: { orient: 7 } } },
    });
    expect(brain.getMaxSteps("orient")).toBe(7);
  });

  it("returns default 3 for orient when not configured", () => {
    const { brain } = makeBrain();
    expect(brain.getMaxSteps("orient")).toBe(3);
  });

  it("returns reflect_default for depth 1", () => {
    const { brain } = makeBrain({}, {
      defaults: { execution: { max_steps: { reflect_default: 8 } } },
    });
    expect(brain.getMaxSteps("reflect", 1)).toBe(8);
  });

  it("returns default 5 for depth 1 when not configured", () => {
    const { brain } = makeBrain();
    expect(brain.getMaxSteps("reflect", 1)).toBe(5);
  });

  it("returns reflect_deep for depth > 1", () => {
    const { brain } = makeBrain({}, {
      defaults: { execution: { max_steps: { reflect_deep: 15 } } },
    });
    expect(brain.getMaxSteps("reflect", 2)).toBe(15);
  });

  it("returns default 10 for depth > 1 when not configured", () => {
    const { brain } = makeBrain();
    expect(brain.getMaxSteps("reflect", 3)).toBe(10);
  });

  it("uses per-level override via reflect_levels", () => {
    const { brain } = makeBrain({}, {
      defaults: {
        reflect_levels: { 2: { max_steps: 25 } },
        execution: { max_steps: { reflect_deep: 15 } },
      },
    });
    expect(brain.getMaxSteps("reflect", 2)).toBe(25);
  });
});

// ── 5. getReflectModel ──────────────────────────────────────

describe("getReflectModel", () => {
  it("uses per-level override", () => {
    const { brain } = makeBrain({}, {
      defaults: {
        reflect_levels: { 2: { model: "opus" } },
        deep_reflect: { model: "sonnet" },
        orient: { model: "haiku" },
      },
    });
    expect(brain.getReflectModel(2)).toBe("opus");
  });

  it("falls back to deep_reflect.model", () => {
    const { brain } = makeBrain({}, {
      defaults: {
        deep_reflect: { model: "sonnet" },
        orient: { model: "haiku" },
      },
    });
    expect(brain.getReflectModel(1)).toBe("sonnet");
  });

  it("falls back to orient.model", () => {
    const { brain } = makeBrain({}, {
      defaults: { orient: { model: "haiku" } },
    });
    expect(brain.getReflectModel(1)).toBe("haiku");
  });

  it("returns undefined when nothing configured", () => {
    const { brain } = makeBrain();
    expect(brain.getReflectModel(1)).toBeUndefined();
  });
});

// ── 6. loadReflectPrompt ────────────────────────────────────

describe("loadReflectPrompt", () => {
  it("returns depth-specific prompt from KV", async () => {
    const { brain } = makeBrain({
      "prompt:reflect:2": JSON.stringify("depth-2 prompt"),
    });
    const result = await brain.loadReflectPrompt(2);
    expect(result).toBe("depth-2 prompt");
  });

  it("falls back to prompt:deep for depth 1", async () => {
    const { brain } = makeBrain({
      "prompt:deep": JSON.stringify("deep prompt"),
    });
    const result = await brain.loadReflectPrompt(1);
    expect(result).toBe("deep prompt");
  });

  it("falls back to hardcoded defaultDeepReflectPrompt", async () => {
    const { brain } = makeBrain();
    const result = await brain.loadReflectPrompt(1);
    expect(result).toContain("depth-1 reflection");
  });

  it("does NOT fall back to prompt:deep for depth > 1", async () => {
    const { brain } = makeBrain({
      "prompt:deep": JSON.stringify("deep prompt"),
    });
    const result = await brain.loadReflectPrompt(3);
    // Should get the hardcoded default, not "deep prompt"
    expect(result).toContain("depth-3 reflection");
  });
});

// ── 7. isReflectDue ─────────────────────────────────────────

describe("isReflectDue", () => {
  it("cold-start: depth 1 due at session 20 (baseInterval)", async () => {
    const { brain } = makeBrain({
      session_counter: JSON.stringify(20),
    }, {
      defaults: { deep_reflect: { default_interval_sessions: 20 } },
    });
    const due = await brain.isReflectDue(1);
    expect(due).toBe(true);
  });

  it("cold-start: depth 1 NOT due below threshold", async () => {
    const { brain } = makeBrain({
      session_counter: JSON.stringify(19),
    }, {
      defaults: { deep_reflect: { default_interval_sessions: 20 } },
    });
    const due = await brain.isReflectDue(1);
    expect(due).toBe(false);
  });

  it("cold-start: depth 2 uses exponential formula", async () => {
    const { brain } = makeBrain({
      session_counter: JSON.stringify(100),
    }, {
      defaults: {
        deep_reflect: { default_interval_sessions: 20 },
        execution: { reflect_interval_multiplier: 5 },
      },
    });
    // threshold = 20 * 5^(2-1) = 100
    const due = await brain.isReflectDue(2);
    expect(due).toBe(true);
  });

  it("cold-start: depth 2 NOT due below exponential threshold", async () => {
    const { brain } = makeBrain({
      session_counter: JSON.stringify(99),
    }, {
      defaults: {
        deep_reflect: { default_interval_sessions: 20 },
        execution: { reflect_interval_multiplier: 5 },
      },
    });
    const due = await brain.isReflectDue(2);
    expect(due).toBe(false);
  });

  it("self-scheduled: due when sessionsSince >= after_sessions", async () => {
    const { brain } = makeBrain({
      "reflect:schedule:1": JSON.stringify({
        after_sessions: 10,
        after_days: 999,
        last_reflect_session: 5,
        last_reflect: new Date().toISOString(),
      }),
      session_counter: JSON.stringify(15),
    }, {
      defaults: { deep_reflect: { default_interval_sessions: 20 } },
    });
    const due = await brain.isReflectDue(1);
    expect(due).toBe(true);
  });

  it("self-scheduled: NOT due when below both thresholds", async () => {
    const { brain } = makeBrain({
      "reflect:schedule:1": JSON.stringify({
        after_sessions: 10,
        after_days: 999,
        last_reflect_session: 12,
        last_reflect: new Date().toISOString(),
      }),
      session_counter: JSON.stringify(15),
    }, {
      defaults: { deep_reflect: { default_interval_sessions: 20 } },
    });
    const due = await brain.isReflectDue(1);
    expect(due).toBe(false);
  });

  it("backward compat: depth 1 reads deep_reflect_schedule", async () => {
    const { brain } = makeBrain({
      deep_reflect_schedule: JSON.stringify({
        after_sessions: 5,
        after_days: 999,
        last_deep_reflect_session: 10,
        last_deep_reflect: new Date().toISOString(),
      }),
      session_counter: JSON.stringify(15),
    }, {
      defaults: { deep_reflect: { default_interval_sessions: 20 } },
    });
    const due = await brain.isReflectDue(1);
    expect(due).toBe(true);
  });
});

// ── 8. highestReflectDepthDue ───────────────────────────────

describe("highestReflectDepthDue", () => {
  it("returns highest due depth", async () => {
    const { brain } = makeBrain({
      session_counter: JSON.stringify(100),
    }, {
      defaults: {
        execution: { max_reflect_depth: 2, reflect_interval_multiplier: 5 },
        deep_reflect: { default_interval_sessions: 20 },
      },
    });
    // depth 2 threshold = 20 * 5 = 100, depth 1 threshold = 20
    const result = await brain.highestReflectDepthDue();
    expect(result).toBe(2);
  });

  it("returns 0 when none due", async () => {
    const { brain } = makeBrain({
      session_counter: JSON.stringify(5),
    }, {
      defaults: {
        execution: { max_reflect_depth: 2, reflect_interval_multiplier: 5 },
        deep_reflect: { default_interval_sessions: 20 },
      },
    });
    const result = await brain.highestReflectDepthDue();
    expect(result).toBe(0);
  });

  it("returns depth 1 when only depth 1 is due", async () => {
    const { brain } = makeBrain({
      session_counter: JSON.stringify(25),
    }, {
      defaults: {
        execution: { max_reflect_depth: 2, reflect_interval_multiplier: 5 },
        deep_reflect: { default_interval_sessions: 20 },
      },
    });
    const result = await brain.highestReflectDepthDue();
    expect(result).toBe(1);
  });
});

// ── 9. callLLM ──────────────────────────────────────────────

describe("callLLM", () => {
  function makeLLMBrain(response = {}) {
    const { brain, env } = makeBrain();
    const defaultResponse = {
      ok: true,
      tier: "hardcoded",
      content: '{"result":"ok"}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolCalls: null,
    };
    brain.callWithCascade = vi.fn(async () => ({ ...defaultResponse, ...response }));
    brain.estimateCost = vi.fn(() => 0.001);
    return { brain, env };
  }

  it("prepends system message when systemPrompt provided", async () => {
    const { brain } = makeLLMBrain();
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful",
      step: "test",
    });

    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.messages[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(call.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("does not prepend system message when no systemPrompt", async () => {
    const { brain } = makeLLMBrain();
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      step: "test",
    });

    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.messages.length).toBe(1);
    expect(call.messages[0].role).toBe("user");
  });

  it("passes tools in request", async () => {
    const { brain } = makeLLMBrain();
    const tools = [{ type: "function", function: { name: "test" } }];
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools,
      step: "test",
    });

    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.tools).toEqual(tools);
  });

  it("returns toolCalls from response", async () => {
    const toolCalls = [{ id: "tc1", function: { name: "test", arguments: "{}" } }];
    const { brain } = makeLLMBrain({ toolCalls });
    const result = await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("retries with fallback model on failure", async () => {
    const { brain } = makeBrain({}, {
      modelsConfig: { fallback_model: "anthropic/claude-haiku-4.5" },
    });
    let callCount = 0;
    brain.callWithCascade = vi.fn(async (request) => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, error: "provider down", tier: "all_failed" };
      }
      return {
        ok: true, tier: "hardcoded",
        content: "fallback worked",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    });
    brain.estimateCost = vi.fn(() => 0.0001);

    const result = await brain.callLLM({
      model: "expensive-model",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });

    expect(callCount).toBe(2);
    // Second call should use fallback model
    const secondCall = brain.callWithCascade.mock.calls[1][0];
    expect(secondCall.model).toBe("anthropic/claude-haiku-4.5");
  });
});

// ── 10. runAgentLoop ────────────────────────────────────────

describe("runAgentLoop", () => {
  it("immediate text response (1 turn)", async () => {
    const { brain } = makeBrain();
    brain.callLLM = vi.fn(async () => ({
      content: '{"answer":"42"}',
      cost: 0.01,
      toolCalls: null,
    }));

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "what is the answer?",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 3,
      step: "test",
    });

    expect(result).toEqual({ answer: "42" });
    expect(brain.callLLM).toHaveBeenCalledTimes(1);
  });

  it("tool call → result → final text (2 turns)", async () => {
    const { brain } = makeBrain();
    let turn = 0;
    brain.callLLM = vi.fn(async () => {
      turn++;
      if (turn === 1) {
        return {
          content: null,
          cost: 0.005,
          toolCalls: [{
            id: "tc1",
            function: { name: "test_tool", arguments: '{"key":"val"}' },
          }],
        };
      }
      return {
        content: '{"done":true}',
        cost: 0.005,
        toolCalls: null,
      };
    });
    brain.executeToolCall = vi.fn(async () => ({ result: "tool output" }));

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "do something",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });

    expect(result).toEqual({ done: true });
    expect(brain.callLLM).toHaveBeenCalledTimes(2);
    expect(brain.executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("max steps forces final output", async () => {
    const { brain } = makeBrain();
    brain.callLLM = vi.fn(async () => ({
      content: null,
      cost: 0.005,
      toolCalls: [{
        id: "tc1",
        function: { name: "looping_tool", arguments: "{}" },
      }],
    }));
    brain.executeToolCall = vi.fn(async () => ({ result: "ok" }));

    // After maxSteps tool calls, the loop appends a "max steps reached"
    // message and makes one more LLM call without tools.
    // Override callLLM to return text on that final call.
    let callCount = 0;
    brain.callLLM = vi.fn(async ({ step }) => {
      callCount++;
      if (step?.endsWith("_final")) {
        return { content: '{"forced":true}', cost: 0.001, toolCalls: null };
      }
      return {
        content: null,
        cost: 0.001,
        toolCalls: [{ id: `tc${callCount}`, function: { name: "tool", arguments: "{}" } }],
      };
    });

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "loop",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 2,
      step: "test",
    });

    expect(result).toEqual({ forced: true });
    // 2 tool-call turns + 1 final = 3 calls
    expect(brain.callLLM).toHaveBeenCalledTimes(3);
  });

  it("parallel tool execution", async () => {
    const { brain } = makeBrain();
    let turn = 0;
    brain.callLLM = vi.fn(async () => {
      turn++;
      if (turn === 1) {
        return {
          content: null,
          cost: 0.005,
          toolCalls: [
            { id: "tc1", function: { name: "tool_a", arguments: "{}" } },
            { id: "tc2", function: { name: "tool_b", arguments: "{}" } },
          ],
        };
      }
      return { content: '{"done":true}', cost: 0.005, toolCalls: null };
    });

    const executedTools = [];
    brain.executeToolCall = vi.fn(async (tc) => {
      executedTools.push(tc.function.name);
      return { ok: true };
    });

    await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "parallel",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });

    expect(executedTools).toContain("tool_a");
    expect(executedTools).toContain("tool_b");
  });

  it("accumulates sessionCost", async () => {
    const { brain } = makeBrain();
    brain.sessionCost = 0;
    brain.callLLM = vi.fn(async () => ({
      content: '{"ok":true}',
      cost: 0.05,
      toolCalls: null,
    }));

    await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "cost test",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 3,
      step: "test",
    });

    expect(brain.sessionCost).toBe(0.05);
  });
});

// ── 11. executeToolCall ─────────────────────────────────────

describe("executeToolCall", () => {
  it("routes spawn_subplan to spawnSubplan", async () => {
    const { brain } = makeBrain();
    brain.spawnSubplan = vi.fn(async (args) => ({ subplan: true, goal: args.goal }));

    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "spawn_subplan", arguments: '{"goal":"test goal"}' },
    });

    expect(brain.spawnSubplan).toHaveBeenCalledWith({ goal: "test goal" });
    expect(result).toEqual({ subplan: true, goal: "test goal" });
  });

  it("routes other tools to executeAction", async () => {
    const { brain } = makeBrain();
    brain.executeAction = vi.fn(async (step) => ({ tool_result: step.tool }));

    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "web_fetch", arguments: '{"url":"https://example.com"}' },
    });

    expect(brain.executeAction).toHaveBeenCalledWith({
      tool: "web_fetch",
      input: { url: "https://example.com" },
      id: "tc1",
    });
    expect(result).toEqual({ tool_result: "web_fetch" });
  });

  it("parses string arguments", async () => {
    const { brain } = makeBrain();
    brain.executeAction = vi.fn(async () => ({}));

    await brain.executeToolCall({
      id: "tc1",
      function: { name: "test", arguments: '{"a":1,"b":"two"}' },
    });

    expect(brain.executeAction).toHaveBeenCalledWith({
      tool: "test",
      input: { a: 1, b: "two" },
      id: "tc1",
    });
  });

  it("handles object arguments (already parsed)", async () => {
    const { brain } = makeBrain();
    brain.executeAction = vi.fn(async () => ({}));

    await brain.executeToolCall({
      id: "tc1",
      function: { name: "test", arguments: { x: 99 } },
    });

    expect(brain.executeAction).toHaveBeenCalledWith({
      tool: "test",
      input: { x: 99 },
      id: "tc1",
    });
  });
});

// ── 12. applyReflectOutput ──────────────────────────────────

describe("applyReflectOutput", () => {
  function makeReflectBrain() {
    const { brain, env } = makeBrain();
    brain.sessionId = "test_session";
    brain.applyKVOperation = vi.fn(async () => {});
    brain.processDeepReflectVerdicts = vi.fn(async () => {});
    brain.applyDirectAsCandidate = vi.fn(async () => "m_123");
    brain.karmaRecord = vi.fn(async () => {});
    brain.getSessionCount = vi.fn(async () => 42);
    // kvPut needs to work for storing reflect output
    brain.kvPut = vi.fn(async () => {});
    brain.kvGet = vi.fn(async (key) => {
      if (key === "config:defaults") return { some: "defaults" };
      return null;
    });
    return { brain, env };
  }

  it("applies kv_operations", async () => {
    const { brain } = makeReflectBrain();
    const output = {
      reflection: "test",
      kv_operations: [
        { op: "put", key: "test_key", value: "test_val" },
      ],
    };

    await brain.applyReflectOutput(1, output, {});
    expect(brain.applyKVOperation).toHaveBeenCalledWith(output.kv_operations[0]);
  });

  it("processes verdicts BEFORE mutation_requests", async () => {
    const { brain } = makeReflectBrain();
    const callOrder = [];
    brain.processDeepReflectVerdicts = vi.fn(async () => { callOrder.push("verdicts"); });
    brain.applyDirectAsCandidate = vi.fn(async () => { callOrder.push("mutations"); return "m_1"; });

    const output = {
      reflection: "test",
      mutation_verdicts: [{ verdict: "promote", mutation_id: "m_old" }],
      mutation_requests: [{ claims: ["a"], ops: [{ op: "put" }], checks: [] }],
    };

    await brain.applyReflectOutput(1, output, {});
    expect(callOrder).toEqual(["verdicts", "mutations"]);
  });

  it("writes schedule to reflect:schedule:N", async () => {
    const { brain } = makeReflectBrain();
    const output = {
      reflection: "test",
      next_reflect: { after_sessions: 30, after_days: 14 },
    };

    await brain.applyReflectOutput(2, output, {});

    const putCalls = brain.kvPut.mock.calls;
    const schedulePut = putCalls.find(([key]) => key === "reflect:schedule:2");
    expect(schedulePut).toBeTruthy();
    const scheduleData = schedulePut[1];
    expect(scheduleData.after_sessions).toBe(30);
    expect(scheduleData.after_days).toBe(14);
    expect(scheduleData).toHaveProperty("last_reflect");
    expect(scheduleData.last_reflect_session).toBe(42);
  });

  it("stores history at reflect:N:sessionId", async () => {
    const { brain } = makeReflectBrain();
    const output = {
      reflection: "deep thoughts",
      note_to_future_self: "remember this",
    };

    await brain.applyReflectOutput(2, output, {});

    const putCalls = brain.kvPut.mock.calls;
    const historyPut = putCalls.find(([key]) => key === "reflect:2:test_session");
    expect(historyPut).toBeTruthy();
    const historyData = historyPut[1];
    expect(historyData.reflection).toBe("deep thoughts");
    expect(historyData.note_to_future_self).toBe("remember this");
    expect(historyData.depth).toBe(2);
    expect(historyData.session_id).toBe("test_session");
  });

  it("depth 1 writes last_reflect + wake_config", async () => {
    const { brain } = makeReflectBrain();
    const output = {
      reflection: "depth 1 reflection",
      note_to_future_self: "keep going",
      next_wake_config: { sleep_seconds: 3600, effort: "low" },
    };

    await brain.applyReflectOutput(1, output, {});

    const putCalls = brain.kvPut.mock.calls;
    const lastReflect = putCalls.find(([key]) => key === "last_reflect");
    expect(lastReflect).toBeTruthy();
    expect(lastReflect[1].was_deep_reflect).toBe(true);
    expect(lastReflect[1].depth).toBe(1);

    const wakeConfig = putCalls.find(([key]) => key === "wake_config");
    expect(wakeConfig).toBeTruthy();
    expect(wakeConfig[1].sleep_seconds).toBe(3600);
    expect(wakeConfig[1]).toHaveProperty("next_wake_after");
  });

  it("depth > 1 does NOT write last_reflect or wake_config", async () => {
    const { brain } = makeReflectBrain();
    const output = {
      reflection: "depth 2 reflection",
      note_to_future_self: "meta thoughts",
      next_wake_config: { sleep_seconds: 3600 },
    };

    await brain.applyReflectOutput(2, output, {});

    const putCalls = brain.kvPut.mock.calls;
    const lastReflect = putCalls.find(([key]) => key === "last_reflect");
    expect(lastReflect).toBeUndefined();
    const wakeConfig = putCalls.find(([key]) => key === "wake_config");
    expect(wakeConfig).toBeUndefined();
  });

  it("refreshes this.defaults after apply", async () => {
    const { brain } = makeReflectBrain();
    brain.kvGet = vi.fn(async (key) => {
      if (key === "config:defaults") return { refreshed: true };
      return null;
    });

    await brain.applyReflectOutput(1, { reflection: "test" }, {});
    expect(brain.defaults).toEqual({ refreshed: true });
  });

  it("depth 1 also writes deep_reflect_schedule for backward compat", async () => {
    const { brain } = makeReflectBrain();
    const output = {
      reflection: "test",
      next_reflect: { after_sessions: 15 },
    };

    await brain.applyReflectOutput(1, output, {});

    const putCalls = brain.kvPut.mock.calls;
    const legacySchedule = putCalls.find(([key]) => key === "deep_reflect_schedule");
    expect(legacySchedule).toBeTruthy();
    expect(legacySchedule[1]).toHaveProperty("last_deep_reflect");
    expect(legacySchedule[1]).toHaveProperty("last_deep_reflect_session");
  });

  it("handles next_deep_reflect alias for schedule", async () => {
    const { brain } = makeReflectBrain();
    const output = {
      reflection: "test",
      next_deep_reflect: { after_sessions: 25 },
    };

    await brain.applyReflectOutput(2, output, {});

    const putCalls = brain.kvPut.mock.calls;
    const schedulePut = putCalls.find(([key]) => key === "reflect:schedule:2");
    expect(schedulePut).toBeTruthy();
    expect(schedulePut[1].after_sessions).toBe(25);
  });
});
