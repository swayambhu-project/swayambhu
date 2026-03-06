export const meta = { secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], kv_access: "none", timeout_ms: 10000 };

export async function execute({ text, parse_mode, secrets, fetch }) {
  const url = `https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: secrets.TELEGRAM_CHAT_ID,
      text,
      parse_mode: parse_mode || "Markdown"
    })
  });
  return resp.json();
}
