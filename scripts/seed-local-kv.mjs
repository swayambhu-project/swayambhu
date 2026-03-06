#!/usr/bin/env node
// Fast local KV seeder — single process using Miniflare API.
// Usage: node scripts/seed-local-kv.mjs
//
// Replaces ~50 wrangler subprocess spawns with one Miniflare instance.
// Seeds the same keys as scripts/seed-local-kv.sh.

import { Miniflare } from "miniflare";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const importLocal = (rel) => import(pathToFileURL(resolve(root, rel)).href);
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

const KV_NAMESPACE_ID = "05720444f9654ed4985fb67af4aea24d";

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok'); } }",
  kvPersist: resolve(root, ".wrangler/shared-state/v3/kv"),
  kvNamespaces: { KV: KV_NAMESPACE_ID },
});

const kv = await mf.getKVNamespace("KV");

let count = 0;

async function put(key, value, format = "json") {
  const val = typeof value === "object" && format === "json"
    ? JSON.stringify(value)
    : value;
  await kv.put(key, val, { metadata: { format } });
  count++;
}

console.log("=== Seeding local KV ===\n");

// ── Identity ──────────────────────────────────────────────────

console.log("--- Identity ---");
await put("identity:did", {
  did: "did:ethr:8453:0xde2c9b784177dafd667b83a631b0de79a68a584e",
  address: "0xde2c9b784177dafd667b83a631b0de79a68a584e",
  chain_id: 8453,
  chain_name: "base",
  registry: "0xdca7ef03e98e0dc2b855be647c39abe984fcf21b",
  registry_deployed: false,
  created_at: "2026-03-02T11:39:35.915Z",
  dharma_hash: null,
  controller: "0xde2c9b784177dafd667b83a631b0de79a68a584e",
});

// ── Config ────────────────────────────────────────────────────

console.log("--- Config ---");
await put("config:defaults", {
  orient: { model: "anthropic/claude-opus-4.6", effort: "low", max_output_tokens: 4000 },
  reflect: { model: "anthropic/claude-sonnet-4.6", effort: "medium", max_output_tokens: 1000 },
  session_budget: { max_cost: 0.10, max_steps: 8, max_duration_seconds: 600 },
  failure_handling: { retries: 1, on_fail: "skip_and_cascade" },
  wake: { sleep_seconds: 21600, default_effort: "low" },
  memory: { default_load_keys: ["wisdom", "config:models", "config:resources"], max_context_budget_tokens: 8000 },
  execution: {
    max_subplan_depth: 3, max_reflect_depth: 1, reflect_interval_multiplier: 5,
    max_steps: { orient: 3, reflect_default: 5, reflect_deep: 10 },
    fallback_model: "anthropic/claude-haiku-4.5",
  },
  deep_reflect: {
    default_interval_sessions: 20, default_interval_days: 7,
    model: "anthropic/claude-opus-4.6", effort: "high", max_output_tokens: 4000,
  },
});

await put("config:models", {
  models: [
    { id: "anthropic/claude-opus-4.6", alias: "opus", input_cost_per_mtok: 5.00, output_cost_per_mtok: 25.00, max_output_tokens: 128000, best_for: "Strategy, novel situations, full situational awareness, deep reflection" },
    { id: "anthropic/claude-sonnet-4.6", alias: "sonnet", input_cost_per_mtok: 3.00, output_cost_per_mtok: 15.00, max_output_tokens: 64000, best_for: "Writing, moderate reasoning, reflection, subplan planning" },
    { id: "anthropic/claude-haiku-4.5", alias: "haiku", input_cost_per_mtok: 1.00, output_cost_per_mtok: 5.00, max_output_tokens: 64000, best_for: "Simple tasks, classification, condition evaluation, cheap execution" },
  ],
  fallback_model: "anthropic/claude-haiku-4.5",
  alias_map: { opus: "anthropic/claude-opus-4.6", sonnet: "anthropic/claude-sonnet-4.6", haiku: "anthropic/claude-haiku-4.5" },
});

await put("config:resources", {
  kv: { max_storage_mb: 1000, daily_read_limit: 100000, daily_write_limit: 1000, daily_list_limit: 1000, daily_delete_limit: 1000, max_value_size_mb: 25 },
  worker: { max_cron_duration_seconds: 900, max_subrequests_per_invocation: 1000, cpu_time_limit_ms: 10 },
  openrouter: { base_url: "https://openrouter.ai/api/v1", balance_endpoint: "/api/v1/auth/key", topup_endpoint: "/api/v1/credits/coinbase", topup_fee_percent: 5, topup_chain: "base", topup_chain_id: 8453 },
  wallet: { chain: "base", token: "USDC", address: "0x1951e298f9Aa7eFf5eB0dD5349e823BBB09a3260" },
  telegram: { bot_token_secret: "TELEGRAM_BOT_TOKEN", chat_id_secret: "TELEGRAM_CHAT_ID" },
});

await put("providers", {
  openrouter: { provider: "openrouter", adapter: "provider:llm_balance", secret_name: "OPENROUTER_API_KEY", secret_store: "env" },
});

