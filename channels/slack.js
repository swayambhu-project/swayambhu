// Channel adapter: Slack
// KV keys: channel:slack:code, channel:slack:config
// No `export default` — required for wrapChannelAdapter compatibility.

export const config = {
  secrets: ["SLACK_BOT_TOKEN"],
  webhook_secret_env: "SLACK_SIGNING_SECRET",
};

export function verify(headers, body, env) {
  // Slack signs requests with HMAC-SHA256: v0:timestamp:body
  // Full verification requires crypto.subtle (available in CF Workers).
  // For now, check the signature header exists and timestamp is fresh.
  const timestamp = headers["x-slack-request-timestamp"]
    || headers.get?.("X-Slack-Request-Timestamp");
  const signature = headers["x-slack-signature"]
    || headers.get?.("X-Slack-Signature");
  if (!timestamp || !signature || !env.SLACK_SIGNING_SECRET) return false;

  // Reject requests older than 5 minutes (replay protection)
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > 300) return false;

  return true;
}

export function parseInbound(body) {
  // Slack URL verification challenge — signal brainstem to echo it back
  if (body.type === "url_verification") {
    return { _challenge: body.challenge };
  }

  const event = body.event;
  if (!event || event.type !== "message") return null;

  // Ignore bot messages, message_changed, etc.
  if (event.bot_id || event.subtype) return null;

  const text = event.text || "";
  const command = text.startsWith("/")
    ? text.slice(1).split(" ")[0]
    : null;

  return {
    chatId: event.channel,
    text,
    userId: event.user,
    command,
  };
}

export async function sendReply(chatId, text, secrets, fetchFn) {
  await fetchFn("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secrets.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: chatId,
      text,
    }),
  });
}
