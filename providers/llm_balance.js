export const meta = { secrets: ["OPENROUTER_API_KEY"], timeout_ms: 10000 };

export async function check({ secrets, fetch }) {
  const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { "Authorization": "Bearer " + secrets.OPENROUTER_API_KEY }
  });
  const data = await resp.json();
  return data?.data?.limit_remaining ?? data?.data?.usage ?? null;
}
