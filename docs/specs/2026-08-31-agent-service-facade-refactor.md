# AgentService Facade Refactor

**Status:** Local implementation specification

## Problem Statement

`AgentService` is a 2,035-line class with 107 private methods. Its seven public
operations are narrow, but the class owns admission, runtime identity, provider
dispatch, retry, provider-event application, durability, stop, teardown, memory
pressure, and port binding. Its 24-parameter constructor also acts as a small
composition root.

The orchestration production directory has nine TypeScript files and 2,675
lines. Related tests and their shared harness have 10,235 lines across 13
files. The 239-line harness passes 24 positional constructor arguments and
mutates private internals. These structures make a behavior change hard to
locate, review, and prove.

## Solution

Keep `AgentService` as the stable facade. Move the coupled runtime state
machine to `TurnRuntimeController` and provider-event state to
`ProviderTurnEventApplication`. Keep existing extracted owners at their
present seams. Move composition work out of the facade.

Each extraction must reduce the affected TypeScript total across production and
tests. A phase completes only after it removes the old owner, temporary
migration code, overlapping tests, and private test mutation. The facade keeps
the same seven operations, result shapes, imports, and caller behavior.

## User Stories

1. As a maintainer, I want to see the seven `AgentService` operations without
   unrelated runtime or event state, so that I can understand the facade fast.
2. As a maintainer, I want one module to own admission, dispatch, retry, stop,
   teardown, shutdown, and runtime snapshots, so that I can find that logic.
3. As a maintainer, I want retry and stop logic to stay together, so that they
   retain their shared execution identity and suppression rules.
4. As a maintainer, I want one `TurnEventApplication` owner for provider-event
   handlers and state, so that I can inspect event behavior in one place.
5. As a contributor, I want ports to bind after collaborators resolve and
   ingress to start in the established path, so that startup order stays valid.
6. As a contributor, I want shared orchestration owners to stay provider-
   neutral, so that provider support does not couple them to one provider.
7. As a test author, I want an owner fixture instead of a positional
   24-argument facade constructor, so that the fixture states its dependencies.
8. As a test author, I want supported test seams, so that I can prove behavior
   without changing facade private internals.
9. As a reviewer, I want each extraction to remove more scoped TypeScript lines
   than it adds, so that the refactor reduces complexity.
10. As a reviewer, I want to reject tests for delegation, getters, mapping
    helpers, and mocked internals, so that tests prove observable behavior.
11. As a user, I want to send a message with the same turn lifecycle and
    result behavior, so that the refactor does not change my turn.
12. As a user, I want a new thread's first message to keep its runtime snapshot
    and warnings, so that thread creation behavior stays the same.
13. As a user, I want Setup to start an automatic queued Turn, so that Setup
    still controls the first Turn.
14. As a user, I want one active Turn to stop once even after provider terminal
    events arrive, so that cancellation remains the terminal outcome.
15. As a user, I want thread deletion to retain its active and pooled provider
    teardown behavior, so that the provider session is handled as before.
16. As a user, I want a transient failed attempt to stay hidden during a valid
    retry and a fatal failure to stay visible, so that I see the right outcome.
17. As a user, I want assistant text and narration to become durable before
    publication, so that the renderer receives persisted turn data.
18. As a user, I want the narrative timeline to retain tool calls, hooks, text
    classification, terminal visibility, and next-turn reset, so that its
    behavior remains the same.
19. As a user, I want sequential, parallel, and nested sub-agent calls to keep
    their parent attribution, so that the narrative hierarchy remains correct.
20. As a user, I want behavior to stay the same across providers, memory
    pressure, compaction, and late hooks, so that lifecycle behavior remains
    stable.

## Decision Sources

- The accepted local HTML architecture plan records the current-state evidence,
  target owners, migration constraints, and behavior gates.
- Conversation decisions require a preserved facade, two deep owners, net
  deletion in every phase, and rejection of trivial tests.
- Current production code and the shared test harness provide the baseline
  facts for constructor coupling, private state, and test coupling.
- No issue, Wayfinder map, external decision, or accepted prototype was
  supplied.

## Prototype Evidence

No accepted prototype constrains this work. The local HTML plan is an
architecture decision artifact, not a UI prototype. Existing runtime behavior
and focused behavior proofs are the acceptance evidence.

## Implementation Decisions

1. Keep `AgentService` as the public facade. Keep `sendMessage`,
   `createAndSend`, `dispatchQueuedAutomaticTurn`, `stopSession`,
   `teardownSession`, `runtimeAccess`, and `stopAll` unchanged for callers.
