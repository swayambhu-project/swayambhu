export const meta = { secrets: ["OPENROUTER_API_KEY"], kv_access: "none", timeout_ms: 10000 };

export async function execute({ secrets, fetch }) {
  const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { "Authorization": `Bearer ${secrets.OPENROUTER_API_KEY}` }
  });
  return resp.json();
}
