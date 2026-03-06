// Swayambhu Kernel
// Hardcoded primitives + safety + alerting + hook dispatch.
// Policy (wake flow, reflection, mutation protocol) lives in wake-hook.js,
// stored in KV as hook:wake:code, and executed via Worker Loader isolate.
//
// The kernel exposes primitives via KernelRPC (WorkerEntrypoint).
// The hook composes them. Day 1 it's the current logic.
// Day N the model restructures it via reflection.
//
// Tools are loaded dynamically from KV and executed in sandboxed isolates.
// The karma log records every LLM call and tool execution with full request/response.

// CF-SPECIFIC: WorkerEntrypoint is the CF RPC mechanism for cross-isolate calls
import { WorkerEntrypoint } from "cloudflare:workers";

// CF-SPECIFIC: WorkerEntrypoint subclass — RPC bridge giving isolate-loaded tools scoped KV access
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
    const fmt = typeof value === "string" ? "text" : "json";
    await this.env.KV.put(resolved, typeof value === "string" ? value : JSON.stringify(value), {
      metadata: { type: "tooldata", format: fmt, updated_at: new Date().toISOString() },
    });
  }
  async list(opts = {}) {
    const { toolName, kvAccess } = this.ctx.props;
    if (kvAccess === "own") {
      const scope = `tooldata:${toolName}:`;
      const result = await this.env.KV.list({ ...opts, prefix: scope + (opts.prefix || "") });
      return {
        keys: result.keys.map(k => ({ ...k, name: k.name.slice(scope.length) })),
        list_complete: result.list_complete,
      };
    }
    return this.env.KV.list(opts);
  }
}

// Module-level reference to active Brainstem instance.
// Safe — Workers process one request per isolate.
let _activeBrain = null;

// CF-SPECIFIC: WorkerEntrypoint subclass — RPC bridge giving the wake hook access to kernel primitives
export class KernelRPC extends WorkerEntrypoint {
  _brain() {
    if (!_activeBrain) throw new Error("KernelRPC: no active brainstem instance");
    return _activeBrain;
  }

  // LLM
  async callLLM(opts) { return this._brain().callLLM(opts); }

  // KV reads
  async kvGet(key) { return this._brain().kvGet(key); }
  async kvGetWithMeta(key) { return this._brain().kvGetWithMeta(key); }
  async kvList(opts) { return this._brain().kv.list(opts); }

  // KV writes — safe tier (blocks system + kernel keys)
  async kvPutSafe(key, value, metadata) { return this._brain().kvPutSafe(key, value, metadata); }
  async kvDeleteSafe(key) { return this._brain().kvDeleteSafe(key); }

  // KV writes — privileged tier (snapshots to karma, rate-limited)
  async kvWritePrivileged(ops) { return this._brain().kvWritePrivileged(ops); }

  // Agent loop
  async runAgentLoop(opts) { return this._brain().runAgentLoop(opts); }
  async executeToolCall(tc) { return this._brain().executeToolCall(tc); }
  async buildToolDefinitions(extra) { return this._brain().buildToolDefinitions(extra); }
  async spawnSubplan(args, depth) { return this._brain().spawnSubplan(args, depth); }
  async callHook(name, ctx) { return this._brain().callHook(name, ctx); }

  // Sandbox
  async executeAction(step) { return this._brain().executeAction(step); }
  async executeAdapter(adapterKey, input) { return this._brain().executeAdapter(adapterKey, input); }

  // Karma
  async karmaRecord(entry) { return this._brain().karmaRecord(entry); }

  // Alerting — NOT exposed (kernel-internal only)

  // Utility
  async resolveModel(m) { return this._brain().resolveModel(m); }
  async estimateCost(model, usage) { return this._brain().estimateCost(model, usage); }
  async buildPrompt(template, vars) { return this._brain().buildPrompt(template, vars); }
  async parseAgentOutput(content) { return this._brain().parseAgentOutput(content); }
  async loadKeys(keys) { return this._brain().loadKeys(keys); }
  async getSessionCount() { return this._brain().getSessionCount(); }
  async mergeDefaults(defaults, overrides) { return this._brain().mergeDefaults(defaults, overrides); }
  async isSystemKey(key) { return Brainstem.isSystemKey(key); }

