export const meta = { secrets: [], kv_access: "read_all", timeout_ms: 5000 };

export async function execute({ prefix, limit, kv }) {
  const opts = { limit: Math.min(parseInt(limit) || 100, 500) };
  if (prefix) opts.prefix = prefix;
  const result = await kv.list(opts);
  return {
    keys: result.keys.map(k => ({ key: k.name, metadata: k.metadata })),
    list_complete: result.list_complete,
    count: result.keys.length,
  };
}
