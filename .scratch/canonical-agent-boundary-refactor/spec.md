# Canonical Agent Boundary Refactor

**Status:** complete

## Problem Statement

The current canonical agent event sink combines durable event commits, parent-turn lifecycle policy, recovery, reads and reconnect, provider ingress, Codex child coordination, publication, and SQL mapping. A change in one concern can alter another concern's behavior because the class hides the contracts between them.

Terminal turn state has no single checked output contract. The repository already demonstrates one mismatch: an overflow checkpoint records `errored` while the reduced canonical turn state is `Interrupted`. The reported case of ordinary turns appearing interrupted or failed has not yet been reproduced, so its root cause is unknown.

The application currently supports canonical and legacy event paths. The legacy path must remain live until every implementation has migrated to the canonical path. Refactoring only the canonical path would break current consumers or leave two unrelated terminal-state behaviors.

## Solution

Create a small, provider-neutral canonical commit core. It validates canonical drafts, reduces canonical state, persists state and envelopes, derives the recovery checkpoint, and returns a durable commit receipt from one SQLite transaction.

Move policy and integrations into focused services: parent-turn lifecycle, publication, reads and reconnect, and Codex collaboration. Provider translators supply native evidence and canonical drafts. The lifecycle normalizer owns the terminal decision for one execution. Both canonical and legacy outputs are published from that same decision while both paths remain supported.

Add an end-to-end status fixture before behavior moves. It will show raw provider evidence, normalized decision, canonical events, checkpoint, legacy projection, and rendered state for one execution. The fixture establishes the cause of the reported normal-turn failure before a fix claims to address it.

## User Stories

1. As a user following a turn, I want completed, cancelled, interrupted, and errored results to stay consistent after live updates and reload, so that the conversation tells me what actually happened.
2. As a user with a current legacy-provider implementation, I want its event stream to keep working during the migration, so that refactoring does not remove my supported experience.
3. As a user with a canonical-provider implementation, I want ordered durable updates and reconnect recovery, so that refresh or temporary delivery failure does not change the turn result.
4. As a provider author, I want to submit provider-neutral canonical drafts through a narrow port, so that native provider signals do not need database access or generic lifecycle branches.
5. As a provider author, I want a commit and delivery receipt, so that I can distinguish duplicate input, durable commit, conflict, and deferred publication.
6. As an agent-runtime maintainer, I want one execution-scoped lifecycle decision, so that late signals from an old execution cannot change a newer turn in the same thread.
7. As a recovery maintainer, I want checkpoints to describe recovery progress without competing with canonical state, so that restart recovery only interrupts work that is unfinished.
8. As a Codex provider maintainer, I want child delegation, native identity binding, delivery uncertainty, retry, and parent continuation to live in one Codex coordinator, so that generic canonical storage does not own provider protocol.
9. As a maintainer of legacy consumers, I want legacy projections to be derived from the same terminal decision as canonical events, so that both active paths have equivalent outcomes during migration.
10. As a conversation reader, I want reconnect to select a contiguous durable delta or a snapshot, so that an incomplete live batch cannot corrupt the local replica.
11. As a debugger, I want one replayable status record to contain source signal, execution identity, decision, durable receipt, checkpoint, legacy projection, and UI result, so that reported state failures can be reproduced without guessing.
12. As a release owner, I want failed transaction participants to publish nothing, so that the UI never sees state the server did not durably accept.
13. As a release owner, I want publication failure to be reported separately from transaction failure, so that reconnect can repair deferred delivery without reporting a false rollback.
14. As a test maintainer, I want duplicate terminal events to be harmless and conflicting terminal events to be visible conflicts, so that races cannot silently conceal incorrect provider behavior.
15. As a maintainer, I want each new service to have one named responsibility and a narrow port, so that future changes do not rebuild another sink-shaped class.

## Decision Sources

1. The user-approved canonical agent boundary refactor plan. Resolved outcome: retain one atomic provider-neutral commit core; move parent policy, reads, publication, and Codex child protocol into focused services.
2. User feedback on the accepted plan. Resolved outcome: canonical and legacy paths remain active and are refactored together. Legacy removal belongs to the later provider-migration work after every implementation converts.
3. ADR 0022, Server-Owned Streaming Durability and Provider-Native Recovery. Resolved outcome: the server is the durability authority; canonical events remain the final conversation authority; checkpoints are recovery data; terminal outcomes distinguish completed, cancelled, interrupted, and errored.
4. Narrative timeline guidance. Resolved outcome: preserve parent identity attribution, replay and recovery behavior, and the canonical timeline contract while changing the server pipeline.

## Prototype Evidence

No UI prototype constrains this work. The accepted HTML refactor plan is a decision source, not a product prototype. The runtime behavior must be established by executable status, recovery, provider, and renderer tests.

## Implementation Decisions

