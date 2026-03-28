# Tool Call UX Redesign

## Problem

Tool calls are ephemeral. They show during agent execution then vanish. Users cannot:
- Review what the agent did after a turn completes
- See file diffs with syntax highlighting
- Track subagent work nested inside parent agent calls
- Know what background agents are doing on the current thread

The current UX shows tool calls in real-time via `ToolCallCard` (Zustand `toolCallsByThread`), fades them out after turn completion via `fadingToolCallsByThread`, then they're gone. The `messages.tool_calls` TEXT column exists in the schema but is never actually populated (always `null`); same for `messages.files_changed`.

## Goals

1. Persist tool calls so users can review them after turn completion
2. Show inline unified diffs with syntax highlighting for file-changing tool calls
3. Nest subagent tool calls inside their parent Agent call (collapsible)
4. Show agent narration (thinking + tool status) in real-time
5. Show per-thread subagent count in the composer status bar

## Non-Goals

- Side-by-side diff view (future enhancement)
- Cross-thread agent count (only per-thread)
- Storing thinking tokens in DB (ephemeral only)
- Full git history viewer

---

## Section 1: Data Model

### New Tables (Migration V002)

```sql
-- Persisted tool call records, linked to the assistant message they belong to.
CREATE TABLE IF NOT EXISTS tool_call_records (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    parent_tool_call_id TEXT REFERENCES tool_call_records(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    input_summary TEXT NOT NULL DEFAULT '',
    output_summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_tool_call_records_message ON tool_call_records(message_id);
CREATE INDEX idx_tool_call_records_parent ON tool_call_records(parent_tool_call_id);

-- Git snapshot refs for reconstructing diffs on demand.
CREATE TABLE IF NOT EXISTS turn_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    ref_before TEXT NOT NULL,
    ref_after TEXT NOT NULL,
    files_changed TEXT NOT NULL DEFAULT '[]',  -- JSON array of relative paths
    worktree_path TEXT,  -- nullable; set when subagent runs in isolated worktree
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_turn_snapshots_message ON turn_snapshots(message_id);
CREATE INDEX idx_turn_snapshots_thread ON turn_snapshots(thread_id);
```

**Design decisions:**

- Table named `tool_call_records` (not `tool_calls`) to avoid collision with the existing `messages.tool_calls` TEXT column.
- All timestamps use `TEXT` (ISO 8601) matching existing schema convention (`workspaces`, `threads`, `messages` all use `strftime` defaults).
- `parent_tool_call_id` is a self-referential FK for nesting subagent tool calls under their parent `Agent` tool call.
- `worktree_path` on `turn_snapshots` supports subagents running in isolated worktrees (`isolation: "worktree"` in Agent tool).
- Cascade deletes chain: thread -> messages -> tool_call_records and turn_snapshots.
- Migration file: `V002__tool_call_persistence.sql` in `apps/desktop/src/main/store/migrations/`. The existing migration runner in `database.ts` glob-loads all `V*.sql` files from this directory in version order.

### Contracts Package: New Types

Add to `packages/contracts`:

```typescript
// packages/contracts/src/models/tool-call-record.ts
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  parent_tool_call_id: z.string().nullable(),
  tool_name: z.string(),
  input_summary: z.string(),
  output_summary: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  sort_order: z.number(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

// packages/contracts/src/models/turn-snapshot.ts
export const TurnSnapshotSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  thread_id: z.string(),
  ref_before: z.string(),
  ref_after: z.string(),
  files_changed: z.array(z.string()),
  worktree_path: z.string().nullable(),
  created_at: z.string(),
});
export type TurnSnapshot = z.infer<typeof TurnSnapshotSchema>;
```

Register new RPC methods in `packages/contracts/src/ws/methods.ts` and new push channel `turn.persisted` in the push channel registry.

### Deprecation: `messages.tool_calls` and `messages.files_changed` Columns

