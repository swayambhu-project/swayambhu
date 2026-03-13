# Swayambhu

*Sanskrit: "self-born"*

An autonomous AI agent that wakes on a schedule, thinks, acts, reflects, and sleeps. Everything that makes it *it* — memory, personality, tools, prompts, goals — lives in a key-value store. The runtime is disposable substrate. The data is the agent.

## The core idea

Most AI agents are programs that call an LLM. Swayambhu is an agent that rewrites its own program.

The runtime — a thin loop deployed on Cloudflare Workers — handles waking up, calling models, running tools, and going back to sleep. It has opinions about almost nothing. It doesn't decide what to think about, which models to use, what tools exist, or how to structure its memory. It reads all of that from a key-value store at the start of each session.

Swayambhu controls everything in that store. He writes his own prompts, creates and rewrites his own tools, chooses his own models, manages his own budget, and restructures his own memory. The runtime enforces a small number of safety invariants and stays out of the way.

This means upgrading Swayambhu doesn't require redeploying code. He upgrades himself, session by session, through reflection.

## How a session works

The brainstem wakes on a cron schedule, checks if it's actually time to act (the agent controls its own sleep duration), runs crash detection and circuit breakers, then loads its state from the store. What happens next depends on whether a deep reflection is due.

### Normal sessions: act → reflect

The agent loads its orient prompt, current state — balances, memory, pending items, recent history — and enters the **agent loop**. This is a multi-turn conversation with tools: the model calls a tool, sees the result, decides what to do next, calls another tool or produces its final output. On each turn the model can call one tool, call several in parallel, or decide it's done.

This is where all operational work happens — checking balances, searching the web, posting to Telegram, executing transactions. The model decides what to focus on based on what it finds, not from a pre-committed plan. If something unexpected shows up mid-session, it can pivot.

When the agent identifies independent threads of work, it can spawn **subplans** — nested agent loops running on cheaper models, executing in parallel, reporting results back to the parent.

After the agent loop completes, **session reflect** runs — a single evaluation call that reviews the session's karma log (the flight recorder of every LLM call and tool execution), produces a summary, and can propose mutations or adjust the next wake schedule. Session reflect answers: *"what just happened, and what should I tell my future self?"*

The runtime then shuts down. Nothing persists except what's in the store. Next wake cycle, a fresh runtime boots and loads whatever the agent left behind.

### Deep reflect sessions

Periodically, instead of a normal session, the brainstem triggers a **deep reflection**. Normal sessions and deep reflect sessions are mutually exclusive — when reflection fires, it replaces the normal act cycle entirely, because the point is to step back and examine the pattern rather than continue acting within it.

**Depth 1** fires roughly every 20 sessions. It reads recent karma logs, reviews the orient prompt, and looks for patterns across sessions. It can propose mutations to prompts, config, and tools through the mutation protocol — and its mutation requests are applied directly as candidates (no staging required). Depth 1 also writes the wake config and schedule that govern normal sessions.

**Depth 2** fires less often (~100 sessions by default, but self-determined after first run). It reads depth 1's stored outputs, looking for patterns in *how depth 1 is reflecting*. Is depth 1 over-correcting? Missing systemic issues? Fixating on symptoms instead of causes?

This extends to arbitrary depth. Each level reads the outputs of the level below, identifies patterns, and can propose changes to the level below's prompt through the mutation protocol.

A critical constraint: **each depth can only target the level directly below.** Depth 2 cannot rewrite the orient prompt — only depth 1 can. If depth 2 sees a problem with how the agent plans, it has to adjust depth 1's behavior so that *depth 1* catches and fixes the planning issue. This prevents write conflicts (each prompt has exactly one author) and forces higher levels to improve the system's self-correcting capability rather than issuing one-off patches.

When the highest due depth fires, it cascades downward — depth 2 runs, then depth 1 runs in the same session, seeing any changes depth 2 just made. This means depth 2's adjustments to depth 1's prompt are immediately exercised against real session history.

