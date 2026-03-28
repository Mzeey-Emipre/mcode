# Tool Call UX Performance Improvements

*Generated: 2026-03-28 | Based on: codebase analysis of `feat/tool-call-overhaul` branch*

## Context

The `feat/tool-call-overhaul` branch redesigned tool call handling into a hybrid system: real-time streaming during active turns, bulk persistence to SQLite on turn completion, and lazy-loaded expandable summaries for history. The architecture is sound, but there are 10 concrete performance improvements ranked by impact.

## Current Performance Patterns Already in Place

- Virtual scrolling via `@tanstack/react-virtual`
- Lazy loading of tool call records and diffs (on expand, not on message load)
- Bulk insert via `db.transaction()` for tool call persistence
- `useMemo` on `buildVirtualItems()` and memoized `VirtualItemRenderer`
- `useShallow()` selectors in Zustand to reduce re-renders
- In-memory tool calls cleared after `turn.persisted`
- Snapshot GC (30-day expiry, cleaned on server startup)

---

## 1. WebSocket Event Batching / Throttling

**Priority: High**

**Problem**: Every `toolUse` and `toolResult` event triggers a Zustand store update, which triggers React re-renders. During burst activity (30+ tool calls in rapid succession), the frontend receives individual events that each cause a virtual items recomputation.

**Current behavior**: Each event hits `handleAgentEvent()` individually, updating `toolCallsByThread` and `activeSubagentsByThread` separately.

**Recommendation**:
- **Server-side**: Batch tool events within a 50-100ms window. Buffer events per thread and flush on a short timer or when a natural boundary occurs (turn complete, tool result).
- **Client-side**: Use `requestAnimationFrame` or a microtask queue in the store to coalesce rapid state updates into a single render cycle. Zustand's `setState` is synchronous, so 10 rapid calls = 10 renders. Wrap in `unstable_batchedUpdates` or use a write-debounce middleware.

**Key files**:
- `apps/server/src/index.ts` (event broadcasting)
- `apps/web/src/stores/threadStore.ts` (`handleAgentEvent`)
- `apps/web/src/transport/ws-events.ts` (push event handlers)

---

## 2. Granular `buildVirtualItems()` Memoization

**Priority: High**

**Problem**: `buildVirtualItems()` recomputes on any change to its inputs, including `toolCallsByThread` which changes on every single tool event. The function iterates all messages and all tool calls.

**Current behavior**: `useMemo` with dependency on `messages`, `toolCallsByThread[threadId]`, `persistedToolCallCounts`, etc. Every tool event invalidates the memo.

**Recommendation**:
- Split virtual items into **stable** (messages + summaries) and **volatile** (active tool calls, streaming, indicator) segments. Memoize the stable part separately so it survives tool call updates.
- Use structural equality on the volatile segment to skip recomputation when the tool call array reference changes but contents haven't materially changed.
- Consider moving virtual item construction into a web worker for threads with 100+ messages.

**Key files**:
- `apps/web/src/components/chat/virtual-items.ts` (`buildVirtualItems`, `estimateItemHeight`)
- `apps/web/src/components/chat/MessageList.tsx` (where memo dependencies are declared)

---

## 3. Async Git Operations

**Priority: Medium-High**

**Problem**: `SnapshotService.captureRef()` calls `git stash create -u` synchronously via `execFileSync`. `getFilesChanged()` and `getDiff()` also use sync exec. These block the Node.js event loop, stalling all WebSocket communication during git operations on large repos.

**Current behavior**: `captureRef` runs at message send time and at turn complete. Large repos with many untracked files could take 500ms+ for `git stash create -u`.

**Recommendation**:
- Switch from `execFileSync` to `execFile` (async) with promises. The `captureRef` call happens at known lifecycle boundaries, so async is straightforward.
- For `getDiff` (called on-demand via RPC), async is even more natural.
- If git operations routinely exceed 200ms, consider a dedicated worker thread pool for git commands.

**Key files**:
- `apps/server/src/services/snapshot-service.ts` (all methods)
- `apps/server/src/services/agent-service.ts` (`persistTurn`, `sendMessage`)

---

## 4. Client-Side Tool Call Record Cache

**Priority: Medium**

**Problem**: Every time a user expands a `ToolCallSummary`, it fires `listToolCallRecords(messageId)`. If the user collapses and re-expands (or scrolls away and back in the virtual list), it re-fetches from the server.

**Current behavior**: No caching. Each expand triggers an RPC call.

