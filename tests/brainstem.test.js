import { describe, it, expect, vi, beforeEach } from "vitest";
import { Brainstem } from "../brainstem.js";
import { makeKVStore } from "./helpers/mock-kv.js";

// ── Test helpers ──────────────────────────────────────────────

function makeEnv(kvInit = {}) {
  return { KV: makeKVStore(kvInit) };
}

function makeBrain(kvInit = {}, opts = {}) {
  const env = makeEnv(kvInit);
  const brain = new Brainstem(env);
  brain.defaults = opts.defaults || {};
  brain.toolRegistry = opts.toolRegistry || null;
  brain.modelsConfig = opts.modelsConfig || null;
  brain.dharma = opts.dharma || null;
  return { brain, env };
}

// ── 1. parseAgentOutput ─────────────────────────────────────

describe("parseAgentOutput", () => {
  it("returns parsed object for valid JSON", async () => {
    const { brain } = makeBrain();
    const result = await brain.parseAgentOutput('{"key":"value","n":42}');
    expect(result).toEqual({ key: "value", n: 42 });
  });

  it("returns { parse_error, raw } for invalid JSON (no hook)", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => null);
    const result = await brain.parseAgentOutput("not json at all");
    expect(result).toEqual({ parse_error: true, raw: "not json at all" });
  });

  it("returns {} for empty/null content", async () => {
    const { brain } = makeBrain();
    expect(await brain.parseAgentOutput(null)).toEqual({});
    expect(await brain.parseAgentOutput("")).toEqual({});
    expect(await brain.parseAgentOutput(undefined)).toEqual({});
  });

  it("calls parse_repair hook on failure", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => ({ content: '{"fixed":true}' }));
    const result = await brain.parseAgentOutput("not json");
    expect(result).toEqual({ fixed: true });
    expect(brain.callHook).toHaveBeenCalledWith("parse_repair", { content: "not json" });
  });

  it("returns parse_error when hook returns bad JSON", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => ({ content: "still bad" }));
    const result = await brain.parseAgentOutput("not json");
    expect(result).toEqual({ parse_error: true, raw: "not json" });
  });

  it("extracts JSON from markdown code fences", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => null);
    const result = await brain.parseAgentOutput('```json\n{"key":"value"}\n```');
    expect(result).toEqual({ key: "value" });
    expect(brain.callHook).not.toHaveBeenCalled();
  });

  it("extracts JSON from prose with surrounding text", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => null);
    const result = await brain.parseAgentOutput('Here is my output:\n{"key":"value"}\nDone.');
    expect(result).toEqual({ key: "value" });
  });
});

// ── 1b. _extractJSON ─────────────────────────────────────────

