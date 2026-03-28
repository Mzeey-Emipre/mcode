# Tool Call Performance Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize tool call rendering performance, eliminate blocking git operations, and add caching to reduce redundant network requests.

**Architecture:** Eight independent improvements targeting three layers: client-side rendering (event batching, memoization), server-side I/O (async git, deferred summarization), and cross-cutting (caching, statement reuse, stack unification). Each task is independently deployable.

**Tech Stack:** React 19, Zustand, TanStack Virtual, better-sqlite3, Node.js child_process

---

## Task 1: WebSocket Event Batching (High Priority)

Coalesce rapid tool call events into batched state updates to reduce React re-renders during burst activity.

**Files:**
- Create: `apps/web/src/stores/batchMiddleware.ts`
- Modify: `apps/web/src/stores/threadStore.ts:309-389` (toolUse/toolResult handlers)
- Test: `apps/web/src/__tests__/batch-middleware.test.ts`

- [ ] **Step 1: Write failing test for batch middleware**

```typescript
// apps/web/src/__tests__/batch-middleware.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatchedUpdater } from "@/stores/batchMiddleware";

describe("createBatchedUpdater", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("coalesces multiple calls into a single flush", () => {
    const setState = vi.fn();
    const batch = createBatchedUpdater<{ count: number }>(setState);

    batch((s) => ({ count: s.count + 1 }));
    batch((s) => ({ count: s.count + 1 }));
    batch((s) => ({ count: s.count + 1 }));

    expect(setState).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("applies updates sequentially to produce correct final state", () => {
    let capturedFn: ((s: { count: number }) => Partial<{ count: number }>) | null = null;
    const setState = vi.fn((fn) => { capturedFn = fn; });
    const batch = createBatchedUpdater<{ count: number }>(setState);

    batch((s) => ({ count: s.count + 1 }));
    batch((s) => ({ count: s.count + 10 }));

    vi.runAllTimers();
    // The merged updater should apply both updates sequentially
    const result = capturedFn!({ count: 0 });
    expect(result.count).toBe(11);
  });

  it("flushes immediately when queue exceeds max size", () => {
    const setState = vi.fn();
    const batch = createBatchedUpdater<{ count: number }>(setState, { maxQueueSize: 2 });

    batch((s) => ({ count: s.count + 1 }));
    batch((s) => ({ count: s.count + 1 }));
    // Should flush immediately without waiting for timer
    expect(setState).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/__tests__/batch-middleware.test.ts --reporter=verbose`
Expected: FAIL with "createBatchedUpdater is not a function"

- [ ] **Step 3: Implement batch middleware**

```typescript
// apps/web/src/stores/batchMiddleware.ts

/** Options for the batched updater. */
interface BatchOptions {
  /** Max updates to queue before forcing a flush. Default: 20. */
  maxQueueSize?: number;
}

/**
 * Create a batched state updater that coalesces rapid Zustand setState calls
 * into a single update using requestAnimationFrame (or setTimeout fallback).
 *
 * Each queued updater is applied sequentially to the state snapshot inside
 * a single setState call, producing one React re-render per frame.
 */
export function createBatchedUpdater<T>(
  setState: (fn: (state: T) => Partial<T>) => void,
  options?: BatchOptions,
) {
  const maxQueue = options?.maxQueueSize ?? 20;
  let queue: Array<(state: T) => Partial<T>> = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    setState((state) => {
      let merged = state;
      for (const updater of batch) {
        merged = { ...merged, ...updater(merged) };
      }
      return merged;
    });
  };

  return (updater: (state: T) => Partial<T>) => {
    queue.push(updater);
    if (queue.length >= maxQueue) {
      flush();
      return;
    }
    if (!scheduled) {
      scheduled = true;
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(flush);
      } else {
        setTimeout(flush, 0);
      }
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/__tests__/batch-middleware.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Wire batch middleware into threadStore for tool events**

Modify `apps/web/src/stores/threadStore.ts`. At the top of the `create()` call, instantiate the batcher. Use it for `session.toolUse` and `session.toolResult` state updates only (these are the high-frequency events).

```typescript
// At the top of the store file, after imports:
import { createBatchedUpdater } from "./batchMiddleware";

