import type { AgentEvent } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueueStore } from "@/stores/queueStore";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread, mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "reconnect-queue-thread";

function queueMessage(content: string): void {
  useQueueStore.getState().enqueue(THREAD_ID, {
    content,
    displayContent: content,
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
  });
}

describe("threadStore reconnect and queued follow-ups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadStoreForTests({ currentThreadId: THREAD_ID });
    useQueueStore.setState({ queues: {}, toast: null, editingThreadId: null });
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
});
