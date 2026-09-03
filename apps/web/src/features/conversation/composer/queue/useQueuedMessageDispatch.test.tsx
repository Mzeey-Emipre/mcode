import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentStopResult } from "@mcode/contracts";
import { useQueueStore } from "@/stores/queueStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import { useQueuedMessageDispatch } from "./useQueuedMessageDispatch";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "queued-message-dispatch-thread";

function queueMessage(content: string): void {
  useQueueStore.getState().enqueue(THREAD_ID, {
    content,
    displayContent: content,
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
  });
}

describe("useQueuedMessageDispatch", () => {
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

  it("keeps the final queued message when Continue cannot start it", async () => {
    useQueueStore.getState().enqueue(THREAD_ID, {
      content: "final queued follow-up",
      displayContent: "final queued follow-up",
      attachments: [],
      model: "claude-sonnet-4-6",
      permissionMode: "full",
      browserCaptureSpillPaths: ["browser-capture-spill/workspace/capture.json"],
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("transport unavailable"),
    );
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.resumeNext();
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(useQueueStore.getState().queues[THREAD_ID]).toEqual([
      expect.objectContaining({
        content: "final queued follow-up",
        browserCaptureSpillPaths: ["browser-capture-spill/workspace/capture.json"],
      }),
    ]);
  });

  it("sends one queued message when the user continues", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await result.current.resumeNext();
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "first queued follow-up" }),
    );
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "second queued follow-up",
    ]);
  });

  it("sends only one message when Continue is selected twice before transport acceptance", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    let resolveSend!: () => void;
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSend = resolve; }),
    );
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    const first = result.current.resumeNext();
    const second = result.current.resumeNext();
    resolveSend();
    await act(async () => {
      await Promise.all([first, second]);
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "second queued follow-up",
    ]);
  });

  it("does not let Send now claim past an in-flight lease", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    const second = useQueueStore.getState().queues[THREAD_ID]![1];
    let resolveSend!: () => void;
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSend = resolve; }),
    );
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    const first = result.current.resumeNext();
    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await act(async () => {
      await result.current.sendNow(second);
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    resolveSend();
    await first;
  });

  it("clears Stop suppression only when Continue sends the next queued message", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      snapshot: { threadId: THREAD_ID, turnExecutionId: "execution-1", phase: "cancelled" },
      status: "cancelled",
      dispatchState: "dispatched",
    });
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    await act(async () => {
      await useThreadStore.getState().stopAgent(THREAD_ID);
    });
    expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(THREAD_ID)).toBe(true);

    await act(async () => {
      await result.current.resumeNext();
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content)).toEqual([
      "second queued follow-up",
    ]);
    expect(useQueueStore.getState().autoDrainSuppressedThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("does not let Continue outrun a pending Stop", async () => {
    queueMessage("first queued follow-up");
    let resolveStop!: (result: AgentStopResult) => void;
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolveStop = resolve; }),
    );
    useThreadStore.setState({
      records: new Map<string, ThreadRecord>([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: "execution-1",
      }]]),
      runningThreadIds: new Set([THREAD_ID]),
    });
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    const stopping = useThreadStore.getState().stopAgent(THREAD_ID);
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
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);

    await act(async () => {
      await result.current.resumeNext();
    });

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    resolveStop({
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      snapshot: { threadId: THREAD_ID, turnExecutionId: "execution-1", phase: "cancelled" },
      status: "cancelled",
      dispatchState: "dispatched",
    });
    await stopping;

    await act(async () => {
      await result.current.resumeNext();
    });
    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps Continue blocked until concurrent Stop calls both settle", async () => {
    queueMessage("first queued follow-up");
    let resolveFirst!: (result: AgentStopResult) => void;
    let resolveSecond!: (result: AgentStopResult) => void;
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    useThreadStore.setState({
      records: new Map<string, ThreadRecord>([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: "execution-1",
      }]]),
      runningThreadIds: new Set([THREAD_ID]),
    });
    const { result } = renderHook(() => useQueuedMessageDispatch(THREAD_ID));

    const firstStop = useThreadStore.getState().stopAgent(THREAD_ID);
    const secondStop = useThreadStore.getState().stopAgent(THREAD_ID);
    resolveFirst({
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      snapshot: { threadId: THREAD_ID, turnExecutionId: "execution-1", phase: "cancelled" },
      status: "cancelled",
      dispatchState: "dispatched",
    });
    await firstStop;

    await act(async () => {
      await result.current.resumeNext();
    });
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();

    resolveSecond({
      threadId: THREAD_ID,
      turnExecutionId: "execution-1",
      snapshot: { threadId: THREAD_ID, turnExecutionId: "execution-1", phase: "cancelled" },
      status: "cancelled",
      dispatchState: "dispatched",
    });
    await secondStop;

    await act(async () => {
      await result.current.resumeNext();
    });
    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
  });
});
