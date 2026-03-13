import { vi } from "vitest";
import { makeKVStore } from "./mock-kv.js";

export function makeMockK(kvInit = {}, opts = {}) {
  const kv = makeKVStore(kvInit);

  return {
    // KV reads
    kvGet: vi.fn(async (key) => {
      const val = kv._store.get(key) ?? null;
      if (val === null) return null;
      try { return typeof val === "string" ? JSON.parse(val) : val; }
      catch { return val; }
    }),
    kvGetWithMeta: vi.fn(async (key) => {
      const val = kv._store.get(key) ?? null;
      return { value: val, metadata: kv._meta.get(key) || null };
    }),
    kvList: vi.fn(async (listOpts = {}) => {
      let keys = [...kv._store.keys()];
      if (listOpts.prefix) keys = keys.filter(k => k.startsWith(listOpts.prefix));
      if (listOpts.limit) keys = keys.slice(0, listOpts.limit);
      return {
        keys: keys.map(name => ({ name, metadata: kv._meta.get(name) || null })),
        list_complete: true,
      };
    }),

    // KV writes
    kvPutSafe: vi.fn(async (key, value, metadata) => {
      kv._store.set(key, typeof value === "string" ? value : JSON.stringify(value));
      if (metadata) kv._meta.set(key, metadata);
    }),
    kvDeleteSafe: vi.fn(async (key) => {
      kv._store.delete(key);
    }),
    kvWritePrivileged: vi.fn(async (ops) => {
      for (const op of ops) {
        if (op.op === "delete") {
          kv._store.delete(op.key);
        } else if (op.op === "patch") {
          const current = kv._store.get(op.key) ?? null;
          if (typeof current !== "string") {
            throw new Error(`patch op: key "${op.key}" is not a string value`);
          }
          if (!current.includes(op.old_string)) {
            throw new Error(`patch op: old_string not found in "${op.key}"`);
          }
          if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) {
            throw new Error(`patch op: old_string matches multiple locations in "${op.key}"`);
          }
          kv._store.set(op.key, current.replace(op.old_string, op.new_string));
        } else {
          kv._store.set(op.key, typeof op.value === "string" ? op.value : JSON.stringify(op.value));
        }
      }
    }),

    // Agent loop
    runAgentLoop: vi.fn(async () => ({})),
    executeToolCall: vi.fn(async () => ({})),
    buildToolDefinitions: vi.fn(async () => []),
    executeAction: vi.fn(async () => ({})),
    executeAdapter: vi.fn(async () => ({})),
    checkBalance: vi.fn(async () => ({ providers: {}, wallets: {} })),
    callHook: vi.fn(async () => null),

    // Karma
    karmaRecord: vi.fn(async () => {}),

    // Utility
    resolveModel: vi.fn(async (m) => m),
    estimateCost: vi.fn(async () => 0),
    buildPrompt: vi.fn(async (t, v) => t || JSON.stringify(v)),
    parseAgentOutput: vi.fn(async (c) => (c ? JSON.parse(c) : {})),
    loadKeys: vi.fn(async (keys) => {
      const result = {};
      for (const key of keys) {
        const val = kv._store.get(key);
        result[key] = val ? (typeof val === "string" ? JSON.parse(val) : val) : null;
      }
      return result;
    }),
    getSessionCount: vi.fn(async () => opts.sessionCount || 0),
    mergeDefaults: vi.fn(async (d, o) => ({ ...d, ...o })),
    isSystemKey: vi.fn(async (key) => false),

    // State
    getSessionId: vi.fn(async () => opts.sessionId || "test_session"),
    getSessionCost: vi.fn(async () => opts.sessionCost || 0),
    getKarma: vi.fn(async () => opts.karma || []),
    getDefaults: vi.fn(async () => opts.defaults || {}),
    getModelsConfig: vi.fn(async () => opts.modelsConfig || null),
    getDharma: vi.fn(async () => opts.dharma || null),
    getToolRegistry: vi.fn(async () => opts.toolRegistry || null),
    getYamas: vi.fn(async () => opts.yamas || null),
    getNiyamas: vi.fn(async () => opts.niyamas || null),
    elapsed: vi.fn(async () => 0),

    // Internal — expose KV store for assertions
    _kv: kv,
  };
}
