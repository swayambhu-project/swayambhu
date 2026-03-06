export const meta = { secrets: [], kv_access: "read_all", timeout_ms: 5000 };

export async function execute({ key, kv }) {
  const val = await kv.get(key);
  return { key, value: val };
}
