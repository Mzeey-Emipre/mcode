import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useToastStore } from "@/stores/toastStore";

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
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set([THREAD_A, THREAD_B]),
      loading: false,
      errorByThread: {},
      streamingByThread: {},
      streamingPreviewByThread: {},
      toolCallsByThread: {},
      agentStartTimes: {
        [THREAD_A]: Date.now(),
        [THREAD_B]: Date.now(),
      },
      currentThreadId: THREAD_A,
      activeSubagentsByThread: {},
      currentTurnMessageIdByThread: {},
      isCompactingByThread: {},
      lastFallbackByThread: {},
      contextByThread: {},
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Error isolation ──────────────────────────────────────────────────

  describe("error isolation", () => {
    it("session.error for background thread does not set error on active thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      // Thread B errors while user views Thread A
      handleAgentEvent(THREAD_B, {
        method: "session.error",
        error: "Out of tokens",
      });

      const state = useThreadStore.getState();
      // Thread B's error is recorded under its own key
      expect(state.errorByThread[THREAD_B]).toBe("Out of tokens");
      // Thread A has no error
      expect(state.errorByThread[THREAD_A]).toBeUndefined();
    });

    it("session.error for active thread sets error on that thread only", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_A, {
        method: "session.error",
        error: "CLI not found",
      });

      const state = useThreadStore.getState();
      expect(state.errorByThread[THREAD_A]).toBe("CLI not found");
      expect(state.errorByThread[THREAD_B]).toBeUndefined();
    });

    it("errors from two concurrent threads are tracked independently", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_A, {
        method: "session.error",
        error: "Error A",
      });
      handleAgentEvent(THREAD_B, {
        method: "session.error",
        error: "Error B",
      });

      const state = useThreadStore.getState();
      expect(state.errorByThread[THREAD_A]).toBe("Error A");
      expect(state.errorByThread[THREAD_B]).toBe("Error B");
    });

    it("loadMessages clears error for the loaded thread", async () => {
      useThreadStore.setState({
        errorByThread: { [THREAD_A]: "stale error", [THREAD_B]: "other error" },
      });
      (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        messages: [],
        hasMore: false,
      });

      await useThreadStore.getState().loadMessages(THREAD_A);

      const state = useThreadStore.getState();
      expect(state.errorByThread[THREAD_A]).toBeUndefined();
      // Thread B's error is preserved
      expect(state.errorByThread[THREAD_B]).toBe("other error");
    });
  });

  // ── Toast isolation ──────────────────────────────────────────────────

  describe("modelFallback toast isolation", () => {
    it("does not show toast when modelFallback fires on a background thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_B, {
        method: "session.modelFallback",
        requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001",
      });

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("shows toast when modelFallback fires on the active thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_A, {
        method: "session.modelFallback",
        requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001",
      });

      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
  });

  // ── TodoWrite panel isolation ────────────────────────────────────────

  describe("TodoWrite panel isolation", () => {
    it("does not open task panel when TodoWrite fires on a background thread", async () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_B, {
        method: "session.toolUse",
        toolCallId: "tc-todo",
        toolName: "TodoWrite",
        toolInput: { todos: [{ id: "0", content: "Plan", status: "in_progress" }] },
      });

      // Give the dynamic import time to resolve
      if (vi.dynamicImportSettled) {
        await vi.dynamicImportSettled();
      } else {
        vi.advanceTimersByTime(0);
      }
      await Promise.resolve();

      const { useDiffStore } = await import("@/stores/diffStore");
      expect(useDiffStore.getState().rightPanelByThread[THREAD_A]?.visible).toBeFalsy();
    });

    it("opens task panel when TodoWrite fires on the active thread", async () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_A, {
        method: "session.toolUse",
        toolCallId: "tc-todo",
        toolName: "TodoWrite",
        toolInput: { todos: [{ id: "0", content: "Plan", status: "in_progress" }] },
      });

      // Give the dynamic import time to resolve
      await vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();

      const { useDiffStore } = await import("@/stores/diffStore");
      expect(useDiffStore.getState().rightPanelByThread[THREAD_A]?.visible).toBe(true);
    });

    it("does not open task panel if user switches threads before the import resolves", async () => {
      // Reset panel state from previous tests
      const { useDiffStore } = await import("@/stores/diffStore");
      useDiffStore.setState({ rightPanelByThread: {} });

      const { handleAgentEvent } = useThreadStore.getState();

      // TodoWrite fires on the active thread (A)
      handleAgentEvent(THREAD_A, {
        method: "session.toolUse",
        toolCallId: "tc-todo-race",
        toolName: "TodoWrite",
        toolInput: { todos: [{ id: "0", content: "Plan", status: "in_progress" }] },
      });

      // User switches to Thread B before the .then() microtask runs
      useWorkspaceStore.setState({ activeThreadId: THREAD_B });

      // Flush microtasks so the .then() callback executes
      await vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(useDiffStore.getState().rightPanelByThread[THREAD_A]?.visible).toBeFalsy();
    });
  });

  // ── Streaming isolation ──────────────────────────────────────────────

  describe("streaming text isolation", () => {
    it("textDelta for background thread does not appear in active thread's streaming", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_B, {
        method: "session.textDelta",
        delta: "background text",
      });

      const state = useThreadStore.getState();
      expect(state.streamingByThread[THREAD_A]).toBeUndefined();
      expect(state.streamingByThread[THREAD_B]).toBe("background text");
    });

    it("turnComplete for background thread does not add message to active thread's messages", () => {
      useThreadStore.setState({
        streamingByThread: { [THREAD_B]: "background content" },
      });

      useThreadStore.getState().handleAgentEvent(THREAD_B, {
        method: "session.turnComplete",
        costUsd: null,
        totalTokensIn: 100,
        totalTokensOut: 50,
      });
      vi.runAllTimers();

      const state = useThreadStore.getState();
      // No message added to the visible list (user is on Thread A)
      expect(state.messages).toHaveLength(0);
      // Streaming state is cleaned up for Thread B
      expect(state.streamingByThread[THREAD_B]).toBeUndefined();
    });
  });

  // ── Tool call isolation ──────────────────────────────────────────────

  describe("tool call isolation", () => {
    it("toolUse for background thread does not contaminate active thread's tool calls", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_B, {
        method: "session.toolUse",
        toolCallId: "tc-bg",
        toolName: "Read",
        toolInput: { path: "/bg" },
      });

      const state = useThreadStore.getState();
      expect(state.toolCallsByThread[THREAD_A]).toBeUndefined();
      expect(state.toolCallsByThread[THREAD_B]).toHaveLength(1);
    });
  });

  // ── Per-thread map cleanup on deletion ─────────────────────────────

  describe("clearThreadState", () => {
    /** All *ByThread Record maps that should be pruned when a thread is deleted. */
    const BY_THREAD_KEYS = [
      "errorByThread",
      "streamingByThread",
      "streamingPreviewByThread",
      "toolCallsByThread",
      "agentStartTimes",
      "settingsByThread",
      "activeSubagentsByThread",
      "currentTurnMessageIdByThread",
      "oldestLoadedSequence",
      "hasMoreMessages",
      "isLoadingMore",
      "loadEpochByThread",
      "contextByThread",
      "isCompactingByThread",
      "lastFallbackByThread",
      "planQuestionsByThread",
      "planAnswersByThread",
      "activeQuestionIndexByThread",
      "planQuestionsStatusByThread",
    ] as const;

    it("removes all per-thread map entries for a background thread", () => {
      // Seed every *ByThread map with a THREAD_B entry
      const seeds: Record<string, Record<string, unknown>> = {};
      for (const key of BY_THREAD_KEYS) {
        seeds[key] = { [THREAD_A]: "kept", [THREAD_B]: "zombie" };
      }
      useThreadStore.setState(seeds as Partial<ReturnType<typeof useThreadStore.getState>>);

      useThreadStore.getState().clearThreadState(THREAD_B);

      const state = useThreadStore.getState();
      for (const key of BY_THREAD_KEYS) {
        const map = state[key] as Record<string, unknown>;
        expect(map[THREAD_B], `${key} should not contain deleted thread`).toBeUndefined();
        expect(map[THREAD_A], `${key} should preserve other threads`).toBe("kept");
      }
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
      useThreadStore.setState({
        currentThreadId: THREAD_A,
        messages: [{ id: "m1", thread_id: THREAD_A, role: "user", content: "hi", tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: "", sequence: 1, attachments: null }],
        persistedToolCallCounts: { m1: 2 },
        persistedFilesChanged: { m1: ["foo.ts"] },
        serverMessageIds: { m1: "server-m1" },
        latestTurnWithChanges: "m1",
      });

      useThreadStore.getState().clearThreadState(THREAD_A);

      const state = useThreadStore.getState();
      expect(state.currentThreadId).toBeNull();
      expect(state.messages).toHaveLength(0);
      expect(state.persistedToolCallCounts).toEqual({});
      expect(state.persistedFilesChanged).toEqual({});
      expect(state.serverMessageIds).toEqual({});
      expect(state.latestTurnWithChanges).toBeNull();
    });

    it("does not clear visible-thread globals when deleting a background thread", () => {
      useThreadStore.setState({
        currentThreadId: THREAD_A,
        messages: [{ id: "m1", thread_id: THREAD_A, role: "user", content: "hi", tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: "", sequence: 1, attachments: null }],
        persistedToolCallCounts: { m1: 2 },
      });

      useThreadStore.getState().clearThreadState(THREAD_B);

      const state = useThreadStore.getState();
      expect(state.currentThreadId).toBe(THREAD_A);
      expect(state.messages).toHaveLength(1);
      expect(state.persistedToolCallCounts).toEqual({ m1: 2 });
    });
  });
});