1. Introduce a small canonical facade only as a migration seam. It composes named ports and does not contain provider branches, SQL mapping, recovery policy, or arbitrary transaction callbacks.
2. Introduce a provider-neutral canonical event store. It validates drafts, reduces state, persists canonical state and envelopes, derives the checkpoint, and returns committed envelopes only after one SQLite transaction succeeds.
3. Canonical append input identifies exactly one thread, turn, and execution, carries canonical drafts and optional provider-native cursor evidence, and does not independently assert phase or terminal outcome.
4. The commit receipt distinguishes committed, duplicate, and conflicting input. The delivery receipt separately distinguishes published and deferred delivery. A publisher exception cannot make a durable commit appear to have rolled back.
5. Derive checkpoint phase and terminal outcome from validated canonical events. A checkpoint records execution recovery progress and must not become an independent UI lifecycle state.
6. Use execution identity as the ownership key for lifecycle transitions and terminal guards. A different terminal result after a terminal state is a recorded conflict. The same terminal result is an idempotent duplicate.
7. Introduce a provider-neutral parent-turn lifecycle service for start, finish, continuation, and restart recovery. Provider transport closure is evidence evaluated by the lifecycle normalizer, not an automatic semantic outcome.
8. Introduce a publication service that publishes canonical envelopes and the matching legacy projection after commit. Both remain required runtime outputs until all implementations migrate.
9. Introduce a read repository for conversation projection, checkpoint and execution lookup, reconnect delta selection, and snapshot selection. It contains no mutation methods.
10. Move the complete Codex child-thread lifecycle into a Codex collaboration coordinator. It creates provider-specific mutation plans and uses the generic atomic event store for durable parent and child writes.
11. Replace transaction callbacks that hide compatibility mutations with explicit, typed transaction participant data. Preserve atomic compatibility projection while the legacy path is active.
12. Record execution-scoped diagnostic evidence at status decisions: provider, native signal, native identities, execution identity, chosen outcome, commit receipt, checkpoint terminal outcome, and canonical and legacy publication result.
13. Preserve bounded event batches, idempotent replay, no-publication-on-rollback, and reconnect snapshot fallback. These are behavior contracts, not implementation details to simplify away.
14. Every new, extracted, or materially changed production function in this refactor has cyclomatic complexity of 10 or less. Split behavior at domain boundaries instead of hiding branches behind helpers or callbacks.

## Testing Decisions

The primary seam is one end-to-end execution-status fixture. It injects provider evidence at the provider host boundary and asserts the normalizer result, canonical commit receipt, checkpoint, legacy projection, canonical renderer replica, and reloaded conversation result. It must fail if those outputs disagree.

Use pure lifecycle tests for every permitted transition, same-terminal duplicate, and different-terminal conflict. These tests exercise the state contract rather than private method arrangement.

Use transaction integration tests to prove state, envelopes, checkpoint, compatibility projection, and publication behavior remain atomic. A deliberately failed participant must leave no published events.

Use restart tests at start, progress, durable terminal persistence, and compatibility materialization. A previously accepted terminal event must not be rewritten as interrupted during recovery.

Use provider conformance fixtures for Claude, Codex, Copilot, and Cursor. Equivalent canonical lifecycle sequences must produce equivalent terminal state and legacy projection while both outputs are active.

Use Codex collaboration tests for one child, sequential children, parallel children, nested children, uncertain delivery, and retry. Parent and child mutations that require one durable outcome must commit together.

Use browser replica tests for contiguous live batches, duplicate batches, recovery delta, snapshot recovery, and canonical plus legacy terminal parity for current consumers. Existing canonical sink, reducer, recovery, turn-finalization, provider-host, and renderer-replica tests are the prior art to extend rather than replace with mocks.

Use the repository's static analysis gate to measure cyclomatic complexity. Every new, extracted, or materially changed production function in this refactor must measure 10 or less. A function over the limit blocks its ticket until its domain branches are separated.

Run focused tests for each slice, then changed-importer verification. The final integration gate runs the documented narrative scenarios live and after reload.

## Out of Scope

- Removing the legacy event path or declaring canonical-only support. That work begins only after every provider implementation has migrated.
- Changing provider product behavior, provider capabilities, or user-visible provider selection.
- Replaying prompts or actions automatically after a restart.
- Redesigning the chat UI outside changes required to show a correctly derived existing terminal result.
- Changing the canonical event model except where an explicit terminal-contract or receipt addition is needed.
- Claiming or fixing the reported normal-turn interruption before its deterministic fixture identifies the responsible path.

## Further Notes

The current overflow fixture is evidence of a terminal contract mismatch. It is not evidence that the same path causes ordinary turns to appear interrupted or failed.

The migration retains both active delivery paths. Canonical state is the durable source of truth, and legacy projection remains a supported runtime output. The implementation must prove terminal parity across the two paths, not remove or ignore either one.
