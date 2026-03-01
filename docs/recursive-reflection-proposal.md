# Recursive Reflection: Symmetric Architecture for Upward Abstraction

## Context

The brainstem has variable-depth recursion downward (orient → subplan → subplan → ...),
controlled by `max_subplan_depth`, but reflection goes only one level up. Deep reflect
can rewrite orient's prompt, but nothing rewrites deep reflect's prompt — a blind spot.

This change does two things. First, it generalizes deep reflection to arbitrary depth,
mirroring the subplan pattern, so each level can examine and evolve the level below it.
Second, it replaces `executeSteps` with `runAgentLoop` as the sole execution primitive
— a multi-turn tool-calling loop used by both orient and reflect. This retires the
plan-upfront execution model and its conditional branch logic in favor of reactive
tool use, where the model decides on each turn what to do next based on what it just
learned. Each reflect depth owns its own invocation cadence after its first run.

When `max_reflect_depth = 1` (the default), only depth 1 reflect fires.

---

## Two-layer model

### Session reflect (not part of the hierarchy)

Session reflect runs inside orient's agent loop every wake cycle. It produces **karma** —
structured session logs recording actions taken, outcomes, resource usage, and
observations. Karma is the ground-truth data layer. Session reflect answers:
*"What just happened?"*

Session reflect is unchanged by this proposal.

### Deep reflect hierarchy (depth 1, 2, 3, ...)

The deep reflect hierarchy is an abstraction ladder built on top of karma. Each depth
reads the outputs of the level below, identifies patterns, and can rewrite the level
below's prompt to improve its behavior. Deep reflect answers: *"What patterns do I see,
and how should I adjust the system?"*

- **Depth 1** reads karma, writes `prompt:orient`
- **Depth 2** reads depth-1 outputs, writes `prompt:reflect:1`
- **Depth N** reads depth-(N-1) outputs, writes `prompt:reflect:{N-1}`

Every depth is a full agent — it can plan, use tools, gather additional context, and
synthesize across multiple turns before producing output.

---

## Design principles

### Strict one-level-below prompt writes

Each depth can only rewrite the prompt of the level directly below it:

| Depth | Reads | Writes prompt |
|-------|-------|---------------|
| 1 | karma, any prompt, any KV key | `prompt:orient` |
| 2 | reflect:1 outputs, karma, any prompt, any KV key | `prompt:reflect:1` |
| N | reflect:{N-1} outputs, karma, any prompt, any KV key | `prompt:reflect:{N-1}` |

**Reads are unrestricted.** Any depth can read any prompt, any karma entry, any reflect
output, any KV key. The agent loop gives full investigative access.

**Prompt writes are strictly one level below.** This eliminates write conflicts (each
prompt has exactly one writer) and enforces indirect influence: if depth 3 sees a problem
with orient, it adjusts depth 2's prompt so depth 2 catches such issues going forward.
Skip-level writes would be patches. One-level writes improve the system's self-correcting
capability.

**Config and KV writes are global.** `updated_defaults` and `kv_operations` from any
depth affect the whole system. `this.defaults` is refreshed in memory after each depth's
output, so depth 2's config changes are visible to depth 1 in the same cascade. This is
an intentional indirect influence channel — higher depths set constraints that lower
depths operate within.

### Self-determined intervals

Each depth owns its invocation cadence via `next_reflect` in its output. The
`reflect_interval_multiplier` config is a **cold-start fallback only**, used when a depth
has never fired. After first run, the formula is never consulted again for that depth.

The agent has information a formula doesn't: what it found, what it changed, how uncertain
it is, what's happening in the world. A depth seeing rapid changes schedules itself sooner.
A depth seeing stability pushes out further.

### `runAgentLoop`: retiring `executeSteps`

This proposal replaces `executeSteps` with `runAgentLoop` as the sole execution
primitive. This is a breaking change to orient's execution model. No backward
compatibility is maintained.