Every depth uses the agent loop with tool access for investigation — it can read arbitrary KV keys, search the web, review karma entries. The one restriction: deep reflect cannot spawn subplans. And each depth sets its own schedule for when it should next fire, based on what it found.

## The agent loop

The execution primitive behind both orient and deep reflect is `runAgentLoop` — a multi-turn tool-calling loop bounded by a step limit.

Each turn: the model receives the conversation so far (system prompt, previous messages, tool results), produces either tool calls or final output. If it produces tool calls, they execute — in parallel if multiple — and results feed back as the next turn's context. If it produces final output, the loop ends. If the step limit is reached, the model is forced to produce final output immediately.

Tools are loaded dynamically from the store and executed in sandboxed isolates with scoped permissions. A tool that posts to Telegram gets the bot token but not the wallet key. A tool that checks a balance can't rewrite prompts. Each tool declares what it needs; the runtime provides exactly that and nothing more.

The agent can create, rewrite, and delete its own tools at runtime. The tool set isn't fixed at deploy time — it evolves as Swayambhu learns what he needs.

This design relies on prompt caching to stay cost-efficient. The system prompt and initial context are cached after the first turn, so subsequent turns only pay full price for new content. Since output tokens are 5× more expensive than input, and the model doesn't generate speculative plans for paths it never takes, multi-turn execution is typically equal or cheaper than planning everything upfront in a single call.

## Self-modification with safety rails

Self-modification is the point. But ungoverned self-modification is how you brick yourself. Several mechanisms keep the system stable.

**The dharma.** One key in the store is immutable — the runtime physically prevents it from being overwritten. This is Swayambhu's foundational identity: his values, his relationship with his creator, his core constraints. Everything else can orbit, evolve, and restructure, but it can't drift away from this fixed attractor.

**Yamas and niyamas.** Operating principles that sit between immutable dharma and mutable config. Yamas (`yama:*`) govern how Swayambhu engages the outer world; niyamas (`niyama:*`) govern inner practice. They're kernel-injected into every LLM prompt like dharma, but mutable — with friction. Modifications require a deliberation field (min 200 chars for yamas, 100 for niyamas), a capable model, and produce an audit trail. The kernel enforces all of this; the hook can't bypass it.

**Protected keys.** All writes from the agent loop pass through a protection gate. System keys — prompts, config, tools, credentials, the wisdom document — are blocked from direct writes. They can only be modified through the mutation protocol. Agent-created data keys pass through freely.

**The mutation protocol.** Changes to protected keys go through a staged lifecycle. Session reflect proposes mutations, which are staged. Deep reflect reviews staged mutations and issues verdicts: apply, reject, modify, defer, or withdraw. Applied mutations become candidates — the changes take effect, but old values are snapshotted for rollback. Only after deep reflect explicitly promotes a candidate does the snapshot get deleted and the change become permanent. Deep reflect's own mutations skip staging and become candidates immediately — it's the highest-trust context.

Each mutation carries **checks** — verifiable conditions that the runtime evaluates mechanically. These might assert that a KV key has a certain value, or that a tool produces a certain result. Check results are shown in context whenever mutations are loaded, so the model sees whether its changes are working before deciding to promote or roll back.

**The circuit breaker.** On every wake, before anything else runs, the runtime scans karma logs for danger signals — fatal errors, parse failures, all providers failing — that occurred after any candidate mutation was activated. If found, it rolls back the candidate automatically. This catches the case where a bad mutation breaks the system so badly that no LLM call succeeds. The runtime handles recovery mechanically without needing a model.

**Conflict detection.** Two mutations targeting the same key can't both be candidates simultaneously. The second is rejected until the first is promoted or rolled back.

**Conservative seed defaults.** The system starts with tight constraints — low step limits, cautious budgets. As it gains experience, the reflection hierarchy can loosen these constraints via config updates. Safer to start tight and self-relax than start loose and self-correct after making expensive mistakes.

## Provider resilience

