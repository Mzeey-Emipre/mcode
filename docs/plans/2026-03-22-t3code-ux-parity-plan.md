# T3 Code UX Parity Plan

See full plan details in the planner agent output. Summary of the 4 phases:

## Phase 1: Data Layer (backend, no UI changes)
- V002 migration: add `model` column to threads table
- Update Thread model, repo, AppState to support model param and lazy thread creation
- Forward tool call events from sidecar (`session.toolUse`, `session.toolResult`)
- New IPC handlers: `create-and-send-message`, `update-thread-title`

## Phase 2: Transport + Stores
- Extend transport types with `model`, `ToolCall`, new methods
- Update thread store for tool calls, working timer (`agentStartTimes`)
- Update workspace store for lazy thread creation (`pendingNewThread`)

## Phase 3: UI Components (parallel agents)
- **ModelSelector**: Multi-provider dropdown (Claude, Codex active; Cursor, OpenCode, Gemini "COMING SOON")
- **ToolCallCard**: Perplexity-style rendering (grouped step labels with expandable sub-queries)
- **MarkdownContent**: Full markdown with syntax-highlighted code blocks
- **StreamingIndicator**: "Working for Xs" elapsed timer
- **Composer**: Send/stop toggle, model selector, lazy thread flow
- **ChatView**: Working timer, new-thread empty state
- **ProjectTree**: Lazy thread creation (no upfront form), rename via context menu

## Phase 4: Polish
- Model lock UI feedback (lock icon)
- Auto-title generation from first message
- Edge case handling (double-click send, navigate away mid-compose)
- Bundle size optimization (lazy-load syntax highlighter)

## Parallel Execution (Phase 3)
- Agent A: model-registry.ts + ModelSelector.tsx
- Agent B: MarkdownContent.tsx
- Agent C: ToolCallCard.tsx (Perplexity style)
- Agent D: StreamingIndicator.tsx (timer)
- Then converge for Composer, ChatView, MessageBubble, ProjectTree

## Files: 20 total (4 new, 16 modified)
