import type { AgentEvent, AgentStopResult } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueueStore } from "@/stores/queueStore";
import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread, mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

vi.mock("@/features/preview/capture/browser-capture-spill", () => ({
  releaseBrowserCaptureSpills: vi.fn(),
}));

const THREAD_ID = "reconnect-queue-thread";

function queueMessage(content: string, browserCaptureSpillPaths?: string[]): boolean {
  return useQueueStore.getState().enqueue(THREAD_ID, {
    content,
    displayContent: content,
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
    browserCaptureSpillPaths,
  });
}

describe("threadStore reconnect and queued follow-ups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadStoreForTests({ currentThreadId: THREAD_ID });
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      disposedQueuedMessages: {},
      queueGenerations: {},
      autoDrainSuppressedThreadIds: new Set<string>(),
      toast: null,
      editingThreadId: null,
    });
    useWorkspaceStore.setState({
      activeThreadId: THREAD_ID,
      threads: [createMockThread({ id: THREAD_ID })],
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears stale streaming state when running-thread hydration reconciles an empty server snapshot", () => {
    resetThreadStoreForTests({
      currentThreadId: THREAD_ID,
      runningThreadIds: new Set([THREAD_ID]),
      records: new Map<string, ThreadRecord>([
        [
          THREAD_ID,
          {
            ...createEmptyThreadRecord(),
            streaming: "stale response",
            streamingPreview: "stale response",
            currentTurnMessageId: "stale-assistant",
            currentTurnResponseKey: "stale-key",
            thoughtSegments: [{ text: "stale narration", startedAt: 1 }],
          },
        ],
      ]),
    });

    useThreadStore.getState().hydrateRunningThreads([]);

    const state = useThreadStore.getState();
    const record = state.records.get(THREAD_ID)!;
    expect(state.runningThreadIds).toEqual(new Set());
    expect(record).toMatchObject({
      streaming: "",
      streamingPreview: "",
      currentTurnMessageId: "",
      currentTurnResponseKey: "",
      thoughtSegments: [],
    });
  });

  it("releases only the first queued follow-up after turn completion, without an early duplicate optimistic bubble", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });

    const complete = {
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent;
    useThreadStore.getState().handleAgentEvent(complete);
    useThreadStore.getState().handleAgentEvent(complete);

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(useThreadStore.getState().records.get(THREAD_ID)?.messages).toEqual([]);
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "first queued follow-up",
      "second queued follow-up",
    ]);

    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "first queued follow-up" }),
    );
    expect(useThreadStore.getState().records.get(THREAD_ID)?.messages).toHaveLength(1);
    expect(useThreadStore.getState().records.get(THREAD_ID)?.messages[0]).toMatchObject({
      role: "user",
      content: "first queued follow-up",
    });
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "second queued follow-up",
    ]);

    useThreadStore.getState().handleAgentEvent(complete);
    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockTransport.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "second queued follow-up" }),
    );
    expect(useQueueStore.getState().queues[THREAD_ID]).toEqual([]);
  });

  it("drains after completion persistence arrives before the matching turnComplete event", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    useThreadStore.setState({
      records: new Map<string, ThreadRecord>([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: "execution-1",
      }]]),
      runningThreadIds: new Set([THREAD_ID]),
    });

    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      messageId: "assistant-1",
      toolCallCount: 0,
      filesChanged: [],
      outcome: "completed",
      executionId: "execution-1",
    });
    useThreadStore.getState().applyThreadRuntimeSnapshot({
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      phase: "completed",
    });
    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);

    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "first queued follow-up" }),
    );
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "second queued follow-up",
    ]);
  });

  it("keeps completed persistence queued until its matching turnComplete arrives", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    useThreadStore.setState({
      records: new Map<string, ThreadRecord>([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: "execution-1",
      }]]),
      runningThreadIds: new Set([THREAD_ID]),
    });

    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      messageId: "assistant-1",
      toolCallCount: 0,
      filesChanged: [],
      outcome: "completed",
      executionId: "execution-1",
    });
    await vi.advanceTimersByTimeAsync(401);

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "first queued follow-up",
    ]);
  });

  it.each(["max_turns", "error_max_budget_usd"] as const)(
    "does not start a queued send before delayed %s guardrail completion arrives",
    async (reason) => {
      vi.useFakeTimers();
      queueMessage("first queued follow-up");
      useThreadStore.setState({
        records: new Map<string, ThreadRecord>([[THREAD_ID, {
          ...createEmptyThreadRecord(),
          runtimePhase: "running",
          turnExecutionId: "execution-1",
        }]]),
        runningThreadIds: new Set([THREAD_ID]),
      });

      useThreadStore.getState().handleTurnPersisted({
        threadId: THREAD_ID,
        messageId: "assistant-1",
        toolCallCount: 0,
        filesChanged: [],
        outcome: "completed",
        executionId: "execution-1",
      });
      await vi.advanceTimersByTimeAsync(401);
      useThreadStore.getState().handleAgentEvent({
        type: "turnComplete",
        threadId: THREAD_ID,
        turnExecutionId: "execution-1",
        reason,
        costUsd: null,
        tokensIn: 0,
        tokensOut: 0,
      } satisfies AgentEvent);

      expect(mockTransport.sendMessage).not.toHaveBeenCalled();
      expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(THREAD_ID)).toBe(true);
    },
  );

  it("does not drain after a stale completion event", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    useThreadStore.setState({
      records: new Map<string, ThreadRecord>([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: "execution-1",
      }]]),
      runningThreadIds: new Set([THREAD_ID]),
    });

    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      messageId: "assistant-1",
      toolCallCount: 0,
      filesChanged: [],
      outcome: "completed",
      executionId: "execution-1",
    });
    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      turnExecutionId: "stale-execution",
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await vi.advanceTimersByTimeAsync(401);

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
  });

  it("does not dispatch a leased message twice when a terminal event arrives before transport acceptance", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    let resolveSend!: (result: number) => void;
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<number>((resolve) => { resolveSend = resolve; }),
    );
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await vi.advanceTimersByTimeAsync(400);
    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(useQueueStore.getState().inFlightQueuedMessages[THREAD_ID]?.message.content).toBe(
      "first queued follow-up",
    );

    resolveSend(1);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("transfers capture spill ownership to an accepted queued turn", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up", ["browser-capture-spill/accepted.json"]);
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await vi.advanceTimersByTimeAsync(400);

    expect(useQueueStore.getState().inFlightQueuedMessages[THREAD_ID]).toBeUndefined();
    expect(useQueueStore.getState().queues[THREAD_ID]).toEqual([]);
    expect(releaseBrowserCaptureSpills).not.toHaveBeenCalled();
  });

  it("keeps the failed queued follow-up first and paused after completion drain cannot start it", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("transport unavailable"),
    );

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    });

    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "first queued follow-up",
      "second queued follow-up",
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps queued follow-ups paused after a manual stop", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      threadId: THREAD_ID,
      turnExecutionId: "turn-1",
      snapshot: { threadId: THREAD_ID, turnExecutionId: "turn-1", phase: "cancelled" },
      status: "cancelled",
      dispatchState: "dispatched",
    });

    await useThreadStore.getState().stopAgent(THREAD_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "first queued follow-up",
      "second queued follow-up",
    ]);
  });

  it.each(["max_turns", "error_max_budget_usd"] as const)(
    "keeps the queue paused when %s arrives after completion persistence",
    async (reason) => {
      vi.useFakeTimers();
      queueMessage("first queued follow-up");
      useThreadStore.setState({
        records: new Map<string, ThreadRecord>([[THREAD_ID, {
          ...createEmptyThreadRecord(),
          runtimePhase: "running",
          turnExecutionId: "execution-1",
        }]]),
        runningThreadIds: new Set([THREAD_ID]),
      });

      useThreadStore.getState().handleTurnPersisted({
        threadId: THREAD_ID,
        messageId: "assistant-1",
        toolCallCount: 0,
        filesChanged: [],
        outcome: "completed",
        executionId: "execution-1",
      });
      useThreadStore.getState().handleAgentEvent({
        type: "turnComplete",
        threadId: THREAD_ID,
        turnExecutionId: "execution-1",
        reason,
        costUsd: null,
        tokensIn: 0,
        tokensOut: 0,
      } satisfies AgentEvent);
      await vi.advanceTimersByTimeAsync(400);

      expect(mockTransport.sendMessage).not.toHaveBeenCalled();
      expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
        "first queued follow-up",
      ]);
      expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(THREAD_ID)).toBe(true);
    },
  );

  it("does not auto-drain when completion persists while Stop is still pending", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    let resolveStop!: (result: AgentStopResult) => void;
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<AgentStopResult>((resolve) => { resolveStop = resolve; }),
    );
    useThreadStore.setState({
      records: new Map<string, ThreadRecord>([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: "execution-1",
      }]]),
      runningThreadIds: new Set([THREAD_ID]),
    });

    const stopping = useThreadStore.getState().stopAgent(THREAD_ID);
    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      messageId: "assistant-1",
      toolCallCount: 0,
      filesChanged: [],
      outcome: "completed",
      executionId: "execution-1",
    });
    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "first queued follow-up",
    ]);

    resolveStop({
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      snapshot: { threadId: THREAD_ID, turnExecutionId: "execution-1", phase: "cancelled" },
      status: "cancelled",
      dispatchState: "dispatched",
    });
    await stopping;
  });

  it("cancels a scheduled drain when a Stop snapshot arrives first", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      snapshot: { threadId: THREAD_ID, turnExecutionId: "execution-1", phase: "cancelled" },
      status: "cancelled",
      dispatchState: "dispatched",
    });

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await useThreadStore.getState().stopAgent(THREAD_ID);
    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "first queued follow-up",
    ]);
  });

  it("does not auto-drain after a late turnComplete while Stop is pending", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    let resolveStop!: (result: AgentStopResult) => void;
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<AgentStopResult>((resolve) => { resolveStop = resolve; }),
    );
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });

    const stopping = useThreadStore.getState().stopAgent(THREAD_ID);
    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await vi.advanceTimersByTimeAsync(400);

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "first queued follow-up",
    ]);

    resolveStop({
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      snapshot: { threadId: THREAD_ID, turnExecutionId: "execution-1", phase: "cancelled" },
      status: "cancelled",
      dispatchState: "dispatched",
    });
    await stopping;
  });

  it("keeps order and capacity when an in-flight queued send rejects", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    queueMessage("third queued follow-up");
    let rejectSend!: (reason?: unknown) => void;
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<never>((_resolve, reject) => { rejectSend = reject; }),
    );
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await vi.advanceTimersByTimeAsync(400);

    const third = useQueueStore.getState().queues[THREAD_ID]?.find(
      (message) => message.content === "third queued follow-up",
    );
    useQueueStore.getState().moveMessage(THREAD_ID, third!.id, 0);
    for (let index = 4; index <= 20; index += 1) {
      queueMessage(`queued follow-up ${index}`);
    }
    expect(queueMessage("overflow")).toBe(false);
    rejectSend(new Error("transport unavailable"));
    await vi.advanceTimersByTimeAsync(0);

    const queue = useQueueStore.getState().queues[THREAD_ID] ?? [];
    expect(queue).toHaveLength(20);
    expect(queue.map((message) => message.content)).toEqual([
      "first queued follow-up",
      "third queued follow-up",
      "second queued follow-up",
      ...Array.from({ length: 17 }, (_value, index) => `queued follow-up ${index + 4}`),
    ]);
    expect(useQueueStore.getState().inFlightQueuedMessages[THREAD_ID]).toBeUndefined();
  });

  it("does not recreate the queue when a failed send races Clear all", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up", ["browser-capture-spill/clear-all.json"]);
    let rejectSend!: (reason?: unknown) => void;
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<never>((_resolve, reject) => { rejectSend = reject; }),
    );
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await vi.advanceTimersByTimeAsync(400);
    useQueueStore.getState().clearQueue(THREAD_ID);
    expect(releaseBrowserCaptureSpills).not.toHaveBeenCalled();
    rejectSend(new Error("transport unavailable"));
    await vi.advanceTimersByTimeAsync(0);

    expect(useQueueStore.getState().queues[THREAD_ID]).toBeUndefined();
    expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(THREAD_ID)).toBe(false);
    expect(releaseBrowserCaptureSpills).toHaveBeenCalledWith(["browser-capture-spill/clear-all.json"]);
  });

  it("does not recreate a queue or suppression state after thread deletion races a failed send", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up", ["browser-capture-spill/thread-delete.json"]);
    let rejectSend!: (reason?: unknown) => void;
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<never>((_resolve, reject) => { rejectSend = reject; }),
    );
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await vi.advanceTimersByTimeAsync(400);
    useWorkspaceStore.getState().applyThreadDeleted(THREAD_ID);
    expect(releaseBrowserCaptureSpills).not.toHaveBeenCalled();
    rejectSend(new Error("transport unavailable"));
    await vi.advanceTimersByTimeAsync(0);

    expect(useQueueStore.getState().queues[THREAD_ID]).toBeUndefined();
    expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(THREAD_ID)).toBe(false);
    expect(releaseBrowserCaptureSpills).toHaveBeenCalledWith(["browser-capture-spill/thread-delete.json"]);
  });
});