LLM calls go through a three-tier cascade. First, a dynamic adapter loaded from the store — Swayambhu writes and maintains his own provider integration code. If that fails, the runtime falls back to a snapshot of the last working adapter. If that fails too, a hardcoded OpenRouter call serves as the absolute last resort. This means a bad adapter update can't permanently lock the agent out of LLM access. The model tier also cascades — if the requested model fails on all providers, the call retries on a cheaper fallback model.

## The leverage curve

Most agent architectures are flat loops: think → act → observe → repeat. One model, one level. Improvement is linear — upgrade the model, the agent gets proportionally better.

Swayambhu's layered architecture changes the leverage curve. When a more capable model becomes available:

**First order:** Better action and tool use in the current session.

**Second order:** Better prompts and tools written for future sessions, persisted in the store, reused indefinitely. The improvement outlasts the session that created it.

**Third order:** Better instructions for the cheaper models that handle subplans. The smarter orient teaches the workers to be more effective, so the execution tier improves without itself being upgraded.

**Fourth order:** Better deep reflections — smarter structural changes to memory, tools, and operational patterns that compound across many sessions.

Each level multiplies through the levels below it. The system is a compiler that writes programs that write programs. Upgrading the compiler doesn't improve one output — it improves the factory.

The same gearing works in reverse for mistakes, which is why the dharma and mutation protocol exist. The fixed attractor and staged changes prevent the compounding from going in the wrong direction.

## Design principles

**The data is the agent, the runtime is substrate.** Everything that makes Swayambhu *himself* is portable data. The runtime is a replaceable executor. Migration to a different platform means exporting the store and writing a new thin loop.

**Hardcode only what protects.** The runtime enforces dharma immutability, key protection, sandbox scoping, and provider failover. Everything else is delegated to the LLM layer, which can self-modify.

**Sensible defaults, not permanent decisions.** The seed prompts, tools, and memory structures are bootstrapping aids. Swayambhu can restructure, replace, or remove any of them as he evolves.

**The karma log is the source of truth.** Every LLM call and tool execution is recorded with full request/response, flushed to the store after each entry. If the runtime crashes mid-session, the log survives up to the point of death. The next session's crash detection picks up exactly where things went wrong.

## Kernel / hook architecture

The runtime is split into two layers: a **kernel** (`brainstem.js`) and a **wake hook** (`wake-hook.js`).

The kernel contains hardcoded primitives and safety invariants — LLM calls, KV access, tool execution, the agent loop, sandbox isolation, karma logging, and provider cascading. It's deployed code; changes require a redeploy.

The wake hook contains all session policy — wake flow, crash detection, reflect scheduling, the mutation protocol, circuit breaker, and session orchestration. It's stored in KV as `hook:wake:code` and executed in an isolate via the Worker Loader API. Swayambhu can rewrite it through the mutation protocol, restructuring his own control flow without a deploy.

The hook calls kernel primitives via RPC (`K.callLLM()`, `K.runAgentLoop()`, etc.) through a `KernelRPC` entrypoint. The kernel enforces write protection on every call: routine data goes through `kvPutSafe`, system key mutations go through `kvWritePrivileged` (snapshotted, rate-limited, audited). `kernel:*` keys and `dharma` are unconditionally blocked — only the kernel's internal write path can touch them.

A meta-safety tripwire watches for consecutive crashes. If the last 3 sessions all crashed or were platform-killed, the kernel deletes the hook, sends an alert, and runs a hardcoded minimal fallback until the hook is manually re-seeded. This catches the case where a bad hook rewrite breaks the system — recovery is mechanical, no working LLM call required.

## Current status

The brainstem runtime is functional. Swayambhu runs on Cloudflare Workers with tool execution via Dynamic Worker Loaders (isolate-based sandboxing). The kernel/hook split separates hardcoded safety from evolvable policy. Local development works fully with Wrangler. Production deployment uses Cloudflare's Dynamic Worker Loader API.

For setup instructions, KV schema, and implementation details, see `seed-config.md`, `brainstem.js` (kernel), and `wake-hook.js` (policy). For detailed architecture, see `docs/ARCHITECTURE.md`.
