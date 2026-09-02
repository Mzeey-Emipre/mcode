import {
  activateTestConversation,
  resetThreadStoreForTests,
  getTestActiveMessages,
  getTestThreadMessages,
  getTestThreadStreaming,
  getTestThreadStreamingPreview,
  getTestThreadThoughtSegments,
  getTestThreadError,
  readActiveThreadField,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockMessage } from "./mocks/transport";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import type { AgentEvent, PreviewAnnotationBundle, SelectedTextComment } from "@mcode/contracts";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

function makePreviewAnnotationBundle(): PreviewAnnotationBundle {
  const capture = {
    schemaVersion: 2 as const,
    pageUrl: "https://www.google.com/",
    pageTitle: "Google",
    capturedAt: "2026-07-02T00:00:00.000Z",
    captureKind: "element" as const,
    selectorHint: "html",
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    layoutViewport: { width: 1280, height: 720 },
  };

  return {
    schemaVersion: 1,
    annotations: [
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        displayNumber: 1,
        pageIdentity: "https://www.google.com/",
        pageContext: capture,
        targetContext: {
          label: "html",
          selectorHint: "html",
          bounds: { x: 0, y: 0, width: 1280, height: 720 },
        },
        note: "Move the header down.",
        snapshot: {
          id: "annotation-shot-1",
          name: "preview.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          sourcePath: "C:/tmp/annotation-shot-1.png",
          capture,
        },
      },
    ],
  };
}

function makeSelectedTextComment(): SelectedTextComment {
  return {
    id: "550e8400-e29b-41d4-a716-446655440003",
    displayNumber: 1,
    source: {
      threadId: "thread-1",
      messageId: "assistant-1",
      sourceRole: "assistant",
      start: 5,
      end: 12,
      quote: "selected",
    },
    note: "Explain this choice.",
    mentions: [],
  };
}

function makeSelectedTextComments(): SelectedTextComment[] {
  const first = makeSelectedTextComment();
  return [
    first,
    {
      ...first,
      id: "550e8400-e29b-41d4-a716-446655440004",
      displayNumber: 2,
      source: {
        ...first.source,
        messageId: "assistant-2",
        start: 0,
        end: 4,
        quote: "next",
      },
      note: "Explain this next choice.",
    },
  ];
}