**Recommendation**:
- Add a Map-based cache in the Zustand store: `toolCallRecordCache: Record<string, ToolCallRecord[]>`.
- Populate on first fetch. Tool call records are immutable after `turn.persisted`, so this is a safe indefinite cache.
- Similarly cache `listToolCallRecordsByParent` results for subagent containers.
- Invalidate only if a new `turn.persisted` arrives for the same message (shouldn't happen).

**Key files**:
- `apps/web/src/stores/threadStore.ts` (new cache state)
- `apps/web/src/components/chat/ToolCallSummary.tsx` (fetch on expand)
- `apps/web/src/components/chat/tool-renderers/SubagentContainer.tsx` (child fetch)

---

## 5. Diff Viewer: Server-Side Truncation and Virtualized Rendering

**Priority: Medium**

**Problem**: `DiffViewer` fetches the entire unified diff string via `getSnapshotDiff()`, then parses and renders up to 500 lines. For files with very large diffs, the full diff is still transferred over WebSocket.

**Current behavior**: Truncated at 500 lines client-side, but the full diff crosses the wire.

**Recommendation**:
- Add a `maxLines` parameter to the `snapshot.getDiff` RPC method. Truncate server-side: pipe git diff through a line limit.
- Render diff lines using a virtualized list (reuse TanStack Virtual) instead of a flat map, so only visible lines are in the DOM.
- Cache diff results per `(snapshotId, filePath)` since they're immutable.

**Key files**:
- `apps/web/src/components/chat/DiffViewer.tsx` (rendering)
- `apps/server/src/services/snapshot-service.ts` (`getDiff`)
- `apps/server/src/transport/ws-router.ts` (`snapshot.getDiff` handler)
- `packages/contracts/src/ws/methods.ts` (add `maxLines` param)

---

## 6. Unify `agentCallStack` Tracking

**Priority: Medium-Low**

**Problem**: Both `index.ts` and `AgentService` maintain independent `agentCallStack` Maps for the same purpose (parent-child inference). This doubles memory and creates a drift risk.

**Current behavior**: Dual tracking for real-time enrichment (`index.ts`) vs. persistence (`AgentService`).

**Recommendation**:
- Unify into a single source of truth in `AgentService`. Expose a method like `getCurrentParentToolCallId(threadId): string | null` that the real-time event enrichment in `index.ts` can call.
- Alternatively, have `AgentService` emit enriched events (with `parentToolCallId` already attached) so `index.ts` doesn't need its own tracking.

**Key files**:
- `apps/server/src/index.ts` (duplicate stack tracking)
- `apps/server/src/services/agent-service.ts` (canonical stack)

---

## 7. Targeted `turn.persisted` Broadcasting

**Priority: Low**

**Problem**: `turn.persisted` is broadcast to all connected clients regardless of which thread they're viewing.

**Current behavior**: Global broadcast via push channel.

**Recommendation**:
- Track which threadId each client is subscribed to (possible via the existing channel subscription model).
- Only push `turn.persisted` to clients subscribed to that thread.
- For sidebar previews, use a lighter notification that just updates the count.

**Key files**:
- `apps/server/src/transport/ws-router.ts` (broadcast logic)
- `apps/web/src/transport/ws-events.ts` (subscription)

---

## 8. Prepared Statement Caching

**Priority: Low**

**Problem**: Verify that `ToolCallRecordRepo` and `TurnSnapshotRepo` reuse prepared statements for hot-path queries rather than re-preparing on each call.

**Recommendation**:
- Cache prepared statements at construction time for `listByMessage`, `listByParent`, `create`, and `bulkCreate`. `better-sqlite3` caches by SQL string, but explicitly storing the statement object avoids repeated hash lookups.

**Key files**:
- `apps/server/src/repositories/tool-call-record-repo.ts`
- `apps/server/src/repositories/turn-snapshot-repo.ts`

---

## 9. Virtual List Height Measurement

**Priority: Low-Medium**

**Problem**: `estimateItemHeight()` returns fixed estimates (36px for tool summary, 48px for indicator). If actual rendered heights differ, the virtualizer accumulates scroll position drift.

**Recommendation**:
- Use TanStack Virtual's `measureElement` callback to replace estimates with actual measurements after first render. This self-corrects scroll position.
- For the streaming case, pin to bottom using `scrollToIndex` after each content update instead of relying on height estimates.

**Key files**:
- `apps/web/src/components/chat/virtual-items.ts` (`estimateItemHeight`)
- `apps/web/src/components/chat/MessageList.tsx` (virtualizer config)

---

## 10. Defer Input Summarization to Persistence Phase

**Priority: Low**

**Problem**: `summarizeInput()` runs a switch statement with JSON serialization and string truncation for every tool call during the hot event-handling path.

**Current behavior**: `JSON.stringify(input).slice(0, 200)` as the default fallback, executed per event.

**Recommendation**:
- Buffer raw tool names and a lightweight key (e.g., just `file_path` for Read/Edit) during the turn. Summarize in bulk inside `persistTurn()` before the transaction.
- Keeps the hot event-handling path faster and batches string work.

**Key files**:
- `apps/server/src/services/agent-service.ts` (`bufferToolCall`, `summarizeInput`, `persistTurn`)

---

## Summary Table

| # | Improvement | Priority | Impact Area |
|---|-------------|----------|-------------|
| 1 | WebSocket event batching | High | Render performance |
| 2 | Granular virtual item memoization | High | Render performance |
| 3 | Async git operations | Medium-High | Server responsiveness |
| 4 | Client-side record cache | Medium | UX responsiveness |
| 5 | Diff truncation + virtualization | Medium | Transfer size, DOM perf |
| 6 | Unify agent call stack | Medium-Low | Code maintainability |
| 7 | Targeted broadcasting | Low | Multi-client scale |
| 8 | Prepared statement caching | Low | DB throughput |
| 9 | Height measurement feedback | Low-Medium | Scroll stability |
| 10 | Deferred summarization | Low | Event processing speed |
