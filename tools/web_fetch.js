export const meta = { secrets: [], kv_access: "none", timeout_ms: 15000 };

export async function execute({ url, headers, method, max_length, fetch }) {
  const resp = await fetch(url, {
    method: method || "GET",
    headers: headers || {}
  });
  const text = await resp.text();
  const limit = max_length || 10000;
  return {
    status: resp.status,
    body: text.length > limit ? text.slice(0, limit) + "...[truncated]" : text
  };
}