Both columns exist in the V001 schema but are never populated (always `null` in `message-repo.ts:create()`). No backfill needed. The columns remain in the schema for now (SQLite cannot drop columns without table recreation). A future migration can remove them via table rebuild if desired.

### Message Type Extension for Tool Call Counts

To render `ToolCallSummary` for historical messages without a separate RPC call, extend the `getMessages` response. The `Message` type in `@mcode/contracts` gains an optional field:

```typescript
tool_call_count?: number;  // populated via LEFT JOIN COUNT on tool_call_records
```

The `getMessages` RPC query joins `tool_call_records` to include the count. Messages with `tool_call_count > 0` get a `tool-summary` virtual item in `buildVirtualItems`.

### Zustand State (Unchanged During Streaming)

The existing `toolCallsByThread` and `fadingToolCallsByThread` in `threadStore.ts` continue to drive real-time rendering during agent execution. No changes to streaming-time state shape.

**New addition:** After turn completion, the server persists tool calls to `tool_call_records` from the event stream (server-side, not client flush). The client receives a `turn.persisted` push event and can then load persisted tool calls on demand.

---

## Section 2: Real-time Rendering

### Layer 1: Thinking Narration (Phase 2)

> **Note:** The current sidecar `startStreamLoop` does not emit `session.delta` events despite the type being defined in `SidecarEvent`. This layer requires building the streaming-delta pipeline in the sidecar first. Marked as Phase 2.

When available (future):
- Italic, ephemeral text above the tool call cards
- Shows model's thinking tokens ("Analyzing the error pattern...", "I need to check the test file...")
- Replaces on each update, never stored in DB
- Falls back to tool-derived status when thinking tokens unavailable

### Layer 2: Tool-Derived Status (Always Available)

Extend the existing `StreamingIndicator` component (`apps/web/src/components/chat/StreamingIndicator.tsx`):

- Current behavior preserved: spinner + phase label + elapsed time
- Phase labels derived from `TOOL_PHASE_LABELS` in `tool-renderers/constants.ts`
- Already reads from `activeToolCalls` prop, already uses `derivePhaseLabel()`
- Enhancement: when thinking narration (Phase 2) is available, show it above the tool-derived line

### Layer 3: Live Tool Call Cards (Current Behavior, Keep)

The existing `ToolCallCard` component groups consecutive same-type tool calls into `CollapsedGroup` with expand/collapse. Individual tool calls render via `getRenderer()` dispatching to `AgentRenderer`, `BashRenderer`, `EditRenderer`, etc.

**No changes during active streaming.** Tool calls render live as they arrive via `toolCallsByThread`.

### Post-Turn: Collapse into Summary

After `session.turnComplete`:

1. Existing fade-out behavior runs (tool calls move to `fadingToolCallsByThread`, CSS animation plays)
2. **New:** Once the server confirms persistence (`turn.persisted` push event), replace the fading cards with a `ToolCallSummary` row
3. The summary row shows: "7 tool calls: 3 edits, 2 reads, 1 bash, 1 agent" (grouped by type, counts)
4. Clicking the summary expands to show the persisted tool call cards (loaded from DB)

### Subagent Nesting

The `AgentRenderer` component currently renders the Agent tool call as a flat card with prompt + show/hide result toggle.

**Enhancement:** When expanded post-turn, the Agent card becomes a `SubagentContainer`:
- Header: agent description + status badge (completed/failed) + tool call count
- Body: nested list of the subagent's own tool calls (loaded from DB via `parent_tool_call_id`)
- Collapsible (default collapsed post-turn, expanded during live streaming)
- Visual nesting capped at 2-3 levels to prevent unreadable trees; deeper levels flatten

**Nesting inference:** The current SDK event stream (`session.toolUse`) does not include parent references. The server must infer parent-child relationships by tracking `Agent` tool call boundaries:

1. When a `session.toolUse` with `toolName: "Agent"` arrives, record its `toolCallId` as a potential parent
2. The SDK processes the Agent tool internally and emits the subagent's tool calls
3. When the Agent tool completes (next `session.toolResult` matching the Agent's `toolCallId`), all tool calls emitted between the Agent's `toolUse` and `toolResult` are children
4. Store `parent_tool_call_id` on the child `tool_call_records` rows

**Risk:** This inference is fragile. The `markPriorToolCallsComplete` heuristic in `handleAgentEvent` marks all prior incomplete tool calls as complete when a new event arrives. This would incorrectly mark parent tool calls complete when a subagent's first tool call arrives.

**Mitigation:** The server augments events before broadcasting to the client. When a `session.toolUse` event falls within an active Agent tool call window, the server adds a `parentToolCallId` field to the event payload before pushing via WebSocket. The client's `handleAgentEvent` uses this field to skip the parent when running `markPriorToolCallsComplete`. This means the client receives enriched events, not raw SDK events. The raw event shape stays the same on the server side; the augmentation is a thin transform layer in the broadcast pipeline.

**Concurrent subagent limitation:** When two `Agent` tool calls run in parallel (dispatched before either completes), boundary-based inference cannot distinguish which child tool calls belong to which parent. The SDK does not include parent references in events. For Phase 1, concurrent subagent tool calls will be grouped under the most recently dispatched Agent tool call. Accurate concurrent nesting requires SDK-level parent tracking (future).

---

## Section 3: Persistence and Diff

### Git Snapshots

Capture working tree state before and after each agent turn using lightweight git refs:

**Capture `ref_before`:** In the server's `sendMessage` handler, before dispatching to the agent provider, run `git stash create -u` in the thread's working directory. The `-u` flag includes untracked files (new files the agent may have created in prior turns). This creates a commit object without modifying the working tree or stash list. Store the returned SHA as `ref_before`. If there are no changes (clean working tree), `git stash create` returns empty; use `HEAD` as `ref_before`.

**Capture `ref_after`:** On `session.turnComplete`, run `git stash create -u` again. Store as `ref_after`. If empty (agent made no file changes), skip snapshot creation entirely.

**Store snapshot:** Insert a `turn_snapshots` row linking the snapshot to the assistant message and thread. The `files_changed` JSON array is populated by running `git diff --name-only ref_before ref_after`.

**Message ID linkage:** Tool call events arrive before the assistant message exists in the DB. The server must buffer tool calls during the turn, keyed by session/thread ID. On `session.turnComplete`, the server creates the assistant message first (from accumulated `session.message` events), obtains its ID, then bulk-inserts tool call records with that `message_id`.

**Performance:** `git stash create -u` is lightweight (no index modification) but can take 500ms-2s on large repos (potentially 3-5s on Windows due to filesystem overhead). Run off the main event loop (async). **The snapshot capture must complete before the next `sendMessage` is dispatched** to prevent ref overlap. The server gates the next turn's dispatch on the previous turn's snapshot completion (the existing 400ms auto-dequeue delay in `threadStore.ts` provides a natural buffer, but the server enforces the gate regardless).

### Diff on Demand

Diffs are not stored in the DB. They are reconstructed from git refs when the user requests them:

1. User expands a tool call summary and clicks a file-changing tool call (Edit, Write, Bash with file output)
2. Client calls `snapshots.getDiff(snapshotId, filePath)` via WebSocket RPC
3. Server runs: `git diff ref_before..ref_after -- <filePath>`
4. Returns unified diff text
5. `DiffViewer` component renders with syntax highlighting

**Syntax highlighting:** Use [Shiki](https://shiki.style/) for diff syntax highlighting:
- Lazy-loaded on first diff view (not bundled upfront) to protect the `< 2MB gzipped` frontend bundle target
- Load only the grammars needed for the file being viewed (TypeScript, JSON, SQL, etc.)
- Use `shiki/wasm` for browser-compatible loading
- Unchanged line regions (> 5 lines) are collapsed with a "show N hidden lines" expander
- **Fallback:** If Shiki WASM fails to load (CSP restrictions, network issues), render the diff as plain text with basic +/- line coloring (green/red). No functionality is lost, only highlighting quality.

**File change type labels:**
- Created file: "File created" header, all lines green
- Deleted file: "File deleted" header, all lines red
- Renamed: `git diff --find-renames` detection, "Renamed: old.ts -> new.ts" header
- Binary: "Binary file changed" label, no diff content
- Large diff (> 500 lines): first 500 lines shown, "Show full diff" button for the rest

### Garbage Collection

Snapshot refs are dangling commits created by `git stash create`. They are unreachable from any branch and will be cleaned up by git's own GC (`git gc --auto`). However, the `turn_snapshots` table rows pointing to garbage-collected refs will produce errors when diffs are requested.

**Strategy:**
- `snapshots.cleanup` RPC method: deletes `turn_snapshots` rows where refs are no longer valid (verify with `git cat-file -t <ref>`)
- Called at app startup and configurable via `SNAPSHOT_MAX_AGE_DAYS` env var (default: 30)
- When a snapshot's refs have been GC'd, the UI falls back to `output_summary` from `tool_call_records` with a subtle indicator: "Full diff no longer available"

---

## Section 4: Edge Cases

### Git Snapshot Edge Cases

| Scenario | Handling |
|----------|----------|
| No file changes in turn | Skip snapshot creation, no `turn_snapshots` row. Tool calls still persist. |
| Clean working tree at turn start | `git stash create -u` returns empty; use `HEAD` as `ref_before` |
| Agent creates new untracked files | `git stash create -u` includes untracked files. Without `-u`, new files would be invisible in the diff. |
| Binary files changed | Detect via `git diff --numstat` (binary shows `-` for lines); render "Binary file changed" |
| Large diffs (>500 lines) | Cap inline render at 500 lines with "Show full diff" expand button |
| Deleted files | Show "File deleted" header, entire content in red |
| Created files | Show "File created" header, entire content in green |
| Renamed files | Use `git diff --find-renames`; show "Renamed: old -> new" header with content diff |
| Worktree context | Snapshots use the thread's working directory (main repo or worktree). `worktree_path` column tracks which. |
| Concurrent threads on same branch | Each snapshot captures the full worktree state at that moment. Overlapping snapshots are valid since `ref_before`/`ref_after` are immutable commit objects. |

### Subagent Edge Cases

| Scenario | Handling |
|----------|----------|
| Nested subagents (agent dispatches agent) | `parent_tool_call_id` chain supports arbitrary depth. UI caps visual nesting at 2-3 levels; deeper levels flatten into parent container. |
| Subagent fails/crashes | Agent card shows red error badge. Child tool calls up to the failure point are still persisted and viewable. |
| Multiple concurrent subagents | Each gets its own `SubagentContainer` card. Tool calls interleave in real-time but are grouped under their respective parent containers post-turn. |
| Subagent in isolated worktree | `turn_snapshots.worktree_path` stores the worktree path. `snapshots.getDiff` uses this path for `git diff`. |
| Subagent tool calls arrive interleaved | Server-side nesting inference tracks Agent tool call boundaries (toolUse -> toolResult window) to correctly assign `parent_tool_call_id`. |

### Persistence Edge Cases

| Scenario | Handling |
|----------|----------|
| `session.error` mid-turn | Accumulated tool calls are still persisted with `status: "failed"` on the last active call. Snapshot `ref_after` is captured at error time (agent may have made partial changes). |
| App closed mid-turn | Tool calls in Zustand are lost. Incomplete turn, acceptable loss. |
| Thread deleted | Cascade delete: thread -> messages -> tool_call_records, turn_snapshots. |
| GC'd snapshot refs | Fallback to `output_summary` with subtle "Full diff no longer available" indicator. |
| Rapid consecutive turns | Snapshot creation queued: turn N's `ref_after` must complete before turn N+1's `ref_before`. |
| Very long tool call list (50+) | Virtualize the expanded summary list using `@tanstack/react-virtual` (already in use). |

### UI Edge Cases

| Scenario | Handling |
|----------|----------|
| Empty tool call output | Show the tool's input params (file path, command) instead of blank content. |
| No thinking tokens (Phase 2 not built) | Layer 1 is absent. Layer 2 (tool-derived status via `StreamingIndicator`) is the sole narration source. |
| Thread switch while agent running | Status bar updates to new thread's state. Background thread continues; tool calls accumulate in Zustand keyed by thread ID. |
| `sort_order` for interleaved subagent calls | Server assigns `sort_order` based on arrival order of `session.toolUse` events. Subagent calls get sequential order within their parent's window. |

---

## Section 5: Component Architecture

### New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `ToolCallSummary` | `apps/web/src/components/chat/ToolCallSummary.tsx` | Collapsed post-turn summary row. Shows grouped counts ("7 tool calls: 3 edits, 2 reads..."). Expands to show persisted tool call cards loaded from DB. |
| `SubagentContainer` | `apps/web/src/components/chat/tool-renderers/SubagentContainer.tsx` | Collapsible wrapper for subagent tool calls. Header with description + status badge + tool call count. Nests child tool calls inside. Used by `AgentRenderer` post-turn. |
| `DiffViewer` | `apps/web/src/components/chat/DiffViewer.tsx` | Inline unified diff renderer with Shiki syntax highlighting. Collapsible unchanged regions. File path header with change-type label. Lazy-loads Shiki grammars on first use. |
| `AgentStatusBar` | `apps/web/src/components/chat/AgentStatusBar.tsx` | Subagent count indicator for the composer status bar area. Shows "N subagents running" only when subagents are active on the current thread. Hidden when only the main agent is running. |

### Modified Components

| Component | File | Change |
|-----------|------|--------|
| `ToolCallCard` | `apps/web/src/components/chat/ToolCallCard.tsx` | After turn complete + persistence confirmed, render `ToolCallSummary` instead of fading out. During execution, same as current. |
| `AgentRenderer` | `apps/web/src/components/chat/tool-renderers/AgentRenderer.tsx` | Post-turn expanded state wraps content in `SubagentContainer`. Passes `parent_tool_call_id` for loading nested tool calls. |
| `StreamingIndicator` | `apps/web/src/components/chat/StreamingIndicator.tsx` | Phase 2: add thinking narration line above tool-derived status when available. Phase 1: no changes needed, already works. |
| `virtual-items.ts` | `apps/web/src/components/chat/virtual-items.ts` | New `ChatVirtualItem` variant: `{ type: "tool-summary"; messageId: string; toolCallCount: number }`. Inserted after assistant messages that have persisted tool calls. |
| `Composer` | `apps/web/src/components/chat/Composer.tsx` | Host `AgentStatusBar` in the status bar row (lines 874-930), positioned between the `ModeSelector` (left) and branch controls (right, `ml-auto`). The status bar indicator sits in the center gap. |
| `MessageList` | `apps/web/src/components/chat/MessageList.tsx` | Handle the new `"tool-summary"` virtual item type, rendering `ToolCallSummary`. |

### New Transport Methods (WebSocket RPC)

Add to `McodeTransport` interface in `apps/web/src/transport/types.ts`:

```typescript
/** Fetch persisted tool call records for a message, with nesting structure. */
listToolCallRecords(messageId: string): Promise<ToolCallRecord[]>;

/** Get a unified diff for a specific file from a turn snapshot. */
getSnapshotDiff(snapshotId: string, filePath?: string): Promise<string>;

/** Run garbage collection on expired snapshot refs. */
cleanupSnapshots(): Promise<{ removed: number }>;
```

### New Server-Side Modules

The codebase has two server implementations:
- **`apps/desktop/src/main/`**: Electron main process. Repos use module-function pattern (`message-repo.ts` exports standalone functions taking `db: Database.Database`).
- **`apps/server/src/`**: Standalone Bun server. Repos use class-based DI pattern (`@injectable()` decorated classes via tsyringe).

New modules must be implemented in both. The module-function versions are listed below; the class-based server versions follow the same interface but use `@injectable()` + constructor injection.

| Module | Desktop Location | Server Location | Purpose |
|--------|-----------------|-----------------|---------|
| `tool-call-record-repo.ts` | `apps/desktop/src/main/repositories/` | `apps/server/src/repositories/` | CRUD for `tool_call_records` table. Exports: `create()`, `bulkCreate()`, `listByMessage()`, `listByParent()`. |
| `turn-snapshot-repo.ts` | `apps/desktop/src/main/repositories/` | `apps/server/src/repositories/` | CRUD for `turn_snapshots` table. Exports: `create()`, `getByMessage()`, `listByThread()`, `deleteExpired()`. |
| `snapshot-service.ts` | `apps/desktop/src/main/` | `apps/server/src/services/` | Git snapshot operations. Exports: `captureBefore(cwd)`, `captureAfter(cwd)`, `getDiff(refBefore, refAfter, filePath?)`, `validateRef(ref)`, `cleanup(maxAgeDays)`. |

### Data Flow: Turn Completion and Persistence

```
session.turnComplete event arrives at server
  │
  ├─ 1. snapshot-service.captureAfter(threadCwd)
  │     └─ git stash create → ref_after SHA
  │     └─ git diff --name-only ref_before ref_after → files_changed[]
  │
  ├─ 2. tool-call-record-repo.bulkCreate(toolCallsFromEventStream)
  │     └─ Insert all tool calls tracked during this turn
  │     └─ parent_tool_call_id set for subagent children
  │
  ├─ 3. turn-snapshot-repo.create({ messageId, threadId, refBefore, refAfter, filesChanged })
  │
  └─ 4. Push "turn.persisted" to client via WebSocket
        └─ { channel: "turn.persisted", data: { threadId, messageId, toolCallCount, filesChanged } }
```

### Data Flow: Viewing Historical Tool Calls

```
User opens old thread → loadMessages(threadId) fetches messages
  │
  ├─ Messages render in MessageList
  │
  ├─ For assistant messages with persisted tool calls:
  │   └─ ToolCallSummary renders below the message bubble
  │       └─ Shows "7 tool calls: 3 edits, 2 reads, 1 bash, 1 agent"
  │
  └─ User clicks to expand ToolCallSummary
      │
      ├─ Client calls listToolCallRecords(messageId)
      │   └─ Returns flat list with parent_tool_call_id for nesting
      │
      ├─ Renders tool call cards (same renderers as live view)
      │   └─ Agent tool calls render as SubagentContainer with nested children
      │
      └─ User clicks a file-changing tool call (Edit/Write)
          │
          ├─ Client calls getSnapshotDiff(snapshotId, filePath)
          │   └─ Server: git diff ref_before..ref_after -- filePath
          │
          └─ DiffViewer renders inline unified diff with Shiki highlighting
```

### Data Flow: Agent Status Bar

```
Agent events stream in for current thread
  │
  ├─ session.toolUse with toolName="Agent" → increment subagent count
  ├─ session.toolResult matching Agent toolCallId → decrement subagent count
  │
  └─ AgentStatusBar reads from threadStore:
      ├─ 0 subagents: hidden (main agent narration via StreamingIndicator only)
      ├─ 1+ subagents: "N subagents running" badge in composer status bar
      └─ Thread switch: count resets to current thread's active subagent count
```

---

## Phase Summary

| Phase | Scope | Dependencies |
|-------|-------|-------------|
| **Phase 1** (this spec) | Tool call persistence, post-turn summary, diff viewer, subagent nesting, agent status bar | None |
| **Phase 2** (future) | Thinking narration layer (requires `session.delta` pipeline in sidecar) | Sidecar streaming delta implementation |
| **Phase 3** (future) | Side-by-side diff view toggle | Phase 1 DiffViewer |
