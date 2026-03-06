// Swayambhu Dev Brainstem — subclass, not fork
// Imports the real Brainstem + wake-hook.js, overrides only the platform-specific
// methods. All business logic (karma, budgets, error handling) lives in the base class.
//
// Run with: npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state

import { Brainstem } from './brainstem.js';
import { wake } from './wake-hook.js';

// ── Tool modules (single source of truth: tools/*.js) ──────────

import * as send_telegram from './tools/send_telegram.js';
import * as web_fetch from './tools/web_fetch.js';
import * as kv_read from './tools/kv_read.js';
import * as kv_write from './tools/kv_write.js';
import * as check_or_balance from './tools/check_or_balance.js';
import * as check_wallet_balance from './tools/check_wallet_balance.js';
import * as topup_openrouter from './tools/topup_openrouter.js';
import * as kv_manifest from './tools/kv_manifest.js';

const TOOL_MODULES = {
  send_telegram, web_fetch, kv_read, kv_write,
  check_or_balance, check_wallet_balance, topup_openrouter, kv_manifest,
};

// ── Provider adapter modules (single source of truth: providers/*.js) ──

import * as llm_balance from './providers/llm_balance.js';
import * as wallet_balance from './providers/wallet_balance.js';

const PROVIDER_MODULES = {
  'provider:llm_balance': llm_balance,
  'provider:wallet_balance': wallet_balance,
};

// ── Entry point ─────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    const brain = new DevBrainstem(env, { ctx });
    await brain.runScheduled();
  },
};

// ── DevBrainstem ────────────────────────────────────────────────

class DevBrainstem extends Brainstem {

  // ── KernelRPC getter bridge ─────────────────────────────────
  // wake-hook.js calls K.getSessionId(), K.getDharma(), etc.
  // In prod these live on KernelRPC (the RPC bridge). In dev, K = this.

  async getSessionId()    { return this.sessionId; }
  async getSessionCost()  { return this.sessionCost; }
  async getKarma()        { return this.karma; }
  async getDefaults()     { return this.defaults; }
  async getModelsConfig() { return this.modelsConfig; }
  async getDharma()       { return this.dharma; }
  async getToolRegistry() { return this.toolRegistry; }
  async kvList(opts)      { return this.kv.list(opts); }
  async isSystemKey(key)  { return Brainstem.isSystemKey(key); }

  // ── Platform override: _invokeHookModules ─────────────────
  // Calls wake() directly instead of Worker Loader isolate.

  async _invokeHookModules(modules, mainModule) {
    // Load config eagerly (wake-hook expects these via getters)
    this.defaults = await this.kvGet("config:defaults");
    this.modelsConfig = await this.kvGet("config:models");
    this.dharma = await this.kvGet("dharma");
    this.toolRegistry = await this.kvGet("config:tool_registry");

    console.log(`[HOOK] Calling wake() for session ${this.sessionId}`);
    const result = await wake(this, { sessionId: this.sessionId });
    console.log(`[HOOK] wake() returned:`, JSON.stringify(result).slice(0, 500));
  }

  // ── Platform override: _loadTool ──────────────────────────
  // Returns inline TOOL_REGISTRY entry instead of loading from KV.

  async _loadTool(toolName) {
    const mod = TOOL_MODULES[toolName];
    if (!mod) throw new Error(`Unknown tool: ${toolName}`);
    return { meta: mod.meta, moduleCode: null };
  }

  // ── Platform override: executeAdapter ────────────────────
  // Calls imported provider module directly instead of CF isolate.

  async executeAdapter(adapterKey, input) {
    const mod = PROVIDER_MODULES[adapterKey];
    if (!mod) throw new Error(`Unknown adapter: ${adapterKey}`);
    const ctx = await this.buildToolContext(adapterKey, mod.meta || {}, input);
    ctx.fetch = (...args) => fetch(...args);
    const fn = mod.execute || mod.call || mod.check;
    if (!fn) throw new Error(`Adapter ${adapterKey} has no callable function`);
    return fn(ctx);
  }

  // ── Platform override: _executeTool ───────────────────────
  // Calls imported tool module directly instead of CF isolate.

  async _executeTool(toolName, moduleCode, meta, ctx) {
    ctx.fetch = (...args) => fetch(...args);

    if (meta.kv_access && meta.kv_access !== "none") {
      ctx.kv = this._buildScopedKV(toolName, meta.kv_access);
    }

    return TOOL_MODULES[toolName].execute(ctx);
  }

  // ── ScopedKV emulation ──────────────────────────────────────

  _buildScopedKV(toolName, kvAccess) {
    const kv = this.kv;
    const scope = `tooldata:${toolName}:`;
    return {
      async get(key) {
        const resolved = kvAccess === "own" ? `${scope}${key}` : key;
        try { return await kv.get(resolved, "json"); }
        catch { try { return await kv.get(resolved, "text"); } catch { return null; } }
      },
      async put(key, value) {
        const resolved = `${scope}${key}`;  // writes always scoped
        const fmt = typeof value === "string" ? "text" : "json";
        await kv.put(resolved, typeof value === "string" ? value : JSON.stringify(value), {
          metadata: { type: "tooldata", format: fmt, updated_at: new Date().toISOString() },
        });
      },
      async list(opts = {}) {
        if (kvAccess === "own") {
          const result = await kv.list({ ...opts, prefix: scope + (opts.prefix || "") });
          return {
            keys: result.keys.map(k => ({ ...k, name: k.name.slice(scope.length) })),
            list_complete: result.list_complete,
          };
        }
        return kv.list(opts);
      },
    };
  }

  // ── Platform override: callWithCascade ─────────────────────
  // Direct OpenRouter fetch instead of adapter cascade.

  async callWithCascade(request, step) {
    const body = {
      model: request.model,
      max_tokens: request.max_tokens,
      messages: request.messages,
    };
    if (request.thinking) {
      body.provider = { require_parameters: true };
      body.thinking = request.thinking;
    }
    if (request.tools?.length) body.tools = request.tools;

    console.log(`[LLM] >>> ${step} | model=${request.model} | msgs=${request.messages.length}`);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();

    if (!resp.ok || data.error) {
      const errMsg = JSON.stringify(data.error || data);
      console.error(`[LLM] <<< ERROR | ${errMsg}`);
      return { ok: false, error: errMsg, tier: "direct" };
    }

    const msg = data.choices?.[0]?.message;
    const usage = data.usage || {};
    const content = msg?.content || "";
    const toolCalls = msg?.tool_calls || null;

    console.log(`[LLM] <<< in=${usage.prompt_tokens} out=${usage.completion_tokens} tools=${toolCalls?.length || 0}`);

    return { ok: true, content, usage, toolCalls, tier: "direct" };
  }

  // ── Platform override: callHook ────────────────────────────
  // No hooks in dev.

  async callHook(hookName, ctx) { return null; }

  // ── Override: karmaRecord ──────────────────────────────────
  // Adds console.log for dev visibility.

  async karmaRecord(entry) {
    console.log(`[KARMA] ${entry.event}`, JSON.stringify(entry).slice(0, 500));
    return super.karmaRecord(entry);
  }
}