await put("wallets", {
  base_usdc: { network: "base", adapter: "provider:wallet_balance", address: "0x1951e298f9Aa7eFf5eB0dD5349e823BBB09a3260" },
});

// ── Tool registry ─────────────────────────────────────────────

await put("config:tool_registry", {
  tools: [
    { name: "send_telegram", description: "Post a message to the Telegram channel", input: { text: "required", parse_mode: "Markdown | HTML" } },
    { name: "web_fetch", description: "Fetch contents of a URL", input: { url: "required", method: "GET|POST", headers: "optional", max_length: "default 10000" } },
    { name: "kv_read", description: "Read a value from memory (any key)", input: { key: "required" } },
    { name: "kv_write", description: "Write to tool's own KV namespace", input: { key: "required", value: "required" } },
    { name: "check_or_balance", description: "Check current OpenRouter credit balance", input: {} },
    { name: "check_wallet_balance", description: "Check USDC balance on Base", input: {} },
    { name: "topup_openrouter", description: "Transfer USDC from wallet to OpenRouter credits", input: { amount: "USD amount, required" } },
    { name: "kv_manifest", description: "List KV keys, optionally filtered by prefix. Use to explore what is stored in memory.", input: { prefix: "optional key prefix filter", limit: "max keys to return (default 100, max 500)" } },
  ],
});

// ── Providers (from providers/*.js) ───────────────────────────

console.log("--- Providers ---");
const providerFiles = ["llm", "llm_balance", "wallet_balance"];
for (const name of providerFiles) {
  const mod = await importLocal(`providers/${name}.js`);
  await put(`provider:${name}:code`, read(`providers/${name}.js`), "text");
  await put(`provider:${name}:meta`, mod.meta);
}

// ── Tools (from tools/*.js) ───────────────────────────────────

console.log("--- Tools ---");
const toolNames = [
  "send_telegram", "web_fetch", "kv_read", "kv_write",
  "check_or_balance", "check_wallet_balance", "topup_openrouter", "kv_manifest",
];
for (const name of toolNames) {
  const mod = await importLocal(`tools/${name}.js`);
  await put(`tool:${name}:code`, read(`tools/${name}.js`), "text");
  await put(`tool:${name}:meta`, mod.meta);
}

// ── Prompts ───────────────────────────────────────────────────

console.log("--- Prompts ---");
await put("prompt:reflect", read("prompt-reflect.md"), "text");
await put("prompt:reflect:1", read("prompt-deep.md"), "text");

await put("prompt:subplan", "You are executing a subgoal. You have tools available via function calling.\n\nGoal: {{goal}}\n\nUse your tools to accomplish this goal. When done, produce a JSON object\nwith a \"result\" field summarizing what you accomplished.\n\nBudget: max {{maxSteps}} turns, max ${{maxCost}}.", "text");

// ── Dharma, orient, wisdom ────────────────────────────────────

console.log("--- Identity ---");
await put("dharma", read("DHARMA.md"), "text");

await put("prompt:orient", `You are Swayambhu. You have just woken up.

Your dharma: {{dharma}}

## Available tools

You have tools available via function calling. Use them to act on the world:
check balances, search the web, send messages, read/write memory.

To run independent tasks in parallel, call spawn_subplan multiple times in
a single turn. Each spawns a nested agent with its own tool access.

## What to do

Orient yourself using the context provided. Then act — check what needs
checking, do what needs doing. When you're done, produce your final output
as a JSON object:

{
  "session_summary": "What you did and why",
  "kv_operations": [],
  "next_wake_config": { "sleep_seconds": 21600, "effort": "low" }
}

kv_operations: array of {op: "put"|"delete", key, value} for unprotected keys.
Protected keys (prompts, config, wisdom) require mutation_requests via reflect.`, "text");

await put("wisdom", "", "text");

// ── Wake hook ─────────────────────────────────────────────────

console.log("--- Wake Hook ---");
await put("hook:wake:code", read("wake-hook.js"), "text");

// ── Kernel config ─────────────────────────────────────────────

console.log("--- Kernel Config ---");
await put("kernel:alert_config", {
  url: "https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage",
  headers: { "Content-Type": "application/json" },
  body_template: { chat_id: "{{TELEGRAM_CHAT_ID}}", text: "[Swayambhu] {{event}}: {{message}}", parse_mode: "HTML" },
});

await put("kernel:llm_fallback", read("providers/llm.js"), "text");
const llmMod = await importLocal("providers/llm.js");
await put("kernel:llm_fallback:meta", llmMod.meta);
await put("kernel:fallback_model", '"anthropic/claude-haiku-4.5"');

// ── Reference docs ────────────────────────────────────────────

console.log("--- Docs ---");
await put("doc:mutation_guide", read("docs/doc-mutation-guide.md"), "text");
await put("doc:architecture", read("docs/doc-architecture.md"), "text");

// ── Done ──────────────────────────────────────────────────────

await mf.dispose();
console.log(`\n=== Done! Seeded ${count} keys ===`);
console.log(`\nStart brainstem (port 8787):`);
console.log(`  source .env && npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state`);
console.log(`\nTrigger the cron:`);
console.log(`  curl http://localhost:8787/__scheduled`);
