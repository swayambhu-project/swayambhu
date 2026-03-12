#!/usr/bin/env node
// Patch specific KV keys without full re-seed.
// Usage: node scripts/patch-kv.mjs

import { Miniflare } from "miniflare";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

const KV_NS = "05720444f9654ed4985fb67af4aea24d";

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok"); } }',
  kvPersist: resolve(root, ".wrangler/shared-state/v3/kv"),
  kvNamespaces: { KV: KV_NS },
});

const kv = await mf.getKVNamespace("KV");

// 1. Patch config:defaults — read current, merge changes
const defaults = JSON.parse(await kv.get("config:defaults"));
defaults.session_budget.reflect_reserve_pct = 0.33;
defaults.deep_reflect.budget_multiplier = 3.0;
defaults.deep_reflect.default_interval_sessions = 5;
await kv.put("config:defaults", JSON.stringify(defaults), {
  metadata: { format: "json" },
});
console.log("patched config:defaults");

// 2. Update wake hook modules + manifest
const hookModules = {
  "hook:wake:code": { file: "hook-main.js", desc: "Wake hook entry point" },
  "hook:wake:reflect": { file: "hook-reflect.js", desc: "Wake hook reflect module" },
  "hook:wake:mutations": { file: "hook-mutations.js", desc: "Wake hook mutations module" },
  "hook:wake:protect": { file: "hook-protect.js", desc: "Wake hook protect module" },
};
for (const [kvKey, { file, desc }] of Object.entries(hookModules)) {
  const code = read(file);
  await kv.put(kvKey, code, { metadata: { format: "text", description: desc } });
  console.log(`patched ${kvKey} — ${code.length} chars`);
}
await kv.put("hook:wake:manifest", JSON.stringify({
  "main": "hook:wake:code",
  "hook-reflect.js": "hook:wake:reflect",
  "hook-mutations.js": "hook:wake:mutations",
  "hook-protect.js": "hook:wake:protect",
}), { metadata: { format: "json", description: "Wake hook module manifest" } });
console.log("patched hook:wake:manifest");

// 3. Update channel adapters
const channelCode = read("channels/slack.js");
await kv.put("channel:slack:code", channelCode, {
  metadata: { format: "text", description: "Slack channel adapter" },
});
console.log("patched channel:slack:code —", channelCode.length, "chars");

// 4. Update prompt:reflect
const reflectPrompt = read("prompts/reflect.md");
await kv.put("prompt:reflect", reflectPrompt, {
  metadata: { format: "text", description: "Session-level reflection prompt (depth 0)" },
});
console.log("patched prompt:reflect —", reflectPrompt.length, "chars");

await mf.dispose();
console.log("done — patched config, 4 hook modules + manifest, channel adapter, prompt:reflect");