**What `executeSteps` does today.** Orient makes a single `callLLM` call which returns
a complete plan — a JSON array of steps with conditional branches. `executeSteps` runs
them sequentially, evaluating conditions and executing actions. The model plans
everything upfront before seeing any results.

**Why replace it.** The plan-upfront model requires the agent to predict what it will
find before finding it. Conditional branches handle known unknowns (price up or down)
but not unknown unknowns (something unexpected that changes the investigation entirely).
For orient, this was a cost tradeoff — one expensive call is cheaper than multiple.
With prompt caching, that tradeoff reverses: cached input tokens make multi-turn
conversations cheap, and output tokens (5x more expensive than input) are *smaller*
in reactive mode because the model doesn't generate speculative branches for paths
it never takes.

**What `runAgentLoop` does.** A multi-turn loop. Each turn the model sees results from
its previous tool call and decides what to do next — call another tool, call multiple
tools in parallel, or produce final output. The loop ends when the model produces
structured output instead of a tool call, or when `maxSteps` is reached.

**How plan-upfront behavior is preserved.** Orient's prompt still says "plan your
actions." On a routine task, the model's first turn produces final output directly —
one call, same as today but without the `executeSteps` intermediary. On a complex task,
the model might make 2-3 tool calls before synthesizing. On a surprising task, it can
follow a thread it didn't anticipate. The prompt shapes the behavior, not the code.

**Subplans become a tool.** Currently subplans are steps within a plan. In the new
model, `spawn_subplan` is a tool call that spawns a nested `runAgentLoop`. The model
calls it when it identifies independent threads of work. Multiple `spawn_subplan` calls
in a single turn execute in parallel. Each subplan runs its own reactive loop and
returns results to the parent. `max_subplan_depth` still limits nesting.

**Cost analysis with caching.**

Orient, plan-upfront (current): 8K input + 3K output (includes speculative branches).
Effective cost: 8 + 15 = 23 units.

Orient, reactive 3 turns: turn 1 is 8 input + 1 output = 9. Turn 2 is mostly cached
input + 1 output ≈ 2.5. Turn 3 is mostly cached + 5 output = 7.2. Total ≈ 18.7 units.

Orient, reactive 1 turn (simple task): 8 input + 2.5 output = 10.5 units.

Reactive is equal or cheaper in every case. Savings come from output tokens — the model
doesn't pay 5x rate for speculative conditional branches it never executes.

**Self-correcting failure modes.** The reflect hierarchy detects and fixes execution
problems without code changes:

- Model loops on a tool → depth 1 sees it in karma, adjusts orient's prompt:
  "if a search fails twice, stop and work with what you have"
- Model over-investigates routine tasks → depth 1 sees cost patterns, tightens
  orient's prompt or lowers `maxSteps` via `updated_defaults`
- Subplan explosion → depth 1 sees cost spikes, adjusts `max_subplan_depth` or
  prompt guidance on when to parallelize
- Conversation grows too large → depth 1 adjusts truncation thresholds or adds
  prompt instruction to summarize tool results before proceeding

The only hardcoded guardrail is `maxSteps` as a ceiling in code. Everything else —
prompt guidance, config values, behavioral nudges — is owned by the reflect hierarchy
and can be tuned without deployment.

**Seed defaults should be conservative.** `maxSteps: 3` for orient, `maxSteps: 5` for
reflect depth 1, higher for deeper depths. The system loosens its own constraints as
it gains confidence. Better to start tight and self-relax than start loose and
self-correct after wasting money.

---

## Files to modify

| File | Change |
|------|--------|
| `brainstem.js` | Remove `executeSteps` and conditional branch logic; add `runAgentLoop`; refactor orient to use it; replace `isDeepReflectDue`/`runDeepReflect` with `isReflectDue`/`runReflect`; convert subplans from plan steps to tool calls; update `wake()` |
| `seed-config.md` | Add `max_reflect_depth`, `reflect_interval_multiplier`, `max_steps`; restructure execution defaults |
| `scripts/seed-local-kv.sh` | Same fields in the heredoc |
| `prompt:orient` (KV) | Rewrite to use tool calls instead of JSON plan output; remove conditional branch syntax |

