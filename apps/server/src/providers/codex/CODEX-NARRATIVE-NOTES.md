# Codex narrative integration (runbook)

Internal notes so we do not redo the same experiments. For the product contract and acceptance criteria, see `docs/guides/codex-narrative-spec.md`. For architecture, see `docs/guides/narrative-pipeline.md` and `docs/guides/provider-architecture.md`.

## What the user sees

Thought rows come from non-final `AgentEventType.TextDelta` events. The web client merges those into `thoughtSegmentsByThread`. Codex assistant text now streams this way until the mapper emits `AssistantMessageBoundary`; the last assistant item of a completed main turn is promoted to the final reply.

Sub-agent rows are `ToolUse` with `toolName: "Agent"`. Children nest when their `ToolUse` carries `parentToolCallId` pointing at the collab item id.

## What we tried

1. **`item/started` for `collabAgentToolCall`**  
   Emits the Agent row early and keeps an internal stack so later `item/completed` tools get `parentToolCallId`. Works when the app-server sends `item/started`.

2. **Legacy collab (only `item/completed`)**  
   The mapper used to emit `ToolUse` + `ToolResult` without pushing the collab id onto the nesting stack, so children never received `parentToolCallId`. Fixed by pushing the collab id on the legacy path and clearing the stack on `turn/completed` / `reset`.  
   Limit: if the server completes child tools **before** the collab item in the notification stream, nesting cannot be reconstructed without `turn.items` ordering or `item/started`.

3. **Reasoning**  
   `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, and `item/completed` with `type: "reasoning"` map to non-final text deltas. If the model or Codex omits reasoning (for example some fast-tier paths), nothing shows in thoughts.

4. **Plan deltas (experimental)**  
   Codex exposes `item/plan/delta`. It was previously silenced in the mapper. It now maps to non-final text deltas so live "planning" text can appear as thoughts. Completed `plan` items stay silent in `SILENT_ITEM_TYPES` by design.

5. **Agent service**  
   One `AgentService` is enough. Codex-specific behavior lives in `CodexEventMapper`. Server-side `agentCallStack` still pops an Agent as soon as its `ToolResult` arrives, so stack fallback enrichment often does not help Codex children; explicit `parentToolCallId` from the mapper is what matters.

6. **Trace**  
   `MCODE_CODEX_TRACE=1` logs each notification and mapped events (see `codex-trace.ts`).

## Open edges

- Parallel sub-agents without per-child parent ids in the protocol still rely on a single stack peek and can mis-attribute if work is interleaved.
- `item/plan/delta` may duplicate or overlap with reasoning in some Codex versions; tune if the timeline feels noisy.
- Typing animation for the final bubble is a separate client concern from thought segments.
