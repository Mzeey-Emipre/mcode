import type { AgentEvent } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { createMockThread, mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-agent-event-inputs";

function dispatch(event: unknown): void {
  useThreadStore.getState().handleAgentEvent(event as AgentEvent);
}

describe("thread store agent-event input boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({
      activeThreadId: THREAD_ID,
      threads: [createMockThread({ id: THREAD_ID })],
    });
    useTaskStore.setState({ tasksByThread: {} });
    resetThreadStoreForTests({
      currentThreadId: THREAD_ID,
      records: new Map<string, ThreadRecord>([[THREAD_ID, createEmptyThreadRecord()]]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores malformed event objects before preflight", () => {
    const records = useThreadStore.getState().records;
    const subscriber = vi.fn();
    const unsubscribe = useThreadStore.subscribe(subscriber);

    for (const event of [null, 1, {}, { type: "textDelta" }, { threadId: THREAD_ID }]) {
      expect(() => dispatch(event)).not.toThrow();
    }
    unsubscribe();

    expect(useThreadStore.getState().records).toBe(records);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("ignores unknown and prototype-key event types without materializing a record", () => {
    const records = useThreadStore.getState().records;
    const subscriber = vi.fn();
    const unsubscribe = useThreadStore.subscribe(subscriber);

    for (const type of ["unknown", "constructor", "toString", "__proto__"]) {
      expect(() => dispatch({ type, threadId: "unknown-thread" })).not.toThrow();
    }
    unsubscribe();

    expect(useThreadStore.getState().records).toBe(records);
    expect(useThreadStore.getState().records.has("unknown-thread")).toBe(false);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("normalizes malformed event fields before projection", () => {
    dispatch({
      type: "message",
      threadId: THREAD_ID,
      messageId: "assistant-with-attachments",
      content: "saved",
      attachments: [
        { id: "valid", name: "note.txt", mimeType: "text/plain", sizeBytes: 3 },
        { id: "invalid", name: "bad.txt", mimeType: "text/plain", sizeBytes: "3" },
      ],
    });
    expect(useThreadStore.getState().records.get(THREAD_ID)?.messages[0]?.attachments).toEqual([
      { id: "valid", name: "note.txt", mimeType: "text/plain", sizeBytes: 3 },
    ]);

    expect(() => dispatch({ type: "textDelta", threadId: THREAD_ID, delta: 7 })).not.toThrow();
    vi.runAllTimers();
    expect(useThreadStore.getState().records.get(THREAD_ID)?.streaming).toBe("");

    dispatch({ type: "hookStarted", threadId: THREAD_ID, hookName: "validate", hookType: "stop" });
    expect(() => dispatch({
      type: "hookProgress",
      threadId: THREAD_ID,
      hookName: "validate",
      output: { unexpected: true },
    })).not.toThrow();
    expect(useThreadStore.getState().records.get(THREAD_ID)?.hooks[0]?.fullOutput).toEqual([]);

    expect(() => dispatch({
      type: "quotaUpdate",
      threadId: THREAD_ID,
      providerId: "claude",
      categories: { unexpected: true },
    })).not.toThrow();
    expect(useThreadStore.getState().records.get(THREAD_ID)?.usageByProvider.claude?.quotaCategories)
      .toEqual([]);
  });

  it("normalizes malformed tool results before task correlation and completion", () => {
    dispatch({
      type: "toolUse",
      threadId: THREAD_ID,
      toolCallId: "malformed-tool-result",
      toolName: "TaskCreate",
      toolInput: { subject: "Malformed result" },
    });

    expect(() => dispatch({
      type: "toolResult",
      threadId: THREAD_ID,
      toolCallId: "malformed-tool-result",
      output: { unexpected: true },
      isError: false,
      outputTruncated: "false",
      outputTotalBytes: Number.POSITIVE_INFINITY,
      outputArtifactPath: { unexpected: true },
      exitCode: 1.5,
    })).not.toThrow();

    const toolCall = useThreadStore.getState().records.get(THREAD_ID)?.toolCalls[0];
    expect(toolCall).toMatchObject({ output: "", isComplete: true });
    expect(toolCall).not.toHaveProperty("outputTruncated");
    expect(toolCall).not.toHaveProperty("outputTotalBytes");
    expect(toolCall).not.toHaveProperty("outputArtifactPath");
    expect(toolCall).not.toHaveProperty("exitCode");
    expect(useTaskStore.getState().tasksByThread[THREAD_ID]?.[0]?.harnessTaskId).toBeUndefined();
  });

  it("normalizes direct-store runtime and message fields", () => {
    dispatch({ type: "turnStarted", threadId: THREAD_ID, fileEffectTurnId: { unexpected: true } });
    expect(useThreadStore.getState().records.get(THREAD_ID)?.fileEffectTurnId).toBe("");

    dispatch({ type: "message", threadId: THREAD_ID, messageId: "", content: "empty message id" });
    dispatch({ type: "message", threadId: THREAD_ID, messageId: 7, content: "numeric message id" });
    const messages = useThreadStore.getState().records.get(THREAD_ID)?.messages ?? [];
    const emptyIdMessage = messages.find((message) => message.content === "empty message id");
    const numericIdMessage = messages.find((message) => message.content === "numeric message id");
    expect(typeof emptyIdMessage?.id).toBe("string");
    expect(emptyIdMessage?.id).not.toBe("");
    expect(typeof numericIdMessage?.id).toBe("string");
    expect(numericIdMessage?.id).not.toBe(7);
  });

  it("normalizes malformed narrative final-response markers", () => {
    dispatch({ type: "textDelta", threadId: THREAD_ID, delta: "preamble", isFinalResponse: "invalid" });
    vi.runAllTimers();
    expect(useThreadStore.getState().records.get(THREAD_ID)?.thoughtSegments).toEqual([
      expect.objectContaining({ text: "preamble" }),
    ]);

    dispatch({ type: "assistantMessageBoundary", threadId: THREAD_ID, isFinalResponse: "invalid" });
    expect(useThreadStore.getState().records.get(THREAD_ID)?.thoughtSegments[0]?.endedAt).toEqual(
      expect.any(Number),
    );
  });

  it("preserves state identity for ignored and duplicate event patches", () => {
    resetThreadStoreForTests({
      currentThreadId: THREAD_ID,
      records: new Map<string, ThreadRecord>([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        thoughtSegments: [{ text: "already closed", startedAt: 1, endedAt: 2 }],
      }]]),
    });
    const records = useThreadStore.getState().records;
    const record = records.get(THREAD_ID);
    const subscriber = vi.fn();
    const unsubscribe = useThreadStore.subscribe(subscriber);

    dispatch({ type: "assistantMessageBoundary", threadId: THREAD_ID, isFinalResponse: false });
    dispatch({ type: "toolProgress", threadId: THREAD_ID, toolCallId: "missing", elapsedSeconds: 1 });
    dispatch({ type: "hookCompleted", threadId: THREAD_ID, hookName: "missing", exitCode: 0 });
    dispatch({
      type: "hookCompleted",
      threadId: "missing-thread",
      hookName: "late",
      exitCode: 0,
      persistedMessageId: "missing-message",
    });
    unsubscribe();

    expect(useThreadStore.getState().records).toBe(records);
    expect(useThreadStore.getState().records.get(THREAD_ID)).toBe(record);
    expect(useThreadStore.getState().records.has("missing-thread")).toBe(false);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("keeps Agent description presence authoritative for child task labels", () => {
    dispatch({
      type: "toolUse",
      threadId: THREAD_ID,
      toolCallId: "agent-empty-description",
      toolName: "Agent",
      toolInput: { description: "", prompt: "fallback prompt" },
    });
    dispatch({
      type: "toolUse",
      threadId: THREAD_ID,
      toolCallId: "task-empty-description",
      toolName: "TaskCreate",
      toolInput: { subject: "Task with empty description" },
      parentToolCallId: "agent-empty-description",
    });
    dispatch({
      type: "toolUse",
      threadId: THREAD_ID,
      toolCallId: "agent-whitespace-description",
      toolName: "Agent",
      toolInput: { description: "  ", prompt: "fallback prompt" },
    });
    dispatch({
      type: "toolUse",
      threadId: THREAD_ID,
      toolCallId: "task-whitespace-description",
      toolName: "TaskCreate",
      toolInput: { subject: "Task with whitespace description" },
      parentToolCallId: "agent-whitespace-description",
    });

    const tasks = useTaskStore.getState().tasksByThread[THREAD_ID] ?? [];
    expect(tasks.find((task) => task.id === "task-empty-description")?.group).toBe("Sub-agent");
    expect(tasks.find((task) => task.id === "task-whitespace-description")?.group).toBe("  ");
  });
});