No new files. Higher-depth prompts use `defaultReflectPrompt(depth)` as fallback or get
created at runtime by the level above.

---

## Changes to brainstem.js

### 1. `wake()`

Replace the boolean with a depth integer:

```javascript
const reflectDepth = await this.highestReflectDepthDue();

if (reflectDepth > 0) {
  await this.runReflect(reflectDepth, context);
}
```

Update `context.deepReflectDue` → `context.reflectDepth`.

### 2. `highestReflectDepthDue()`

Scans from `max_reflect_depth` down to 1, returns the first depth that is due (or 0).

### 3. `isReflectDue(depth)`

Two-phase check:

1. **Self-scheduled (primary).** Read `reflect:schedule:{depth}`. If it exists, use it.
   This was set by the depth's last invocation via `next_reflect`.

2. **Cold-start fallback (only if no schedule exists).** Compute default interval:
   `base_interval * multiplier^(depth-1)` where base is
   `defaults.deep_reflect.default_interval_sessions` (20) and multiplier is
   `defaults.execution.reflect_interval_multiplier` (5). Depth 1 = 20 sessions,
   depth 2 = 100, depth 3 = 500.

Once a depth has fired and set its own schedule, the cold-start formula is never
consulted again.

### 4. `runAgentLoop(config)` — replaces `callLLM` → `executeSteps`

```javascript
async runAgentLoop({ systemPrompt, initialContext, tools, model, maxSteps }) {
  const messages = [{ role: 'user', content: initialContext }];

  for (let step = 0; step < maxSteps; step++) {
    const response = await this.callLLM({ systemPrompt, messages, tools, model });

    // If the model produced tool calls, execute and feed results back
    if (response.toolCalls?.length) {
      messages.push({ role: 'assistant', content: response });
      // Parallel: multiple tool calls in one turn execute concurrently
      const results = await Promise.all(
        response.toolCalls.map(tc => this.executeToolCall(tc))
      );
      messages.push({ role: 'user', content: results });
      continue;
    }

    // Model produced final output — done
    return response;
  }

  // Max steps reached — return last response as final
  return messages[messages.length - 1];
}
```

`executeToolCall` handles all tool types including `spawn_subplan`, which recursively
calls `runAgentLoop` with its own prompt, context, and `maxSteps`. This replaces the
subplan logic previously embedded in `executeSteps`.

**Orient refactor.** Current orient flow (`callLLM` → `executeSteps`) is replaced with
`runAgentLoop`. Orient's prompt, tools, and model config are passed in. On routine tasks
the model produces output on turn 1 — identical cost to today. `executeSteps` and its
conditional branch logic are removed entirely.

### 5. `runReflect(depth, context)`

Uses `runAgentLoop`, then applies reflect-specific outputs.

```javascript
async runReflect(depth, context) {
  const prompt = await this.loadReflectPrompt(depth);
  const initialContext = await this.gatherInitialReflectContext(depth);
  const belowPrompt = await this.loadBelowPrompt(depth);

  const agentResult = await this.runAgentLoop({
    systemPrompt: prompt,
    initialContext: { ...initialContext, belowPrompt },
    tools: this.tools,
    model: this.getReflectModel(depth),
    maxSteps: this.getMaxSteps('reflect', depth),
  });

  const output = this.parseReflectOutput(agentResult);
  await this.applyReflectOutput(depth, output, context);

  if (depth > 1) {
    await this.runReflect(depth - 1, context);
  }
}
```

**Initial context (pre-loaded before loop starts):**
- Depth 1: 10 most recent `karma:*` entries + `prompt:orient`
- Depth N>1: 10 most recent `reflect:{N-1}:*` entries + `prompt:reflect:{N-1}`

The agent can pull more via tools during its loop.

The agent's final turn produces structured output, which is then applied:

