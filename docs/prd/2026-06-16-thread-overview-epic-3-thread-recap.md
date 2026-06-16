# PRD - Thread Recap

**Epic:** 3 of 4 (Thread Overview)
**GitHub:** epic #755; sub-issues #768-#771
**Date:** 2026-06-16
**Status:** ready-for-agent
**Arch spec:** [2026-06-16-thread-overview-design.md](../specs/2026-06-16-thread-overview-design.md)
**ADR:** [0013](../adr/0013-thread-recap-generation-and-caching.md)
**Reference:** Synara (github.com/Emanuele-web04/synara) - the trigger and caching model this epic adapts.

## Problem Statement

I cannot tell at a glance what a thread is about. The thread title is terse and deterministic, and to remember what a thread was doing I have to scroll back and read it. With several threads open, re-orienting on each one is friction. I want a plain-language line that tells me what I am working on in this thread - but not at the cost of token spam from a model that fires on every turn or for threads I never look at.

## Solution

A short AI-generated one-line recap at the top of the Overview - "what you're working on" for the active thread. It is generated cheaply and lazily: only while the Overview is open, only after the thread goes quiet, only when the conversation has materially changed, and only over the new messages since the last recap. It updates as the thread evolves and is cached for the session so reopening the panel costs nothing. It never fires mid-turn and never runs for a thread whose Overview I never open.

## User Stories

1. As a developer, I want a one-line recap of what a thread is doing at the top of its Overview, so that I can re-orient without reading the transcript.
2. As a developer, I want the recap to update as the thread evolves, so that it stays accurate after new turns.
3. As a developer, I want the recap to cost near-zero tokens, so that the feature does not waste my budget.
4. As a developer, I want the recap to generate only while the Overview is open, so that threads I never inspect never trigger a call.
5. As a developer, I want the recap to wait until the thread goes quiet, so that it does not fire mid-turn or while the assistant is streaming.
6. As a developer, I want the recap to regenerate only when the conversation materially changes, so that tool noise and work-log churn do not trigger it.
7. As a developer, I want a refresh to send only the new messages since the last recap plus the previous recap, so that re-summarizing the whole transcript does not waste tokens.
8. As a developer, I want the recap to stay unchanged when nothing meaningful changed, so that a refresh does not churn the line for no reason.
9. As a developer, I want the recap cached for the session, so that reopening the Overview does not regenerate it.
10. As a developer who restarts the app, I want the first Overview open per thread to regenerate the recap once, so that the in-memory reset is acceptable and predictable.
11. As a developer, I want the recap clipped to a short single line, so that it fits the Overview row.

## Implementation Decisions

- **Stateless generation RPC.** A new `recap.generate` RPC takes the client-selected bounded material (`threadId` for telemetry only, `messages`, `previousRecap`) and returns `{ text }`. The server stores nothing - no table, no migration, no thread-row field. This is the deliberate divergence from the durable diff Summary.
- **Server prompt builder.** A `RecapService` with a pure `buildThreadRecapPrompt(messages, previousRecap)` and `sanitizeThreadRecap(text)` (mirroring `buildDiffSummaryPrompt` and Synara's `textGenerationShared`), calling `UtilityCompletionService.complete` (our haiku utility model, low reasoning effort, not Synara's `gpt-5.4-mini`). The prompt instructs the model to return the previous recap unchanged when nothing material changed. Output clipped to ~220 chars.
- **In-memory client cache.** `threadStore` gains `recapByThread: Record<threadId, { text, signature, coveredMessageId }>`, never persisted, dropped by `clearThread`. On restart the first panel-open per thread regenerates once - the accepted cost of not persisting.
- **A trigger hook owns all gating.** A `useThreadRecap` hook (mirroring Synara's `useThreadRecap`) is panel-gated (runs only while the Overview is open), idle-debounced (~12s first / ~35s refresh, reset on each new message, never mid-turn), signature-gated (a cheap hash of `[last message id, role, length, turn state, pending flags]`; only user/assistant messages advance it; skipped when the signature matches the cached, in-flight, or last-failed value), and incremental (after the first recap, send only the delta since `coveredMessageId` - bounded to ~4 messages, ~600 chars each - plus the previous recap). First pass is bounded to ~6 messages.
- **No hot-path coupling.** The hook is an opt-in side effect of the open panel and must never run from the transcript render or the turn-event path.

## Testing Decisions

- A good test asserts the decision the system makes - whether to schedule a generation, and the prompt/output shape - not the React hook internals.
- **Modules tested:** the pure `buildThreadRecapPrompt` / `sanitizeThreadRecap`, the pure scheduling decision (`shouldScheduleThreadRecapGeneration`) and signature hash, and the `recapByThread` cache cleanup.
- **Prior art:** `diff-summary-prompt.test.ts` tests `buildDiffSummaryPrompt` as a pure function with no mocks - mirror it for the recap prompt and sanitizer. `utility-completion-service.test.ts` mocks the provider registry and asserts `complete()` - reuse that path; the recap RPC handler stays a thin pass-through and is not separately unit-tested (consistent with `diffSummary.*`). Synara's `threadRecap.ts` is the model for the pure scheduling decision. The hook's end-to-end behavior is covered by the Overview E2E (panel-gated, no call when closed).
- Cases to add: the scheduler returns false when the panel is closed, mid-turn, signature-unchanged, or in-flight, and true only when idle and materially changed; the prompt includes the previous recap and only the delta; sanitize clips to the char cap; `clearThread` drops the cache entry.

## Out of Scope

- Persisting the recap server-side or in localStorage (Synara's choice) - intentionally in-memory.
- Eager or per-turn generation.
- A "regenerate now" button or any user-triggered generation - the trigger is automatic and gated.

## Further Notes

This epic carries the user's one hard constraint - no token spam - which is why its cost control is isolated here rather than folded into the surface epic. It hard-depends on Epic 2 for the panel and the panel-open gate. Synara already shipped this feature cost-controlled; adapt its trigger and caching, but the prompt and model are ours.
