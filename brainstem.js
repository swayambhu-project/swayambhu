// Swayambhu Brainstem
// A thin, unopinionated execution layer. It reads config, follows instructions,
// makes API calls, and writes results. It has no opinions. Every decision that
// can be pushed to the models has been pushed to the models.
//
// Tools are loaded dynamically from KV — Swayambhu creates, edits, and deletes
// his own tools. The brainstem only provides primitives: fetch, scoped KV, scoped secrets.
//
// The karma log records every LLM call and tool execution with full request/response.
// It flushes to KV after each entry so that if the worker crashes, the log survives
// up to the point of death. Swayambhu manages archival of old karma logs himself.

import { WorkerEntrypoint } from "cloudflare:workers";

// RPC bridge — gives isolate-loaded tools scoped KV access without passing functions through JSON.
export class ScopedKV extends WorkerEntrypoint {
  async get(key) {
    const { toolName, kvAccess } = this.ctx.props;
    const resolved = kvAccess === "own" ? `tooldata:${toolName}:${key}` : key;
    try { return await this.env.KV.get(resolved, "json"); }
    catch { try { return await this.env.KV.get(resolved, "text"); } catch { return null; } }
  }
  async put(key, value) {
    const { toolName } = this.ctx.props;
    const resolved = `tooldata:${toolName}:${key}`;  // writes always scoped
    await this.env.KV.put(resolved, typeof value === "string" ? value : JSON.stringify(value));
  }
}

export default {
  async scheduled(event, env) {
    const brain = new Brainstem(env);
    await brain.wake();
  },
};

class Brainstem {
  constructor(env) {
    this.env = env;
    this.kv = env.KV;
    this.startTime = Date.now();
    this.sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessionCost = 0;
    this.karma = [];           // The flight recorder — replaces this.log
    this.kvWritesThisSession = 0;
    this.modelsConfig = null;
    this.defaults = null;
    this.soul = null;
    this.toolsCache = {};      // Loaded tool code+meta, cached per session
    this.lastWorkingSnapshotted = false; // Only snapshot provider once per session
  }

  static SYSTEM_KEY_PREFIXES = [
    'prompt:', 'config:', 'functions:', 'secret:',
    'mutation_staged:', 'mutation_candidate:',
  ];
  static SYSTEM_KEY_EXACT = ['providers', 'wallets', 'wisdom'];

  static isSystemKey(key) {
    if (Brainstem.SYSTEM_KEY_EXACT.includes(key)) return true;
    return Brainstem.SYSTEM_KEY_PREFIXES.some(p => key.startsWith(p));
  }

  generateMutationId() {
    return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ── Reflect hierarchy helpers ──────────────────────────────

  async loadReflectPrompt(depth) {
    // Try depth-specific prompt, fall back to prompt:deep for depth 1
    const specific = await this.kvGet(`prompt:reflect:${depth}`);
    if (specific) return specific;
    if (depth === 1) {
      const legacy = await this.kvGet("prompt:deep");
      if (legacy) return legacy;
    }
    return this.defaultDeepReflectPrompt(depth);
  }

  async loadBelowPrompt(depth) {
    if (depth === 1) return this.kvGet("prompt:orient");
    return this.kvGet(`prompt:reflect:${depth - 1}`);
  }

  async loadReflectHistory(depth, count = 10) {
    const kvIndex = await this.listKVKeys();
    const keys = kvIndex
      .filter(k => k.key.startsWith(`reflect:${depth}:`))
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, count)
      .map(k => k.key);
    return this.loadKeys(keys);
  }

  getReflectModel(depth) {
    const perLevel = this.defaults?.reflect_levels?.[depth];
    if (perLevel?.model) return perLevel.model;
    return this.defaults?.deep_reflect?.model || this.defaults?.orient?.model;
  }

  getMaxSteps(role, depth) {
    if (role === 'orient') return this.defaults?.execution?.max_steps?.orient || 3;
    const perLevel = this.defaults?.reflect_levels?.[depth];
    if (perLevel?.max_steps) return perLevel.max_steps;
    return depth === 1
      ? (this.defaults?.execution?.max_steps?.reflect_default || 5)
      : (this.defaults?.execution?.max_steps?.reflect_deep || 10);
  }

  // ── Reflect scheduling ───────────────────────────────────

  async isReflectDue(depth) {
    // Phase 1: self-scheduled check
    const scheduleKey = depth === 1 ? "deep_reflect_schedule" : `reflect:schedule:${depth}`;
    const schedule = await this.kvGet(`reflect:schedule:${depth}`)
      || (depth === 1 ? await this.kvGet("deep_reflect_schedule") : null);

    const sessionCount = await this.getSessionCount();

    if (schedule) {
      const sessionsSince = sessionCount - (schedule.last_deep_reflect_session || schedule.last_reflect_session || 0);
      const daysSince = schedule.last_deep_reflect || schedule.last_reflect
        ? (Date.now() - new Date(schedule.last_deep_reflect || schedule.last_reflect).getTime()) / 86400000
        : Infinity;
      const maxSessions = schedule.after_sessions
        || this.defaults?.deep_reflect?.default_interval_sessions || 20;
      const maxDays = schedule.after_days
        || this.defaults?.deep_reflect?.default_interval_days || 7;
      return sessionsSince >= maxSessions || daysSince >= maxDays;
    }

    // Phase 2: cold-start fallback — exponential interval
    const baseInterval = this.defaults?.deep_reflect?.default_interval_sessions || 20;
    const multiplier = this.defaults?.execution?.reflect_interval_multiplier || 5;
    const threshold = baseInterval * Math.pow(multiplier, depth - 1);
    return sessionCount >= threshold;
  }

  async highestReflectDepthDue() {
    const maxDepth = this.defaults?.execution?.max_reflect_depth || 1;
    for (let d = maxDepth; d >= 1; d--) {
      if (await this.isReflectDue(d)) return d;
    }
    return 0;
  }

  // ── Karma log ────────────────────────────────────────────────

  async karmaRecord(entry) {
    this.karma.push({
      t: Date.now(),
      elapsed_ms: this.elapsed(),
      ...entry,
    });
    await this.kvPut(`karma:${this.sessionId}`, this.karma);
  }

  // ── Wake cycle ──────────────────────────────────────────────

