import type { AgentEvent } from "@mcode/contracts";
import {
  activateTestConversation,
  resetThreadStoreForTests,
  getTestActiveMessages,
  getTestActiveLatestTurnWithChanges,
  getTestThreadStreaming,
  getTestThreadToolCalls,
  getTestThreadError,
  getTestThreadMessages,
  getTestThreadHasMoreMessages,
  getTestThreadLoadEpoch,
  getTestThreadPlanQuestionsStatus,
  readActiveThreadField,
  hasTestThreadRecord,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useToastStore } from "@/stores/toastStore";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

/**
 * Tests that agent events from one thread do not leak into another thread's
 * UI state. Covers the cross-thread isolation contract for error state,
 * toast notifications, panel side-effects, and per-thread map cleanup.
 */
describe("Agent event thread isolation", () => {
  const THREAD_A = "thread-a";
  const THREAD_B = "thread-b";

  beforeEach(() => {
    vi.useFakeTimers();
    resetThreadStoreForTests({
      currentThreadId: THREAD_A,
      runningThreadIds: new Set([THREAD_A, THREAD_B]),
      records: new Map<string, ThreadRecord>([
        [THREAD_A, {
          ...createEmptyThreadRecord(),
          agentStartTime: Date.now(),
          runtimePhase: "running",
          turnExecutionId: "exec-a",
        }],
        [THREAD_B, {
          ...createEmptyThreadRecord(),
          agentStartTime: Date.now(),
          runtimePhase: "running",
          turnExecutionId: "exec-b",
        }],
      ]),
    });
    useWorkspaceStore.setState({
      activeThreadId: THREAD_A,
      threads: [
        createMockThread({ id: THREAD_A, workspace_id: "ws-1", title: "A", branch: "main" }),
        createMockThread({ id: THREAD_B, workspace_id: "ws-1", title: "B", branch: "feat" }),
      ],
    });
    useToastStore.setState({ toasts: [] });
    vi.clearAllMocks();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback): number => {
      queueMicrotask(() => {
        cb(0);
      });
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Error isolation ──────────────────────────────────────────────────

  describe("error isolation", () => {
    it("session.error for background thread does not set error on active thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      // Thread B errors while user views Thread A
      handleAgentEvent({ type: "error", threadId: THREAD_B, error: "Out of tokens" } as AgentEvent);

      // Thread B's error is recorded under its own key
      expect(getTestThreadError(THREAD_B)).toBe("Out of tokens");
      // Thread A has no error
      expect(getTestThreadError(THREAD_A)).toBeUndefined();
    });

    it("session.error for active thread sets error on that thread only", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "error", threadId: THREAD_A, error: "CLI not found" } as AgentEvent);

      expect(getTestThreadError(THREAD_A)).toBe("CLI not found");
      expect(getTestThreadError(THREAD_B)).toBeUndefined();
    });

    it("errors from two concurrent threads are tracked independently", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "error", threadId: THREAD_A, error: "Error A" } as AgentEvent);
      handleAgentEvent({ type: "error", threadId: THREAD_B, error: "Error B" } as AgentEvent);

      expect(getTestThreadError(THREAD_A)).toBe("Error A");
      expect(getTestThreadError(THREAD_B)).toBe("Error B");
    });

    it("loadMessages clears error for the loaded thread", async () => {
      resetThreadStoreForTests({
        records: new Map<string, ThreadRecord>([
          [THREAD_A, { ...createEmptyThreadRecord(), error: "stale error" }],
          [THREAD_B, { ...createEmptyThreadRecord(), error: "other error" }],
        ]),
      });
      (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        messages: [],
        hasMore: false,
      });

await activateTestConversation(THREAD_A);

      expect(getTestThreadError(THREAD_A)).toBeUndefined();
      // Thread B's error is preserved
      expect(getTestThreadError(THREAD_B)).toBe("other error");
    });
  });

  // ── Toast isolation ──────────────────────────────────────────────────

  describe("modelFallback toast isolation", () => {
    it("does not show toast when modelFallback fires on a background thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "modelFallback", threadId: THREAD_B, requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001" } as AgentEvent);

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("shows toast when modelFallback fires on the active thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "modelFallback", threadId: THREAD_A, requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001" } as AgentEvent);

      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
  });

  describe("mcpServerStartupStatus toast isolation", () => {
    it("shows an error toast without changing the active thread state", () => {
      const beforeMessages = getTestThreadMessages(THREAD_A);
      const beforeRunningThreadIds = new Set(useThreadStore.getState().runningThreadIds);
      const beforeStatus = useWorkspaceStore.getState().threads.find((t) => t.id === THREAD_A)?.status;

      useThreadStore.getState().handleAgentEvent({
        type: "mcpServerStartupStatus",
        threadId: THREAD_A,
        providerId: "codex",
        serverThreadId: "server-thread-a",
        name: "filesystem",
        status: "failed",
        error: "Connection refused",
      } as AgentEvent);

      expect(useToastStore.getState().toasts).toMatchObject([{
        level: "error",
        title: "MCP server unavailable",
        message: "The turn will continue without it. filesystem: Connection refused",
      }]);
      expect(getTestThreadMessages(THREAD_A)).toEqual(beforeMessages);
      expect(readActiveThreadField((record) => record.runtimePhase)).toBe("running");
      expect(useThreadStore.getState().runningThreadIds).toEqual(beforeRunningThreadIds);
      expect(useWorkspaceStore.getState().threads.find((t) => t.id === THREAD_A)?.status).toBe(beforeStatus);
    });

    it.each([
      ["failureReason", { failureReason: "Server exited" }, "Server exited"],
      ["default reason", {}, "Startup failed"],
    ] as const)("uses the %s when error is absent", (_label, details, reason) => {
      useThreadStore.getState().handleAgentEvent({
        type: "mcpServerStartupStatus",
        threadId: THREAD_A,
        providerId: "codex",
        serverThreadId: "server-thread-a",
        name: "filesystem",
        status: "failed",
        ...details,
      } as AgentEvent);

      expect(useToastStore.getState().toasts[0]).toMatchObject({
        level: "error",
        title: "MCP server unavailable",
        message: `The turn will continue without it. filesystem: ${reason}`,
      });
    });

    it("does not show a toast for a background thread failure", () => {
      const beforeMessages = getTestThreadMessages(THREAD_B);
      const beforeRunningThreadIds = new Set(useThreadStore.getState().runningThreadIds);
      const beforeStatus = useWorkspaceStore.getState().threads.find((t) => t.id === THREAD_B)?.status;

      useThreadStore.getState().handleAgentEvent({
        type: "mcpServerStartupStatus",
        threadId: THREAD_B,
        providerId: "codex",
        serverThreadId: "server-thread-b",
        name: "filesystem",
        status: "failed",
        failureReason: "Server exited",
      } as AgentEvent);

      expect(useToastStore.getState().toasts).toHaveLength(0);
      expect(getTestThreadMessages(THREAD_B)).toEqual(beforeMessages);
      expect(readActiveThreadField((record) => record.runtimePhase)).toBe("running");
      expect(useThreadStore.getState().runningThreadIds).toEqual(beforeRunningThreadIds);
      expect(useWorkspaceStore.getState().threads.find((t) => t.id === THREAD_B)?.status).toBe(beforeStatus);
    });

    it.each(["starting", "ready", "cancelled"] as const)("does not show a toast for %s status", (status) => {
      useThreadStore.getState().handleAgentEvent({
        type: "mcpServerStartupStatus",
        threadId: THREAD_A,
        providerId: "codex",
        serverThreadId: "server-thread-a",
        name: "filesystem",
        status,
      } as AgentEvent);

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });

  // ── TodoWrite panel isolation ────────────────────────────────────────

  describe("TodoWrite panel isolation", () => {
    it("does not open task panel when TodoWrite fires on a background thread", async () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "toolUse", threadId: THREAD_B, toolCallId: "tc-todo",
        toolName: "TodoWrite",
        toolInput: { todos: [{ id: "0", content: "Plan", status: "in_progress" }] } } as AgentEvent);

      // Give the dynamic import time to resolve
      if (vi.dynamicImportSettled) {
        await vi.dynamicImportSettled();
      } else {
        vi.advanceTimersByTime(0);
      }
      await Promise.resolve();

      const { useDiffStore } = await import("@/stores/diffStore");
      expect(useDiffStore.getState().getRightPanelVisible("ws-1", THREAD_A)).toBeFalsy();
    });

    it("does not auto-open task panel on TodoWrite", async () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "toolUse", threadId: THREAD_A, toolCallId: "tc-todo",
        toolName: "TodoWrite",
        toolInput: { todos: [{ id: "0", content: "Plan", status: "in_progress" }] } } as AgentEvent);

      await vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();

      const { useDiffStore } = await import("@/stores/diffStore");
      expect(useDiffStore.getState().getRightPanelVisible("ws-1", THREAD_A)).toBeFalsy();
    });
  });

  // ── Streaming isolation ──────────────────────────────────────────────

  describe("streaming text isolation", () => {
    it("textDelta for background thread does not appear in active thread's streaming", async () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "textDelta", threadId: THREAD_B, delta: "background text" } as AgentEvent);

      for (let i = 0; i < 8; i++) {
        await Promise.resolve();
      }
      expect(getTestThreadStreaming(THREAD_A)).toBeUndefined();
      expect(getTestThreadStreaming(THREAD_B)).toBe("background text");
    });

    it("turnComplete for background thread does not add message to active thread's messages", () => {
      resetThreadStoreForTests({
        records: new Map<string, ThreadRecord>([
          [THREAD_B, { ...createEmptyThreadRecord(), streaming: "background content" }],
        ]),
      });

      useThreadStore.getState().handleAgentEvent({ type: "turnComplete", threadId: THREAD_B, reason: "end_turn", costUsd: null,
        tokensIn: 100,
        tokensOut: 50 } as AgentEvent);
      vi.runAllTimers();

      // No message added to the visible list (user is on Thread A)
      expect(getTestActiveMessages()).toHaveLength(0);
      // Streaming state is cleaned up for Thread B
      expect(getTestThreadStreaming(THREAD_B)).toBeUndefined();
    });
  });

  // ── Compaction notice isolation ──────────────────────────────────────

  describe("compaction notice isolation", () => {
    it("appends background compaction notice to event thread, not selected thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "compacting", threadId: THREAD_B, active: true } as AgentEvent);
      handleAgentEvent({ type: "compacting", threadId: THREAD_B, active: false } as AgentEvent);

      expect(getTestThreadMessages(THREAD_B).map((message) => message.content)).toEqual([
        "Context compacted",
      ]);
      expect(getTestThreadMessages(THREAD_A)).toHaveLength(0);
    });

    it("appends background compaction notice when no thread is selected", () => {
      resetThreadStoreForTests({
        currentThreadId: null,
        runningThreadIds: new Set([THREAD_B]),
        records: new Map([[THREAD_B, createEmptyThreadRecord()]]),
      });
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "compacting", threadId: THREAD_B, active: true } as AgentEvent);
      handleAgentEvent({ type: "compacting", threadId: THREAD_B, active: false } as AgentEvent);

      expect(getTestThreadMessages(THREAD_B)).toHaveLength(1);
      expect(getTestThreadMessages(THREAD_B)[0]?.content).toBe("Context compacted");
    });

    it("sets hasMoreMessages when compaction notice evicts an older message", () => {
      const messages = Array.from({ length: 200 }, (_, index) => ({
        id: `message-${index}`,
        thread_id: THREAD_B,
        role: "user" as const,
        content: `message ${index}`,
        tool_calls: null,
        files_changed: null,
        cost_usd: null,
        tokens_used: null,
        timestamp: "",
        sequence: index + 1,
        attachments: null,
      }));
      resetThreadStoreForTests({
        currentThreadId: THREAD_A,
        records: new Map([
          [THREAD_A, createEmptyThreadRecord()],
          [THREAD_B, { ...createEmptyThreadRecord(), messages }],
        ]),
      });
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "compacting", threadId: THREAD_B, active: true } as AgentEvent);
      handleAgentEvent({ type: "compacting", threadId: THREAD_B, active: false } as AgentEvent);

      expect(getTestThreadMessages(THREAD_B)).toHaveLength(200);
      expect(getTestThreadMessages(THREAD_B)[0]?.id).toBe("message-1");
      expect(getTestThreadMessages(THREAD_B).at(-1)?.content).toBe("Context compacted");
      expect(getTestThreadHasMoreMessages(THREAD_B)).toBe(true);
      expect(getTestThreadMessages(THREAD_A)).toHaveLength(0);
    });
  });

  // ── Tool call isolation ──────────────────────────────────────────────

  describe("tool call isolation", () => {
    it("toolUse for background thread does not contaminate active thread's tool calls", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent({ type: "toolUse", threadId: THREAD_B, toolCallId: "tc-bg",
        toolName: "Read",
        toolInput: { path: "/bg" } } as AgentEvent);

      expect(getTestThreadToolCalls(THREAD_A)).toEqual([]);
      expect(getTestThreadToolCalls(THREAD_B)).toHaveLength(1);
    });
  });

  // ── Per-thread map cleanup on deletion ─────────────────────────────

  describe("recapByThread", () => {
    it("starts empty for a fresh store baseline", () => {
      resetThreadStoreForTests();

      expect(useThreadStore.getState().recapByThread).toEqual({});
    });

    it("records manual generation without an automatic marker", () => {
      useThreadStore.getState().recordThreadRecapGeneration({
        threadId: THREAD_A,
        text: "Fix the checkout flow",
        signature: "sig-a",
        coveredMessageId: "msg-a",
        generatedAt: "2026-06-25T10:00:00.000Z",
        source: "manual",
      });

      expect(useThreadStore.getState().recapByThread[THREAD_A]).toEqual({
        text: "Fix the checkout flow",
        signature: "sig-a",
        coveredMessageId: "msg-a",
        generatedAt: "2026-06-25T10:00:00.000Z",
      });
    });

    it("records automatic generation and updates the automatic marker", () => {
      useThreadStore.getState().recordThreadRecapGeneration({
        threadId: THREAD_A,
        text: "Investigate startup health",
        signature: "sig-auto",
        coveredMessageId: "msg-auto",
        generatedAt: "2026-06-25T10:05:00.000Z",
        source: "automatic",
      });

      expect(useThreadStore.getState().recapByThread[THREAD_A]).toEqual({
        text: "Investigate startup health",
        signature: "sig-auto",
        coveredMessageId: "msg-auto",
        generatedAt: "2026-06-25T10:05:00.000Z",
        lastAutoGeneratedAt: "2026-06-25T10:05:00.000Z",
      });
    });

    it("preserves the automatic marker when manual generation follows automatic generation", () => {
      useThreadStore.getState().recordThreadRecapGeneration({
        threadId: THREAD_A,
        text: "Investigate startup health",
        signature: "sig-auto",
        coveredMessageId: "msg-auto",
        generatedAt: "2026-06-25T10:05:00.000Z",
        source: "automatic",
      });

      useThreadStore.getState().recordThreadRecapGeneration({
        threadId: THREAD_A,
        text: "Refine the startup health check",
        signature: "sig-manual",
        coveredMessageId: "msg-manual",
        generatedAt: "2026-06-25T10:08:00.000Z",
        source: "manual",
      });

      expect(useThreadStore.getState().recapByThread[THREAD_A]).toEqual({
        text: "Refine the startup health check",
        signature: "sig-manual",
        coveredMessageId: "msg-manual",
        generatedAt: "2026-06-25T10:08:00.000Z",
        lastAutoGeneratedAt: "2026-06-25T10:05:00.000Z",
      });
    });
  });

  describe("clearThreadState", () => {
    it("removes all per-thread map entries for a background thread", () => {
      resetThreadStoreForTests({
        currentThreadId: null,
        runningThreadIds: new Set([THREAD_A, THREAD_B]),
        records: new Map<string, ThreadRecord>([
          [
            THREAD_A,
            {
              ...createEmptyThreadRecord(),
              runtimePhase: "running",
              turnExecutionId: "exec-a",
              error: "kept",
              streaming: "kept-stream",
              loadEpoch: 1,
              planQuestionsStatus: "idle",
            },
          ],
          [
            THREAD_B,
            {
              ...createEmptyThreadRecord(),
              runtimePhase: "running",
              turnExecutionId: "exec-b",
              error: "zombie",
              streaming: "zombie-stream",
              loadEpoch: 99,
              planQuestionsStatus: "pending",
            },
          ],
        ]),
      });
      useThreadStore.setState({
        recapByThread: {
          [THREAD_A]: {
            text: "kept recap",
            signature: "sig-a",
            coveredMessageId: "msg-a",
            generatedAt: "2026-06-25T10:00:00.000Z",
          },
          [THREAD_B]: {
            text: "zombie recap",
            signature: "sig-b",
            coveredMessageId: "msg-b",
            generatedAt: "2026-06-25T10:01:00.000Z",
          },
        },
      });

      useThreadStore.getState().clearThreadState(THREAD_B);

      expect(hasTestThreadRecord(THREAD_B)).toBe(false);
      expect(useThreadStore.getState().recapByThread[THREAD_B]).toBeUndefined();
      expect(useThreadStore.getState().recapByThread[THREAD_A]?.text).toBe("kept recap");
      expect(getTestThreadError(THREAD_A)).toBe("kept");
      expect(getTestThreadStreaming(THREAD_A)).toBe("kept-stream");
      expect(getTestThreadLoadEpoch(THREAD_A)).toBe(1);
      expect(getTestThreadPlanQuestionsStatus(THREAD_A)).toBe("idle");
    });

    it("removes threadId from runningThreadIds", () => {
      useThreadStore.setState({
        runningThreadIds: new Set([THREAD_A, THREAD_B]),
      });

      useThreadStore.getState().clearThreadState(THREAD_B);

      const state = useThreadStore.getState();
      expect(state.runningThreadIds.has(THREAD_B)).toBe(false);
      expect(state.runningThreadIds.has(THREAD_A)).toBe(true);
    });

    it("clears visible-thread globals when deleting the current thread", () => {
      resetThreadStoreForTests({
        currentThreadId: THREAD_A,
        records: new Map<string, ThreadRecord>([
          [
            THREAD_A,
            {
              ...createEmptyThreadRecord(),
              messages: [{ id: "m1", thread_id: THREAD_A, role: "user", content: "hi", tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: "", sequence: 1, attachments: null }],
              persistedToolCallCounts: { m1: 2 },
              persistedFilesChanged: { m1: ["foo.ts"] },
              serverMessageIds: { m1: "server-m1" },
              latestTurnWithChanges: "m1",
            },
          ],
        ]),
      });

      useThreadStore.getState().clearThreadState(THREAD_A);

      const state = useThreadStore.getState();
      expect(state.currentThreadId).toBeNull();
      expect(getTestActiveMessages()).toHaveLength(0);
      expect(readActiveThreadField((r) => r.persistedToolCallCounts) ?? {}).toEqual({});
      expect(readActiveThreadField((r) => r.persistedFilesChanged) ?? {}).toEqual({});
      expect(readActiveThreadField((r) => r.serverMessageIds) ?? {}).toEqual({});
      expect(getTestActiveLatestTurnWithChanges()).toBeNull();
    });

    it("removes listed recap entries in one batch and preserves unlisted entries", () => {
      resetThreadStoreForTests({
        currentThreadId: null,
        runningThreadIds: new Set([THREAD_A, THREAD_B, "thread-c"]),
        records: new Map<string, ThreadRecord>([
          [THREAD_A, createEmptyThreadRecord()],
          [THREAD_B, createEmptyThreadRecord()],
          ["thread-c", createEmptyThreadRecord()],
        ]),
      });
      useThreadStore.setState({
        recapByThread: {
          [THREAD_A]: {
            text: "delete A",
            signature: "sig-a",
            coveredMessageId: "msg-a",
            generatedAt: "2026-06-25T10:00:00.000Z",
          },
          [THREAD_B]: {
            text: "delete B",
            signature: "sig-b",
            coveredMessageId: "msg-b",
            generatedAt: "2026-06-25T10:01:00.000Z",
          },
          "thread-c": {
            text: "keep C",
            signature: "sig-c",
            coveredMessageId: "msg-c",
            generatedAt: "2026-06-25T10:02:00.000Z",
          },
        },
      });

      useThreadStore.getState().clearThreadStateMany([THREAD_A, THREAD_B]);

      expect(useThreadStore.getState().recapByThread).toEqual({
        "thread-c": {
          text: "keep C",
          signature: "sig-c",
          coveredMessageId: "msg-c",
          generatedAt: "2026-06-25T10:02:00.000Z",
        },
      });
    });

    it("does not clear visible-thread globals when deleting a background thread", () => {
      resetThreadStoreForTests({
        currentThreadId: THREAD_A,
        records: new Map<string, ThreadRecord>([
          [
            THREAD_A,
            {
              ...createEmptyThreadRecord(),
              messages: [{ id: "m1", thread_id: THREAD_A, role: "user", content: "hi", tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: "", sequence: 1, attachments: null }],
              persistedToolCallCounts: { m1: 2 },
            },
          ],
        ]),
      });

      useThreadStore.getState().clearThreadState(THREAD_B);

      const state = useThreadStore.getState();
      expect(state.currentThreadId).toBe(THREAD_A);
      expect(getTestActiveMessages()).toHaveLength(1);
      expect(readActiveThreadField((r) => r.persistedToolCallCounts) ?? {}).toEqual({ m1: 2 });
    });
  });
});
