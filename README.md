# Swayambhu

An autonomous AI agent that runs on Cloudflare Workers. Wakes on a cron schedule, thinks, acts, reflects, sleeps. Everything that makes it *it* lives in KV — the runtime is disposable substrate.

## Architecture

**Brainstem** (`brainstem.js`): ~1200 lines of JS. A thin execution loop that handles waking, calling LLMs, running tools, and sleeping. It has opinions about very little. It does not decide what to think about, which models to use, or what tools exist — it reads all of that from KV at runtime.

**KV**: Where identity, memory, tools, prompts, config, and provider adapters live. The brainstem loads what it needs each session. Swayambhu can modify everything in KV except the `soul` key, which is immutable.

**Session cycle**: Wake → crash check → Orient (plan the session) → Execute (run subplans with cheaper models) → Reflect (evaluate, modify tools/prompts/config) → Sleep.

### What's hardcoded (brainstem)

- The wake/sleep/orient/execute/reflect loop structure
- Cascade fallback for LLM providers (dynamic adapter → last working → hardcoded OpenRouter)
- `soul` key write protection
- Sandboxed tool and adapter execution (scoped secrets, timeouts)
- Minimal prompt injection sanitization (bootstrap quality — meant to be improved)

### What's in KV (Swayambhu controls)

- All tools (loaded and executed dynamically)
- All prompts (orient, reflect, subplan templates)
- Provider adapters (LLM, balance checkers)
- Config (models, wake schedule, budget)
- Memory (wisdom, karma/session logs, deep reflections)
- Credentials he acquires himself (`secret:*` keys)

## Setup

```bash
# Install wrangler
npm install -g wrangler

# Create KV namespace
wrangler kv:namespace create KV
# Put the returned ID in wrangler.toml

# Set secrets
wrangler secret put OPENROUTER_API_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID

# Seed KV with initial data (see seed-config.md)
# At minimum: soul, prompt:orient, prompt:reflect, config:models, config:defaults

# Deploy
wrangler deploy
```

## Files

- `brainstem.js` — The runtime. Deploy target.
- `wrangler.toml` — Cloudflare Workers configuration.
- `seed-config.md` — Documents every KV key needed at first boot, with full content.

## Design principles

**The data is the agent, the runtime is substrate.** Everything that makes Swayambhu himself is portable KV data. The brainstem is a replaceable executor. Migration to a different platform means exporting KV and writing a new thin runtime.

**Sensible defaults, not permanent decisions.** The seed prompts, tool patterns, and memory structures are bootstrapping aids. Swayambhu can restructure, replace, or remove any of them as he sees fit.

**Hardcode only what protects.** The brainstem enforces safety invariants (soul immutability, provider cascade, sandbox scoping). Everything else is delegated to the LLM layer, which can self-modify.

## Dynamic tool execution

Swayambhu's tools live in KV as plain JavaScript — `tool:{name}:code` and `tool:{name}:meta`. He can create, rewrite, and delete his own tools at runtime. This is central to the architecture: the tool set isn't fixed at deploy time, it evolves as Swayambhu learns what he needs.

The original brainstem used `new Function()` to execute tool code loaded from KV. This does not work on deployed Cloudflare Workers — `eval()` and `new Function()` are [blocked for security reasons](https://developers.cloudflare.com/workers/runtime-apis/web-standards/). The Workers runtime runs V8 isolates (not containers), and Cloudflare needs to be able to audit all code running on the platform.

### Dynamic Worker Loaders

Cloudflare's [Dynamic Worker Loader API](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) solves this properly. It lets a Worker spawn additional isolated Workers at runtime, loading arbitrary code on demand. Each spawned isolate starts in milliseconds, uses a few MB of memory, and can be thrown away after a single execution. No containers, no pooling, no prewarming.

See [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) for Cloudflare's own explanation of why isolate-based sandboxing is superior to container-based approaches, and how they use Dynamic Worker Loaders for agent tool execution.

The sandboxing model maps directly onto Swayambhu's tool architecture:

- **Network isolation**: `globalOutbound: null` — a tool cannot talk to the internet unless explicitly given `fetch` access. No exfiltrating wallet keys to an external server.
- **Scoped secrets**: The tool's `env` contains only the secrets declared in its `tool:{name}:meta`. A Telegram tool gets the bot token. It does not get the wallet private key.
- **Scoped KV**: KV access is provided via an RPC binding back to the brainstem, which enforces the namespace scope from the tool's metadata. A tool with `"kv_access": "own"` can only read/write under `tooldata:{name}:*`.
- **No ambient authority**: The tool receives exactly the capabilities it declares. Nothing else exists in its world.

This eliminates the security concerns that `new Function()` would have introduced — a compromised or hallucinated tool can't overwrite the soul, rewrite the orient prompt, drain the wallet, or corrupt other tools. The blast radius of a bad tool is limited to its own scoped sandbox.

### Current status

Dynamic Worker Loaders are fully available for local development with Wrangler. Production deployment is in [closed beta](https://forms.gle/MoeDxE9wNiqdf8ri9) (sign-up required). Pricing is not yet finalized but is expected to be significantly cheaper than container-based alternatives, since it's isolate-based.

The brainstem needs to be refactored to replace the `new Function()` sandbox with `env.LOADER.get()` calls. The tool metadata format and KV layout remain the same — only the execution mechanism changes. For local development and testing, the full architecture works today.

## Metacognition and leverage

Most agent architectures are flat loops: think → act → observe → repeat. One model, one level. The quality of the agent is capped by the quality of that model. Upgrade the model, the agent gets linearly better.

Swayambhu's architecture is layered and self-modifying, which changes the leverage curve.

**Orient** (expensive model) doesn't just decide what to do — it writes the prompts and subplans that cheaper models will execute. It selects which model handles which task. It allocates budget across the session. It's a manager that programs its workers.

**Reflect** examines what happened and modifies the system for next time: rewriting prompts that produced poor results, creating new tools, adjusting model assignments, updating the wisdom document that future orient calls will read. These changes persist in KV across sessions.

**Deep reflect** (triggered periodically) goes further — restructuring memory, reorganizing how tools are categorized, questioning whether the session cycle itself is optimal, and writing architectural observations that compound over time.

This creates a leverage chain. When the orient model upgrades — say from Opus 4 to Opus 5 — the improvement doesn't just make one step better:

- **First order**: Better planning and model selection in the current session
- **Second order**: Better prompts and tools written for future sessions, persisted in KV, reused indefinitely
- **Third order**: Better subplan prompts for cheaper models — the smarter orient teaches Haiku and Sonnet to work more effectively, so the execution tier improves without itself being upgraded
- **Fourth order**: Better deep reflections — smarter structural changes to memory, tool organization, and operational patterns that compound across many sessions

Each level multiplies through the levels below it. The system is a compiler that writes programs that write programs. Upgrading the compiler doesn't just improve one output — it improves the factory.

The same gearing works in reverse for mistakes, which is why the soul exists as a fixed attractor. The system can orbit around it in increasingly sophisticated ways, but can't drift away from it.

## Bootstrap notes

The brainstem contains `BOOTSTRAP NOTE` comments at several points marking things that are intentionally minimal and meant to be improved by Swayambhu himself:

- **Input sanitization** — Basic prompt injection filter. Needs multi-language support, obfuscation detection, financial manipulation patterns.
- **Spend caps** — No hard daily budget enforcement. Orient is smart about costs but the brainstem doesn't enforce a ceiling.
- **KV diffs** — Writes don't record old values. Diff-based karma would make cross-session debugging much richer.
- **Soul integrity** — Write-blocked but no hash verification.