// Inside the create() callback, before the return:
const batchSet = createBatchedUpdater<ThreadState>(set);

// Replace direct set() calls in session.toolUse handler (around line 337):
// OLD: set((state) => ({ toolCallsByThread: { ...state.toolCallsByThread, [threadId]: [...] } }));
// NEW: batchSet((state) => ({ toolCallsByThread: { ...state.toolCallsByThread, [threadId]: [...] } }));

// Same for session.toolResult handler (around line 365):
// OLD: set((state) => ({ toolCallsByThread: { ...state.toolCallsByThread, [threadId]: updated } }));
// NEW: batchSet((state) => ({ toolCallsByThread: { ...state.toolCallsByThread, [threadId]: updated } }));
```

- [ ] **Step 6: Run full test suite**

Run: `cd apps/web && npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/stores/batchMiddleware.ts apps/web/src/__tests__/batch-middleware.test.ts apps/web/src/stores/threadStore.ts
git commit -m "perf: batch rapid tool call events into single render cycles"
```

---

## Task 2: Granular buildVirtualItems Memoization (High Priority)

Split virtual items into stable (messages + summaries) and volatile (active tools, streaming, indicator) segments so tool call events don't recompute the entire message list.

**Files:**
- Modify: `apps/web/src/components/chat/virtual-items.ts:23-108`
- Modify: `apps/web/src/components/chat/MessageList.tsx:73-92`
- Modify: `apps/web/src/__tests__/virtual-items.test.ts`

- [ ] **Step 1: Write failing test for split memoization**

Add to `apps/web/src/__tests__/virtual-items.test.ts`:

```typescript
describe("buildStableItems", () => {
  it("returns message items with tool summaries interleaved", () => {
    const messages: Message[] = [
      { id: "u1", role: "user", content: "hi", createdAt: "2026-01-01" },
      { id: "a1", role: "assistant", content: "hello", createdAt: "2026-01-01" },
    ];
    const counts = { a1: 5 };
    const items = buildStableItems(messages, counts);
    expect(items).toHaveLength(3); // user msg + tool-summary + assistant msg
    expect(items[0].type).toBe("message");
    expect(items[1].type).toBe("tool-summary");
    expect(items[2].type).toBe("message");
  });
});

