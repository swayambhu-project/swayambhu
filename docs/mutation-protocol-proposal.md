Mutation Protocol: Feature Proposal for brainstem.js

 Context

 brainstem.js currently allows reflect and deep_reflect to write any KV key
 freely via kv_operations (an array of KV write operations in the LLM's JSON
 output, processed by applyKVOperation) and named fields (updated_wisdom, updated_defaults,
 updated_model_details, orient_prompt_proposals). There is no rollback, no
 checks, and no evaluation of whether changes improved anything.

 This change adds a governed self-modification protocol. Writes to KV keys
 from LLM output are protected by default and must go through a mutation
 lifecycle: staged → candidate → promoted.

 ---
 Files to modify

 brainstem.js    Add mutation protocol methods, modify applyKVOperation,
                 modify kvPut, modify executeReflect, modify runDeepReflect,
                 modify writeSessionResults, modify wake.

 prompt:reflect  Update to include:
                 - The mutation_requests output field schema (claims, ops, checks)
                 - The mutation_verdicts output field (withdraw, modify only)
                 - Explanation that protected key writes via kv_operations are
                   blocked and must use mutation_requests instead
                 - Guidance on grouping: related changes that must succeed or
                   fail together go in one request, unrelated changes in separate
                   requests
                 - The system key patterns so the agent knows which keys always
                   require the protocol
                 - The check DSL (kv_assert, tool_call)
                 - That staged mutations from previous reflects are included in
                   context and can be modified or withdrawn

 prompt:deep     Update to include:
                 - The mutation_requests output field schema
                 - The mutation_verdicts output field (for staged: apply,
                   reject, modify, defer; for candidates: promote, rollback,
                   defer)
                 - That staged and candidate mutation records are included in
                   context and must all be reviewed with explicit verdicts
                 - The same grouping, system key, and check DSL guidance as
                   prompt:reflect
                 - That the check vocabulary can be extended by creating tools
                   and invoking them via tool_call
                 - That mutations proposed by deep reflect become candidates
                   immediately (skip staging)

 ---
 Three-tier protection model

 1. soul — immutable. kvPut throws. Cannot be changed by any mechanism.

 2. System keys — always protected. Mutation protocol required. Protection
    cannot be toggled off.

    Any key starting with: prompt:  config:  functions:  secret:
                           mutation_staged:  mutation_candidate:

    These specific keys:   providers  wallets  wisdom

 3. Agent-created keys — protected by default. The agent can toggle the
    unprotected flag on or off via a mutation request. Once marked unprotected,
    subsequent reflect phases can write the key freely via kv_operations. The
    agent can flip it back to protected later.

 The brainstem has two code paths for writing KV:

 1. Direct writes (kvPut) — used by the brainstem's own mechanical operations:
    karmaRecord, writeSessionResults, wake (session breadcrumb), callWithCascade
    (adapter snapshot), executeReflect (last_reflect, wake_config),
    runDeepReflect (last_reflect, wake_config, deep_reflect_schedule).
    These bypass the protection gate entirely.

 2. LLM-output writes (applyKVOperation) — used when processing kv_operations
    arrays from reflect/deep_reflect output. These are checked:
    - System key → blocked, requires mutation_request
    - Agent key with unprotected metadata → write proceeds
    - Agent key without unprotected metadata → blocked, requires mutation_request

 kvPut silently strips the unprotected metadata flag on system keys.

 The agent receives the system key patterns in its prompt context so it knows
 which keys require the mutation protocol and which it can toggle.

 ---
 Mutation request schema

 Reflect and deep_reflect output can include a mutation_requests array. Each
 entry is an independent mutation with its own ops, checks, and rollback scope.

 Each mutation request contains:

   claims    Non-empty string. What this change is expected to improve.
   ops       Non-empty array of KV operations. Each op contains:
               op:        "create", "update", "delete", or "rename"
               key:       The target KV key
               value:     The new value (for create/update), or the new key
                          name (for rename)
               metadata:  Optional KV-native metadata object
   checks    Non-empty array of check objects (see Check DSL below).

 The brainstem validates that all three fields are present and non-empty.

 ---
 Mutation verdict schema

 Reflect and deep_reflect output can include a mutation_verdicts array. Deep
 reflect must include verdicts for all pending staged and candidate mutations.
 Session reflect may optionally include verdicts on staged mutations.

 Each verdict contains:

   mutation_id   The ID of the staged or candidate mutation being reviewed.
   verdict       The decision (see Deep reflect review and Session reflect
                 review sections for permitted values per phase).
   reason        Why this verdict was reached. Required for all verdicts
                 except apply and promote.
   updated       For modify only — an object containing the fields to update
                 on the staged record (ops, claims, and/or checks).

 ---
 Mutation lifecycle

 Post-session reflect proposes → STAGED (stored, not applied)
   ↓
 Deep reflect N reviews → CANDIDATE (applied) or rejected or modified or deferred
   ↓
 Deep reflect N+1 reviews → PROMOTED (permanent) or rolled back or deferred

 Deep reflect can also propose mutations directly — these skip staging and
 become candidates immediately. They still need the following deep reflect
 to promote.

 STAGED

 Mutation stored in mutation_staged:{id}. Target keys are untouched.

 Succeeding post-session reflect steps receive all currently staged mutations
 in their context. They can modify a staged mutation (update its ops, claims,
 or checks) or withdraw it entirely. Many regular sessions may run between
 deep reflects — the agent may learn that a staged proposal is wrong or needs
 refinement before deep reflect ever sees it.

 CANDIDATE

 Mutation applied to the target keys. A rollback snapshot of the previous
 values is stored in mutation_candidate:{id}. Changes are live but reversible.

 PROMOTED

 Deep reflect confirms the mutation is working well. The candidate record
 and its snapshot are deleted. Changes are permanent.

 ---
 Deep reflect review

 Deep reflect sessions must review all pending staged and candidate mutations.
 Deep reflect receives in its prompt context:

   - All mutation_staged:{id} records (ops, claims, checks, check results,
     proposing session)
   - All mutation_candidate:{id} records (snapshots, activation time,
     activating session)
   - Recent karma logs

 Deep reflect issues a verdict for every staged and candidate mutation:

 For staged mutations:
   apply     Snapshot current values, apply ops, convert to candidate.
   reject    Discard. Delete staged record. Reason required.
   modify    Update the staged record (change ops, claims, or checks).
             Reason required.
   defer     Keep staged as-is for next deep reflect. Reason required.

 For candidate mutations:
   promote   Make permanent. Delete candidate record and snapshot.
   rollback  Restore snapshotted values. Delete candidate record.
             Reason required.
   defer     Keep candidate as-is for next deep reflect. Reason required.

 The defer verdict produces a mutation_deferred karma entry so there is an
 explicit record that deep reflect reviewed the mutation and chose to wait.

 ---
 Session reflect review

 Post-session reflect steps receive all currently staged mutations in their
 context. They can issue two verdicts:

   withdraw  Pull back a staged mutation the agent no longer wants.
             Reason required.
   modify    Update a staged mutation's ops, claims, or checks.
             Reason required.

 Other verdict types from session reflect are ignored by the brainstem.

 ---
 Emergency circuit breaker

 Every wake cycle, before anything else, the brainstem scans active
 mutation_candidate records. If karma since a candidate's activation contains
 any of these, the candidate is auto-rolled-back:

   - fatal_error event
   - All LLM providers failed (cascade exhausted)
   - orient_parse_error

 ---
 Check DSL

 Built-in check types:

   kv_assert     Read a KV key, optionally navigate a dot-path into the
                 value, evaluate a predicate.
                 Fields: key, path (optional), predicate, expected (optional)
                 Predicates: exists, equals, gt, lt, matches, type

   tool_call     Run a dynamic tool (from functions in KV), optionally assert
                 on the result using the same predicates as kv_assert.
                 Fields: tool, input, assert (optional: { field, predicate,
                 expected })

 Unknown check types fail closed (return false). The agent extends the check
 vocabulary by creating tools and invoking them via tool_call.

 ---
 Changes to existing methods

 applyKVOperation
   Add protection gate. Extract raw write logic into applyKVOperationDirect
   for use by the mutation protocol after validation. Blocked writes log
   mutation_blocked to karma.

 kvPut
   After the soul immutability check, strip unprotected metadata flag on
   system keys.

 wake
   After crash detection, before loading ground truth, run the emergency
   circuit breaker to auto-rollback catastrophically failing candidates.

 executeReflect
   Load all mutation_staged records into prompt context before calling LLM.
   Split kv_operations: unprotected keys applied directly, protected keys
   skipped with a mutation_blocked event recorded in karma.
   Process mutation_requests — all go to staged.
   Process mutation_verdicts — withdraw and modify only.

 runDeepReflect
   Load all mutation_staged and mutation_candidate records into prompt context.
   Non-protected kv_operations applied directly.
   Process mutation_requests — applied immediately as candidates.
   Process mutation_verdicts — all verdict types.
   Refresh in-memory defaults if any mutation touches config:defaults.
   Remove the legacy named fields (updated_wisdom, updated_defaults,
   updated_model_details, orient_prompt_proposals). These are replaced by
   mutation_requests.

 writeSessionResults
   Remove model_details_updates. Orient observes model performance via karma;
   reflect proposes changes through the mutation protocol.

 ---
 KV key conventions (new)

 mutation_staged:{mutation_id}
   Contains: ops, claims, checks, check_results, proposed_at, proposed_session.
   May also have modified_at, modified_session if amended by a later reflect.
   Deleted on apply, reject, or withdraw.

 mutation_candidate:{mutation_id}
   Contains: snapshots of previous values, activated_at, activated_session.
   Deleted on promote or rollback.

 Both are system keys (always protected).

 ---
 Karma events (new)

 mutation_staged       Reflect proposed a mutation (stored, not applied)
 mutation_applied      Deep reflect applied a mutation as candidate
 mutation_promoted     Deep reflect promoted a candidate to permanent
 mutation_rolled_back  Deep reflect or circuit breaker rolled back a candidate
 mutation_rejected     Failed validation/checks, or deep reflect rejected staged
 mutation_blocked      LLM output tried to write a protected key directly
 mutation_withdrawn    Reflect or deep reflect withdrew a staged mutation
 mutation_modified     Reflect or deep reflect modified a staged mutation
 mutation_deferred     Deep reflect reviewed and chose to keep watching

 ---
 Conflicting candidates

 Multiple candidates on different keys: no issue.

 Same key across two candidates creates unresolvable conflicts — rollback
 order matters, promoting one then rolling back the other corrupts state,
 and snapshots become stale. Rather than adding complex stack tracking, the
 brainstem enforces one active candidate per key.

 When applying a mutation as candidate (either from a new proposal or from
 an apply verdict on a staged mutation), the brainstem checks if any existing
 candidate touches any of the same keys. If so, the mutation is rejected
 with a mutation_rejected karma entry explaining the conflict.

 Deep reflect can resolve this in a single session: promote or rollback the
 existing candidate, then apply the new one. Since verdicts and proposals
 are processed in the same session, this is a natural workflow.
