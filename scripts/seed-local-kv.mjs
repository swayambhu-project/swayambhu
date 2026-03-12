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

async function put(key, value, format = "json", description) {
  const val = typeof value === "object" && format === "json"
    ? JSON.stringify(value)
    : value;
  const metadata = { format };
  if (description) metadata.description = description;
  await kv.put(key, val, { metadata });
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
}, "json", "On-chain identity (DID, address, chain, registry)");

// ── Config ────────────────────────────────────────────────────

console.log("--- Config ---");
await put("config:defaults", {
  orient: { model: "anthropic/claude-opus-4.6", effort: "low", max_output_tokens: 4000 },
  reflect: { model: "anthropic/claude-sonnet-4.6", effort: "medium", max_output_tokens: 1000 },
  session_budget: { max_cost: 0.15, max_steps: 8, max_duration_seconds: 600, reflect_reserve_pct: 0.33 },
  chat: {
    model: "sonnet",
    effort: "low",
    max_cost_per_conversation: 0.50,
    max_tool_rounds: 5,
    max_output_tokens: 1000,
    max_history_messages: 40,
  },
  failure_handling: { retries: 1, on_fail: "skip_and_cascade" },
  wake: { sleep_seconds: 21600, default_effort: "low" },
  memory: { default_load_keys: ["wisdom", "config:models", "config:resources"], max_context_budget_tokens: 8000 },
  execution: {
    max_subplan_depth: 3, max_reflect_depth: 1, reflect_interval_multiplier: 5,
    max_steps: { orient: 3, reflect_default: 5, reflect_deep: 10 },
    fallback_model: "anthropic/claude-haiku-4.5",
  },
  deep_reflect: {
    default_interval_sessions: 5, default_interval_days: 7,
    model: "anthropic/claude-opus-4.6", effort: "high", max_output_tokens: 4000, budget_multiplier: 3.0,
  },
}, "json", "Session budgets, model roles, effort levels, execution limits");

await put("config:models", {
  models: [
    { id: "anthropic/claude-opus-4.6", alias: "opus", input_cost_per_mtok: 5.00, output_cost_per_mtok: 25.00, max_output_tokens: 128000, best_for: "Strategy, novel situations, full situational awareness, deep reflection" },
    { id: "anthropic/claude-sonnet-4.6", alias: "sonnet", input_cost_per_mtok: 3.00, output_cost_per_mtok: 15.00, max_output_tokens: 64000, best_for: "Writing, moderate reasoning, reflection, subplan planning" },
    { id: "anthropic/claude-haiku-4.5", alias: "haiku", input_cost_per_mtok: 1.00, output_cost_per_mtok: 5.00, max_output_tokens: 64000, best_for: "Simple tasks, classification, condition evaluation, cheap execution" },
  ],
  fallback_model: "anthropic/claude-haiku-4.5",
  alias_map: { opus: "anthropic/claude-opus-4.6", sonnet: "anthropic/claude-sonnet-4.6", haiku: "anthropic/claude-haiku-4.5" },
}, "json", "Available LLM models with pricing, aliases, and capabilities");

await put("config:resources", {
  kv: { max_storage_mb: 1000, daily_read_limit: 100000, daily_write_limit: 1000, daily_list_limit: 1000, daily_delete_limit: 1000, max_value_size_mb: 25 },
  worker: { max_cron_duration_seconds: 900, max_subrequests_per_invocation: 1000, cpu_time_limit_ms: 10 },
  openrouter: { base_url: "https://openrouter.ai/api/v1", balance_endpoint: "/api/v1/auth/key", topup_endpoint: "/api/v1/credits/coinbase", topup_fee_percent: 5, topup_chain: "base", topup_chain_id: 8453 },
  wallet: { chain: "base", token: "USDC", address: "0x1951e298f9Aa7eFf5eB0dD5349e823BBB09a3260" },
  slack: { bot_token_secret: "SLACK_BOT_TOKEN", channel_id_secret: "SLACK_CHANNEL_ID" },
}, "json", "Platform limits and external service endpoints (KV, worker, OpenRouter, wallet, Slack)");