describe("buildVolatileItems", () => {
  it("returns active-tools and indicator items", () => {
    const toolCalls = [
      { id: "t1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
    ];
    const items = buildVolatileItems(toolCalls, true, 1000, undefined);
    expect(items.some((i) => i.type === "active-tools")).toBe(true);
    expect(items.some((i) => i.type === "indicator")).toBe(true);
  });

  it("returns empty array when no tool calls and agent not running", () => {
    const items = buildVolatileItems([], false, undefined, undefined);
    expect(items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/__tests__/virtual-items.test.ts --reporter=verbose`
Expected: FAIL with "buildStableItems is not exported"

- [ ] **Step 3: Split buildVirtualItems into stable and volatile builders**

Refactor `apps/web/src/components/chat/virtual-items.ts`:

```typescript
/**
 * Build the stable segment: messages interleaved with persisted tool summaries.
 * This only changes when messages or persistedToolCallCounts change (infrequent).
 */
export function buildStableItems(
  messages: readonly Message[],
  persistedToolCallCounts?: Record<string, number>,
): ChatVirtualItem[] {
  const items: ChatVirtualItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const count = persistedToolCallCounts?.[msg.id];
      if (count && count > 0) {
        items.push({
          key: `tool-summary-${msg.id}`,
          type: "tool-summary",
          messageId: msg.id,
          toolCallCount: count,
        });
      }
    }
    items.push({ key: msg.id, type: "message", message: msg });
  }
  return items;
}

/**
 * Build the volatile segment: active tool calls, streaming text, and indicator.
 * This changes on every tool call event but doesn't depend on messages.
 */
export function buildVolatileItems(
  toolCalls: readonly ToolCall[],
  isAgentRunning: boolean,
  agentStartTime: number | undefined,
  streamingText: string | undefined,
): ChatVirtualItem[] {
  const items: ChatVirtualItem[] = [];

  if (toolCalls.length > 0) {
    items.push({ key: "active-tools", type: "active-tools", toolCalls });
  }

  if (streamingText) {
    items.push({ key: "streaming", type: "streaming", content: streamingText });
  }

  if (isAgentRunning && !streamingText) {
    const activeOnly = toolCalls.filter((tc) => !tc.isComplete);
    items.push({
      key: "indicator",
      type: "indicator",
      startTime: agentStartTime,
      activeToolCalls: activeOnly,
    });
  }

  return items;
}

/**
 * Combine stable and volatile segments into the final virtual item array.
 * When tool calls exist, the last assistant message is moved after the
 * active-tools item so tools appear above the response.
 */
export function buildVirtualItems(
  stableItems: readonly ChatVirtualItem[],
  volatileItems: readonly ChatVirtualItem[],
  hasToolCalls: boolean,
): ChatVirtualItem[] {
  if (!hasToolCalls || volatileItems.length === 0) {
    return [...stableItems, ...volatileItems];
  }

  // Move last assistant message after volatile items
  const lastItem = stableItems[stableItems.length - 1];
  if (lastItem?.type === "message" && lastItem.message.role === "assistant") {
    // Check if the preceding item is a tool-summary for this message
    const secondLast = stableItems[stableItems.length - 2];
    const skipSummary =
      secondLast?.type === "tool-summary" &&
      secondLast.messageId === lastItem.message.id;
    const cutAt = skipSummary ? stableItems.length - 2 : stableItems.length - 1;
    return [
      ...stableItems.slice(0, cutAt),
      ...volatileItems,
      ...stableItems.slice(cutAt),
    ];
  }

  return [...stableItems, ...volatileItems];
}
```

- [ ] **Step 4: Update MessageList to use split memoization**

Modify `apps/web/src/components/chat/MessageList.tsx`:

```typescript
import {
  buildStableItems,
  buildVolatileItems,
  buildVirtualItems,
  estimateItemHeight,
} from "./virtual-items";

// Split into two memos: stable survives tool call events
const stableItems = useMemo(
  () => buildStableItems(messages, persistedToolCallCounts),
  [messages, persistedToolCallCounts],
);

const volatileItems = useMemo(
  () => buildVolatileItems(toolCalls, isAgentRunning, agentStartTime, streamingText),
  [toolCalls, isAgentRunning, agentStartTime, streamingText],
);

const items = useMemo(
  () => buildVirtualItems(stableItems, volatileItems, toolCalls.length > 0),
  [stableItems, volatileItems, toolCalls.length],
);
```

- [ ] **Step 5: Update existing tests for new function signatures**

Update `apps/web/src/__tests__/virtual-items.test.ts` to use the new split API. Any tests calling `buildVirtualItems()` with 6 params need to call `buildStableItems()` + `buildVolatileItems()` + `buildVirtualItems()` instead.

- [ ] **Step 6: Run full test suite**

Run: `cd apps/web && npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/chat/virtual-items.ts apps/web/src/components/chat/MessageList.tsx apps/web/src/__tests__/virtual-items.test.ts
git commit -m "perf: split virtual items into stable/volatile segments for granular memoization"
```

---

## Task 3: Async Git Operations (Medium-High Priority)

Replace all `execFileSync` calls in SnapshotService with async `execFile` to unblock the Node.js event loop during git operations.

**Files:**
- Modify: `apps/server/src/services/snapshot-service.ts` (all 4 methods)
- Modify: `apps/server/src/services/agent-service.ts:83-188` (sendMessage), `403-463` (persistTurn)
- Modify: `apps/server/src/transport/ws-router.ts:281-295` (snapshot.getDiff handler)
- Test: `apps/server/src/__tests__/snapshot-service.test.ts`

- [ ] **Step 1: Convert SnapshotService methods from sync to async**

```typescript
// apps/server/src/services/snapshot-service.ts
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

@singleton()
export class SnapshotService {
  /** Capture a git ref representing the current working tree state. */
  async captureRef(cwd: string): Promise<string> {
    try {
      const { stdout } = await execFile("git", ["stash", "create", "-u"], {
        cwd,
        timeout: 10_000,
      });
      const ref = stdout.trim();
      if (ref) return ref;
    } catch {
      // stash create can fail if nothing to stash
    }
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 10_000,
    });
    return stdout.trim();
  }

  /** List files changed between two git refs. */
  async getFilesChanged(cwd: string, refBefore: string, refAfter: string): Promise<string[]> {
    try {
      const { stdout } = await execFile(
        "git",
        ["diff", "--name-only", refBefore, refAfter],
        { cwd, timeout: 10_000 },
      );
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Get unified diff between two refs, optionally scoped to a file. */
  async getDiff(
    cwd: string,
    refBefore: string,
    refAfter: string,
    filePath?: string,
    maxLines?: number,
  ): Promise<string> {
    const args = ["diff", "--find-renames", refBefore, refAfter];
    if (filePath) args.push("--", filePath);
    try {
      const { stdout } = await execFile("git", args, {
        cwd,
        timeout: 10_000,
      });
      if (maxLines) {
        return stdout.split("\n").slice(0, maxLines).join("\n");
      }
      return stdout;
    } catch {
      return "";
    }
  }

  /** Check whether a git ref still exists (not garbage collected). */
  async validateRef(cwd: string, ref: string): Promise<boolean> {
    try {
      await execFile("git", ["cat-file", "-t", ref], {
        cwd,
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 2: Update AgentService callers to await**

In `apps/server/src/services/agent-service.ts`:

- `sendMessage` (line ~139): Change `this.snapshotService.captureRef(cwd)` to `await this.snapshotService.captureRef(cwd)`
- `persistTurn` (line ~435-437): Make `persistTurn` async. Change `captureRef` and `getFilesChanged` calls to `await`.

```typescript
// Change method signature:
private async persistTurn(threadId: string, isError = false): Promise<void> {
  // ... existing code ...
  const refAfter = await this.snapshotService.captureRef(refData.cwd);
  const filesChanged = await this.snapshotService.getFilesChanged(
    refData.cwd, refData.ref, refAfter,
  );
  // ... rest unchanged ...
}
```

- [ ] **Step 3: Update ws-router snapshot.getDiff handler to await**

In `apps/server/src/transport/ws-router.ts` (line ~294):

```typescript
case "snapshot.getDiff": {
  const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
  if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
  // ... cwd resolution unchanged ...
  return await deps.snapshotService.getDiff(cwd, snapshot.ref_before, snapshot.ref_after, params.filePath);
}
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p apps/server/tsconfig.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/snapshot-service.ts apps/server/src/services/agent-service.ts apps/server/src/transport/ws-router.ts
git commit -m "perf: replace execFileSync with async execFile in SnapshotService"
```

---

## Task 4: Client-Side Tool Call Record Cache (Medium Priority)

Add a shared cache for tool call records so expanding/collapsing summaries and scrolling away/back don't re-fetch from the server.

**Files:**
- Modify: `apps/web/src/stores/threadStore.ts` (add cache state + actions)
- Modify: `apps/web/src/components/chat/ToolCallSummary.tsx:147-155` (use cache)
- Modify: `apps/web/src/components/chat/tool-renderers/SubagentContainer.tsx:50-57` (use cache)
- Test: `apps/web/src/__tests__/tool-call-cache.test.ts`

- [ ] **Step 1: Write failing test for cache behavior**

```typescript
// apps/web/src/__tests__/tool-call-cache.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("tool call record cache", () => {
  it("caches records by message ID after first fetch", async () => {
    const { useThreadStore } = await import("@/stores/threadStore");
    const store = useThreadStore.getState();

    // Simulate caching
    const records = [{ id: "r1", tool_name: "Read", input_summary: "file.ts" }];
    store.cacheToolCallRecords("msg1", records as any);

    const cached = store.getCachedToolCallRecords("msg1");
    expect(cached).toEqual(records);
  });

  it("returns null for uncached message IDs", async () => {
    const { useThreadStore } = await import("@/stores/threadStore");
    const cached = useThreadStore.getState().getCachedToolCallRecords("unknown");
    expect(cached).toBeNull();
  });

  it("clears cache on thread switch via clearMessages", async () => {
    const { useThreadStore } = await import("@/stores/threadStore");
    const store = useThreadStore.getState();
    store.cacheToolCallRecords("msg1", []);
    store.clearMessages();
    expect(store.getCachedToolCallRecords("msg1")).toBeNull();
  });
});
```

- [ ] **Step 2: Add cache state and actions to threadStore**

In `apps/web/src/stores/threadStore.ts`, add to the state interface:

```typescript
// Add to ThreadState interface:
toolCallRecordCache: Record<string, ToolCallRecord[]>;
cacheToolCallRecords: (key: string, records: ToolCallRecord[]) => void;
getCachedToolCallRecords: (key: string) => ToolCallRecord[] | null;
```

Add implementations:

```typescript
// In initial state:
toolCallRecordCache: {},

// Actions:
cacheToolCallRecords: (key, records) => {
  set((state) => ({
    toolCallRecordCache: { ...state.toolCallRecordCache, [key]: records },
  }));
},

getCachedToolCallRecords: (key) => {
  return get().toolCallRecordCache[key] ?? null;
},
```

In `clearMessages`, add `toolCallRecordCache: {}` to the reset.

- [ ] **Step 3: Use cache in ToolCallSummary**

In `apps/web/src/components/chat/ToolCallSummary.tsx`, update `handleToggle`:

```typescript
const handleToggle = useCallback(async () => {
  if (!expanded && records === null) {
    // Check cache first
    const cached = useThreadStore.getState().getCachedToolCallRecords(messageId);
    if (cached) {
      setRecords(cached);
    } else {
      setLoading(true);
      try {
        const loaded = await getTransport().listToolCallRecords(messageId);
        setRecords(loaded);
        useThreadStore.getState().cacheToolCallRecords(messageId, loaded);
      } catch {
        setRecords([]);
      } finally {
        setLoading(false);
      }
    }
  }
  setExpanded((prev) => {
    if (prev) setShowAll(false);
    return !prev;
  });
}, [expanded, records, messageId]);
```

- [ ] **Step 4: Use cache in SubagentContainer**

In `apps/web/src/components/chat/tool-renderers/SubagentContainer.tsx`, update the fetch effect:

```typescript
useEffect(() => {
  let cancelled = false;
  const cacheKey = `parent:${toolCallId}`;
  const cached = useThreadStore.getState().getCachedToolCallRecords(cacheKey);
  if (cached) {
    setChildren(cached);
    return;
  }
  getTransport()
    .listToolCallRecordsByParent(toolCallId)
    .then((data) => {
      if (!cancelled) {
        setChildren(data);
        useThreadStore.getState().cacheToolCallRecords(cacheKey, data);
      }
    })
    .catch(() => { if (!cancelled) setChildren([]); });
  return () => { cancelled = true; };
}, [toolCallId]);
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd apps/web && npx vitest run --reporter=verbose && npx tsc --noEmit -p tsconfig.json`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/stores/threadStore.ts apps/web/src/components/chat/ToolCallSummary.tsx apps/web/src/components/chat/tool-renderers/SubagentContainer.tsx apps/web/src/__tests__/tool-call-cache.test.ts
git commit -m "perf: add client-side cache for tool call records"
```

---

## Task 5: Diff Viewer Server-Side Truncation (Medium Priority)

Add a `maxLines` parameter to the `snapshot.getDiff` RPC method so large diffs are truncated server-side instead of transferring the full diff over WebSocket.

**Files:**
- Modify: `packages/contracts/src/ws/methods.ts:193-199` (add maxLines param)
- Modify: `apps/server/src/transport/ws-router.ts:281-295` (pass maxLines to service)
- Modify: `apps/web/src/components/chat/DiffViewer.tsx` (pass maxLines from client)
- Modify: `apps/web/src/transport/ws-transport.ts` (update RPC call signature)
- Modify: `apps/web/src/transport/types.ts` (update interface)

- [ ] **Step 1: Add maxLines to contract schema**

In `packages/contracts/src/ws/methods.ts`:

```typescript
"snapshot.getDiff": {
  params: z.object({
    snapshotId: z.string(),
    filePath: z.string().optional(),
    maxLines: z.number().int().positive().optional(),
  }),
  result: z.string(),
},
```

- [ ] **Step 2: Pass maxLines through ws-router to SnapshotService**

In `apps/server/src/transport/ws-router.ts`, update the `snapshot.getDiff` handler:

```typescript
case "snapshot.getDiff": {
  const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
  if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
  // ... cwd resolution ...
  return await deps.snapshotService.getDiff(
    cwd, snapshot.ref_before, snapshot.ref_after, params.filePath, params.maxLines,
  );
}
```

(The `getDiff` signature was already updated in Task 3 to accept `maxLines`.)

- [ ] **Step 3: Update transport types and RPC binding**

In `apps/web/src/transport/types.ts`, update the `McodeTransport` interface:

```typescript
getSnapshotDiff(snapshotId: string, filePath?: string, maxLines?: number): Promise<string>;
```

In `apps/web/src/transport/ws-transport.ts`:

```typescript
getSnapshotDiff: (snapshotId, filePath, maxLines) =>
  rpc<string>("snapshot.getDiff", { snapshotId, filePath, maxLines }),
```

- [ ] **Step 4: Pass maxLines from DiffViewer**

In `apps/web/src/components/chat/DiffViewer.tsx`, update the fetch to pass `MAX_LINES`:

```typescript
const loaded = await getTransport().getSnapshotDiff(snapshotId, filePath, MAX_LINES);
```

Remove the client-side line truncation since the server now handles it.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json && npx tsc --noEmit -p apps/server/tsconfig.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/ws/methods.ts apps/server/src/transport/ws-router.ts apps/web/src/transport/types.ts apps/web/src/transport/ws-transport.ts apps/web/src/components/chat/DiffViewer.tsx
git commit -m "perf: add server-side diff truncation via maxLines parameter"
```

---

## Task 6: Unify agentCallStack Tracking (Medium-Low Priority)

Consolidate the duplicate parent-child tracking from `index.ts` and `AgentService` into a single source of truth.

**Files:**
- Modify: `apps/server/src/services/agent-service.ts:54-58,348-376` (expose getCurrentParent)
- Modify: `apps/server/src/index.ts:82-113` (remove duplicate stack, use service method)

- [ ] **Step 1: Add public method to AgentService**

```typescript
// In apps/server/src/services/agent-service.ts, add public method:

/** Get the current parent tool call ID for a thread's active Agent nesting. */
getCurrentParentToolCallId(threadId: string): string | undefined {
  const stack = this.agentCallStack.get(threadId);
  return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
}
```

- [ ] **Step 2: Remove duplicate tracking from index.ts**

In `apps/server/src/index.ts`, replace the `agentCallStacks` Map and its management with calls to `agentService.getCurrentParentToolCallId()`:

```typescript
// REMOVE: const agentCallStacks = new Map<string, string[]>();
// REMOVE: All agentCallStacks push/pop/delete logic

// In the event handler, replace parent inference with:
if (event.type === "toolUse") {
  const parentId = agentService.getCurrentParentToolCallId(threadId);
  if (parentId) {
    enrichedEvent.parentToolCallId = parentId;
  }
}
// The agentCallStack push/pop is already handled inside bufferToolCall/updateBufferedToolCallOutput
```

- [ ] **Step 3: Verify bufferToolCall is called before event broadcast**

Ensure the event processing order in `index.ts` is: `agentService.bufferToolCall()` (updates stack) THEN `broadcast()` (reads stack for parent inference). If not, reorder.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p apps/server/tsconfig.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/agent-service.ts apps/server/src/index.ts
git commit -m "refactor: unify agentCallStack into single source of truth in AgentService"
```

---

## Task 7: Prepared Statement Caching (Low Priority)

Cache frequently-used SQL prepared statements at repository construction time to avoid repeated hash lookups in better-sqlite3.

**Files:**
- Modify: `apps/server/src/repositories/tool-call-record-repo.ts`
- Modify: `apps/server/src/repositories/turn-snapshot-repo.ts`

- [ ] **Step 1: Cache statements in ToolCallRecordRepo**

```typescript
// apps/server/src/repositories/tool-call-record-repo.ts
// Add private statement fields after the db property:

private readonly stmtListByMessage: ReturnType<Database["prepare"]>;
private readonly stmtListByParent: ReturnType<Database["prepare"]>;
private readonly stmtCountByMessage: ReturnType<Database["prepare"]>;
private readonly stmtInsert: ReturnType<Database["prepare"]>;

constructor(@inject("Database") private readonly db: Database) {
  this.stmtListByMessage = db.prepare(
    `SELECT ${TOOL_CALL_RECORD_COLUMNS} FROM tool_call_records WHERE message_id = ? ORDER BY sort_order ASC`
  );
  this.stmtListByParent = db.prepare(
    `SELECT ${TOOL_CALL_RECORD_COLUMNS} FROM tool_call_records WHERE parent_tool_call_id = ? ORDER BY sort_order ASC`
  );
  this.stmtCountByMessage = db.prepare(
    `SELECT COUNT(*) as count FROM tool_call_records WHERE message_id = ?`
  );
  this.stmtInsert = db.prepare(
    `INSERT INTO tool_call_records (...) VALUES (...)`
  );
}

// Then use this.stmtListByMessage.all(messageId) instead of db.prepare(...).all(messageId)
```

- [ ] **Step 2: Cache statements in TurnSnapshotRepo**

Same pattern: cache `getById`, `getByMessage`, `listByThread`, `insert`, and `deleteExpired` statements in the constructor.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p apps/server/tsconfig.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/repositories/tool-call-record-repo.ts apps/server/src/repositories/turn-snapshot-repo.ts
git commit -m "perf: cache prepared SQL statements at repository construction time"
```

---

## Task 8: Defer Input Summarization to Persistence Phase (Low Priority)

Move `summarizeInput()` from the hot event-handling path into the `persistTurn()` batch to avoid per-event string work.

**Files:**
- Modify: `apps/server/src/services/agent-service.ts:348-376` (bufferToolCall), `403-463` (persistTurn), `474-490` (summarizeInput)

- [ ] **Step 1: Store raw tool inputs in the buffer instead of summaries**

In `bufferToolCall`, stop calling `summarizeInput()`. Instead, store the raw `toolName` and a lightweight key (just the info needed for summarization):

```typescript
// In bufferToolCall, change:
// input_summary: this.summarizeInput(toolName, toolInput),
// TO:
input_summary: "", // Deferred to persistTurn
_rawInput: toolInput, // Temporary: used during persistTurn summarization
```

- [ ] **Step 2: Summarize in bulk inside persistTurn**

Before the `bulkCreate` call in `persistTurn`, iterate the buffered calls and summarize:

```typescript
// In persistTurn, before bulkCreate:
for (const record of buffered) {
  if (!record.input_summary && record._rawInput) {
    record.input_summary = this.summarizeInput(record.tool_name, record._rawInput);
    delete record._rawInput;
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p apps/server/tsconfig.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/services/agent-service.ts
git commit -m "perf: defer input summarization from event handler to persistence phase"
```