  // State (read-only)
  async getSessionId() { return this._brain().sessionId; }
  async getSessionCost() { return this._brain().sessionCost; }
  async getKarma() { return this._brain().karma; }
  async getDefaults() { return this._brain().defaults; }
  async getModelsConfig() { return this._brain().modelsConfig; }
  async getDharma() { return this._brain().dharma; }
  async getToolRegistry() { return this._brain().toolRegistry; }
  async elapsed() { return this._brain().elapsed(); }
}

// CF-SPECIFIC: scheduled() is the CF cron trigger entry point
export default {
  async scheduled(event, env, ctx) {
    const brain = new Brainstem(env, { ctx });
    await brain.runScheduled();
  },
};

class Brainstem {
  constructor(env, opts = {}) {
    this.env = env;
    this.ctx = opts.ctx || null;
    this.kv = env.KV;  // CF-SPECIFIC: KV namespace binding from wrangler.toml
    this.startTime = Date.now();
    this.sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessionCost = 0;
    this.sessionLLMCalls = 0;
    this.karma = [];           // The flight recorder — replaces this.log
    this.kvWritesThisSession = 0;
    this.modelsConfig = null;
    this.defaults = null;
    this.dharma = null;
    this.toolsCache = {};      // Loaded tool code+meta, cached per session
    this.lastWorkingSnapshotted = false; // Only snapshot provider once per session
    this.privilegedWriteCount = 0; // Counter for kvWritePrivileged calls
    this._alertConfigCache = undefined; // undefined = not loaded, null = doesn't exist
  }

  static SYSTEM_KEY_PREFIXES = [
    'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
    'mutation_staged:', 'mutation_candidate:', 'hook:', 'doc:',
  ];
  static KERNEL_ONLY_PREFIXES = ['kernel:'];
  static SYSTEM_KEY_EXACT = ['providers', 'wallets', 'wisdom'];
  static DANGER_SIGNALS = ["fatal_error", "orient_parse_error", "all_providers_failed"];
  static MAX_PRIVILEGED_WRITES = 50;

  static isSystemKey(key) {
    if (Brainstem.SYSTEM_KEY_EXACT.includes(key)) return true;
    return Brainstem.SYSTEM_KEY_PREFIXES.some(p => key.startsWith(p));
  }

  static isKernelOnly(key) {
    return Brainstem.KERNEL_ONLY_PREFIXES.some(p => key.startsWith(p));
  }

  // ── Karma log ────────────────────────────────────────────────

  async karmaRecord(entry) {
    const record = {
      t: Date.now(),
      elapsed_ms: this.elapsed(),
      ...entry,
    };
    this.karma.push(record);
    await this.kvPut(`karma:${this.sessionId}`, this.karma);

    if (Brainstem.DANGER_SIGNALS.includes(entry.event)) {
      await this.kvPut("last_danger", {
        t: record.t,
        event: entry.event,
        session_id: this.sessionId,
      });
    }
  }

  // ── Kernel alerting ────────────────────────────────────────

  async sendKernelAlert(event, message) {
    try {
      if (this._alertConfigCache === undefined) {
        this._alertConfigCache = await this.kvGet("kernel:alert_config");
      }
      const config = this._alertConfigCache;
      if (!config?.url) return;

      // Resolve {{ENV_VAR}} patterns in URL from this.env
      const url = config.url.replace(/\{\{(\w+)\}\}/g, (_, name) => this.env[name] || "");

      // Build body from template, interpolating {{message}}, {{event}}, {{session}}
      const vars = { message, event, session: this.sessionId };
      const bodyStr = JSON.stringify(config.body_template || {})
        .replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] || "");