await put("providers", {
  openrouter: { adapter: "provider:llm_balance", scope: "general" },
}, "json", "Registered LLM providers with adapter bindings and scope");

await put("wallets", {
  base_usdc: { adapter: "provider:wallet_balance", scope: "general" },
}, "json", "Registered crypto wallets with adapter bindings and scope");

// ── Tool registry ─────────────────────────────────────────────

await put("config:tool_registry", {
  tools: [
    { name: "send_slack", description: "Post a message to the Slack channel", input: { text: "required", channel: "optional — override default channel" } },
    { name: "web_fetch", description: "Fetch contents of a URL", input: { url: "required", method: "GET|POST", headers: "optional", max_length: "default 10000" } },
    { name: "kv_read", description: "Read a value from memory (any key)", input: { key: "required" } },
    { name: "kv_write", description: "Write to tool's own KV namespace", input: { key: "required", value: "required" } },
    { name: "check_balance", description: "Check balances across all configured providers and wallets. Returns balances grouped by scope (general vs project-specific). Only 'general' scope counts toward your operating budget.", input: { scope: "optional — filter by scope (e.g. 'general', 'project_x'). Omit to see all." } },
    { name: "kv_manifest", description: "List KV keys, optionally filtered by prefix. Use to explore what is stored in memory.", input: { prefix: "optional key prefix filter", limit: "max keys to return (default 100, max 500)" } },
    { name: "karma_query", description: "Lazily traverse a session's karma log using dot-bracket path expressions. Returns one level of depth per call — use progressively deeper paths to drill into events.", input: { session: "required — session ID (e.g. s_1709123456_abc)", path: "optional — dot-bracket path (e.g. [1].tool_calls[0].function)" } },
    { name: "akash_exec", description: "Run a shell command on the akash Linux server. Returns status, exit code, and output (stdout/stderr entries).", input: { command: "required — shell command to run", timeout: "optional — seconds to wait (default 60)" } },
    { name: "check_email", description: "Check for unread emails in Gmail inbox. Returns sender, subject, date, and snippet for each.", input: { mark_read: "optional boolean — mark fetched emails as read (default false)", max_results: "optional — max emails to return (default 10, max 20)" } },
    { name: "send_email", description: "Send an email or reply to an existing thread via Gmail.", input: { to: "required — recipient email address", subject: "required (unless replying)", body: "required — plain text email body", reply_to_id: "optional — Gmail message ID to reply to (threads the reply)" } },
  ],
}, "json", "Tool definitions — names, descriptions, and input schemas for function calling");

// ── Providers (from providers/*.js) ───────────────────────────

console.log("--- Providers ---");
const providerFiles = ["llm", "llm_balance", "wallet_balance", "gmail"];
for (const name of providerFiles) {
  const mod = await importLocal(`providers/${name}.js`);
  await put(`provider:${name}:code`, read(`providers/${name}.js`), "text", `Provider source: ${name}`);
  await put(`provider:${name}:meta`, mod.meta, "json", `Provider metadata: ${name}`);
}

// ── Tools (from tools/*.js) ───────────────────────────────────

console.log("--- Tools ---");
const toolNames = [
  "send_slack", "web_fetch", "kv_read", "kv_write",
  "kv_manifest", "karma_query", "akash_exec",
  "check_email", "send_email",
];
for (const name of toolNames) {
  const mod = await importLocal(`tools/${name}.js`);
  await put(`tool:${name}:code`, read(`tools/${name}.js`), "text", `Tool source: ${name}`);
  await put(`tool:${name}:meta`, mod.meta, "json", `Tool metadata: ${name}`);
}

// ── Prompts ───────────────────────────────────────────────────