  async wake() {
    try {
      // 0. Check if it's actually time to wake up
      const wakeConfig = await this.kvGet("wake_config");
      if (wakeConfig?.next_wake_after) {
        if (Date.now() < new Date(wakeConfig.next_wake_after).getTime()) {
          return; // Not time yet, go back to sleep
        }
      }

      // 1. Crash detection — check if previous session died mid-flight
      const crashData = await this.detectCrash();

      // 1b. Circuit breaker — auto-rollback candidates if system is unstable
      await this.runCircuitBreaker();

      // 1a. Mark this session as in-progress (crash breadcrumb for next wake)
      await this.kvPut("session", this.sessionId);

      // 2. Load ground truth (no LLM needed)
      const [balances, kvUsage] = await Promise.all([
        this.getBalances(),
        this.getKVUsage(),
      ]);

      // 3. Load core state from KV
      this.defaults = await this.kvGet("config:defaults");
      const lastReflect = await this.kvGet("last_reflect");

      // 4. Merge with defaults
      const config = this.mergeDefaults(this.defaults, wakeConfig);

      // 4a. Cache immutable/stable values for the session
      this.modelsConfig = await this.kvGet("config:models");
      this.soul = await this.kvGet("soul");
      this.toolRegistry = await this.kvGet("config:tool_registry");

      // 5. Check if reflection is due (any depth)
      const reflectDepth = await this.highestReflectDepthDue();

      // 6. Evaluate tripwires against live data
      const effort = this.evaluateTripwires(
        config,
        { balances, kvUsage }
      );

      // 7. Load context keys (from last_reflect or defaults)
      const loadKeys = lastReflect?.next_orient_context?.load_keys
        || this.defaults?.memory?.default_load_keys
        || [];
      const additionalContext = await this.loadKeys(loadKeys);

      // 8. Build KV index
      const kvIndex = await this.listKVKeys();

      // 9. Build context object
      const context = {
        balances,
        kvUsage,
        lastReflect,
        additionalContext,
        kvIndex,
        effort,
        reflectDepth,
        crashData,  // null if clean, full karma of dead session if crash
      };

      // 10. Record session start in karma
      await this.karmaRecord({
        event: "session_start",
        session_id: this.sessionId,
        effort,
        crash_detected: !!crashData,
      });

      // 11. Run the appropriate session type
      if (reflectDepth > 0) {
        await this.runReflect(reflectDepth, context);
      } else {
        await this.runSession(context, config);
      }

      // 12. Mark session complete — clear the crash breadcrumb
      await this.kv.delete("session");

    } catch (err) {
      // Last resort: log error to karma and KV
      await this.karmaRecord({
        event: "fatal_error",
        error: err.message,
        stack: err.stack,
      });
    }
  }

  // ── Crash detection ─────────────────────────────────────────

  async detectCrash() {
    const stale = await this.kvGet("session");
    if (!stale) return null;  // first boot or clean exit

    // That session never finished — load its karma
    const deadKarma = await this.kvGet(`karma:${stale}`);
    return {
      dead_session_id: stale,
      karma: deadKarma,
      last_entry: Array.isArray(deadKarma) ? deadKarma[deadKarma.length - 1] : null,
    };
  }

  // ── Normal session ──────────────────────────────────────────

  async runSession(context, config) {
    const orientPrompt = await this.kvGet("prompt:orient");
    const resources = await this.kvGet("config:resources");

    // Build system prompt
    const systemPrompt = this.buildPrompt(orientPrompt, {
      soul: this.soul,
      models: this.modelsConfig,
      resources,
      config,
    });

    // Build initial context (user message with dynamic data)
    const initialContext = this.buildOrientContext(context);

    const orientModel = this.resolveModel(
      config.orient?.model || this.defaults.orient.model
    );

    const tools = this.buildToolDefinitions();

    // Run orient agent loop
    const output = await this.runAgentLoop({
      systemPrompt,
      initialContext,
      tools,
      model: orientModel,
      effort: context.effort || config.orient?.effort || this.defaults.orient.effort,
      maxTokens: config.orient?.max_output_tokens || this.defaults.orient.max_output_tokens,
      maxSteps: this.getMaxSteps('orient'),
      step: 'orient',
    });

    // Apply KV operations from orient output (gated by protection)
    if (output.kv_operations) {
      for (const op of output.kv_operations) {
        await this.applyKVOperation(op);
      }
    }

    // Session reflect — unchanged, triggered after orient loop
    await this.executeReflect({ model: this.defaults.reflect.model });

    // Write session results
    await this.writeSessionResults(output, config);
  }

  buildOrientContext(context) {
    return JSON.stringify({
      balances: context.balances,
      kv_usage: context.kvUsage,
      last_reflect: context.lastReflect,
      additional_context: context.additionalContext,
      kv_index: context.kvIndex,
      effort: context.effort,
      crash_data: context.crashData,
    });
  }

  // ── Actions (dynamic tools) ─────────────────────────────────