describe("_extractJSON", () => {
  const { brain } = makeBrain();

  it("returns null for null/undefined/empty", () => {
    expect(brain._extractJSON(null)).toBeNull();
    expect(brain._extractJSON(undefined)).toBeNull();
    expect(brain._extractJSON("")).toBeNull();
  });

  it("extracts from ```json fences", () => {
    expect(brain._extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts from bare ``` fences", () => {
    expect(brain._extractJSON('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts object from surrounding prose", () => {
    expect(brain._extractJSON('Here is the result:\n{"a":1,"b":"two"}\nEnd.')).toEqual({ a: 1, b: "two" });
  });

  it("extracts array from surrounding prose", () => {
    expect(brain._extractJSON('Result: [1,2,3] done')).toEqual([1, 2, 3]);
  });

  it("handles nested braces", () => {
    expect(brain._extractJSON('```json\n{"a":{"b":{"c":1}}}\n```')).toEqual({ a: { b: { c: 1 } } });
  });

  it("handles braces inside strings", () => {
    expect(brain._extractJSON('{"msg":"use {curly} braces","n":1}')).toEqual({ msg: "use {curly} braces", n: 1 });
  });

  it("handles escaped quotes inside strings", () => {
    expect(brain._extractJSON('{"msg":"say \\"hello\\"","n":1}')).toEqual({ msg: 'say "hello"', n: 1 });
  });

  it("returns null for no JSON content", () => {
    expect(brain._extractJSON("just some text")).toBeNull();
  });

  it("handles real-world reflect output with fences", () => {
    const input = '```json\n{\n  "session_summary": "Short orient session",\n  "note_to_future_self": "Check last_sessions first"\n}\n```';
    expect(brain._extractJSON(input)).toEqual({
      session_summary: "Short orient session",
      note_to_future_self: "Check last_sessions first",
    });
  });
});

// ── 2. buildToolDefinitions ─────────────────────────────────

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
    expect(defs.length).toBe(3);
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

// ── 3. callLLM ──────────────────────────────────────────────

describe("callLLM", () => {
  function makeLLMBrain(response = {}) {
    const { brain, env } = makeBrain();
    const defaultResponse = {
      ok: true,
      tier: "kernel_fallback",
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
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("You are helpful");
    expect(call.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("does not prepend system message when no systemPrompt and no dharma", async () => {
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

  it("injects dharma into system prompt when dharma is set", async () => {
    const { brain } = makeLLMBrain();
    brain.dharma = "Be truthful and compassionate.";
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful",
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("[DHARMA]");
    expect(call.messages[0].content).toContain("Be truthful and compassionate.");
    expect(call.messages[0].content).toContain("You are helpful");
  });

  it("injects dharma even when no systemPrompt provided", async () => {
    const { brain } = makeLLMBrain();
    brain.dharma = "Be truthful.";
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("[DHARMA]");
    expect(call.messages[0].content).toContain("Be truthful.");
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
        ok: true, tier: "kernel_fallback",
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
    const secondCall = brain.callWithCascade.mock.calls[1][0];
    expect(secondCall.model).toBe("anthropic/claude-haiku-4.5");
  });
});

// ── 3b. callViaKernelFallback ────────────────────────────────

describe("callViaKernelFallback", () => {
  it("throws when no kernel:llm_fallback configured", async () => {
    const { brain } = makeBrain();
    await expect(brain.callViaKernelFallback({
      model: "test", messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    })).rejects.toThrow("No LLM fallback configured at kernel:llm_fallback");
  });

  it("executes adapter via runInIsolate with scoped secrets", async () => {
    const adapterCode = 'async function call(ctx) { return { content: "ok", usage: {} }; }';
    const { brain } = makeBrain({
      "kernel:llm_fallback": JSON.stringify(adapterCode),
      "kernel:llm_fallback:meta": JSON.stringify({
        secrets: ["OPENROUTER_API_KEY"],
        timeout_ms: 30000,
      }),
    });
    brain.env.OPENROUTER_API_KEY = "test-key";
    brain.runInIsolate = vi.fn(async () => ({
      content: "fallback response",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));

    const result = await brain.callViaKernelFallback({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    });

    expect(result.content).toBe("fallback response");
    expect(brain.runInIsolate).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleCode: adapterCode,
        ctx: expect.objectContaining({
          model: "test-model",
          secrets: { OPENROUTER_API_KEY: "test-key" },
        }),
        timeoutMs: 30000,
      })
    );
  });

  it("rejects invalid adapter response", async () => {
    const adapterCode = 'async function call() { return { bad: true }; }';
    const { brain } = makeBrain({
      "kernel:llm_fallback": JSON.stringify(adapterCode),
    });
    brain.runInIsolate = vi.fn(async () => ({ bad: true }));

    await expect(brain.callViaKernelFallback({
      model: "test", messages: [], max_tokens: 100,
    })).rejects.toThrow("Adapter returned invalid response");
  });
});

// ── 4. runAgentLoop ────────────────────────────────────────

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
    brain.executeToolCall = vi.fn(async () => ({ result: "ok" }));
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
});

// ── 5. executeToolCall ─────────────────────────────────────

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

// ── 6. executeAction ────────────────────────────────────────

describe("executeAction", () => {
  it("reads from tool:name:code + tool:name:meta", async () => {
    const toolCode = 'async function execute({ x }) { return { doubled: x * 2 }; }';
    const toolMeta = { secrets: [], kv_access: "none", timeout_ms: 5000 };
    const { brain } = makeBrain({
      "tool:doubler:code": JSON.stringify(toolCode),
      "tool:doubler:meta": JSON.stringify(toolMeta),
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.buildToolContext = vi.fn(async () => ({ x: 5 }));
    brain.runInIsolate = vi.fn(async () => ({ doubled: 10 }));

    const result = await brain.executeAction({ tool: "doubler", input: { x: 5 }, id: "tc1" });
    expect(result).toEqual({ doubled: 10 });
    expect(brain.runInIsolate).toHaveBeenCalledWith(
      expect.objectContaining({ moduleCode: toolCode })
    );
  });

  it("throws for missing tool code", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.executeAction({ tool: "nonexistent", input: {}, id: "tc1" }))
      .rejects.toThrow("Unknown tool: nonexistent");
  });
});

// ── 7. callLLM budget enforcement ──────────────────────────

describe("callLLM budget enforcement", () => {
  function makeBudgetBrain(budgetOverrides = {}) {
    const { brain, env } = makeBrain();
    const budget = {
      max_cost: 0.10,
      max_steps: 8,
      max_duration_seconds: 600,
      ...budgetOverrides,
    };
    brain.defaults = { session_budget: budget };
    brain.callWithCascade = vi.fn(async () => ({
      ok: true,
      tier: "kernel_fallback",
      content: '{"result":"ok"}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolCalls: null,
    }));
    brain.estimateCost = vi.fn(() => 0.001);
    return { brain, env };
  }

  it("throws on cost limit", async () => {
    const { brain } = makeBudgetBrain();
    brain.sessionCost = 0.10;
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    })).rejects.toThrow("Budget exceeded: cost");
  });

  it("throws on step limit", async () => {
    const { brain } = makeBudgetBrain();
    brain.sessionLLMCalls = 8;
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    })).rejects.toThrow("Budget exceeded: steps");
  });

  it("throws on duration limit", async () => {
    const { brain } = makeBudgetBrain();
    brain.startTime = Date.now() - 601_000;
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    })).rejects.toThrow("Budget exceeded: duration");
  });

  it("accumulates cost and calls", async () => {
    const { brain } = makeBudgetBrain();
    brain.sessionCost = 0;
    brain.sessionLLMCalls = 0;
    await brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    });
    expect(brain.sessionCost).toBe(0.001);
    expect(brain.sessionLLMCalls).toBe(1);
  });

  it("passes when under budget", async () => {
    const { brain } = makeBudgetBrain();
    brain.sessionCost = 0.05;
    brain.sessionLLMCalls = 4;
    const result = await brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    });
    expect(result.content).toBe('{"result":"ok"}');
  });
});

// ── 8. runAgentLoop budget handling ────────────────────────

describe("runAgentLoop budget handling", () => {
  it("catches budget error gracefully", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    let callCount = 0;
    brain.callLLM = vi.fn(async () => {
      callCount++;
      if (callCount === 2) throw new Error("Budget exceeded: cost");
      return {
        content: null,
        cost: 0.05,
        toolCalls: [{ id: "tc1", function: { name: "tool", arguments: "{}" } }],
      };
    });
    brain.executeToolCall = vi.fn(async () => ({ ok: true }));

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "budget test",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });
    expect(result.budget_exceeded).toBe(true);
    expect(result.reason).toBe("Budget exceeded: cost");
  });

  it("re-throws non-budget errors", async () => {
    const { brain } = makeBrain();
    brain.callLLM = vi.fn(async () => {
      throw new Error("Network failure");
    });
    await expect(brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "error test",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    })).rejects.toThrow("Network failure");
  });
});

// ── 9. callHook ────────────────────────────────────────────

describe("callHook", () => {
  it("returns null when hook doesn't exist", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.buildToolContext = vi.fn(async () => ({}));
    brain.runInIsolate = vi.fn(async () => ({}));
    const result = await brain.callHook("validate", { tool: "test" });
    expect(result).toBeNull();
    expect(brain.toolsCache["validate"]).toBe(false);
  });

  it("calls hook and returns result", async () => {
    const hookCode = 'async function execute(ctx) { return { ok: true }; }';
    const { brain } = makeBrain({
      "tool:validate:code": JSON.stringify(hookCode),
      "tool:validate:meta": JSON.stringify({ timeout_ms: 3000 }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.buildToolContext = vi.fn(async (name, meta, input) => input);
    brain.runInIsolate = vi.fn(async () => ({ ok: true }));
    brain.sessionId = "test_session";
    const result = await brain.callHook("validate", { tool: "test" });
    expect(result).toEqual({ ok: true });
    expect(brain.runInIsolate).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleCode: hookCode,
        toolName: "validate",
        timeoutMs: 3000,
      })
    );
  });

  it("caches miss — doesn't re-check KV", async () => {
    const { brain, env } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.buildToolContext = vi.fn(async () => ({}));
    brain.runInIsolate = vi.fn(async () => ({}));
    await brain.callHook("validate", {});
    await brain.callHook("validate", {});
    const kvCalls = env.KV.get.mock.calls.filter(([key]) => key === "tool:validate:code");
    expect(kvCalls).toHaveLength(1);
  });

  it("swallows hook errors", async () => {
    const hookCode = 'async function execute() { throw new Error("boom"); }';
    const { brain } = makeBrain({
      "tool:validate:code": JSON.stringify(hookCode),
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.buildToolContext = vi.fn(async () => ({}));
    brain.runInIsolate = vi.fn(async () => { throw new Error("boom"); });
    brain.sessionId = "test_session";
    const result = await brain.callHook("validate", {});
    expect(result).toBeNull();
    expect(brain.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "hook_error", hook: "validate" })
    );
  });
});

// ── 10. executeToolCall with hooks ──────────────────────────

describe("executeToolCall with hooks", () => {
  it("pre-validate rejects bad args", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async () => ({ result: "should not reach" }));
    brain.callHook = vi.fn(async (hookName) => {
      if (hookName === "validate") return { ok: false, error: "missing field" };
      return null;
    });
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{"a":1}' },
    });
    expect(result).toEqual({ error: "missing field" });
    expect(brain.executeAction).not.toHaveBeenCalled();
  });

  it("pre-validate corrects args", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async (step) => ({ received: step.input }));
    brain.callHook = vi.fn(async (hookName) => {
      if (hookName === "validate") return { ok: true, args: { a: 1, b: "added" } };
      return null;
    });
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{"a":1}' },
    });
    expect(brain.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ input: { a: 1, b: "added" } })
    );
  });

  it("post-validate rejects bad result", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async () => ({ data: "some result" }));
    brain.callHook = vi.fn(async (hookName) => {
      if (hookName === "validate_result") return { ok: false, error: "empty response" };
      return null;
    });
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{}' },
    });
    expect(result).toEqual({ error: "empty response" });
  });

  it("no hooks — pass through", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async () => ({ tool_result: "ok" }));
    brain.callHook = vi.fn(async () => null);
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{"x":1}' },
    });
    expect(result).toEqual({ tool_result: "ok" });
    expect(brain.executeAction).toHaveBeenCalled();
  });

  it("garbled arguments returns error", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async () => ({}));
    brain.callHook = vi.fn(async () => null);
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: "not json" },
    });
    expect(result).toEqual({ error: "Invalid JSON in tool arguments for test_tool" });
    expect(brain.executeAction).not.toHaveBeenCalled();
  });
});

// ── 11. runAgentLoop parse error retry ──────────────────────

describe("runAgentLoop parse error retry", () => {
  it("retries on parse_error", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    let turn = 0;
    brain.callLLM = vi.fn(async () => {
      turn++;
      if (turn === 1) {
        return { content: "not json", cost: 0.001, toolCalls: null };
      }
      return { content: '{"recovered":true}', cost: 0.001, toolCalls: null };
    });
    brain.callHook = vi.fn(async () => null);

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "retry test",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });
    expect(result).toEqual({ recovered: true });
    expect(brain.callLLM).toHaveBeenCalledTimes(2);
  });

  it("retries only once", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.callLLM = vi.fn(async () => ({
      content: "still not json",
      cost: 0.001,
      toolCalls: null,
    }));
    brain.callHook = vi.fn(async () => null);

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "retry test",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });
    expect(result.parse_error).toBe(true);
    expect(result.raw).toBe("still not json");
    expect(brain.callLLM).toHaveBeenCalledTimes(2);
  });
});

// ── 12. isSystemKey / isKernelOnly ──────────────────────────

describe("isSystemKey / isKernelOnly", () => {
  it("recognizes system key prefixes", () => {
    expect(Brainstem.isSystemKey("config:defaults")).toBe(true);
    expect(Brainstem.isSystemKey("prompt:orient")).toBe(true);
    expect(Brainstem.isSystemKey("tool:kv_read:code")).toBe(true);
    expect(Brainstem.isSystemKey("hook:wake:code")).toBe(true);
    expect(Brainstem.isSystemKey("mutation_staged:m_1")).toBe(true);
    expect(Brainstem.isSystemKey("doc:mutation_guide")).toBe(true);
  });

  it("recognizes exact system keys", () => {
    expect(Brainstem.isSystemKey("providers")).toBe(true);
    expect(Brainstem.isSystemKey("wallets")).toBe(true);
    expect(Brainstem.isSystemKey("wisdom")).toBe(true);
  });

  it("rejects non-system keys", () => {
    expect(Brainstem.isSystemKey("wake_config")).toBe(false);
    expect(Brainstem.isSystemKey("last_reflect")).toBe(false);
    expect(Brainstem.isSystemKey("session_counter")).toBe(false);
  });

  it("recognizes kernel-only keys", () => {
    expect(Brainstem.isKernelOnly("kernel:last_sessions")).toBe(true);
    expect(Brainstem.isKernelOnly("kernel:active_session")).toBe(true);
    expect(Brainstem.isKernelOnly("kernel:alert_config")).toBe(true);
  });

  it("kernel-only does not overlap with system keys", () => {
    expect(Brainstem.isKernelOnly("config:defaults")).toBe(false);
    expect(Brainstem.isKernelOnly("prompt:orient")).toBe(false);
  });
});

// ── 13. kvPutSafe ──────────────────────────────────────────

describe("kvPutSafe", () => {
  it("blocks dharma", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvPutSafe("dharma", "new value"))
      .rejects.toThrow("immutable");
  });

  it("blocks kernel-only keys", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvPutSafe("kernel:last_sessions", []))
      .rejects.toThrow("kernel-only");
  });

  it("blocks system keys", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvPutSafe("config:defaults", {}))
      .rejects.toThrow("system key");
  });

  it("allows non-system keys", async () => {
    const { brain } = makeBrain();
    await brain.kvPutSafe("wake_config", { sleep_seconds: 100 });
    // Should not throw
  });
});

// ── 14. kvDeleteSafe ───────────────────────────────────────

describe("kvDeleteSafe", () => {
  it("blocks dharma", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvDeleteSafe("dharma"))
      .rejects.toThrow("immutable");
  });

  it("blocks kernel-only keys", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvDeleteSafe("kernel:active_session"))
      .rejects.toThrow("kernel-only");
  });

  it("blocks system keys", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvDeleteSafe("prompt:orient"))
      .rejects.toThrow("system key");
  });

  it("allows non-system keys", async () => {
    const { brain } = makeBrain();
    await brain.kvDeleteSafe("tooldata:mykey");
    // Should not throw
  });
});

// ── 15. kvWritePrivileged ──────────────────────────────────

describe("kvWritePrivileged", () => {
  it("blocks dharma", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "dharma", value: "evil" },
    ])).rejects.toThrow("immutable");
  });

  it("blocks kernel-only keys", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "kernel:last_sessions", value: [] },
    ])).rejects.toThrow("kernel-only");
  });

  it("allows system keys with snapshot", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await brain.kvWritePrivileged([
      { op: "put", key: "config:defaults", value: { new: true } },
    ]);
    expect(brain.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "privileged_write", key: "config:defaults" })
    );
    expect(brain.privilegedWriteCount).toBe(1);
  });

  it("enforces rate limit", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.privilegedWriteCount = 49;
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "config:defaults", value: {} },
      { op: "put", key: "wisdom", value: "new" },
    ])).rejects.toThrow("Privileged write limit");
  });

  it("auto-refreshes config after privileged writes", async () => {
    const { brain } = makeBrain({
      "config:defaults": JSON.stringify({ updated: true }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    await brain.kvWritePrivileged([
      { op: "put", key: "config:defaults", value: { updated: true } },
    ]);
    expect(brain.defaults).toEqual({ updated: true });
  });

  it("handles delete operations", async () => {
    const { brain, env } = makeBrain({
      "mutation_staged:m_1": JSON.stringify({ id: "m_1" }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    await brain.kvWritePrivileged([
      { op: "delete", key: "mutation_staged:m_1" },
    ]);
    expect(env.KV.delete).toHaveBeenCalledWith("mutation_staged:m_1");
    expect(brain.privilegedWriteCount).toBe(1);
  });
});

// ── 16. checkHookSafety ────────────────────────────────────

describe("checkHookSafety", () => {
  it("returns true with no history", async () => {
    const { brain } = makeBrain();
    brain.sendKernelAlert = vi.fn(async () => {});
    const safe = await brain.checkHookSafety();
    expect(safe).toBe(true);
  });

  it("returns true with mixed outcomes", async () => {
    const { brain } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "clean" },
        { id: "s_3", outcome: "crash" },
      ]),
    });
    brain.sendKernelAlert = vi.fn(async () => {});
    const safe = await brain.checkHookSafety();
    expect(safe).toBe(true);
  });

  it("fires tripwire on 3 consecutive crashes (no snapshot → fallback)", async () => {
    const { brain, env } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "killed" },
        { id: "s_3", outcome: "crash" },
      ]),
      "hook:wake:code": "some code",
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    const safe = await brain.checkHookSafety();
    expect(safe).toBe(false);
    expect(env.KV.delete).toHaveBeenCalledWith("hook:wake:code");
    expect(brain.sendKernelAlert).toHaveBeenCalledWith("hook_reset",
      expect.stringContaining("No good version to restore"));
  });

  it("auto-restores from last_good_hook on tripwire", async () => {
    const { brain, env } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "killed" },
        { id: "s_3", outcome: "crash" },
      ]),
      "hook:wake:code": "bad code",
      "kernel:last_good_hook": JSON.stringify({ code: "good code" }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    const safe = await brain.checkHookSafety();
    expect(safe).toBe(true);
    // Old bad code deleted
    expect(env.KV.delete).toHaveBeenCalledWith("hook:wake:code");
    // Good code restored
    const putCalls = env.KV.put.mock.calls;
    const hookPut = putCalls.find(([key]) => key === "hook:wake:code");
    expect(hookPut).toBeTruthy();
    // Snapshot deleted (anti-loop)
    expect(env.KV.delete).toHaveBeenCalledWith("kernel:last_good_hook");
    expect(brain.sendKernelAlert).toHaveBeenCalledWith("hook_reset",
      expect.stringContaining("Restored last good version"));
  });

  it("auto-restores manifest-based hook on tripwire", async () => {
    const manifest = {
      "main": "hook:wake:modules:main",
      "utils.js": "hook:wake:modules:utils",
    };
    const { brain, env } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "crash" },
        { id: "s_3", outcome: "crash" },
      ]),
      "hook:wake:manifest": JSON.stringify(manifest),
      "hook:wake:modules:main": JSON.stringify("bad main"),
      "hook:wake:modules:utils": JSON.stringify("bad utils"),
      "kernel:last_good_hook": JSON.stringify({
        manifest,
        modules: {
          "hook:wake:modules:main": "good main",
          "hook:wake:modules:utils": "good utils",
        },
      }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    const safe = await brain.checkHookSafety();
    expect(safe).toBe(true);
    // Bad modules deleted
    expect(env.KV.delete).toHaveBeenCalledWith("hook:wake:modules:main");
    expect(env.KV.delete).toHaveBeenCalledWith("hook:wake:modules:utils");
    expect(env.KV.delete).toHaveBeenCalledWith("hook:wake:manifest");
    // Snapshot deleted (anti-loop)
    expect(env.KV.delete).toHaveBeenCalledWith("kernel:last_good_hook");
  });

  it("anti-loop: second tripwire with no snapshot falls to fallback", async () => {
    const { brain } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "crash" },
        { id: "s_3", outcome: "crash" },
      ]),
      "hook:wake:code": "restored-but-still-bad code",
      // No kernel:last_good_hook — was deleted by first tripwire
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    const safe = await brain.checkHookSafety();
    expect(safe).toBe(false);
    expect(brain.sendKernelAlert).toHaveBeenCalledWith("hook_reset",
      expect.stringContaining("No good version to restore"));
  });
});

// ── 17. detectPlatformKill ─────────────────────────────────

describe("detectPlatformKill", () => {
  it("no-op when no active session marker", async () => {
    const { brain, env } = makeBrain();
    await brain.detectPlatformKill();
    // No writes to kernel:last_sessions
    const putCalls = env.KV.put.mock.calls.filter(
      ([key]) => key === "kernel:last_sessions"
    );
    expect(putCalls).toHaveLength(0);
  });

  it("injects killed outcome when active session found", async () => {
    const { brain, env } = makeBrain({
      "kernel:active_session": JSON.stringify("s_dead"),
    });
    await brain.detectPlatformKill();

    // Should have written kernel:last_sessions with killed entry
    const putCalls = env.KV.put.mock.calls;
    const lastSessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    expect(lastSessionsPut).toBeTruthy();

    // Should have deleted kernel:active_session
    expect(env.KV.delete).toHaveBeenCalledWith("kernel:active_session");
  });
});

// ── 18. updateSessionOutcome snapshot ──────────────────────

describe("updateSessionOutcome snapshot", () => {
  it("snapshots hook on first clean (no existing snapshot)", async () => {
    const { brain, env } = makeBrain({
      "hook:wake:code": JSON.stringify("seed hook code"),
    });
    await brain.updateSessionOutcome("clean");

    const putCalls = env.KV.put.mock.calls;
    const snapshotPut = putCalls.find(([key]) => key === "kernel:last_good_hook");
    expect(snapshotPut).toBeTruthy();
    const snapshot = JSON.parse(snapshotPut[1]);
    expect(snapshot.code).toBe("seed hook code");
  });

  it("snapshots when hook_dirty is set", async () => {
    const { brain, env } = makeBrain({
      "hook:wake:code": JSON.stringify("modified hook"),
      "kernel:hook_dirty": JSON.stringify(true),
      "kernel:last_good_hook": JSON.stringify({ code: "old version" }),
    });
    await brain.updateSessionOutcome("clean");

    const putCalls = env.KV.put.mock.calls;
    const snapshotPut = putCalls.find(([key]) => key === "kernel:last_good_hook");
    expect(snapshotPut).toBeTruthy();
    const snapshot = JSON.parse(snapshotPut[1]);
    expect(snapshot.code).toBe("modified hook");
    // hook_dirty should be cleared
    expect(env.KV.delete).toHaveBeenCalledWith("kernel:hook_dirty");
  });

  it("skips snapshot when not dirty and snapshot exists", async () => {
    const { brain, env } = makeBrain({
      "hook:wake:code": JSON.stringify("unchanged hook"),
      "kernel:last_good_hook": JSON.stringify({ code: "unchanged hook" }),
      // No kernel:hook_dirty
    });
    await brain.updateSessionOutcome("clean");

    const putCalls = env.KV.put.mock.calls;
    const snapshotPut = putCalls.find(([key]) => key === "kernel:last_good_hook");
    expect(snapshotPut).toBeFalsy();
  });

  it("does not snapshot on crash outcome", async () => {
    const { brain, env } = makeBrain({
      "hook:wake:code": JSON.stringify("some hook"),
    });
    await brain.updateSessionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const snapshotPut = putCalls.find(([key]) => key === "kernel:last_good_hook");
    expect(snapshotPut).toBeFalsy();
  });

  it("snapshots manifest-based hook", async () => {
    const manifest = {
      "main": "hook:wake:modules:main",
      "utils.js": "hook:wake:modules:utils",
    };
    const { brain, env } = makeBrain({
      "hook:wake:manifest": JSON.stringify(manifest),
      "hook:wake:modules:main": JSON.stringify("main code"),
      "hook:wake:modules:utils": JSON.stringify("utils code"),
      "kernel:hook_dirty": JSON.stringify(true),
      "kernel:last_good_hook": JSON.stringify({ code: "old" }),
    });
    await brain.updateSessionOutcome("clean");

    const putCalls = env.KV.put.mock.calls;
    const snapshotPut = putCalls.find(([key]) => key === "kernel:last_good_hook");
    expect(snapshotPut).toBeTruthy();
    const snapshot = JSON.parse(snapshotPut[1]);
    expect(snapshot.manifest).toEqual(manifest);
    expect(snapshot.modules["hook:wake:modules:main"]).toBe("main code");
    expect(snapshot.modules["hook:wake:modules:utils"]).toBe("utils code");
  });

  it("skips snapshot when no hook is loaded", async () => {
    const { brain, env } = makeBrain({
      // No hook:wake:code and no hook:wake:manifest
    });
    await brain.updateSessionOutcome("clean");

    const putCalls = env.KV.put.mock.calls;
    const snapshotPut = putCalls.find(([key]) => key === "kernel:last_good_hook");
    expect(snapshotPut).toBeFalsy();
  });
});

// ── 19. kvWritePrivileged hook_dirty flag ──────────────────

describe("kvWritePrivileged hook_dirty flag", () => {
  it("sets kernel:hook_dirty when writing hook:wake:* key", async () => {
    const { brain, env } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    await brain.kvWritePrivileged([
      { op: "put", key: "hook:wake:code", value: "new hook" },
    ]);

    const putCalls = env.KV.put.mock.calls;
    const dirtyPut = putCalls.find(([key]) => key === "kernel:hook_dirty");
    expect(dirtyPut).toBeTruthy();
  });

  it("does not set hook_dirty for non-wake hook keys", async () => {
    const { brain, env } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    await brain.kvWritePrivileged([
      { op: "put", key: "hook:other:code", value: "something" },
    ]);

    const putCalls = env.KV.put.mock.calls;
    const dirtyPut = putCalls.find(([key]) => key === "kernel:hook_dirty");
    expect(dirtyPut).toBeFalsy();
  });

  it("sets hook_dirty for hook:wake:manifest writes", async () => {
    const { brain, env } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    await brain.kvWritePrivileged([
      { op: "put", key: "hook:wake:manifest", value: { "main": "hook:wake:modules:main" } },
    ]);

    const putCalls = env.KV.put.mock.calls;
    const dirtyPut = putCalls.find(([key]) => key === "kernel:hook_dirty");
    expect(dirtyPut).toBeTruthy();
  });
});

// ── 20. runScheduled manifest loading ─────────────────────

describe("runScheduled manifest loading", () => {
  it("loads single hook:wake:code when no manifest", async () => {
    const { brain } = makeBrain({
      "hook:wake:code": JSON.stringify("single hook code"),
    });
    brain.detectPlatformKill = vi.fn(async () => {});
    brain.checkHookSafety = vi.fn(async () => true);
    brain.executeHook = vi.fn(async () => {});
    brain.wake = vi.fn(async () => {});

    await brain.runScheduled();

    expect(brain.executeHook).toHaveBeenCalledWith(
      { "hook.js": "single hook code" },
      "hook.js"
    );
    expect(brain.wake).not.toHaveBeenCalled();
  });

  it("loads manifest-based modules", async () => {
    const manifest = {
      "main": "hook:wake:modules:main",
      "utils.js": "hook:wake:modules:utils",
    };
    const { brain } = makeBrain({
      "hook:wake:manifest": JSON.stringify(manifest),
      "hook:wake:modules:main": JSON.stringify("main module code"),
      "hook:wake:modules:utils": JSON.stringify("utils module code"),
    });
    brain.detectPlatformKill = vi.fn(async () => {});
    brain.checkHookSafety = vi.fn(async () => true);
    brain.executeHook = vi.fn(async () => {});
    brain.wake = vi.fn(async () => {});

    await brain.runScheduled();

    expect(brain.executeHook).toHaveBeenCalledWith(
      {
        "main": "main module code",
        "utils.js": "utils module code",
      },
      "main"
    );
  });

  it("falls back to wake() when hook unsafe", async () => {
    const { brain } = makeBrain({
      "hook:wake:code": JSON.stringify("some code"),
    });
    brain.detectPlatformKill = vi.fn(async () => {});
    brain.checkHookSafety = vi.fn(async () => false);
    brain.executeHook = vi.fn(async () => {});
    brain.wake = vi.fn(async () => {});

    await brain.runScheduled();

    expect(brain.executeHook).not.toHaveBeenCalled();
    expect(brain.wake).toHaveBeenCalled();
  });

  it("falls back to wake() when no hook code exists", async () => {
    const { brain } = makeBrain({
      // No hook:wake:code or manifest
    });
    brain.detectPlatformKill = vi.fn(async () => {});
    brain.checkHookSafety = vi.fn(async () => true);
    brain.executeHook = vi.fn(async () => {});
    brain.wake = vi.fn(async () => {});

    await brain.runScheduled();

    expect(brain.executeHook).not.toHaveBeenCalled();
    expect(brain.wake).toHaveBeenCalled();
  });
});

// ── checkBalance ──────────────────────────────────────────────

describe("checkBalance", () => {
  it("iterates providers and wallets, calls executeAdapter for each", async () => {
    const { brain } = makeBrain({
      providers: JSON.stringify({
        openrouter: { adapter: "provider:llm_balance", scope: "general" },
        no_adapter: { note: "manual" },
      }),
      wallets: JSON.stringify({
        base: { adapter: "provider:wallet_balance", scope: "general" },
      }),
    });
    brain.executeAdapter = vi.fn(async () => 42);

    const result = await brain.checkBalance({});

    expect(brain.executeAdapter).toHaveBeenCalledTimes(2);
    expect(result.providers.openrouter).toEqual({ balance: 42, scope: "general" });
    expect(result.providers.no_adapter).toBeUndefined();
    expect(result.wallets.base).toEqual({ balance: 42, scope: "general" });
  });

  it("filters by scope", async () => {
    const { brain } = makeBrain({
      providers: JSON.stringify({
        main: { adapter: "provider:llm_balance", scope: "general" },
        proj: { adapter: "provider:llm_balance", scope: "project_x" },
      }),
      wallets: JSON.stringify({}),
    });
    brain.executeAdapter = vi.fn(async () => 10);

    const result = await brain.checkBalance({ scope: "general" });

    expect(brain.executeAdapter).toHaveBeenCalledTimes(1);
    expect(result.providers.main).toEqual({ balance: 10, scope: "general" });
    expect(result.providers.proj).toBeUndefined();
  });

  it("returns error for failing adapters", async () => {
    const { brain } = makeBrain({
      providers: JSON.stringify({
        broken: { adapter: "provider:bad", scope: "general" },
      }),
      wallets: JSON.stringify({}),
    });
    brain.executeAdapter = vi.fn(async () => { throw new Error("no code"); });

    const result = await brain.checkBalance({});

    expect(result.providers.broken).toEqual({ balance: null, scope: "general", error: "no code" });
  });

});

// ── callLLM budgetCap ──────────────────────────────────────

describe("callLLM budgetCap", () => {
  function makeLLMBrain(sessionCost, budget, budgetCap) {
    const { brain } = makeBrain();
    brain.sessionCost = sessionCost;
    brain.sessionLLMCalls = 0;
    brain.defaults = { session_budget: budget };
    brain.startTime = Date.now();
    brain.elapsed = () => 0;
    brain.callWithCascade = vi.fn(async () => ({
      ok: true, content: "hi", usage: { prompt_tokens: 10, completion_tokens: 5 },
      tier: "primary",
    }));
    brain.estimateCost = () => 0.01;
    brain.karmaRecord = vi.fn(async () => {});
    return brain;
  }

  it("uses session_budget.max_cost when no budgetCap", async () => {
    const brain = makeLLMBrain(0.14, { max_cost: 0.15 });
    // 0.14 < 0.15 — should succeed
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
    })).resolves.toBeDefined();
  });

  it("throws when sessionCost >= budgetCap", async () => {
    const brain = makeLLMBrain(0.10, { max_cost: 0.15 });
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
      budgetCap: 0.10,
    })).rejects.toThrow("Budget exceeded: cost");
  });

  it("allows call when sessionCost < budgetCap even if close to max_cost", async () => {
    const brain = makeLLMBrain(0.09, { max_cost: 0.15 });
    // budgetCap=0.10, sessionCost=0.09 < 0.10 — should succeed
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
      budgetCap: 0.10,
    })).resolves.toBeDefined();
  });

  it("budgetCap overrides max_cost (lower cap)", async () => {
    const brain = makeLLMBrain(0.08, { max_cost: 0.15 });
    // Without budgetCap: 0.08 < 0.15, would succeed
    // With budgetCap=0.05: 0.08 >= 0.05, should fail
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
      budgetCap: 0.05,
    })).rejects.toThrow("Budget exceeded: cost");
  });

  it("resolves kv: secret overrides", async () => {
    const { brain } = makeBrain({
      providers: JSON.stringify({
        proj: { adapter: "provider:llm_balance", scope: "project_x", secrets: { OPENROUTER_API_KEY: "kv:secret:proj_key" } },
      }),
      wallets: JSON.stringify({}),
      "secret:proj_key": JSON.stringify("sk-proj-12345"),
    });
    brain.executeAdapter = vi.fn(async () => 99);

    await brain.checkBalance({});

    // executeAdapter should have been called with resolved secret overrides
    const overrides = brain.executeAdapter.mock.calls[0][2];
    expect(overrides).toEqual({ OPENROUTER_API_KEY: "sk-proj-12345" });
  });
});
