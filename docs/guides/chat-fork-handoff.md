# Chat Fork Handoff

How chat forking works in mcode and how to extend it.

## Overview

Clicking the fork icon on a message in a parent thread creates a child thread. The child receives a "handoff document" that summarises the parent conversation up to the fork point, giving the child's first turn full context without replaying every message token-by-token.

The document is produced either by the parent's provider (when the provider supports a side-channel query) or by a deterministic builder (when it does not). Either way the artifact is the same shape: a Markdown file with YAML frontmatter plus a JSON sidecar.

The pipeline lives in `apps/server/src/features/handoff/orchestration/`.

## The B/D ladder

Two paths are tried in order. The result of the first path that succeeds becomes the handoff artifact.

**Path B -- clean-fork providers (Claude, Cursor, Codex, Copilot).** The pipeline calls `runSideChannelQuery` on the parent provider. This issues a new query against a forked copy of the provider's existing session without mutating it, so the parent thread's conversation state is unchanged. Path B requires a live `sdk_session_id` on the parent thread because the side-channel must resume the correct provider conversation.

**Path D -- deterministic fallback.** Always available. Builds the handoff by walking the message list up to the fork point and rendering a structured Markdown summary. No provider call is made. Path D fires when the parent provider does not support forking at all (`sessionForkOnResume === "unsupported"`), when the parent has no `sdk_session_id` and the provider is clean-resume, or when path B throws an error that error-classification routes as quota, auth, context-overflow, or fatal (errors for which retrying would hit the same wall).

Transient errors (network blips, 5xx, AbortController timeout at 120 seconds) also route to path D so forks always succeed.

## Provider capabilities

Provider fork capability is declared in `packages/contracts/src/providers/interfaces.ts`.

`sessionForkOnResume: "clean" | "unsupported"` -- declares whether the provider supports side-channel queries (`"clean"`) or not (`"unsupported"`).

`forker: SessionForker` -- produces the handoff artifact. Clean providers use `CleanForker`; unsupported providers use `DeterministicForker`.

Implement `runSideChannelQuery` on path-B providers. It receives an `AbortSignal` that fires after 120 seconds.

## Storage layout

Each handoff is a ULID-named directory so lexicographic order equals chronological order:

```text
<MCODE_DATA_DIR>/threads/<threadId>/handoffs/<ulid>/handoff.md
<MCODE_DATA_DIR>/threads/<threadId>/handoffs/<ulid>/handoff.json
```

`handoff.md` contains YAML frontmatter (schema version, provenance, ladder step, mode) followed by the handoff body.

`handoff.json` is the full `HandoffMeta` object: provenance, error classification if any, attachment manifest, and regeneration history.

Attachments copied from parent messages land at:

```text
<MCODE_DATA_DIR>/threads/<threadId>/attachments/<id>.<ext>
```

## Full vs minimal mode

When the child provider's per-turn input cap is below 8000 characters, the handoff prompt switches to minimal mode (3 sections instead of 8). This keeps the inlined handoff within the child's first-turn budget.

The mode is recorded in `HandoffMeta.mode` (`"full"` or `"minimal"`) and in the YAML frontmatter.

## Robustness

The pipeline includes several guards to avoid blocking or corrupting the fork flow:

- **120-second timeout.** An `AbortController` wraps every provider call. If the controller fires, the pipeline catches the abort and falls to path D with `reason: "transient"`.
- **Fork history budget.** Parent history is read in newest-first pages under a byte budget. The handoff records when older history was elided.
- **25 MB attachment size cap.** `HandoffStorage.copyAttachments` skips any attachment larger than 25 MB and records a sentinel `sha256: "<skipped>"` in the manifest.
- **Budget truncation at section boundaries.** When a provider returns more than 115% of the computed character budget, `applyBudgetGuard` truncates at the nearest H2 heading boundary and appends a notice so the child agent knows the doc was cut.
- **Abandoned-child cleanup.** Before writing the artifact, `AgentService` re-fetches the child thread. If it has been hard-deleted between orchestration start and the write, the artifact is dropped and the fork fails cleanly rather than writing orphaned files.

## Settings

`chat.handoff.notifyOnLocalFallback` (default `true`) -- when true, the UI shows a notice when the handoff fell back to path D (deterministic) due to a provider error. Set to `false` to suppress the notice.

## Adding a new provider

1. Decide which path the provider supports based on its session model. Providers that can fork a session (resuming a session id into a throwaway connection branches the conversation rather than mutating it) use `"clean"`. Providers with no forkable session concept use `"unsupported"`.

2. Set `sessionForkOnResume` to the chosen value and `maxInputCharactersPerTurn` to the provider's documented limit (or a conservative estimate like `16_000` if unknown).

3. If `"clean"`: implement `runSideChannelQuery({ parentThreadId, parentSdkSessionId, prompt, abortSignal })`. The method must return a Markdown string. It must respect `abortSignal` and throw (or let the signal reject the underlying fetch) when it fires.

4. Run `(cd apps/server && npx vitest run src/features/handoff)` to verify the existing tests still pass with the new provider registered.

5. Add a test case in `apps/server/src/features/handoff/orchestration/__tests__/handoff-pipeline.test.ts` covering the happy path and at least one failure mode for the new provider.
