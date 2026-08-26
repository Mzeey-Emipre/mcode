# Composer Deep-Module Refactor

**Date:** 2026-08-26

**Status:** Local implementation specification

## Problem Statement

The Composer is a 2,252-line module that owns its screen, draft lifecycle,
execution-target state, agent configuration, queue lifecycle, and dispatch
mechanics. A change to one behavior requires navigating unrelated state and
effects. Repeated queue and transport work is easy to fix in one route and miss
in another.

## Solution

Make the Composer a coordinator for four feature-owned modules: form session,
execution target, agent controls, and submission. Each module owns one coherent
product responsibility behind a small interface. The visible Composer behavior,
copy, DOM order, stores, and provider contracts remain unchanged.

## User Stories

1. As a user, I can switch threads and recover the correct Composer session.
2. As a user, I can keep an unsent draft, attachments, and model selection when
   I return to a thread.
3. As a user, I can start work directly, in a new worktree, or in an existing
   worktree without a target-selection regression.
4. As a user, I can fork from a message and keep the correct branch and
   detached-worktree behavior.
5. As a user, I can configure model, provider, permissions, reasoning, context
   window, thinking, and fast mode as before.
6. As a user, I can attach Plan, Goal, and orchestration capabilities as before.
7. As a user, I can queue a follow-up while a turn is running and preserve its
   reply, attachments, annotations, and execution settings.
8. As a user, I can edit a queued message, cancel the edit, and recover the
   original message in its original queue slot.
9. As a user, I can send a child-thread follow-up after its handoff context is
   ready without duplicate delivery.
10. As a user, I can confirm a Direct-mode branch checkout before a new thread
    starts.

## Decision Sources

- The user requires a substantive reduction of the Composer rather than file
  moves that leave the same orchestration in one module.
- The Composer session glossary defines the session as one value that saves and
  restores atomically.
- The existing focused Composer tests define the behavior that this refactor
  must preserve.
- The advisor plan supplied for this local specification defines the module
  order and the hard queue and dispatch invariants.

## Prototype Evidence

No prototype constrains this refactor. Existing product behavior and focused
tests are the acceptance evidence.

## Implementation Decisions

1. The form controller owns draft state, attachment preparation, editor updates,
   session save and restore, pending prefills, stop recall, and model/provider
   reconciliation. Its interface exposes form state and operations, not raw
   React setters or attachment-hook internals.
2. The execution controller owns Direct, New worktree, Existing worktree, and
   fork target resolution. It owns remembered mode, branch and worktree loading,
   pull-request detection and review prefill, and stale-worktree detection. It
   returns one discriminated execution target.
3. The agent-controls module owns provider capability discovery, permission
   locking, preference controls, capability chips, and thread-setting writes
   caused by toolbar interactions. It does not own the toolbar position or the
   send button.
4. The submission controller owns handoff deferral, queue editing, queued
   dispatch, submit routing, checkout confirmation, and all cleanup coupled to
   dispatch. It receives the form and execution controller interfaces.
5. Composer retains surface composition and display-only conditions. It does
   not call transport actions, mutate queue state, mutate Lexical roots, or
   write thread settings.
6. The final Composer must contain no callback longer than 25 lines and no more
   than 1,100 physical lines.

## Testing Decisions

- Test each controller through its public interface using the real in-process
  stores. Do not add a store port only for tests.
- Preserve the current checkout, running-submit, pull-request detection, queue
  edit, attachment, and capability tests. Move test files only when their
  product owner moves.
- Add controller contract tests for form switching and cleanup, every execution
  target variant, agent-control persistence, and every submission route.
- Keep the highest seam: Composer integration tests verify visible target,
  checkout, toolbar, and editor behavior; controller tests verify lifecycle and
  dispatch invariants.
- After each phase, run focused Composer tests, typecheck, and lint. Run changed
  verification and a diff check before completion.

## Out of Scope

- UI redesign or copy changes.
- Provider behavior, transport contracts, Zustand schema changes, or generic
  abstractions outside the conversation feature.
- Refactoring shared chat controls, stores, or the Lexical editor.
- Test deletion, test weakening, mocks that replace real in-process stores, or
  a live Electron check unless a focused test exposes an interaction change.

## Further Notes

The extraction order is form controller, execution target, agent controls,
submission controller, then Composer cleanup. Submission must wait for form and
execution interfaces. Queue cleanup order is fixed: wait for attachment
preparation before capture, collect attachments before clearing a handoff form,
clear annotations before transport completion, and release capture spill files
when queued dispatch fails.
