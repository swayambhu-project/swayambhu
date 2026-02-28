# The Brainstem

The brainstem is Swayambhu's execution layer — a thin, unopinionated runtime
that wakes up on a timer, asks an LLM what to do, follows the plan, and goes
back to sleep. It has no opinions of its own. Every decision that can be pushed
to the models has been pushed to the models.

It runs as a single Cloudflare Worker (`brainstem.js`), triggered by a cron
schedule.

---

## The Lifecycle

```
Timer fires
  |
  v
wake()
  |
  +-- Am I supposed to be sleeping? --> yes --> return (go back to sleep)
  |
  +-- Did the last session crash? --> gather the dead session's flight recorder
  |
  +-- Load ground truth (API balance, wallet balance, KV usage)
  +-- Load config + context from KV
  |
  +-- Is deep reflection due?
  |     |
  |     yes --> runDeepReflect()
  |     |         Review recent history, update wisdom, modify own prompts
  |     |         and config, schedule next deep reflection, sleep.
  |     |
  |     no --> runSession()
  |              |
  |              +-- Orient: call LLM with full context
  |              |     "Here's everything. What should I do?"
  |              |     LLM returns a JSON plan with steps.
  |              |
  |              +-- Execute steps (loop):
  |              |     action     --> run a dynamic tool from KV
  |              |     think      --> call LLM, store the response
  |              |     conditional --> ask LLM a question, branch on the answer
  |              |     subplan    --> ask LLM for a mini-plan, execute recursively
  |              |     reflect    --> review session, write notes for next time
  |              |
  |              +-- Write session results, increment counter
  |
  +-- Mark session complete (crash-detection marker)
```

---

## Key Concepts

### KV is the brain, the brainstem is the body

Cloudflare KV (a persistent key-value store) holds everything: the soul,
prompt templates, config, tools, session logs, wisdom, secrets. The brainstem
reads from KV, does what it's told, and writes results back. Between sessions,
KV is the only thing that persists.

### The karma log (flight recorder)

Every LLM call and tool execution is logged to a `karma:{session_id}` key in
KV. The log flushes after every entry, so if the worker crashes, the record
survives up to the point of death — like an airplane's black box.

The next session can read the dead session's karma to understand what went
wrong.

### Dynamic tools

Tools are not hardcoded. They live in KV as JavaScript code (`tool:{name}:code`)
with metadata (`tool:{name}:meta`). Swayambhu can create, edit, and delete its
own tools. The brainstem only provides primitives: `fetch`, scoped KV access,
and scoped secrets.

### Self-modification through reflection

At the end of each session, a "reflect" step reviews what happened and writes
notes for the next session. Periodically, a deeper reflection can rewrite the
orient prompt, update config defaults, and modify model preferences. The system
evolves over time.

---

## Walkthrough

### 1. Entry point

```js
export default {
  async scheduled(event, env) {
    const brain = new Brainstem(env);
    await brain.wake();
  },
};
```

Cloudflare calls `scheduled()` on a cron timer. Each invocation creates a fresh
`Brainstem` instance with a unique session ID and calls `wake()`.

### 2. Wake-up checks

The first thing `wake()` does is check whether it should actually run:

- **Sleep check** — The previous session may have said "don't wake me for 30
  minutes." If that time hasn't passed, return immediately.
- **Crash detection** — Compare the most recent karma log's session ID against
  the `session:last_completed` marker. If they don't match, the previous session
  wrote karma but never finished — it crashed. Load the dead session's full
  karma so the LLM can learn what went wrong.

### 3. Loading ground truth

Three pieces of real-world data are fetched in parallel:

| Data | Source | Why |
|------|--------|-----|
| OpenRouter balance | OpenRouter API | How much LLM credit remains |
| Wallet balance | Base blockchain (USDC) | On-chain financial state |
| KV usage | Internal counter | Track write volume |

These are facts the LLM can't hallucinate — hard constraints on what's possible.

### 4. Tripwires and effort levels

Tripwires are rules like "if balance drops below $5, switch to high-effort
mode." The brainstem evaluates them against the live data and determines the
session's effort level (`low`, `medium`, `high`, or `max`).

### 5. The orient call

The brainstem loads a prompt template from KV (`prompt:orient`), fills in all
the context variables (balances, config, last reflection, crash data, KV index),
and sends it to the LLM.

The LLM responds with a **JSON plan** — a list of steps to execute, plus
metadata like session budget and wake config.

### 6. Step execution

The brainstem loops through the plan's steps. Before each step, it checks three
budget limits:

- **Cost** — total dollars spent on LLM calls this session
- **Steps** — total number of steps executed
- **Time** — wall-clock duration since wake

If any limit is exceeded, execution stops.

Each step has a **type** that determines how it's executed:

#### `action` — Run a dynamic tool

1. Load the tool's JavaScript code and metadata from KV (cached per session)
2. Build a sandboxed context with scoped secrets and KV access
3. Execute the code with a timeout using `Promise.race`
4. Store the result if the step specifies `store_result_as`

