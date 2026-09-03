import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@mcode/contracts";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import { useQueuedMessageDispatch } from "@/features/conversation/composer/queue/useQueuedMessageDispatch";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useQueueStore } from "@/stores/queueStore";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { ComposerQueueList } from "../ComposerQueueList";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "composer-queue-lifecycle-thread";

function queueMessage(content: string): void {
  useQueueStore.getState().enqueue(THREAD_ID, {
    content,
    displayContent: content,
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
  });
}

function QueueControls() {
  const isAgentRunning = useThreadStore((state) => state.runningThreadIds.has(THREAD_ID));
  const { resumeNext } = useQueuedMessageDispatch(THREAD_ID);
  return (
    <ComposerQueueList
      threadId={THREAD_ID}
      isAgentRunning={isAgentRunning}
      onLoadIntoComposer={() => undefined}
      onResume={() => void resumeNext()}
    />
  );
}

describe("ComposerQueueList lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("shows the remaining FIFO item after a successful completion drain", async () => {
    vi.useFakeTimers();
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    useThreadStore.setState({ runningThreadIds: new Set([THREAD_ID]) });
    render(<QueueControls />);

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "first queued follow-up" }),
    );
    expect(screen.queryByText("first queued follow-up")).not.toBeInTheDocument();
    expect(screen.getByText("second queued follow-up")).toBeInTheDocument();
  });

  it("keeps the queue visible and paused after a manual stop", async () => {
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
    render(<QueueControls />);

    await act(async () => {
      await useThreadStore.getState().stopAgent(THREAD_ID);
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText("first queued follow-up")).toBeInTheDocument();
    expect(screen.getByText("second queued follow-up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send next queued message" })).toBeInTheDocument();
  });

  it("reveals Continue after the prior queued dispatch lease settles", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    queueMessage("third queued follow-up");
    const first = useQueueStore.getState().claimNextQueuedMessage(THREAD_ID)!;
    render(<QueueControls />);

    expect(screen.getByText("second queued follow-up")).toBeInTheDocument();
    expect(screen.getByText("third queued follow-up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send next queued message" })).not.toBeInTheDocument();

    act(() => {
      useQueueStore.getState().settleQueuedDispatch(THREAD_ID, first.id, true);
    });
    await userEvent.click(screen.getByRole("button", { name: "Send next queued message" }));

    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "second queued follow-up" }),
    );
    expect(screen.getByText("third queued follow-up")).toBeInTheDocument();
  });

  it("sends one item when the user selects Continue", async () => {
    queueMessage("first queued follow-up");
    queueMessage("second queued follow-up");
    render(<QueueControls />);

    await userEvent.click(screen.getByRole("button", { name: "Send next queued message" }));

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockTransport.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, content: "first queued follow-up" }),
    );
    expect(screen.getByText("second queued follow-up")).toBeInTheDocument();
  });
});
