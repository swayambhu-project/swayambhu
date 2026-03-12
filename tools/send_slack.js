export const meta = { secrets: ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"], kv_access: "none", timeout_ms: 10000 };

export async function execute({ text, channel, secrets, fetch }) {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secrets.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: channel || secrets.SLACK_CHANNEL_ID,
      text,
    }),
  });
  return resp.json();
}