- `updated_wisdom` → writes wisdom key
- `kv_operations` → applies each via `applyKVOperation`
- `updated_defaults` → deep-merges into `config:defaults` AND refreshes `this.defaults`
  in memory (critical for cascade)
- `updated_model_details` → `applyModelUpdates`
- `below_prompt_proposals` → rewrites the **one-level-below** prompt key only:
  - depth 1 → writes `prompt:orient`
  - depth N>1 → writes `prompt:reflect:{N-1}`
- `next_reflect` → writes `reflect:schedule:{depth}` (self-determined interval)
- Stores output as `reflect:{depth}:{sessionId}` (history for the level above)
- Only depth 1 writes `last_reflect` and `wake_config` (terminal cascade step)

#### Cascade

```javascript
if (depth > 1) {
  await this.runReflect(depth - 1, context);
}
```

### 6. `defaultReflectPrompt(depth)`

Hardcoded fallback for depths without a KV prompt (analogous to `defaultSubplanPrompt()`).

Instructs the model to:
- Examine the level below's prompt and recent outputs
- Plan its investigation — decide what additional context to gather and what tools to use
- Produce analysis and optionally rewrite the below-level's prompt
- Set its own next invocation interval

Output schema: `reflection`, `note_to_future_self`, `below_prompt_proposals`,
`updated_defaults`, `kv_operations`, `next_reflect`, `next_wake_config`.

### 7. `loadReflectPrompt(depth)`

```javascript
async loadReflectPrompt(depth) {
  const stored = await this.kv.get(`prompt:reflect:${depth}`);
  return stored || this.defaultReflectPrompt(depth);
}
```

### 8. `loadBelowPrompt(depth)`

```javascript
async loadBelowPrompt(depth) {
  if (depth === 1) return await this.kv.get('prompt:orient');
  return await this.kv.get(`prompt:reflect:${depth - 1}`);
}
```

### 9. Model/effort/tokens

```javascript
getReflectModel(depth) {
  const perLevel = this.defaults.reflect_levels?.[depth];
  if (perLevel?.model) return perLevel.model;
  return this.defaults.deep_reflect.model;
}

getMaxSteps(role, depth) {
  if (role === 'orient') return this.defaults.execution.max_steps.orient;
  const perLevel = this.defaults.reflect_levels?.[depth];
  if (perLevel?.max_steps) return perLevel.max_steps;
  return depth === 1
    ? this.defaults.execution.max_steps.reflect_default
    : this.defaults.execution.max_steps.reflect_deep;
}
```

---

## KV key conventions

Uniform naming across all depths:

| Key pattern | Purpose |
|---|---|
| `prompt:reflect:{depth}` | Prompt for this depth |
| `reflect:schedule:{depth}` | Self-determined next invocation |
| `reflect:{depth}:{sessionId}` | Output record (history for level above) |
| `prompt:orient` | Orient's prompt (written by depth 1) |
| `karma:{sessionId}` | Session logs (read by depth 1) |

---

## Config defaults

```json
"execution": {
  "max_subplan_depth": 3,
  "max_reflect_depth": 1,
  "reflect_interval_multiplier": 5,
  "max_steps": {
    "orient": 3,
    "reflect_default": 5,
    "reflect_deep": 10
  },
  "fallback_model": "anthropic/claude-haiku-4-5-20251001"
}
```

- `max_reflect_depth: 1` — only depth 1 fires by default
- `reflect_interval_multiplier: 5` — cold-start only, for depths that have never fired
- `max_steps` — hard ceiling on `runAgentLoop` turns per invocation. Conservative
  seed defaults; the reflect hierarchy can adjust these via `updated_defaults`

Optional per-depth overrides:

```json
"reflect_levels": {
  "2": { "model": "anthropic/claude-sonnet-4-5-20250929", "max_steps": 15 },
  "3": { "model": "anthropic/claude-sonnet-4-5-20250929", "max_steps": 20 }
}
```

---