console.log("--- Prompts ---");
await put("prompt:orient", read("prompts/orient.md"), "text", "Orient session system prompt — shapes waking behavior");
await put("prompt:subplan", read("prompts/subplan.md"), "text", "Subplan agent system prompt template");
await put("prompt:reflect", read("prompts/reflect.md"), "text", "Session-level reflection prompt (depth 0)");
await put("prompt:reflect:1", read("prompts/deep-reflect.md"), "text", "Deep reflection prompt (depth 1) — examines alignment, patterns, structures");

// ── Dharma, wisdom ────────────────────────────────────────────

console.log("--- Identity ---");
await put("dharma", read("DHARMA.md"), "text", "Core identity and purpose — what Swayambhu is and why it exists");
await put("wisdom", "", "text", "Accumulated insights from past reflections — grows over time");

// ── Wake hook (modular) ───────────────────────────────────────

console.log("--- Wake Hook ---");
await put("hook:wake:code", read("hook-main.js"), "text", "Wake hook entry point — wake flow, session, crash detection");
await put("hook:wake:reflect", read("hook-reflect.js"), "text", "Wake hook reflect module — session/deep reflect, scheduling, prompts");
await put("hook:wake:mutations", read("hook-mutations.js"), "text", "Wake hook mutations module — staging, candidates, circuit breaker");
await put("hook:wake:protect", read("hook-protect.js"), "text", "Wake hook protect module — constants, protection gate");
await put("hook:wake:manifest", {
  "main": "hook:wake:code",
  "hook-reflect.js": "hook:wake:reflect",
  "hook-mutations.js": "hook:wake:mutations",
  "hook-protect.js": "hook:wake:protect",
}, "json", "Wake hook module manifest — maps filenames to KV keys");

// ── Channel adapters ──────────────────────────────────────────

console.log("--- Channel Adapters ---");
await put("channel:slack:code", read("channels/slack.js"), "text", "Slack channel adapter");
await put("channel:slack:config", {
  secrets: ["SLACK_BOT_TOKEN"],
  webhook_secret_env: "SLACK_SIGNING_SECRET",
}, "json", "Slack channel config");

// ── Chat prompt ───────────────────────────────────────────────

console.log("--- Chat ---");
await put("prompt:chat", [
  "",
  "",
  "You are in a live chat session. Respond conversationally and concisely.",
  "Use tools when the user asks about balances, KV state, or anything that",
  "requires looking up data. Keep replies short — this is real-time chat,",
  "not a report.",
].join("\n"), "text", "Chat system prompt — shapes real-time conversation style");

// ── Kernel config ─────────────────────────────────────────────

console.log("--- Kernel Config ---");
await put("kernel:alert_config", {
  url: "https://slack.com/api/chat.postMessage",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer {{SLACK_BOT_TOKEN}}" },
  body_template: { channel: "{{SLACK_CHANNEL_ID}}", text: "[Swayambhu] {{event}}: {{message}}" },
}, "json", "Slack alert template for kernel events");

await put("kernel:llm_fallback", read("providers/llm.js"), "text", "Fallback LLM provider source code");
const llmMod = await importLocal("providers/llm.js");
await put("kernel:llm_fallback:meta", llmMod.meta, "json", "Fallback LLM provider metadata");
await put("kernel:fallback_model", '"anthropic/claude-haiku-4.5"', "json", "Model used when primary LLM call fails");

// ── Reference docs ────────────────────────────────────────────

console.log("--- Docs ---");
await put("doc:mutation_guide", read("docs/doc-mutation-guide.md"), "text", "Reference: how the mutation protocol works (staging, candidates, rollback)");
await put("doc:architecture", read("docs/doc-architecture.md"), "text", "Reference: system architecture overview (kernel, hooks, KV, tools)");

// ── Done ──────────────────────────────────────────────────────

await mf.dispose();
console.log(`\n=== Done! Seeded ${count} keys ===`);
console.log(`\nStart brainstem (port 8787):`);
console.log(`  source .env && npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state`);
console.log(`\nTrigger the cron:`);
console.log(`  curl http://localhost:8787/__scheduled`);