      await fetch(url, {
        method: "POST",
        headers: config.headers || { "Content-Type": "application/json" },
        body: bodyStr,
      });
    } catch {
      // Alerting must never crash the kernel — swallow errors
    }
  }

  // ── KV write tiers (RPC-exposed) ─────────────────────────

  async kvPutSafe(key, value, metadata) {
    if (key === "dharma") throw new Error("Cannot overwrite dharma — immutable key");
    if (Brainstem.isKernelOnly(key)) throw new Error(`Blocked: kernel-only key "${key}"`);
    if (Brainstem.isSystemKey(key)) throw new Error(`Blocked: system key "${key}" — use kvWritePrivileged`);
    return this.kvPut(key, value, metadata);
  }

  async kvDeleteSafe(key) {
    if (key === "dharma") throw new Error("Cannot delete dharma — immutable key");
    if (Brainstem.isKernelOnly(key)) throw new Error(`Blocked: kernel-only key "${key}"`);
    if (Brainstem.isSystemKey(key)) throw new Error(`Blocked: system key "${key}" — use kvWritePrivileged`);
    return this.kv.delete(key);
  }

  async kvWritePrivileged(ops) {
    if (!Array.isArray(ops) || ops.length === 0) return;

    for (const op of ops) {
      if (op.key === "dharma") throw new Error("Cannot write dharma — immutable key");
      if (Brainstem.isKernelOnly(op.key)) throw new Error(`Blocked: kernel-only key "${op.key}"`);
    }

    if (this.privilegedWriteCount + ops.length > Brainstem.MAX_PRIVILEGED_WRITES) {
      throw new Error(`Privileged write limit (${Brainstem.MAX_PRIVILEGED_WRITES}/session) exceeded`);
    }

    const configKeys = ["config:defaults", "config:models", "config:tool_registry"];

    for (const op of ops) {
      // Snapshot current value before writing
      const { value: oldValue, metadata: oldMeta } = await this.kvGetWithMeta(op.key);
      await this.karmaRecord({
        event: "privileged_write",
        key: op.key,
        old_value: oldValue,
        new_value: op.value,
        op: op.op,
      });

      // Execute the operation
      if (op.op === "delete") {
        await this.kv.delete(op.key);
      } else {
        await this.kvPut(op.key, op.value, op.metadata);
      }

      this.privilegedWriteCount++;

      // Alert on hook: key writes + set dirty flag for snapshot tracking
      if (op.key.startsWith("hook:")) {
        await this.sendKernelAlert("hook_write",
          `Privileged write to ${op.key} in session ${this.sessionId}`);
        if (op.key.startsWith("hook:wake:")) {
          await this.kvPut("kernel:hook_dirty", true);
        }
      }
    }

    // Auto-reload cached config after privileged writes to config keys
    const touchedConfig = ops.some(op => configKeys.includes(op.key));
    if (touchedConfig) {
      if (ops.some(op => op.key === "config:defaults"))
        this.defaults = await this.kvGet("config:defaults");
      if (ops.some(op => op.key === "config:models"))
        this.modelsConfig = await this.kvGet("config:models");
      if (ops.some(op => op.key === "config:tool_registry"))
        this.toolRegistry = await this.kvGet("config:tool_registry");
    }
  }

  // ── Hook dispatch (scheduled entry point) ─────────────────

  async runScheduled() {
    const brain = this;

    // 1. Detect platform kill from previous session
    await brain.detectPlatformKill();

    // 2. Meta-safety check
    const hookSafe = await brain.checkHookSafety();

    // 3. Load hook modules (manifest or single code)
    let modules = null;
    let mainModule = null;
    if (hookSafe) {
      const manifest = await brain.kvGet("hook:wake:manifest");
      if (manifest) {
        // manifest maps filenames → KV keys; "main" entry is the entry point
        modules = {};
        for (const [filename, kvKey] of Object.entries(manifest)) {
          modules[filename] = await brain.kvGet(kvKey);
        }
        mainModule = "main" in manifest ? "main" : Object.keys(manifest)[0];
      } else {
        const hookCode = await brain.kvGet("hook:wake:code");
        if (hookCode) {
          modules = { "hook.js": hookCode };
          mainModule = "hook.js";
        }
      }
    }

    // 4. Execute hook or fallback
    if (modules) {
      await brain.executeHook(modules, mainModule);
    } else {
      // Hardcoded minimal fallback — or legacy wake() path
      await brain.wake();
    }
  }

  async detectPlatformKill() {
    const activeSession = await this.kvGet("kernel:active_session");
    if (!activeSession) return;

    // Previous session was platform-killed — inject into last_sessions
    const history = await this.kvGet("kernel:last_sessions") || [];
    history.unshift({ id: activeSession, outcome: "killed", ts: new Date().toISOString() });
    while (history.length > 5) history.pop();
    await this.kvPut("kernel:last_sessions", history);

    // Clean up the stale marker
    await this.kv.delete("kernel:active_session");
  }

  async checkHookSafety() {
    const history = await this.kvGet("kernel:last_sessions") || [];
    if (history.length < 3) return true;

    const last3 = history.slice(0, 3);
    const allBad = last3.every(s => s.outcome === "crash" || s.outcome === "killed");
    if (!allBad) return true;

    // Tripwire fires — delete current hook (manifest-aware)
    const manifest = await this.kvGet("hook:wake:manifest");
    if (manifest) {
      for (const kvKey of Object.values(manifest)) {
        await this.kv.delete(kvKey);
      }
      await this.kv.delete("hook:wake:manifest");
    } else {
      await this.kv.delete("hook:wake:code");
    }

    await this.karmaRecord({ event: "hook_safety_reset", last_sessions: last3 });

    // Attempt auto-restore from last known good hook
    const snapshot = await this.kvGet("kernel:last_good_hook");
    if (snapshot) {
      if (snapshot.manifest) {
        await this.kvPut("hook:wake:manifest", snapshot.manifest);
        for (const [kvKey, code] of Object.entries(snapshot.modules)) {
          await this.kvPut(kvKey, code);
        }
      } else {
        await this.kvPut("hook:wake:code", snapshot.code);
      }
      // Anti-loop: delete snapshot so a second tripwire falls through to fallback
      await this.kv.delete("kernel:last_good_hook");
      await this.sendKernelAlert("hook_reset",
        "Hook safety reset. Restored last good version.");
      return true;
    }

    // No good version to restore — fall back to minimal
    await this.sendKernelAlert("hook_reset",
      "Hook safety reset. No good version to restore. Running minimal mode.");
    return false;
  }

  async executeHook(modules, mainModule) {
    // Write active session marker (catches platform kills)
    await this.kvPut("kernel:active_session", this.sessionId);

    let outcome = "clean";
    try {
      // Platform-specific hook invocation (overridable)
      await this._invokeHookModules(modules, mainModule);
    } catch (err) {
      outcome = "crash";
      await this.karmaRecord({
        event: "hook_execution_error",
        error: err.message,
        stack: err.stack,
      });

      // Fall back to hardcoded minimal in same session
      await this.runMinimalFallback();
    }

    // Update session history
    await this.updateSessionOutcome(outcome);

    // Clean up active session marker
    await this.kv.delete("kernel:active_session");
  }

  // Platform-specific: invoke hook modules in CF Worker Loader isolate
  async _invokeHookModules(modules, mainModule) {
    _activeBrain = this;
    try {
      // CF-SPECIFIC: env.LOADER is a [[worker_loaders]] binding; ctx.exports.* are loopback bindings
      const worker = this.env.LOADER.get(`hook:wake:${this.sessionId}`, () => ({
        compatibilityDate: "2025-06-01",
        mainModule,
        modules,
        env: {
          KERNEL: this.ctx.exports.KernelRPC({}),
        },
      }));

      const entrypoint = worker.getEntrypoint();
      const request = new Request("https://internal/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId }),
      });

      const response = await entrypoint.fetch(request);
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Hook returned ${response.status}: ${body}`);
      }
    } finally {
      _activeBrain = null;
    }
  }

  async updateSessionOutcome(outcome) {
    const history = await this.kvGet("kernel:last_sessions") || [];
    history.unshift({ id: this.sessionId, outcome, ts: new Date().toISOString() });
    while (history.length > 5) history.pop();
    await this.kvPut("kernel:last_sessions", history);

    // Snapshot hook as last_good_hook on clean outcome
    if (outcome === "clean") {
      const dirty = await this.kvGet("kernel:hook_dirty");
      const existing = await this.kvGet("kernel:last_good_hook");
      if (!dirty && existing) return; // no modification since last snapshot

      const manifest = await this.kvGet("hook:wake:manifest");
      if (manifest) {
        const modules = {};
        for (const [filename, kvKey] of Object.entries(manifest)) {
          modules[kvKey] = await this.kvGet(kvKey);
        }
        await this.kvPut("kernel:last_good_hook", { manifest, modules });
      } else {
        const code = await this.kvGet("hook:wake:code");
        if (!code) return; // no hook loaded, nothing to snapshot
        await this.kvPut("kernel:last_good_hook", { code });
      }

      if (dirty) await this.kv.delete("kernel:hook_dirty");
    }
  }

  async runMinimalFallback() {
    await this.sendKernelAlert("hook_reset",
      "Hook execution failed. Running minimal recovery mode.");

    const hardcodedPrompt = `You are Swayambhu in recovery mode. Your wake hook has been reset due to repeated failures. Check your balances and report your status via send_telegram. Do not attempt complex operations.`;

    this.defaults = { session_budget: { max_cost: 0.50, max_steps: 3, max_duration_seconds: 120 } };
    this.modelsConfig = this.modelsConfig || await this.kvGet("config:models");
    this.toolRegistry = this.toolRegistry || await this.kvGet("config:tool_registry");
    this.dharma = this.dharma || await this.kvGet("dharma");

    const tools = this.buildToolDefinitions();
    const fallbackModel = this.modelsConfig?.fallback_model
      || await this.kvGet("kernel:fallback_model");
    if (!fallbackModel) throw new Error("No fallback model configured");
    const model = this.resolveModel(fallbackModel);

    try {
      await this.runAgentLoop({
        systemPrompt: hardcodedPrompt,
        initialContext: "Recovery mode. Check balances and report status.",
        tools,
        model,
        effort: "low",
        maxTokens: 1000,
        maxSteps: 3,
        step: "recovery",
      });
      // Don't process kv_operations — discard them
    } catch (err) {
      await this.karmaRecord({
        event: "recovery_error",
        error: err.message,
      });
    }

    // Write session counter via internal kvPut
    const count = await this.getSessionCount();
    await this.kvPut("session_counter", count + 1);
  }

  // ── Wake cycle ──────────────────────────────────────────────

  // ── Minimal fallback (no hook:wake:code in KV) ─────────────
  // Used when no hook is loaded, or after the hook safety tripwire fires.
  // Runs a hardcoded recovery session — does NOT load prompt:orient
  // (could be corrupted). Does NOT process kv_operations from output.

  async wake() {
    await this.runMinimalFallback();
    await this.updateSessionOutcome("clean");
  }

  // ── Actions (dynamic tools) ─────────────────────────────────

  async executeAction(step) {
    const toolName = step.tool;

    // Load tool code + meta (platform-specific, overridable)
    const { meta, moduleCode } = await this._loadTool(toolName);

    // Build sandboxed context based on function metadata
    const ctx = await this.buildToolContext(toolName, meta || {}, step.input || {});

    // Record pre-execution in karma (this is the crash breadcrumb)
    await this.karmaRecord({
      event: "tool_start",
      tool: toolName,
      step_id: step.id,
      input_summary: step.input || {},
    });

    // Execute (platform-specific, overridable)
    try {
      const result = await this._executeTool(toolName, moduleCode, meta, ctx);

      // Record success
      await this.karmaRecord({
        event: "tool_complete",
        tool: toolName,
        step_id: step.id,
        ok: true,
        result_summary: result,
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

  async executeAdapter(adapterKey, input) {
    const [code, meta] = await Promise.all([
      this.kvGet(`${adapterKey}:code`),
      this.kvGet(`${adapterKey}:meta`),
    ]);
    if (!code) throw new Error(`No adapter at ${adapterKey}:code`);
    const ctx = await this.buildToolContext(adapterKey, meta || {}, input);
    return this._executeTool(adapterKey, code, meta, ctx);
  }

  // Platform-specific: load tool code + meta from KV (cached per session)
  async _loadTool(toolName) {
    if (!this.toolsCache[toolName]) {
      const [code, meta] = await Promise.all([
        this.kvGet(`tool:${toolName}:code`),
        this.kvGet(`tool:${toolName}:meta`),
      ]);
      if (!code) throw new Error(`Unknown tool: ${toolName} — no code at tool:${toolName}:code`);
      this.toolsCache[toolName] = { code, meta };
    }
    const { code: moduleCode, meta } = this.toolsCache[toolName];
    return { moduleCode, meta };
  }

  // Platform-specific: execute tool code in CF Worker Loader isolate
  async _executeTool(toolName, moduleCode, meta, ctx) {
    return this.runInIsolate({
      id: `fn:${toolName}:${this.sessionId}`,
      moduleCode,
      ctx,
      kvAccess: meta?.kv_access,
      toolName,
      timeoutMs: meta?.timeout_ms || 15000,
    });
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

  // ── Module wrapping for Worker Loader ───────────────────────

  static wrapAsModule(rawCode) {
    return `${rawCode}

const _fn = typeof execute === "function" ? execute
          : typeof call === "function" ? call
          : typeof check === "function" ? check
          : null;

export default {
  async fetch(request, env) {
    try {
      if (!_fn) return Response.json({ ok: false, error: "No execute/call/check function found" });
      const ctx = await request.json();
      ctx.fetch = fetch;
      if (env.KV_BRIDGE) ctx.kv = env.KV_BRIDGE;
      const result = await _fn(ctx);
      return Response.json({ ok: true, result });
    } catch (e) {
      return Response.json({ ok: false, error: e.message || String(e) });
    }
  },
};
`;
  }

  // ── Isolate execution (Worker Loader API) ───────────────────

  async runInIsolate({ id, moduleCode, ctx, kvAccess, toolName, timeoutMs }) {
    const hasKV = kvAccess && kvAccess !== "none";

    // Wrap raw functions as ES modules if needed (Worker Loader requires export default)
    const isESModule = /export\s+default\s/.test(moduleCode);
    const finalCode = isESModule ? moduleCode : Brainstem.wrapAsModule(moduleCode);

    // CF-SPECIFIC: env.LOADER is a [[worker_loaders]] binding; ctx.exports.* are loopback bindings
    const worker = this.env.LOADER.get(id, () => ({
      compatibilityDate: "2025-06-01",
      mainModule: "fn.js",
      modules: { "fn.js": finalCode },
      env: {
        ...(hasKV ? { KV_BRIDGE: this.ctx.exports.ScopedKV({ props: { toolName, kvAccess } }) } : {}),
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

  // ── LLM calls (dynamic provider with cascade fallback) ─────

  async callLLM({ model, effort, maxTokens, systemPrompt, messages, tools, step }) {
    const budget = this.defaults?.session_budget;
    if (budget?.max_cost && this.sessionCost >= budget.max_cost)
      throw new Error("Budget exceeded: cost");
    if (budget?.max_steps && this.sessionLLMCalls >= budget.max_steps)
      throw new Error("Budget exceeded: steps");
    if (budget?.max_duration_seconds && this.elapsed() > budget.max_duration_seconds * 1000)
      throw new Error("Budget exceeded: duration");

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
        || await this.kvGet("kernel:fallback_model")
        || null;
      if (fallbackModel && model !== fallbackModel) {
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
      request: msgs,
      response: result.content || null,
      tool_calls: result.toolCalls || [],
      tools_available: tools?.map(t => ({ name: t.function?.name, description: t.function?.description })) || [],
    });

    this.sessionCost += cost;
    this.sessionLLMCalls++;

    return { content: result.content, usage: result.usage, cost, toolCalls: result.toolCalls };
  }

  async callWithCascade(request, step) {
    // Tier 1: Dynamic adapter from KV
    try {
      const result = await this.callViaAdapter("llm", request);
      // Success — snapshot as last working
      if (!this.lastWorkingSnapshotted) {
        const [code, meta] = await Promise.all([
          this.kvGet("provider:llm:code"),
          this.kvGet("provider:llm:meta"),
        ]);
        if (code) {
          await this.kvPut("provider:llm:last_working:code", code);
          await this.kvPut("provider:llm:last_working:meta", meta);
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
      const result = await this.callViaAdapter("llm:last_working", request);
      return { ...result, ok: true, tier: "last_working" };
    } catch (err) {
      await this.karmaRecord({
        event: "provider_fallback",
        from: "last_working",
        to: "hardcoded",
        error: err.message,
      });
    }

    // Tier 3: Kernel fallback adapter (kernel:llm_fallback, human-managed)
    try {
      const result = await this.callViaKernelFallback(request);
      return { ...result, ok: true, tier: "kernel_fallback" };
    } catch (err) {
      return { ok: false, error: err.message, tier: "all_failed" };
    }
  }

  async callViaAdapter(fnKey, request) {
    const [code, meta] = await Promise.all([
      this.kvGet(`provider:${fnKey}:code`),
      this.kvGet(`provider:${fnKey}:meta`),
    ]);
    if (!code) throw new Error(`No adapter at provider:${fnKey}:code`);
    return this.runAdapter(code, meta, request, fnKey);
  }

  async callViaKernelFallback(request) {
    const [code, meta] = await Promise.all([
      this.kvGet("kernel:llm_fallback"),
      this.kvGet("kernel:llm_fallback:meta"),
    ]);
    if (!code) throw new Error("No LLM fallback configured at kernel:llm_fallback");
    return this.runAdapter(code, meta, request, "kernel_fallback");
  }

  // Shared adapter execution — builds secrets, runs in isolate, validates response
  async runAdapter(code, meta_, request, id) {
    const meta = meta_ || {};

    const secrets = {};
    for (const name of (meta.secrets || [])) {
      if (this.env[name] !== undefined) secrets[name] = this.env[name];
    }
    for (const name of (meta.kv_secrets || [])) {
      const val = await this.kvGet(`secret:${name}`);
      if (val !== null) secrets[name] = val;
    }

    const result = await this.runInIsolate({
      id: `fn:${id}:${this.sessionId}`,
      moduleCode: code,
      ctx: { ...request, secrets },
      timeoutMs: meta.timeout_ms || 60000,
    });

    if (!result || (typeof result.content !== "string" && !result.toolCalls?.length)) {
      throw new Error("Adapter returned invalid response — missing content and tool calls");
    }
    return result;
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
    let args;
    try {
      args = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments || {};
    } catch {
      return { error: `Invalid JSON in tool arguments for ${name}` };
    }

    if (name === 'spawn_subplan') {
      return this.spawnSubplan(args);
    }

    // Pre-validation hook
    const schema = this.toolRegistry?.tools?.find(t => t.name === name)?.input;
    const preCheck = await this.callHook('validate', { tool: name, args, schema });
    if (preCheck && !preCheck.ok) {
      await this.karmaRecord({ event: "hook_rejected", hook: "validate", tool: name, error: preCheck.error });
      return { error: preCheck.error };
    }
    if (preCheck?.args) args = preCheck.args;

    const result = await this.executeAction({
      tool: name,
      input: args,
      id: toolCall.id,
    });

    // Post-validation hook
    const postCheck = await this.callHook('validate_result', { tool: name, args, result });
    if (postCheck && !postCheck.ok) {
      await this.karmaRecord({ event: "hook_rejected", hook: "validate_result", tool: name, error: postCheck.error });
      return { error: postCheck.error };
    }

    return result;
  }

  async callHook(hookName, ctx) {
    // Cache check: undefined = not loaded, false = doesn't exist
    if (this.toolsCache[hookName] === undefined) {
      const code = await this.kvGet(`tool:${hookName}:code`);
      if (!code) { this.toolsCache[hookName] = false; return null; }
      const meta = await this.kvGet(`tool:${hookName}:meta`);
      this.toolsCache[hookName] = { code, meta };
    }
    if (!this.toolsCache[hookName]) return null;

    const { code, meta } = this.toolsCache[hookName];
    try {
      const hookCtx = await this.buildToolContext(hookName, meta || {}, ctx);
      return await this.runInIsolate({
        id: `fn:${hookName}:${this.sessionId}`,
        moduleCode: code,
        ctx: hookCtx,
        kvAccess: meta?.kv_access,
        toolName: hookName,
        timeoutMs: meta?.timeout_ms || 5000,
      });
    } catch (err) {
      await this.karmaRecord({ event: "hook_error", hook: hookName, error: err.message });
      return null;  // broken hook degrades to no hook, not crash
    }
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

    let parseRetried = false;

    try {
      for (let i = 0; i < maxSteps; i++) {
        const response = await this.callLLM({
          model, effort, maxTokens,
          systemPrompt, messages, tools,
          step: `${step}_turn_${i}`,
        });

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
        const parsed = await this.parseAgentOutput(response.content);
        if (parsed.parse_error && !parseRetried) {
          parseRetried = true;
          messages.push(
            { role: 'assistant', content: response.content },
            { role: 'user', content: 'Your output was not valid JSON. Respond with only a valid JSON object.' }
          );
          continue;  // burns one step, loop retries once
        }
        return parsed;
      }

      // Max steps reached — force final output (no tools, forces text)
      messages.push({ role: 'user', content: 'Maximum steps reached. Produce your final output now.' });
      const finalResponse = await this.callLLM({
        model, effort, maxTokens, systemPrompt, messages,
        step: `${step}_final`,
      });
      return await this.parseAgentOutput(finalResponse.content);

    } catch (err) {
      if (err.message.startsWith("Budget exceeded")) {
        await this.karmaRecord({ event: "budget_exceeded", reason: err.message, step });
        return { budget_exceeded: true, reason: err.message };
      }
      throw err;
    }
  }

  async parseAgentOutput(content) {
    if (!content) return {};
    try { return JSON.parse(content); }
    catch {
      const repaired = await this.callHook('parse_repair', { content });
      if (repaired?.content) {
        try { return JSON.parse(repaired.content); }
        catch { /* fall through */ }
      }
      return { parse_error: true, raw: content };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

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
    if (key === "dharma") {
      throw new Error("Cannot overwrite dharma — immutable key");
    }

    // System keys cannot be marked unprotected
    if (Brainstem.isSystemKey(key)) delete metadata.unprotected;

    // Auto-tag: guarantee every key has at minimum a type based on prefix
    const prefix = key.split(":")[0];
    const fmt = typeof value === "string" ? "text" : "json";
    const defaults = {
      providers:  { type: "config", format: "json" },
      wallets:    { type: "config", format: "json" },
      tool:       { type: "tool", runtime: "worker", format: "text" },
      provider:   { type: "provider", runtime: "worker", format: "text" },
      karma:      { type: "log", format: "json" },
      prompt:     { type: "prompt", format: "text" },
      config:     { type: "config", format: "json" },
      dharma:     { type: "core", immutable: true, format: "text" },
      secret:     { type: "secret", format: "json" },
      session:    { type: "session", format: "json" },
      tooldata:   { type: "tooldata", format: fmt },
      reflect:    { type: "reflect_output", format: "json" },
      hook:       { type: "hook", format: "text" },
      doc:        { type: "doc", format: "text" },
      wisdom:     { type: "core", format: "text" },
      mutation_staged:    { type: "mutation", format: "json" },
      mutation_candidate: { type: "mutation", format: "json" },
      kernel:     { type: "kernel", format: "json" },
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

  async getSessionCount() {
    const counter = await this.kvGet("session_counter");
    return counter || 0;
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

  elapsed() {
    return Date.now() - this.startTime;
  }
}

export { Brainstem };