## Cascade flow example (depth 2)

```
wake()
  highestReflectDepthDue() → 2
  
  runReflect(2, context)
    loads prompt:reflect:2 (or defaultReflectPrompt(2))
    initial context: recent reflect:1:* records + prompt:reflect:1
    
    runAgentLoop (depth 2, max 10 steps):
      turn 1: reads initial context, reactively requests read_karma({last: 30})
              to check patterns that depth 1 flagged
      turn 2: reads karma, requests web_search("solana validator economics")
              because depth 1 has been evaluating staking decisions
      turn 3: reads web results, requests read_prompt("prompt:orient")
              to see if orient's instructions align with findings
      turn 4: produces final output
              → rewrites prompt:reflect:1 via below_prompt_proposals
              → sets next_reflect: 80 ("check back in 80 sessions")
    
    stores reflect:2:{sessionId}
    writes reflect:schedule:2 = {next_session: currentSession + 80}
    updates this.defaults in memory
    
    cascade → runReflect(1, context)
      loads prompt:reflect:1 (possibly just rewritten by depth 2!)
      initial context: 10 recent karma:* + prompt:orient
      
      runAgentLoop (depth 1, max 5 steps):
        turn 1: reads initial context, everything looks routine,
                produces final output immediately
                → may rewrite prompt:orient
                → sets next_reflect: 25
      
      stores reflect:1:{sessionId}
      writes reflect:schedule:1 = {next_session: currentSession + 25}
      writes last_reflect, wake_config
      depth === 1, cascade stops
```

**Validation property:** depth 2's changes to `prompt:reflect:1` are immediately
exercised by depth 1 in the same wake cycle, against real session history.

**Planning property:** depth 2 went reactive — followed an investigation thread across
karma, web, and prompt data before deciding how to adjust depth 1. Depth 1 saw a routine
review and produced output immediately. Same primitive, different model choices.

**Self-scheduling property:** depth 2 chose 80 sessions based on what it observed,
not a formula. Depth 1 chose 25. Each level tunes its own cadence.

**Write discipline property:** depth 2 wanted to adjust orient's behavior, but it
wrote to `prompt:reflect:1`, not `prompt:orient`. Depth 1 is the only writer of
orient's prompt. Depth 2 influences orient indirectly by shaping depth 1's judgment.

---

## Migration

This is a breaking change. No backward compatibility is maintained.

- **`executeSteps` removed.** All plan execution, conditional branch logic, and the
  JSON plan output schema are deleted. Orient's prompt is rewritten to use tool calls
  instead of emitting a plan array.
- **`runAgentLoop` replaces all execution.** Orient, reflect at every depth, and
  subplans all use the same loop.
- **Subplans become tool calls.** `spawn_subplan` is a tool the model invokes, not a
  step type in a plan. Each subplan spawns a nested `runAgentLoop`.
- **KV key renames.** `prompt:deep` → `prompt:reflect:1`.
  `deep_reflect_schedule` → `reflect:schedule:1`.
- **Orient prompt rewrite required.** The orient prompt must be updated to work with
  tool-calling instead of the plan output schema. The prompt instructs the model to
  call tools directly (check balance, search, stake, post to Telegram) rather than
  emitting a plan array.
- **Conservative seed `maxSteps`.** Orient starts at 3, reflect depth 1 at 5. The
  system self-adjusts from there.

---

## Out of scope (future work)

**Async questions and watches.** Any agent loop (orient or reflect) may want to express
conditional future behavior: ask a human and resume when they reply, act when a price
crosses a threshold, wait for on-chain confirmation. This requires a general-purpose
watch/park primitive in the wake loop. It's cross-cutting infrastructure, not
reflect-specific, and deserves its own design doc.

**Depth tagging on mutations.** Add `source_depth` field to mutation records
(`kv_operations`, `updated_defaults`) so each depth can filter to its own changes
when reviewing history. Enables a reflect depth to evaluate whether its past config
changes helped or hurt.