Tools get a `ctx` object with:
- The step's input arguments
- Only the secrets listed in the tool's metadata
- KV access at one of three levels: `none`, `own` (namespaced to the tool), or
  `read_all` (can read anything, writes still namespaced)
- A `fetch` function for HTTP requests

#### `think` — Call the LLM

Send a prompt to the LLM and store the response. Used for reasoning,
summarization, or generating content mid-session.

#### `conditional` — Branch on LLM judgment

Ask the LLM a question (e.g., "should I proceed? answer yes or no"). The
response determines which branch of steps to execute next.

#### `subplan` — Recursive planning

Ask the LLM to generate a mini-plan for a sub-goal, then execute those steps.
Subplans can nest up to 3 levels deep (configurable) to prevent infinite
recursion.

#### `reflect` — Session review

Review the karma log, costs, and results. Produce a summary, notes for the
future, and optionally KV operations or wake config changes.

### 7. Variable passing between steps

Steps can store results with `store_result_as: "myVar"`. Later steps can
reference those results with `{{myVar}}` in any field. If a referenced step
failed, the dependent step is skipped automatically.

### 8. Failure handling

When a step fails:
1. Log the failure to karma
2. Retry up to N times (configurable per step or globally)
3. If all retries fail, mark the result as `__failed` so dependent steps skip
4. Optionally stop the entire session (`on_fail: "stop_session"`)

---

## The LLM Provider Cascade

The brainstem uses a three-tier fallback for LLM calls:

```
Tier 1: Dynamic adapter
  Code stored in KV at provider:llm:code
  Swayambhu can modify this to change providers, add headers, etc.
  If it works, snapshot it as "last working."
        |
        | (fails)
        v
Tier 2: Last working adapter
  A copy of the dynamic adapter from the last time it succeeded.
  Safety net if Swayambhu breaks the dynamic adapter.
        |
        | (fails)
        v
Tier 3: Hardcoded OpenRouter
  Baked into brainstem.js. Can never be broken by Swayambhu's
  own modifications. The absolute last resort.
```

If all three tiers fail for a given model, it falls back to a cheaper model
(default: Claude Haiku) and tries the whole cascade again.

---

## Deep Reflection

Every N sessions (or N days), the brainstem runs a deep reflection instead of a
normal session. This is a more thorough self-review that can:

- **Update wisdom** — long-term accumulated knowledge
- **Modify config defaults** — change operating parameters
- **Rewrite the orient prompt** — change the instructions it gives itself
- **Update model preferences** — change which models are used for what
- **Schedule the next deep reflection**

Deep reflection loads significantly more context than a normal session: the soul,
wisdom, recent karma logs, the orient prompt, current defaults, and session
history.

---

## Safety Rails

### Immutable soul
The `soul` key in KV cannot be overwritten — `kvPut` throws an error if you
try. This is the one thing Swayambhu cannot change about itself.

### Prompt injection filtering
External input is sanitized by stripping prompt boundary markers (`<system>`,
`[INST]`, ChatML tags), removing zero-width characters, and wrapping the content
in a trust boundary label. The code acknowledges this is a bare minimum.

### Scoped tool access
Tools can only access secrets and KV keys they've been explicitly granted in
their metadata. A tool with `kv_access: "own"` can only read/write keys under
its own `tooldata:{name}:` prefix.

### Budget enforcement
Hard limits on cost, step count, and wall-clock time prevent runaway sessions.

### Provider resilience
The three-tier cascade ensures the system can always make LLM calls, even if
Swayambhu breaks its own provider configuration.

---

## KV Key Conventions

| Pattern | Contents |
|---------|----------|
| `soul` | Immutable identity document |
| `wisdom` | Accumulated long-term knowledge |
| `prompt:orient` | Orient prompt template |
| `prompt:reflect` | Reflect prompt template |
| `prompt:deep` | Deep reflection prompt template |
| `config:defaults` | Default operating parameters |
| `config:models` | Model registry (IDs, aliases, pricing) |
| `config:resources` | Resource registry |
| `wake_config` | When to wake next, effort overrides |
| `last_reflect` | Output of the most recent reflection |
| `session_counter` | Total session count |
| `session:last_completed` | Session ID of last clean completion |
| `karma:{session_id}` | Full flight recorder for a session |
| `tool:{name}:code` | JavaScript source for a dynamic tool |
| `tool:{name}:meta` | Tool metadata (secrets, KV access, timeout) |
| `tooldata:{name}:{key}` | Tool-scoped persistent data |
| `provider:llm:code` | Dynamic LLM provider adapter |
| `provider:llm:meta` | Provider adapter metadata |
| `provider:llm:last_working:*` | Snapshot of last successful adapter |
| `secret:{name}` | Swayambhu-provisioned secrets |
| `deep_reflect_schedule` | When the next deep reflection is due |
| `session_history` | Aggregated session history |
