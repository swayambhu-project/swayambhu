import { vi } from "vitest";

export function makeKVStore(initial = {}) {
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
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
      if (opts?.metadata) metaStore.set(key, opts.metadata);
    }),
    delete: vi.fn(async (key) => {
      store.delete(key);
      metaStore.delete(key);
    }),
    list: vi.fn(async (opts = {}) => {
      let keys = [...store.keys()];
      if (opts.prefix) keys = keys.filter(k => k.startsWith(opts.prefix));
      if (opts.limit) keys = keys.slice(0, opts.limit);
      return {
        keys: keys.map((name) => ({
          name,
          metadata: metaStore.get(name) || null,
        })),
        list_complete: true,
      };
    }),
    getWithMetadata: vi.fn(async (key, format) => {
      const val = store.get(key) ?? null;
      return { value: val, metadata: metaStore.get(key) || null };
    }),
    _store: store,
    _meta: metaStore,
  };
}
