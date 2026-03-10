import { Miniflare } from "miniflare";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok"); } }',
  kvPersist: resolve(root, ".wrangler/shared-state/v3/kv"),
  kvNamespaces: { KV: "05720444f9654ed4985fb67af4aea24d" },
});

const kv = await mf.getKVNamespace("KV");
const ids = JSON.parse(await kv.get("cache:session_ids"));

for (const id of ids) {
  const r = await kv.get("reflect:0:" + id);
  if (r === null) { console.log(id + ": no reflect\n"); continue; }
  const parsed = JSON.parse(r);
  // Try to extract from raw if parse_error
  let data = parsed;
  if (parsed.parse_error && parsed.raw) {
    try {
      const fenceMatch = parsed.raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (fenceMatch) data = JSON.parse(fenceMatch[1].trim());
    } catch { /* use parsed as-is */ }
  }
  const summary = data.session_summary || "no summary";
  const note = data.note_to_future_self || "";
  console.log("---", id, "---");
  console.log("Summary:", summary.slice(0, 500));
  if (note) console.log("Note:", note.slice(0, 400));
  if (data === parsed && parsed.raw) console.log("Raw:", parsed.raw.slice(0, 500));
  if (parsed.budget_exceeded) console.log("BUDGET EXCEEDED:", parsed.reason);
  if (parsed.parse_error && !parsed.raw) console.log("Keys:", Object.keys(parsed));
  console.log();
}

const tools = JSON.parse(await kv.get("config:tool_registry"));
console.log("=== TOOLS ===");
console.log(tools.tools.map(x => x.name).join(", "));

await mf.dispose();
