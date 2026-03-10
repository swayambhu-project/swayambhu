#!/usr/bin/env node
// Reset wake_config.next_wake_after to the past so the next wake isn't skipped.
// Uses Miniflare with a hard process.exit() to avoid dispose() hangs.

import { Miniflare } from "miniflare";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const KV_NAMESPACE_ID = "05720444f9654ed4985fb67af4aea24d";

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok'); } }",
  kvPersist: resolve(root, ".wrangler/shared-state/v3/kv"),
  kvNamespaces: { KV: KV_NAMESPACE_ID },
});

const kv = await mf.getKVNamespace("KV");
const raw = await kv.get("wake_config");

if (raw) {
  const cfg = JSON.parse(raw);
  cfg.next_wake_after = "2020-01-01T00:00:00Z";
  await kv.put("wake_config", JSON.stringify(cfg), { metadata: { format: "json" } });
  console.log("  reset next_wake_after to past");
} else {
  console.log("  no wake_config found (first run?) — skipping");
}

// Force exit — mf.dispose() can hang if workerd subprocess won't quit
process.exit(0);
