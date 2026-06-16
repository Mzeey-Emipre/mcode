# PRD - Fork and Switch provider

**Epic:** 4 of 4 (Thread Overview)
**GitHub:** epic #756; sub-issues #772-#776
**Date:** 2026-06-16
**Status:** ready-for-agent
**Arch spec:** [2026-06-16-thread-overview-design.md](../specs/2026-06-16-thread-overview-design.md)
**ADR:** a cross-provider-switch ADR is written when this piece is built; the mechanics are in `CONTEXT.md` (Fork, Switch provider, Cross-provider switch).

## Problem Statement

To take a thread further I have to leave its context. There is no in-thread way to spawn a copy of the work along a different path, and there is no way to change the provider driving a thread without losing everything it has built up. If I want a different model or provider to continue this exact thread - same history, same worktree - I have to start over cold. Forking and provider-switching are different intentions ("a new thread" versus "this thread, new driver"), and neither is reachable from the thread itself.

## Solution

Two continuation actions in the Overview, split by what each does to this thread. Fork spawns a new child thread and leaves this one untouched, with three targets: a new worktree, an existing worktree, or a new local thread (Direct mode) - each carrying a handoff from this thread. Switch provider keeps this same thread (id, history, worktree unchanged) and swaps only the provider driving it, generating a handoff from the outgoing provider so the new one continues with context. Switching back is the same action in reverse. Handoff is always-on for both; it is the mechanism, not a menu item.

## User Stories

1. As a developer, I want to fork this thread into a new worktree from the Overview, so that I can explore a different path in isolation while this thread stays as it is.
2. As a developer, I want to fork into an existing worktree, so that I can continue the work where another worktree already lives.
3. As a developer, I want to fork into a new local thread (Direct mode), so that I can branch the conversation without a worktree.
4. As a developer forking a thread, I want the child to carry a handoff from this thread, so that the new thread continues with context rather than cold.
5. As a developer, I want forking to leave this thread untouched, so that I keep the original line of work.
6. As a developer, I want to switch the provider driving this thread from the Overview, so that a different provider continues the same thread with its history and worktree intact.
7. As a developer switching provider, I want a handoff generated from the outgoing provider, so that the incoming provider picks up with context rather than starting cold.
8. As a developer, I want to switch the provider back later, so that I can move between providers on the same thread freely.
9. As a developer, I want Fork and Switch provider visually distinct in the Overview, so that I do not confuse spawning a copy with changing this thread's driver.
10. As a developer, I want switching provider to keep the thread id and history, so that nothing about the thread is lost in the swap.

## Implementation Decisions

- **Fork reuses the existing flow.** The Fork group is a new entry point into `agent.createAndSend` with `parentThreadId` (and optional `forkedFromMessageId`), which already creates a child thread in the chosen mode (worktree / existing-worktree -> worktree + `existingWorktreePath` / direct) and attaches the handoff via `HandoffCoordinator.deliverHandoff`. The mode resolution mirrors `workspaceStore.branchThread`. No server changes for Fork.
- **Switch provider is a new orchestration RPC.** `thread.switchProvider(threadId, provider, model?)` generates a handoff from the outgoing provider and swaps the provider in place. The pieces it reuses already exist: `thread.provider` is mutable (`threadRepo.updateProvider`), `agent.send` already accepts an explicit `provider` that re-persists it and broadcasts `thread.modelUpdated`, and `HandoffCoordinator.deliverHandoff` works when `childThreadId` equals the parent thread id.
- **The seq-anchor fix.** The handoff coordinator persists its internal handoff system message at a hardcoded `seq = 1`. On an existing thread with `nextSeq > 1` that collides. The switch path must write the internal message at the thread's current `nextSeq`, not a constant. This is the one structural change the switch requires beyond wiring the new RPC.
- **Flow.** Switch provider: generate the handoff from the current provider (coordinator targeted at the same thread id, writing at `nextSeq`), update the persisted provider, broadcast `thread.modelUpdated`; the next user send drives the new provider with the handoff already in place.
- **An ADR is written when this is built**, capturing the same-thread-switch mechanism and the seq-anchor decision; the product mechanics are already settled in `CONTEXT.md`.

## Testing Decisions

- A good test asserts the observable outcome of a switch or fork - the thread's provider, the presence and placement of the handoff message, the broadcast - not the orchestration internals.
- **Modules tested:** the `thread.switchProvider` orchestration (provider updated, handoff generated against the same thread id, internal message written at `nextSeq` not `1`, `thread.modelUpdated` broadcast) and the Overview's Fork and Switch actions.
- **Prior art:** the handoff builder and coordinator have pure-function tests (`handoff-builder.test.ts`) - assert the switch path's handoff content and the seq anchor there. Fork already has end-to-end coverage through the existing create-and-send flow; the Overview's Fork group is a new entry point, covered by the Overview E2E. The RPC handler stays thin and is not separately unit-tested, consistent with the other `agent.*` and `handoff.*` handlers.
- A specific regression to lock: switching provider on a thread with prior messages writes the internal handoff message at `nextSeq` and does not collide at `seq = 1`.

## Out of Scope

- Changing the handoff B/A/D ladder mechanism - the switch reuses it as-is.
- The cross-provider-switch ADR document - written when the piece is built, not part of this PRD.
- Any change to how Fork creates threads - it reuses the existing flow unchanged.

## Further Notes

This is the heaviest behavioral epic: it spawns threads and drives the handoff machinery and a same-thread provider swap. It hard-depends on Epic 2 (the actions live in the shell). The seq-anchor collision is the single real hazard and is the reason the switch carries its own epic rather than riding along in the surface work.