2. Give `TurnRuntimeController` one deep ownership boundary. It owns admission
   activation, exact runtime identity, mutation reservations, provider
   dispatch, transient retry, suppression, single-flight stop, teardown,
   shutdown, memory pressure, runtime snapshots, and narrow
   publication-runtime reads.
3. Keep retry and stop in `TurnRuntimeController`. Both depend on the same
   thread ID, turn execution ID, mutation token, generation, and suppression
   invariants.
4. Give `ProviderTurnEventApplication` the event handlers and their state. It
   exposes the existing `TurnEventApplication` interface to
   `TurnEventPipeline` and uses narrow runtime, durability, narrative and
   file, feature-effect, and publication seams.
5. Remove `TurnEventEffects` before the event-owner phase completes. It can
   only bridge a short migration and must not become a callback bag.
6. Keep `ThreadCreationCoordinator`, `TurnAdmissionDispatchCoordinator`,
   `TurnEventPipeline`, `TurnFinalizer`, `TurnFileEffects`, `NarrativeStore`,
   `ParentAssistantTextCoordinator`, `ParentNarrativeRecoveryCoordinator`,
   and `AgentEventPublicationService` at their present ownership seams.
7. Keep port creation in composition. Bind ports only after collaborators
   resolve. Start provider ingress after publication binding in the established
   startup path. Create one ingress and one pipeline instance.
8. Do not hide coupling in a dependency or options bag. Do not add a DI
   framework, one class per event, provider-specific logic, compatibility
   shims, or public behavior changes.
9. In each phase, identify existing behavior proof, extract one cohesive owner,
   and delete the old implementation at once. Move, merge, or delete its
   overlapping tests in the same phase.
10. Count the affected production and test TypeScript lines after every phase.
    The phase must remove more lines than it adds. Simplify or reject a design
    that increases the scoped total. Readability and behavior gates still
    apply.
11. Do not call a phase complete while old methods, duplicate state, temporary
    callback bags, compatibility bridges, duplicate tests, or private test
    mutation remain.

## Testing Decisions

- Do not add a separate phase for blanket facade contract tests. Start each
  phase from the existing behavior proof for the owner that moves.
- Use the highest existing seam. Test facade results and lifecycle effects,
  `ProviderTurnEventApplication` through `TurnEventApplication`, and
  `TurnRuntimeController` through its narrow interface.
- Admit a test only when it names a plausible regression, uses an independent
  oracle, and adds proof that no current test gives.
- Classify every touched test as Keep, Move, Merge, or Delete. Delete
  delegation, getter, pass-through, constructor-mechanics, mocked-internal,
  unfiltered-snapshot, and higher-seam duplicate tests. Keep one container
  resolution smoke test.
- Do not add unit tests for trivial mapping helpers. Prove stop outcome
  normalization through the public or controller stop flow. Validate hostile
  external values at the boundary. Do not add tests for invalid states that a
  trusted TypeScript union cannot represent.
- Facade tests assert results and lifecycle effects, never collaborator calls.
  They do not inspect facade private state.
- Preserve proof for execution fencing; single-flight stop and terminal order;
  transient retry visibility and rollback; durability before renderer
  publication; one finalization; pipeline order and capacity; file effects;
  late hooks; compaction; automatic Setup completion; memory pressure;
  teardown; provider neutrality; sequential, parallel, and nested sub-agent
  attribution; text classification; terminal visibility; and next-turn reset.
- Run focused checks after every phase and record the scoped TypeScript delta.
  Before completion, run the changed-package verification, type checking, and
  fast lint checks. Compare the final diff with every implementation decision
  and behavior gate.

## Out of Scope

- A change to the public facade operations, result shapes, imports, or caller
  behavior.
- New provider-specific behavior in shared orchestration owners.
- A dependency bag, DI framework, compatibility layer, or one-class-per-event
  structure.
- Tests that protect implementation trivia or weaken existing behavior proof.
- Publishing this local specification to an issue tracker or adding tracker
  labels.

## Further Notes

The line counts are baseline evidence, not targets. The refactor succeeds only
when the resulting owners are smaller to understand and the scoped TypeScript
total falls after every completed phase.

Provider runtime events may carry private provider evidence. Only
provider-neutral `AgentEvent` data can pass into narration, lifecycle, and
renderer publication. Preserve the pipeline order and capacity, durable
publication order, exact execution fencing, and narrative attribution rules
while ownership moves.