describe("Thread Lifecycle Behavior", () => {
  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests();
    vi.clearAllMocks();
  });

  it("when the user sends a message, the thread is marked as running", async () => {
    const threadId = "thread-1";
    await useThreadStore.getState().sendMessage(threadId, "Hello");

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(true);
  });

  it("sends saved selected-text comments with a normal prompt after persistence acknowledges", async () => {
    const threadId = "thread-1";
    const comments = makeSelectedTextComments();
    resetThreadStoreForTests({ currentThreadId: threadId });

    const persisted = await useThreadStore.getState().sendMessage(
      threadId,
      "Please explain it.",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      comments,
    );

    expect(persisted).toBe(true);
    expect(mockTransport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: "Please explain it.",
      selectedTextComments: comments,
    }));
    expect(getTestThreadMessages(threadId)[0]?.selectedTextComments).toEqual(comments);
  });

  it("reports a rejected selected-text send so the Composer can retain its draft", async () => {
    const threadId = "thread-1";
    const comment = makeSelectedTextComment();
    resetThreadStoreForTests({ currentThreadId: threadId });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("connection lost"));

    const persisted = await useThreadStore.getState().sendMessage(
      threadId,
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [comment],
    );

    expect(persisted).toBe(false);
    expect(mockTransport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: "",
      selectedTextComments: [comment],
    }));
    expect(getTestThreadMessages(threadId)[0]?.selectedTextComments).toEqual([comment]);
  });

  it("shows saved annotation screenshots as optimistic image attachments", async () => {
    const threadId = "thread-1";
    const bundle = makePreviewAnnotationBundle();
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, createEmptyThreadRecord()],
      ]),
    });

    await useThreadStore.getState().sendMessage(
      threadId,
      "fix this",
      undefined,
      undefined,
      undefined,
      "fix this",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      bundle,
    );

    expect(getTestThreadMessages(threadId)[0]?.attachments).toEqual([
      {
        id: "annotation-shot-1",
        name: "Annotation 1 screenshot.png",
        mimeType: "image/png",
        sizeBytes: 2048,
      },
    ]);
  });

  it("when the user sends a follow-up, stale live turn text is cleared immediately", async () => {
    const threadId = "thread-1";
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [
          threadId,
          {
            ...createEmptyThreadRecord(),
            streaming: "Implemented logo wiring is in...",
            streamingPreview: "Implemented logo wiring is in...",
            currentTurnMessageId: "old-assistant",
            currentTurnResponseKey: "old-key",
            thoughtSegments: [{ text: "stale narration", startedAt: 1 }],
          },
        ],
      ]),
    });

    await useThreadStore.getState().sendMessage(threadId, "what happened?");

    expect(getTestThreadStreaming(threadId)).toBeUndefined();
    expect(getTestThreadStreamingPreview(threadId)).toBeUndefined();
    expect(readActiveThreadField((rec) => rec.currentTurnMessageId)).toBe("");
    expect(readActiveThreadField((rec) => rec.currentTurnResponseKey)).toMatch(
      /^turn-response:thread-1:/,
    );
    expect(getTestThreadThoughtSegments(threadId)).toEqual([]);
  });

  it("when a direct caller sends while running, no optimistic duplicate is appended", async () => {
    const threadId = "thread-1";
    const existing = createMockMessage({
      id: "user-1",
      thread_id: threadId,
      content: "first turn",
      sequence: 1,
    });
    resetThreadStoreForTests({
      currentThreadId: threadId,
      runningThreadIds: new Set([threadId]),
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          messages: [existing],
          runtimePhase: "running",
        }],
      ]),
    });

    await expect(
      useThreadStore.getState().sendMessage(threadId, "duplicate turn"),
    ).rejects.toThrow("already has an active agent session");

    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(true);
    expect(getTestThreadMessages(threadId)).toEqual([existing]);
  });

  it("when the server rejects an unknown active turn, the optimistic duplicate is removed", async () => {
    const threadId = "thread-1";
    const existing = createMockMessage({
      id: "user-1",
      thread_id: threadId,
      content: "first turn",
      sequence: 1,
    });
    resetThreadStoreForTests({
      currentThreadId: threadId,
      runningThreadIds: new Set(),
      records: new Map<string, ThreadRecord>([
        [threadId, { ...createEmptyThreadRecord(), messages: [existing] }],
      ]),
    });
    (
      mockTransport.sendMessage as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("Thread thread-1 already has an active agent session"));

    await useThreadStore.getState().sendMessage(threadId, "duplicate turn");

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(true);
    expect(getTestThreadMessages(threadId)).toEqual([existing]);
    expect(getTestThreadError(threadId)).toContain("already has an active agent session");
  });

  it("when the user stops an agent, the thread is no longer running", async () => {
    const threadId = "thread-1";
    useThreadStore.setState({
      runningThreadIds: new Set([threadId]),
    });

    await useThreadStore.getState().stopAgent(threadId);

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(
      false,
    );
  });

  it("when stopAgent fails, the thread remains running for retry", async () => {
    const threadId = "thread-1";
    useThreadStore.setState({
      runningThreadIds: new Set([threadId]),
    });
    (
      mockTransport.stopAgent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("connection lost"));

    await useThreadStore.getState().stopAgent(threadId);

    // Provider stop failure must not create false idle state.
    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(
      true,
    );
    expect(getTestThreadError("thread-1")).toBeTruthy();
  });

  it("recalls only an undispatched stopped message", async () => {
    const threadId = "thread-1";
    const userMessage = createMockMessage({
      id: "user-1",
      thread_id: threadId,
      role: "user",
      content: "keep working on this",
    });
    resetThreadStoreForTests({
      currentThreadId: threadId,
      runningThreadIds: new Set([threadId]),
      records: new Map([[threadId, { ...createEmptyThreadRecord(), messages: [userMessage] }]]),
    });
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      threadId,
      turnExecutionId: "00000000-0000-4000-8000-000000000001",
      snapshot: {
        threadId,
        turnExecutionId: "00000000-0000-4000-8000-000000000001",
        phase: "cancelled",
      },
      status: "cancelled",
      dispatchState: "not-dispatched",
    });

    await useThreadStore.getState().stopAgent(threadId);

    expect(useThreadStore.getState().records.get(threadId)?.composerRecallFromStop).toEqual({
      text: "keep working on this",
    });
  });

  it("does not recall a dispatched stopped message", async () => {
    const threadId = "thread-1";
    const userMessage = createMockMessage({
      id: "user-1",
      thread_id: threadId,
      role: "user",
      content: "keep working on this",
    });
    resetThreadStoreForTests({
      currentThreadId: threadId,
      runningThreadIds: new Set([threadId]),
      records: new Map([[threadId, { ...createEmptyThreadRecord(), messages: [userMessage] }]]),
    });
    (mockTransport.stopAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      threadId,
      turnExecutionId: "00000000-0000-4000-8000-000000000001",
      snapshot: {
        threadId,
        turnExecutionId: "00000000-0000-4000-8000-000000000001",
        phase: "cancelled",
      },
      status: "cancelled",
      dispatchState: "dispatched",
    });

    await useThreadStore.getState().stopAgent(threadId);

    expect(useThreadStore.getState().records.get(threadId)?.composerRecallFromStop).toBeUndefined();
  });

  it("when sendMessage fails, the thread is no longer marked as running", async () => {
    const threadId = "thread-1";
    (
      mockTransport.sendMessage as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("spawn failed"));

    await useThreadStore.getState().sendMessage(threadId, "Hello");

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(
      false,
    );
    expect(getTestThreadError("thread-1")).toBeTruthy();
  });

  it("accepts a new turn execution after a completed turn", async () => {
    const threadId = "thread-1";
    const previousExecutionId = "00000000-0000-4000-8000-000000000001";
    const nextExecutionId = "00000000-0000-4000-8000-000000000002";
    resetThreadStoreForTests({
      currentThreadId: threadId,
      runningThreadIds: new Set(),
      records: new Map([[threadId, {
        ...createEmptyThreadRecord(),
        runtimePhase: "completed",
        turnExecutionId: previousExecutionId,
      }]]),
    });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      expect(useThreadStore.getState().records.get(threadId)?.turnExecutionId).toBeNull();
      useThreadStore.getState().handleAgentEvent({
        type: "turnStarted",
        threadId,
        turnExecutionId: nextExecutionId,
        fileEffectTurnId: nextExecutionId,
      } as AgentEvent);
    });

    await useThreadStore.getState().sendMessage(threadId, "Continue");

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(true);
    expect(useThreadStore.getState().records.get(threadId)?.turnExecutionId).toBe(nextExecutionId);
  });

  it("preserves running state when transport fails after authoritative startup", async () => {
    const threadId = "thread-1";
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      useThreadStore.setState((state) => ({
        records: new Map(state.records).set(threadId, {
          ...state.records.get(threadId)!,
          turnExecutionId: "00000000-0000-4000-8000-000000000001",
          runtimePhase: "running",
          agentStartTime: 123,
        }),
      }));
      throw new Error("provider disconnected");
    });

    await useThreadStore.getState().sendMessage(threadId, "Hello");

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(true);
    expect(useThreadStore.getState().records.get(threadId)?.runtimePhase).toBe("running");
    expect(useThreadStore.getState().records.get(threadId)?.agentStartTime).toBe(123);
  });

  it("when clearMessages is called, streaming state resets but running threads persist", () => {
    const msg = createMockMessage({
      id: "1",
      thread_id: "t",
      content: "hi",
    });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        ["thread-1", {
          ...createEmptyThreadRecord(),
          messages: [msg],
          streaming: "partial",
          runtimePhase: "running",
          turnExecutionId: "00000000-0000-4000-8000-000000000001",
        }],
      ]),
    });

    useThreadStore.getState().clearMessages();

    const state = useThreadStore.getState();
    expect(getTestActiveMessages()).toHaveLength(0);
    // Only the current thread's streaming entry should be pruned
    expect(getTestThreadStreaming("thread-1")).toBeUndefined();
    // Running threads should NOT be cleared by clearMessages
    expect(state.runningThreadIds.has("thread-1")).toBe(true);
  });

  it("when loadMessages is called, it sets the current thread and fetches messages", async () => {
    const threadId = "thread-1";
    const msgs = [
      createMockMessage({ thread_id: threadId, sequence: 1 }),
      createMockMessage({ thread_id: threadId, sequence: 2 }),
    ];
    (
      mockTransport.getMessages as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ messages: msgs, hasMore: false });

await activateTestConversation(threadId);

    const state = useThreadStore.getState();
    expect(state.currentThreadId).toBe(threadId);
    expect(getTestActiveMessages()).toEqual(msgs);
    expect(readActiveThreadField((r) => r.loading) ?? false).toBe(false);
  });

  it("when loadMessages fails, the error is captured", async () => {
    const threadId = "thread-1";
    (
      mockTransport.getMessages as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("db connection failed"));

    await activateTestConversation(threadId);

    expect(getTestThreadError("thread-1")).toContain("db connection failed");
    expect(readActiveThreadField((r) => r.loading) ?? false).toBe(false);
  });
});