  async executeAction(step) {
    const toolName = step.tool;

    // Load function code + KV-native metadata (cached per session)
    if (!this.toolsCache[toolName]) {
      const fn = await this.kvGetWithMeta(`functions:${toolName}`);
      if (!fn.value) {
        throw new Error(`Unknown tool: ${toolName} — no code at functions:${toolName}`);
      }
      this.toolsCache[toolName] = fn;
    }

    const { value: moduleCode, metadata: meta } = this.toolsCache[toolName];

    // Build sandboxed context based on function metadata
    const ctx = await this.buildToolContext(toolName, meta || {}, step.input || {});

    // Record pre-execution in karma (this is the crash breadcrumb)
    await this.karmaRecord({
      event: "tool_start",
      tool: toolName,
      step_id: step.id,
      input_summary: JSON.stringify(step.input || {}).slice(0, 500),
    });

    // Execute in isolate
    try {
      const result = await this.runInIsolate({
        id: `fn:${toolName}:${this.sessionId}`,
        moduleCode,
        ctx,
        kvAccess: meta?.kv_access,
        toolName,
        timeoutMs: meta?.timeout_ms || 15000,
      });

      // Record success
      await this.karmaRecord({
        event: "tool_complete",
        tool: toolName,
        step_id: step.id,
        ok: true,
        result_summary: JSON.stringify(result).slice(0, 1000),
      });

      return result;
    } catch (err) {
      await this.karmaRecord({
        event: "tool_complete",
        tool: toolName,
        step_id: step.id,
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }

  async buildToolContext(toolName, meta, input) {
    // Scoped secrets from two tiers:
    // 1. env secrets (encrypted, human-provisioned)
    // 2. KV secrets (Swayambhu-provisioned, stored at secret:{name})
    const secrets = {};
    for (const secretName of (meta.secrets || [])) {
      if (this.env[secretName] !== undefined) {
        secrets[secretName] = this.env[secretName];
      }
    }
    for (const secretName of (meta.kv_secrets || [])) {
      const val = await this.kvGet(`secret:${secretName}`);
      if (val !== null) secrets[secretName] = val;
    }

    // kv and fetch are handled by the ES module itself (env.KV_BRIDGE, globalThis.fetch)
    return { ...input, secrets };
  }

  // ── Isolate execution (Worker Loader API) ───────────────────

  async runInIsolate({ id, moduleCode, ctx, kvAccess, toolName, timeoutMs }) {
    const hasKV = kvAccess && kvAccess !== "none";

    const worker = this.env.LOADER.get(id, (loaderCtx) => ({
      compatibilityDate: "2025-06-01",
      mainModule: "fn.js",
      modules: { "fn.js": moduleCode },
      env: {
        ...(hasKV ? { KV_BRIDGE: loaderCtx.exports.ScopedKV({ props: { toolName, kvAccess } }) } : {}),
      },
    }));

    const entrypoint = worker.getEntrypoint();
    const request = new Request("https://internal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ctx),
    });

    const response = await Promise.race([
      entrypoint.fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Isolate timeout")), timeoutMs || 15000)),
    ]);

    const body = await response.json();
    if (!body.ok) throw new Error(body.error || "Isolate execution failed");
    return body.result;
  }

  // ── Reflect ─────────────────────────────────────────────────

  async executeReflect(step) {
    const reflectPrompt = await this.kvGet("prompt:reflect");
    const stagedMutations = await this.loadStagedMutations();

    const systemKeyPatterns = {
      prefixes: Brainstem.SYSTEM_KEY_PREFIXES,
      exact: Brainstem.SYSTEM_KEY_EXACT,
    };

    const prompt = this.buildPrompt(reflectPrompt || this.defaultReflectPrompt(), {
      soul: this.soul,
      karma: this.karma,
      sessionCost: this.sessionCost,
      stagedMutations,
      systemKeyPatterns,
    });

    const model = this.resolveModel(
      step.model || this.defaults.reflect.model
    );
    const result = await this.callLLM({
      model,
      effort: step.effort || this.defaults.reflect.effort,
      maxTokens: step.max_output_tokens || this.defaults.reflect.max_output_tokens,
      messages: [{ role: "user", content: prompt }],
      step: "reflect",
    });
    this.sessionCost += result.cost;

    try {
      const reflection = JSON.parse(result.content);
      await this.kvPut("last_reflect", {
        ...reflection,
        session_id: this.sessionId,
      });

      // Apply any KV operations the reflection requests (gated by protection)
      if (reflection.kv_operations) {
        for (const op of reflection.kv_operations) {
          await this.applyKVOperation(op);
        }
      }

      // Process mutation verdicts (withdraw/modify only)
      if (reflection.mutation_verdicts) {
        await this.processReflectVerdicts(reflection.mutation_verdicts);
      }

      // Stage new mutation requests
      if (reflection.mutation_requests) {
        for (const req of reflection.mutation_requests) {
          await this.stageMutation(req, this.sessionId);
        }
      }

      // Update wake config if specified
      if (reflection.next_wake_config) {
        const wakeConf = { ...reflection.next_wake_config };
        if (wakeConf.sleep_seconds) {
          wakeConf.next_wake_after = new Date(
            Date.now() + wakeConf.sleep_seconds * 1000
          ).toISOString();
        }
        await this.kvPut("wake_config", wakeConf);
      }
    } catch (err) {
      await this.kvPut("last_reflect", {
        raw: result.content,
        parse_error: err.message,
        session_id: this.sessionId,
      });
    }
  }

  // ── Deep reflection (recursive, depth-aware) ────────────────

  async runReflect(depth, context) {
    const prompt = await this.loadReflectPrompt(depth);
    const initialCtx = await this.gatherReflectContext(depth, context);
    const belowPrompt = await this.loadBelowPrompt(depth);

    // Build system prompt with template substitution
    const systemPrompt = this.buildPrompt(prompt, {
      soul: this.soul,
      depth,
      belowPrompt,
      ...initialCtx.templateVars,
    });

    // Reflect uses tools for investigation but NOT spawn_subplan
    const tools = this.buildToolDefinitions()
      .filter(t => t.function.name !== 'spawn_subplan');

    const model = this.resolveModel(this.getReflectModel(depth));
    const maxSteps = this.getMaxSteps('reflect', depth);

    const output = await this.runAgentLoop({
      systemPrompt,
      initialContext: initialCtx.userMessage,
      tools,
      model,
      effort: this.defaults?.deep_reflect?.effort || 'high',
      maxTokens: this.defaults?.deep_reflect?.max_output_tokens || 4000,
      maxSteps,
      step: `reflect_depth_${depth}`,
    });

    // Apply output through mutation protocol
    await this.applyReflectOutput(depth, output, context);

    // Cascade — run next depth down
    if (depth > 1) {
      await this.runReflect(depth - 1, context);
    }
  }

  async gatherReflectContext(depth, context) {
    const wisdom = await this.kvGet("wisdom");
    const stagedMutations = await this.loadStagedMutations();
    const candidateMutations = await this.loadCandidateMutations();
    const systemKeyPatterns = {
      prefixes: Brainstem.SYSTEM_KEY_PREFIXES,
      exact: Brainstem.SYSTEM_KEY_EXACT,
    };

    const templateVars = {
      wisdom,
      currentDefaults: this.defaults,
      models: this.modelsConfig,
      stagedMutations,
      candidateMutations,
      systemKeyPatterns,
    };

    let userMessage;

    if (depth === 1) {
      // Depth 1: examines karma + orient prompt + session history
      const karmaKeys = context.kvIndex
        .filter(k => k.key.startsWith("karma:"))
        .sort((a, b) => b.key.localeCompare(a.key))
        .slice(0, 10)
        .map(k => k.key);
      const recentKarma = await this.loadKeys(karmaKeys);
      const orientPrompt = await this.kvGet("prompt:orient");
      const sessionHistory = await this.kvGet("session_history");

      templateVars.recentKarma = recentKarma;
      templateVars.orientPrompt = orientPrompt;
      templateVars.sessionHistory = sessionHistory;

      userMessage = JSON.stringify({
        depth,
        balances: context.balances,
        kv_usage: context.kvUsage,
        kv_index: context.kvIndex,
        effort: context.effort,
        crash_data: context.crashData,
        staged_mutations: stagedMutations,
        candidate_mutations: candidateMutations,
      });
    } else {
      // Depth N>1: examines depth N-1 outputs + below prompt
      const belowOutputs = await this.loadReflectHistory(depth - 1, 10);
      const belowPromptText = await this.loadBelowPrompt(depth);

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

  async applyReflectOutput(depth, output, context) {
    // 1. KV operations (gated by protection)
    if (output.kv_operations) {
      for (const op of output.kv_operations) {
        await this.applyKVOperation(op);
      }
    }

    // 2. Verdicts BEFORE new requests — clears conflicts first
    if (output.mutation_verdicts) {
      await this.processDeepReflectVerdicts(output.mutation_verdicts);
    }

    // 3. New mutation requests — applied directly as candidates
    if (output.mutation_requests) {
      for (const req of output.mutation_requests) {
        await this.applyDirectAsCandidate(req, this.sessionId);
      }
    }

    // 4. Schedule — store for this depth
    const schedule = output.next_reflect || output.next_deep_reflect;
    if (schedule) {
      await this.kvPut(`reflect:schedule:${depth}`, {
        ...schedule,
        last_reflect: new Date().toISOString(),
        last_reflect_session: await this.getSessionCount(),
      });
      // Backward compat: also write deep_reflect_schedule for depth 1
      if (depth === 1) {
        await this.kvPut("deep_reflect_schedule", {
          ...schedule,
          last_deep_reflect: new Date().toISOString(),
          last_deep_reflect_session: await this.getSessionCount(),
        });
      }
    }

    // 5. Store output as reflect:{depth}:{sessionId}
    await this.kvPut(`reflect:${depth}:${this.sessionId}`, {
      reflection: output.reflection,
      note_to_future_self: output.note_to_future_self,
      depth,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
    });

    // 6. Only depth 1: write last_reflect and wake_config
    if (depth === 1) {
      await this.kvPut("last_reflect", {
        session_summary: output.reflection,
        note_to_future_self: output.note_to_future_self,
        was_deep_reflect: true,
        depth,
        session_id: this.sessionId,
      });

      const wakeConf = output.next_wake_config || {};
      if (wakeConf.sleep_seconds) {
        wakeConf.next_wake_after = new Date(
          Date.now() + wakeConf.sleep_seconds * 1000
        ).toISOString();
      }
      await this.kvPut("wake_config", wakeConf);
    }

    // 7. Refresh defaults after every depth (cascade visibility)
    this.defaults = await this.kvGet("config:defaults");

    // 8. Karma
    await this.karmaRecord({
      event: "reflect_complete",
      depth,
      session_id: this.sessionId,
    });
  }

  // ── LLM calls (dynamic provider with cascade fallback) ─────
  // BOOTSTRAP NOTE: No hard daily spend cap is enforced here.
  // Swayambhu could add a config:budget_limits key and have the brainstem
  // refuse to call the LLM if daily cost exceeds the cap, regardless
  // of what orient requests. Orient optimizes; brainstem enforces floors.

  async callLLM({ model, effort, maxTokens, systemPrompt, messages, tools, step }) {
    const startMs = Date.now();

    // Build messages array, prepending system prompt if provided
    const msgs = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : [...messages];

    // Standardized request — provider adapter translates this
    const request = {
      model,
      max_tokens: maxTokens || 1000,
      messages: msgs,
      thinking: (effort && effort !== "none")
        ? { type: "adaptive", effort }
        : null,
      ...(tools?.length ? { tools } : {}),
    };

    // Try cascade: dynamic adapter → last working → hardcoded fallback
    const result = await this.callWithCascade(request, step);
    const durationMs = Date.now() - startMs;

    if (!result.ok) {
      await this.karmaRecord({
        event: "llm_call",
        step, model, effort,
        ok: false,
        error: result.error,
        duration_ms: durationMs,
        provider_tier: result.tier,
      });

      // Model fallback (separate from provider fallback)
      const fallbackModel = this.modelsConfig?.fallback_model
        || "anthropic/claude-haiku-4.5";
      if (model !== fallbackModel) {
        return this.callLLM({ model: fallbackModel, effort: "low", maxTokens,
          systemPrompt, messages, tools, step });
      }
      throw new Error(`LLM call failed on all providers: ${result.error}`);
    }

    const cost = this.estimateCost(model, result.usage) || 0;

    await this.karmaRecord({
      event: "llm_call",
      step, model, effort,
      ok: true,
      duration_ms: durationMs,
      provider_tier: result.tier,
      in_tokens: result.usage.prompt_tokens,
      out_tokens: result.usage.completion_tokens,
      thinking_tokens: result.usage.thinking_tokens || 0,
      cost,
      request: `[${msgs.length} messages]`,
      response: result.content?.slice(0, 2000) || null,
      tool_calls: result.toolCalls?.length || 0,
    });

    return { content: result.content, usage: result.usage, cost, toolCalls: result.toolCalls };
  }

  async callWithCascade(request, step) {
    // Tier 1: Dynamic adapter from KV
    try {
      const result = await this.callViaAdapter("llm_adapter", request);
      // Success — snapshot as last working (value + KV-native metadata)
      if (!this.lastWorkingSnapshotted) {
        const fn = await this.kvGetWithMeta("functions:llm_adapter");
        if (fn.value) {
          await this.kvPut("functions:llm_adapter:last_working", fn.value, fn.metadata);
          this.lastWorkingSnapshotted = true;
        }
      }
      return { ...result, ok: true, tier: "dynamic" };
    } catch (err) {
      await this.karmaRecord({
        event: "provider_fallback",
        from: "dynamic",
        to: "last_working",
        error: err.message,
      });
    }

    // Tier 2: Last known working adapter
    try {
      const result = await this.callViaAdapter("llm_adapter:last_working", request);
      return { ...result, ok: true, tier: "last_working" };
    } catch (err) {
      await this.karmaRecord({
        event: "provider_fallback",
        from: "last_working",
        to: "hardcoded",
        error: err.message,
      });
    }

    // Tier 3: Hardcoded OpenRouter — the absolute last resort
    try {
      const result = await this.hardcodedOpenRouterCall(request);
      return { ...result, ok: true, tier: "hardcoded" };
    } catch (err) {
      return { ok: false, error: err.message, tier: "all_failed" };
    }
  }

  async callViaAdapter(fnKey, request) {
    const fn = await this.kvGetWithMeta(`functions:${fnKey}`);
    if (!fn.value) throw new Error(`No adapter at functions:${fnKey}`);

    const meta = fn.metadata || {};

    // Build scoped secrets — same two-tier pattern as tools
    const secrets = {};
    for (const name of (meta.secrets || [])) {
      if (this.env[name] !== undefined) secrets[name] = this.env[name];
    }
    for (const name of (meta.kv_secrets || [])) {
      const val = await this.kvGet(`secret:${name}`);
      if (val !== null) secrets[name] = val;
    }

    const result = await this.runInIsolate({
      id: `fn:${fnKey}:${this.sessionId}`,
      moduleCode: fn.value,
      ctx: { ...request, secrets },
      timeoutMs: meta.timeout_ms || 60000,
    });

    // Adapter must return { content, usage } or { toolCalls, usage }
    if (!result || (typeof result.content !== "string" && !result.toolCalls?.length)) {
      throw new Error("Adapter returned invalid response — missing content and tool calls");
    }
    return result;
  }

  // Hardcoded fallback — this is the one thing that never changes
  async hardcodedOpenRouterCall(request) {
    const body = {
      model: request.model,
      max_tokens: request.max_tokens,
      messages: request.messages,
    };
    if (request.thinking) {
      body.provider = { require_parameters: true };
      body.thinking = request.thinking;
    }
    if (request.tools?.length) {
      body.tools = request.tools;
    }

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok || data.error) {
      throw new Error(JSON.stringify(data.error));
    }

    const msg = data.choices?.[0]?.message;
    return {
      content: msg?.content || "",
      usage: data.usage || {},
      toolCalls: msg?.tool_calls || null,
    };
  }

  // ── Agent loop (tool-calling execution primitive) ──────────

  buildToolDefinitions(extraTools = []) {
    const registry = this.toolRegistry || { tools: [] };
    const defs = registry.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.input || {}).map(([k, v]) => [k, { type: 'string', description: String(v) }])
          ),
        },
      },
    }));

    // Built-in: spawn a nested agent loop
    defs.push({
      type: 'function',
      function: {
        name: 'spawn_subplan',
        description: 'Spawn a nested agent to handle an independent sub-task. Multiple spawn_subplan calls in one turn execute in parallel.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'What the subplan should achieve' },
            model: { type: 'string', description: 'Model alias (default: haiku)' },
            max_steps: { type: 'number', description: 'Max turns (default: 5)' },
          },
          required: ['goal'],
        },
      },
    });

    return [...defs, ...extraTools];
  }

  async executeToolCall(toolCall) {
    const name = toolCall.function.name;
    const args = typeof toolCall.function.arguments === 'string'
      ? JSON.parse(toolCall.function.arguments)
      : toolCall.function.arguments || {};

    if (name === 'spawn_subplan') {
      return this.spawnSubplan(args);
    }

    return this.executeAction({
      tool: name,
      input: args,
      id: toolCall.id,
    });
  }

  async spawnSubplan(args, depth = 0) {
    const maxDepth = this.defaults?.execution?.max_subplan_depth || 3;
    if (depth >= maxDepth) {
      return { error: `Subplan depth limit (${maxDepth}) reached`, goal: args.goal };
    }

    const subplanPrompt = await this.kvGet("prompt:subplan") || this.defaultSubplanPrompt();
    const model = this.resolveModel(args.model || this.defaults?.execution?.fallback_model || 'haiku');
    const maxSteps = args.max_steps || 5;

    const builtPrompt = this.buildPrompt(subplanPrompt, {
      goal: args.goal,
      maxSteps,
      maxCost: args.max_cost || 0.05,
      executorModel: args.model || 'haiku',
    });

    // Subplan tools: same as parent
    const tools = this.buildToolDefinitions();

    return this.runAgentLoop({
      systemPrompt: builtPrompt,
      initialContext: `Execute this goal: ${args.goal}`,
      tools,
      model,
      effort: args.effort || 'low',
      maxTokens: args.max_output_tokens || 1000,
      maxSteps,
      step: `subplan_d${depth}`,
    });
  }

  async runAgentLoop({ systemPrompt, initialContext, tools, model, effort,
                       maxTokens, maxSteps, step }) {
    const messages = [];
    if (initialContext) {
      const content = typeof initialContext === 'string'
        ? initialContext
        : JSON.stringify(initialContext);
      messages.push({ role: 'user', content });
    }

    for (let i = 0; i < maxSteps; i++) {
      const response = await this.callLLM({
        model, effort, maxTokens,
        systemPrompt, messages, tools,
        step: `${step}_turn_${i}`,
      });
      this.sessionCost += response.cost;

      if (response.toolCalls?.length) {
        // Add assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: response.content || null,
          tool_calls: response.toolCalls,
        });

        // Execute tools in parallel
        const results = await Promise.all(
          response.toolCalls.map(tc => this.executeToolCall(tc)
            .catch(err => ({ error: err.message })))
        );

        // Add tool result messages (one per tool call)
        for (let j = 0; j < response.toolCalls.length; j++) {
          messages.push({
            role: 'tool',
            tool_call_id: response.toolCalls[j].id,
            content: JSON.stringify(results[j]),
          });
        }
        continue;
      }

      // No tool calls — final output
      return this.parseAgentOutput(response.content);
    }

    // Max steps reached — force final output (no tools, forces text)
    messages.push({ role: 'user', content: 'Maximum steps reached. Produce your final output now.' });
    const finalResponse = await this.callLLM({
      model, effort, maxTokens, systemPrompt, messages,
      step: `${step}_final`,
    });
    this.sessionCost += finalResponse.cost;
    return this.parseAgentOutput(finalResponse.content);
  }

  parseAgentOutput(content) {
    if (!content) return {};
    try { return JSON.parse(content); }
    catch { return { raw: content }; }
  }

  // ── Mutation protocol ──────────────────────────────────────

  evaluatePredicate(value, predicate, expected) {
    switch (predicate) {
      case "exists": return value !== null && value !== undefined;
      case "equals": return value === expected;
      case "gt": return typeof value === "number" && value > expected;
      case "lt": return typeof value === "number" && value < expected;
      case "matches": return typeof value === "string" && new RegExp(expected).test(value);
      case "type": return typeof value === expected;
      default: return false; // Unknown predicates fail closed
    }
  }

  async evaluateCheck(check) {
    try {
      switch (check.type) {
        case "kv_assert": {
          let value = await this.kvGet(check.key);
          if (check.path && value != null) {
            value = check.path.split(".").reduce((o, k) => o?.[k], value);
          }
          const passed = this.evaluatePredicate(value, check.predicate, check.expected);
          return { passed, detail: `${check.key}${check.path ? '.' + check.path : ''} ${check.predicate} ${JSON.stringify(check.expected)} → actual: ${JSON.stringify(value)}` };
        }
        case "tool_call": {
          const result = await this.executeAction({
            tool: check.tool,
            input: check.input || {},
            id: `check_${check.tool}`,
          });
          if (check.assert) {
            const passed = this.evaluatePredicate(result, check.assert.predicate, check.assert.expected);
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

  async evaluateChecks(checks) {
    const results = [];
    for (const check of checks) {
      results.push(await this.evaluateCheck(check));
    }
    return {
      all_passed: results.every(r => r.passed),
      results,
    };
  }

  async stageMutation(request, sessionId) {
    if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
      await this.karmaRecord({ event: "mutation_invalid", reason: "missing required fields (claims, ops, checks)" });
      return null;
    }
    const id = this.generateMutationId();
    await this.kvPut(`mutation_staged:${id}`, {
      id,
      claims: request.claims,
      ops: request.ops,
      checks: request.checks,
      staged_at: new Date().toISOString(),
      staged_by_session: sessionId,
    });
    await this.karmaRecord({ event: "mutation_staged", mutation_id: id, claims: request.claims });
    return id;
  }

  async applyStagedAsCandidate(mutationId) {
    const record = await this.kvGet(`mutation_staged:${mutationId}`);
    if (!record) throw new Error(`No staged mutation: ${mutationId}`);

    const targetKeys = record.ops.map(op => op.key);
    const conflict = await this.findCandidateConflict(targetKeys);
    if (conflict) {
      await this.karmaRecord({ event: "mutation_conflict", mutation_id: mutationId, conflicting_mutation: conflict.id, overlapping_keys: conflict.keys });
      throw new Error(`Conflict with candidate ${conflict.id} on keys: ${conflict.keys.join(", ")}`);
    }

    // Snapshot current values before applying
    const snapshots = {};
    for (const key of targetKeys) {
      const { value, metadata } = await this.kvGetWithMeta(key);
      snapshots[key] = { value: value !== null ? value : null, metadata };
    }

    // Apply ops
    for (const op of record.ops) {
      await this.applyKVOperationDirect(op);
    }

    // Write candidate record
    await this.kvPut(`mutation_candidate:${mutationId}`, {
      ...record,
      snapshots,
      activated_at: new Date().toISOString(),
    });
    await this.kv.delete(`mutation_staged:${mutationId}`);

    // Refresh defaults if ops touch config:defaults
    if (targetKeys.some(k => k === "config:defaults")) {
      this.defaults = await this.kvGet("config:defaults");
    }

    await this.karmaRecord({ event: "mutation_applied", mutation_id: mutationId, target_keys: targetKeys });
    return mutationId;
  }

  async applyDirectAsCandidate(request, sessionId) {
    if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
      await this.karmaRecord({ event: "mutation_invalid", reason: "missing required fields (claims, ops, checks)" });
      return null;
    }
    const id = this.generateMutationId();
    const targetKeys = request.ops.map(op => op.key);

    const conflict = await this.findCandidateConflict(targetKeys);
    if (conflict) {
      await this.karmaRecord({ event: "mutation_conflict", mutation_id: id, conflicting_mutation: conflict.id, overlapping_keys: conflict.keys });
      return null;
    }

    const snapshots = {};
    for (const key of targetKeys) {
      const { value, metadata } = await this.kvGetWithMeta(key);
      snapshots[key] = { value: value !== null ? value : null, metadata };
    }

    for (const op of request.ops) {
      await this.applyKVOperationDirect(op);
    }

    await this.kvPut(`mutation_candidate:${id}`, {
      id,
      claims: request.claims,
      ops: request.ops,
      checks: request.checks,
      snapshots,
      staged_by_session: sessionId,
      activated_at: new Date().toISOString(),
    });

    if (targetKeys.some(k => k === "config:defaults")) {
      this.defaults = await this.kvGet("config:defaults");
    }

    await this.karmaRecord({ event: "mutation_applied", mutation_id: id, target_keys: targetKeys });
    return id;
  }

  async promoteCandidate(mutationId) {
    await this.kv.delete(`mutation_candidate:${mutationId}`);
    await this.karmaRecord({ event: "mutation_promoted", mutation_id: mutationId });
  }

  async rollbackCandidate(mutationId, reason) {
    const record = await this.kvGet(`mutation_candidate:${mutationId}`);
    if (!record) return;

    // Restore snapshotted values
    for (const [key, snapshot] of Object.entries(record.snapshots || {})) {
      if (snapshot.value === null) {
        await this.kv.delete(key);
      } else {
        await this.kvPut(key, snapshot.value, snapshot.metadata || {});
      }
    }

    // Refresh defaults if applicable
    const targetKeys = Object.keys(record.snapshots || {});
    if (targetKeys.some(k => k === "config:defaults")) {
      this.defaults = await this.kvGet("config:defaults");
    }

    await this.kv.delete(`mutation_candidate:${mutationId}`);
    await this.karmaRecord({ event: "mutation_rolled_back", mutation_id: mutationId, reason });
  }

  async findCandidateConflict(targetKeys) {
    const kvIndex = await this.listKVKeys();
    const candidateKeys = kvIndex
      .filter(k => k.key.startsWith("mutation_candidate:"))
      .map(k => k.key);

    for (const ck of candidateKeys) {
      const record = await this.kvGet(ck);
      if (!record?.snapshots) continue;
      const overlap = targetKeys.filter(k => k in record.snapshots);
      if (overlap.length > 0) {
        return { id: record.id, keys: overlap };
      }
    }
    return null;
  }

  async loadStagedMutations() {
    const kvIndex = await this.listKVKeys();
    const stagedKeys = kvIndex
      .filter(k => k.key.startsWith("mutation_staged:"))
      .map(k => k.key);

    const result = {};
    for (const key of stagedKeys) {
      const record = await this.kvGet(key);
      if (!record) continue;
      const checkResults = await this.evaluateChecks(record.checks || []);
      result[record.id] = { record, check_results: checkResults };
    }
    return result;
  }

  async processReflectVerdicts(verdicts) {
    for (const v of verdicts || []) {
      switch (v.verdict) {
        case "withdraw":
          await this.kv.delete(`mutation_staged:${v.mutation_id}`);
          await this.karmaRecord({ event: "mutation_withdrawn", mutation_id: v.mutation_id });
          break;
        case "modify": {
          const record = await this.kvGet(`mutation_staged:${v.mutation_id}`);
          if (record) {
            await this.kvPut(`mutation_staged:${v.mutation_id}`, {
              ...record,
              ...(v.updated_ops ? { ops: v.updated_ops } : {}),
              ...(v.updated_checks ? { checks: v.updated_checks } : {}),
              ...(v.updated_claims ? { claims: v.updated_claims } : {}),
              modified_at: new Date().toISOString(),
            });
            await this.karmaRecord({ event: "mutation_modified", mutation_id: v.mutation_id });
          }
          break;
        }
        // Other verdict types silently ignored by reflect
      }
    }
  }

  async processDeepReflectVerdicts(verdicts) {
    for (const v of verdicts || []) {
      switch (v.verdict) {
        // Staged mutation verdicts
        case "apply":
          try { await this.applyStagedAsCandidate(v.mutation_id); }
          catch (err) { await this.karmaRecord({ event: "mutation_apply_failed", mutation_id: v.mutation_id, error: err.message }); }
          break;
        case "reject":
          await this.kv.delete(`mutation_staged:${v.mutation_id}`);
          await this.karmaRecord({ event: "mutation_rejected", mutation_id: v.mutation_id, reason: v.reason });
          break;
        case "withdraw":
          await this.kv.delete(`mutation_staged:${v.mutation_id}`);
          await this.karmaRecord({ event: "mutation_withdrawn", mutation_id: v.mutation_id });
          break;
        case "modify": {
          const record = await this.kvGet(`mutation_staged:${v.mutation_id}`);
          if (record) {
            await this.kvPut(`mutation_staged:${v.mutation_id}`, {
              ...record,
              ...(v.updated_ops ? { ops: v.updated_ops } : {}),
              ...(v.updated_checks ? { checks: v.updated_checks } : {}),
              ...(v.updated_claims ? { claims: v.updated_claims } : {}),
              modified_at: new Date().toISOString(),
            });
            await this.karmaRecord({ event: "mutation_modified", mutation_id: v.mutation_id });
          }
          break;
        }
        // Candidate mutation verdicts
        case "promote":
          await this.promoteCandidate(v.mutation_id);
          break;
        case "rollback":
          await this.rollbackCandidate(v.mutation_id, v.reason || "deep_reflect_verdict");
          break;
        // Shared
        case "defer":
          await this.karmaRecord({ event: "mutation_deferred", mutation_id: v.mutation_id, reason: v.reason });
          break;
      }
    }
  }

  async runCircuitBreaker() {
    const kvIndex = await this.listKVKeys();
    const candidateKeys = kvIndex
      .filter(k => k.key.startsWith("mutation_candidate:"))
      .map(k => k.key);

    const dangerSignals = ["fatal_error", "orient_parse_error", "all_providers_failed"];

    for (const ck of candidateKeys) {
      const record = await this.kvGet(ck);
      if (!record?.activated_at) continue;

      const activatedAt = new Date(record.activated_at).getTime();

      // Scan karma logs for danger signals after activation
      const karmaKeys = kvIndex
        .filter(k => k.key.startsWith("karma:"))
        .map(k => k.key);

      let shouldRollback = false;
      for (const kk of karmaKeys) {
        const entries = await this.kvGet(kk);
        if (!Array.isArray(entries)) continue;
        if (entries.some(e => e.t >= activatedAt && dangerSignals.includes(e.event))) {
          shouldRollback = true;
          break;
        }
      }

      if (shouldRollback) {
        await this.rollbackCandidate(record.id, "circuit_breaker");
        await this.karmaRecord({ event: "circuit_breaker_fired", mutation_id: record.id });
      }
    }
  }

  async loadCandidateMutations() {
    const kvIndex = await this.listKVKeys();
    const candidateKeys = kvIndex
      .filter(k => k.key.startsWith("mutation_candidate:"))
      .map(k => k.key);

    const result = {};
    for (const key of candidateKeys) {
      const record = await this.kvGet(key);
      if (!record) continue;
      const checkResults = await this.evaluateChecks(record.checks || []);
      result[record.id] = { record, check_results: checkResults };
    }
    return result;
  }

  // ── Helpers ─────────────────────────────────────────────────

  // Config-driven balance checks — iterates providers and wallets KV configs,
  // calling functions:check_{type} for each. No hardcoded provider logic.
  async getBalances() {
    const [providers, wallets] = await Promise.all([
      this.kvGet("providers"),
      this.kvGet("wallets"),
    ]);

    const balances = { providers: {}, wallets: {} };

    for (const [name, config] of Object.entries(providers || {})) {
      const fn = await this.kvGetWithMeta(`functions:check_${config.provider}`);
      if (!fn.value) continue;

      const secret = config.secret_store === "env"
        ? this.env[config.secret_name] ?? null
        : await this.kvGet(`secret:${config.secret_name}`);

      try {
        balances.providers[name] = await this.runInIsolate({
          id: `fn:check_${config.provider}:${this.sessionId}`,
          moduleCode: fn.value,
          ctx: { provider: config, secret },
          timeoutMs: fn.metadata?.timeout_ms || 10000,
        });
      } catch { balances.providers[name] = null; }
    }

    for (const [name, config] of Object.entries(wallets || {})) {
      const fn = await this.kvGetWithMeta(`functions:check_${config.network}`);
      if (!fn.value) continue;

      try {
        balances.wallets[name] = await this.runInIsolate({
          id: `fn:check_${config.network}:${this.sessionId}`,
          moduleCode: fn.value,
          ctx: { wallet: config },
          timeoutMs: fn.metadata?.timeout_ms || 10000,
        });
      } catch { balances.wallets[name] = null; }
    }

    return balances;
  }

  async getKVUsage() {
    return { writes_this_session: this.kvWritesThisSession };
  }

  async kvGet(key) {
    try {
      const val = await this.kv.get(key, "json");
      return val;
    } catch {
      try {
        return await this.kv.get(key, "text");
      } catch {
        return null;
      }
    }
  }

  // Returns { value, metadata } using KV's native metadata slot.
  // Value is returned as raw text (not JSON-parsed).
  async kvGetWithMeta(key) {
    try {
      return await this.kv.getWithMetadata(key, "text");
    } catch {
      return { value: null, metadata: null };
    }
  }

  async kvPut(key, value, metadata = {}) {
    // Protect immutable keys
    if (key === "soul") {
      throw new Error("Cannot overwrite soul — immutable key");
    }

    // System keys cannot be marked unprotected
    if (Brainstem.isSystemKey(key)) delete metadata.unprotected;

    // Auto-tag: guarantee every key has at minimum a type based on prefix
    const prefix = key.split(":")[0];
    const defaults = {
      providers:  { type: "config" },
      wallets:    { type: "config" },
      functions:  { type: "function", runtime: "worker" },
      karma:      { type: "log" },
      prompt:     { type: "prompt" },
      config:     { type: "config" },
      soul:       { type: "core", immutable: true },
      secret:     { type: "secret" },
      session:    { type: "session" },
      tooldata:   { type: "tooldata" },
      reflect:    { type: "reflect_output" },
    };
    const finalMetadata = {
      ...defaults[prefix],
      ...metadata,  // caller can override/extend
      updated_at: new Date().toISOString(),
    };

    const data = typeof value === "string" ? value : JSON.stringify(value);
    await this.kv.put(key, data, { metadata: finalMetadata });
    this.kvWritesThisSession++;
  }

  async listKVKeys() {
    const keys = [];
    const result = await this.kv.list({ limit: 1000 });
    for (const key of result.keys) {
      keys.push({ key: key.name, metadata: key.metadata });
    }
    return keys;
  }

  async loadKeys(keys) {
    const context = {};
    for (const key of keys) {
      context[key] = await this.kvGet(key);
    }
    return context;
  }

  resolveModel(modelOrAlias) {
    return this.modelsConfig?.alias_map?.[modelOrAlias] || modelOrAlias;
  }

  estimateCost(model, usage) {
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    const modelInfo = this.modelsConfig?.models?.find(
      m => m.id === model || m.alias === model
    );
    if (!modelInfo) return null;
    return (inputTokens * modelInfo.input_cost_per_mtok
      + outputTokens * modelInfo.output_cost_per_mtok) / 1_000_000;
  }

  mergeDefaults(defaults, overrides) {
    if (!overrides) return defaults || {};
    if (!defaults) return overrides;
    const merged = { ...defaults };
    for (const [key, val] of Object.entries(overrides)) {
      if (val && typeof val === "object" && !Array.isArray(val) && merged[key]) {
        merged[key] = { ...merged[key], ...val };
      } else {
        merged[key] = val;
      }
    }
    return merged;
  }

  evaluateTripwires(config, liveData) {
    const alerts = config.alerts || [];
    let effort = config.default_effort || config.wake?.default_effort || "low";
    for (const alert of alerts) {
      // Support dotted paths like "balances.providers.or:main"
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


  async getSessionCount() {
    const counter = await this.kvGet("session_counter");
    return counter || 0;
  }

  async applyKVOperation(op) {
    const key = op.key;

    // System keys always blocked — must go through mutation protocol
    if (Brainstem.isSystemKey(key)) {
      await this.karmaRecord({
        event: "mutation_blocked",
        key,
        reason: "system_key",
      });
      return;
    }

    // Agent keys: check KV-native metadata for unprotected flag
    const { metadata } = await this.kvGetWithMeta(key);
    if (!metadata?.unprotected) {
      await this.karmaRecord({
        event: "mutation_blocked",
        key,
        reason: "protected_key",
      });
      return;
    }

    await this.applyKVOperationDirect(op);
  }

  async applyKVOperationDirect(op) {
    switch (op.op) {
      case "put":
        await this.kvPut(op.key, op.value, op.metadata);
        break;
      case "delete":
        await this.kv.delete(op.key);
        break;
      case "rename": {
        const { value, metadata } = await this.kvGetWithMeta(op.key);
        if (value !== null) {
          await this.kvPut(op.value, value, metadata);
          await this.kv.delete(op.key);
        }
        break;
      }
    }
  }

  async writeSessionResults(plan, config) {
    const writes = [];

    if (plan.next_wake_config) {
      const wakeConf = { ...plan.next_wake_config };
      if (wakeConf.sleep_seconds) {
        wakeConf.next_wake_after = new Date(
          Date.now() + wakeConf.sleep_seconds * 1000
        ).toISOString();
      }
      writes.push(this.kvPut("wake_config", wakeConf));
    }

    writes.push(
      this.getSessionCount().then(count =>
        this.kvPut("session_counter", count + 1)
      )
    );

    return Promise.all(writes);
  }

  buildPrompt(template, vars) {
    if (!template) return JSON.stringify(vars);
    let result = typeof template === "string" ? template : JSON.stringify(template);
    result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
      const val = path.split(".").reduce((obj, key) => obj?.[key], vars);
      if (val === undefined) return match;
      return typeof val === "string" ? val : JSON.stringify(val);
    });
    return result;
  }

  defaultSubplanPrompt() {
    return `You are executing a subgoal. You have tools available via function calling.

Goal: {{goal}}

Use your tools to accomplish this goal. When done, produce a JSON object
with a "result" field summarizing what you accomplished.

Budget: max {{maxSteps}} turns, max ${{maxCost}}.`;
  }

  defaultReflectPrompt() {
    return `You are reflecting on a session that just completed.
Session karma log: {{karma}}
Total cost: ${{sessionCost}}

Produce a JSON object with: session_summary, note_to_future_self,
next_orient_context (with load_keys array), and optionally
next_wake_config and kv_operations.`;
  }

  defaultDeepReflectPrompt(depth) {
    if (depth === 1) {
      return `You are performing a depth-1 reflection. This is a deep examination of your recent operations.

Your soul: {{soul}}

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

Your soul: {{soul}}

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

  elapsed() {
    return Date.now() - this.startTime;
  }
}

export { Brainstem };
