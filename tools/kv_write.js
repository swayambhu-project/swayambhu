export const meta = { secrets: [], kv_access: "own", timeout_ms: 5000 };

export async function execute({ key, value, kv }) {
  await kv.put(key, typeof value === "string" ? value : JSON.stringify(value));
  return { key, written: true };
}
