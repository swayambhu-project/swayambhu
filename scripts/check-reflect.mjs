import { Miniflare } from "miniflare";

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response() } }',
  kvPersist: ".wrangler/shared-state/v3/kv",
  kvNamespaces: { KV: "05720444f9654ed4985fb67af4aea24d" },
});

const kv = await mf.getKVNamespace("KV");
const ids = JSON.parse(await kv.get("cache:session_ids"));

for (const sid of ids.slice(-2)) {
  const karma = JSON.parse(await kv.get("karma:" + sid));
  const reflect = karma.find(e => e.step === "reflect_turn_0");
  if (!reflect || !reflect.response) {
    console.log(sid, ": no reflect response");
    continue;
  }
  try {
    const clean = reflect.response.replace(/```json\n?/g, "").replace(/\n?```$/g, "");
    const parsed = JSON.parse(clean);
    console.log("=== " + sid + " ===");
    console.log("  mutation_requests:", JSON.stringify(parsed.mutation_requests || "(field missing)"));
    console.log("  kv_operations:", JSON.stringify(parsed.kv_operations || "(field missing)"));
    console.log("\n  --- Full reflect response ---");
    console.log(JSON.stringify(parsed, null, 2));
    console.log();
  } catch (e) {
    console.log(sid, ": parse error:", e.message);
    console.log("  Raw response:", reflect.response.slice(0, 2000));
  }
}

// Also check: did budget_exceeded fire during reflect?
for (const sid of ids.slice(-2)) {
  const karma = JSON.parse(await kv.get("karma:" + sid));
  const budgetEvents = karma.filter(e => e.type === "budget_exceeded" || e.event === "budget_exceeded");
  const reflectEvents = karma.filter(e => e.step && e.step.startsWith("reflect"));
  console.log(`=== ${sid} budget/reflect timeline ===`);
  for (const e of karma) {
    if ((e.step && e.step.startsWith("reflect")) || e.type === "budget_exceeded" || e.event === "budget_exceeded") {
      console.log(`  [${e.step || e.type || e.event}] ${e.type || ""} cost=${e.cost || ""} total=${e.total_cost || ""}`);
    }
  }
  console.log();
}

await mf.dispose();
