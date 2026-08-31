import type { AgentEvent } from "@mcode/contracts";
import {
  resetThreadStoreForTests,
  getTestActiveMessages,
  getTestThreadStreaming,
  getTestThreadStreamingPreview,
  getTestThreadToolCalls,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("Agent Message Flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({
      threads: [
        createMockThread({ id: "thread-1" }),
        createMockThread({ id: "thread-a" }),
        createMockThread({ id: "thread-b" }),
      ],
    });
    resetThreadStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("session.message adds an assistant message to the current thread", () => {
    const threadId = "thread-1";
    useThreadStore.setState({ currentThreadId: threadId });
    const { handleAgentEvent } = useThreadStore.getState();

    handleAgentEvent({ type: "message", threadId: threadId, content: "Hello world", tokens: 42 } satisfies AgentEvent);
    vi.runAllTimers();

    expect(getTestActiveMessages()).toHaveLength(1);
    expect(getTestActiveMessages()[0].content).toBe("Hello world");
    expect(getTestActiveMessages()[0].role).toBe("assistant");
    expect(getTestActiveMessages()[0].tokens_used).toBe(42);
  });

  it("session.message assigns distinct response keys when one turn persists multiple assistant messages", () => {
    const threadId = "thread-1";
    useThreadStore.setState({ currentThreadId: threadId });
    const { handleAgentEvent } = useThreadStore.getState();

    // Codex narration turn: an assistant message lands mid-turn, then the
    // final response lands as a second message with different content.
    handleAgentEvent({ type: "message", threadId: threadId, content: "Narration before tool batch", messageId: "msg-1", tokens: null } satisfies AgentEvent);
    handleAgentEvent({ type: "message", threadId: threadId, content: "Final response", messageId: "msg-2", tokens: null } satisfies AgentEvent);
    vi.runAllTimers();

    const keys = readThreadField(threadId, (r) => r.assistantResponseKeys)!;
    expect(keys["msg-1"]).toBeTruthy();
    expect(keys["msg-2"]).toBeTruthy();
    // Sharing a key would render two React siblings with the same key.
    expect(keys["msg-1"]).not.toBe(keys["msg-2"]);
    // The live key rotates after each claim so follow-up streaming in the
    // same turn never collides with an already-persisted bubble.
    const liveKey = readThreadField(threadId, (r) => r.currentTurnResponseKey);
    expect(liveKey).not.toBe(keys["msg-1"]);
    expect(liveKey).not.toBe(keys["msg-2"]);
  });

  it("session.message retains the target thread message without changing the active transcript", () => {
    useThreadStore.setState({ currentThreadId: "thread-a" });
    const { handleAgentEvent } = useThreadStore.getState();

    // Message for current thread is added
    handleAgentEvent({ type: "message", threadId: "thread-a", content: "Alpha", tokens: null } satisfies AgentEvent);
    vi.runAllTimers();
    expect(getTestActiveMessages()).toHaveLength(1);

    // The background message belongs to its target record, not the visible transcript.
    handleAgentEvent({ type: "message", threadId: "thread-b", content: "Beta", tokens: null } satisfies AgentEvent);
    vi.runAllTimers();
    expect(getTestActiveMessages()).toHaveLength(1);
    expect(getTestActiveMessages()[0].content).toBe("Alpha");
    expect(readThreadField("thread-b", (record) => record.messages.map((message) => message.content)))
      .toEqual(["Beta"]);
  });

  it("when session.ended fires, running state and streaming are cleared", () => {
    const threadId = "thread-1";
    resetThreadStoreForTests({
      runningThreadIds: new Set([threadId]),
      records: new Map<string, ThreadRecord>([
        [threadId, {
          ...createEmptyThreadRecord(),
          runtimePhase: "running",
          turnExecutionId: "exec-1",
          streaming: "partial content",
        }],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({
      type: "ended",
      threadId,
      turnExecutionId: "exec-1",
      outcome: "completed",
    } satisfies AgentEvent);
    vi.runAllTimers();

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.has(threadId)).toBe(false);
    expect(getTestThreadStreaming(threadId)).toBeUndefined();
  });

  it.each([
    ["cancelled", "cancelled", "interrupted"],
    ["completed", "completed", "completed"],
    ["errored", "errored", "errored"],
  ] as const)("projects Ended outcome %s into runtime and workspace status", (outcome, runtimePhase, workspaceStatus) => {
    const threadId = "thread-1";
    resetThreadStoreForTests({
      currentThreadId: "thread-a",
      runningThreadIds: new Set([threadId]),
      records: new Map<string, ThreadRecord>([
        ["thread-a", createEmptyThreadRecord()],
        [threadId, {
          ...createEmptyThreadRecord(),
          runtimePhase: "running",
          turnExecutionId: "exec-1",
          streaming: "partial content",
        }],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({
      type: "ended",
      threadId,
      turnExecutionId: "exec-1",
      outcome,
    } satisfies AgentEvent);
    vi.runAllTimers();

    expect(readThreadField(threadId, (record) => record.runtimePhase)).toBe(runtimePhase);
    expect(useWorkspaceStore.getState().threads.find((thread) => thread.id === threadId)?.status)
      .toBe(workspaceStatus);
  });

  it("leaves an outcome-less Ended unresolved", () => {
    const threadId = "thread-1";
    resetThreadStoreForTests({
      runningThreadIds: new Set([threadId]),
      records: new Map<string, ThreadRecord>([[threadId, {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: "exec-1",
        streaming: "partial content",
      }]]),
    });

    useThreadStore.getState().handleAgentEvent({
      type: "ended",
      threadId,
      turnExecutionId: "exec-1",
    } satisfies AgentEvent);

    expect(readThreadField(threadId, (record) => record.runtimePhase)).toBe("running");
    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(true);
  });

  it("releases a provider-lost runtime without clearing streamed content", () => {
    const threadId = "thread-1";
    resetThreadStoreForTests({
      runningThreadIds: new Set([threadId]),
      records: new Map<string, ThreadRecord>([[threadId, {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: "exec-1",
        agentStartTime: 100,
        savingStatus: { threadId, executionId: "exec-1", mode: "saving-delayed" },
        streaming: "partial content",
        streamingPreview: "partial content",
      }]]),
    });

    useThreadStore.getState().handleAgentEvent({
      type: "ended",
      threadId,
      turnExecutionId: "exec-1",
      reason: "provider_lost",
    } satisfies AgentEvent);

    expect(readThreadField(threadId, (record) => record.runtimePhase)).toBe("idle");
    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(false);
    expect(readThreadField(threadId, (record) => record.agentStartTime)).toBeUndefined();
    expect(readThreadField(threadId, (record) => record.savingStatus)).toBeNull();
    expect(getTestThreadStreaming(threadId)).toBe("partial content");
    expect(getTestThreadStreamingPreview(threadId)).toBe("partial content");
    expect(useWorkspaceStore.getState().threads.find((thread) => thread.id === threadId)?.status)
      .toBe("active");
  });

  it("turnComplete without streaming content clears running state", () => {
    const threadId = "thread-1";
    useThreadStore.setState({
      runningThreadIds: new Set([threadId]),
      currentThreadId: threadId,
    });

    useThreadStore.getState().handleAgentEvent({ type: "turnComplete", threadId: threadId, reason: "end_turn", costUsd: 0.01, tokensIn: 50, tokensOut: 50 } satisfies AgentEvent);
    vi.runAllTimers();

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.has(threadId)).toBe(false);
  });

  it("turnComplete retains streaming fallback in the target record without changing the active transcript", () => {
    resetThreadStoreForTests({
      currentThreadId: "thread-other",
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord(), streaming: "background response" }],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "turnComplete", threadId: "thread-1", reason: "end_turn", costUsd: 0.005,
      tokensIn: 25,
      tokensOut: 25 } satisfies AgentEvent);
    vi.runAllTimers();

    expect(getTestThreadStreaming("thread-1")).toBeUndefined();
    expect(getTestActiveMessages()).toHaveLength(0);
    expect(readThreadField("thread-1", (record) => record.messages.map((message) => message.content)))
      .toEqual(["background response"]);
  });

  it("keeps a background response through completion and persistence after reopening the thread", () => {
    resetThreadStoreForTests({
      currentThreadId: "thread-b",
      records: new Map<string, ThreadRecord>([
        ["thread-a", createEmptyThreadRecord()],
        ["thread-b", createEmptyThreadRecord()],
      ]),
      runningThreadIds: new Set(["thread-a"]),
    });

    const { handleAgentEvent, handleTurnPersisted } = useThreadStore.getState();
    handleAgentEvent({ type: "message", threadId: "thread-a", content: "Alpha completed while inactive",
        messageId: "thread-a-completed", tokens: null } satisfies AgentEvent);
    handleAgentEvent({ type: "turnComplete", threadId: "thread-a", reason: "end_turn", costUsd: 0.005, tokensIn: 25, tokensOut: 25 } satisfies AgentEvent);

    useThreadStore.setState({ currentThreadId: "thread-a" });
    handleTurnPersisted({
      threadId: "thread-a",
      messageId: "thread-a-completed",
      toolCallCount: 0,
      filesChanged: [],
    });
    vi.runAllTimers();

    expect(getTestActiveMessages().map((message) => message.content)).toEqual([
      "Alpha completed while inactive",
    ]);
    expect(readThreadField("thread-b", (record) => record.messages)).toEqual([]);
  });
});

describe("duplicate message prevention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "thread-1" })] });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        ["thread-1", {
          ...createEmptyThreadRecord(),
          streaming: "Hello world",
          streamingPreview: "Hello world",
          agentStartTime: Date.now(),
        }],
      ]),
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("session.message clears streamingByThread so turnComplete does not duplicate", () => {
    const { handleAgentEvent } = useThreadStore.getState();

    // session.message arrives with the final content
    handleAgentEvent({ type: "message", threadId: "thread-1", content: "Hello world", tokens: 10 } satisfies AgentEvent);
    vi.runAllTimers();

    // Both streaming fields must be cleared
    expect(getTestThreadStreaming("thread-1")).toBeUndefined();
    expect(getTestThreadStreamingPreview("thread-1")).toBeUndefined();

    // Now turnComplete fires — should NOT create a second message
    handleAgentEvent({ type: "turnComplete", threadId: "thread-1", reason: "end_turn", costUsd: 0.01, tokensIn: 50, tokensOut: 50 } satisfies AgentEvent);
    vi.runAllTimers();

    const messages = getTestActiveMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello world");
  });

  it("session.message replaces trailing optimistic assistant when content matches server message", () => {
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      records: new Map<string, ThreadRecord>([
        ["thread-1", {
          ...createEmptyThreadRecord(),
          currentTurnMessageId: "client-provisional-id",
          messages: [
            {
              id: "client-provisional-id",
              thread_id: "thread-1",
              role: "assistant",
              content: "Hello world",
              tool_calls: null,
              files_changed: null,
              cost_usd: null,
              tokens_used: null,
              sequence: 1,
              timestamp: new Date().toISOString(),
              attachments: null,
            },
          ],
        }],
      ]),
    });
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent({ type: "message", threadId: "thread-1", content: "Hello world",
        messageId: "persisted-msg-id",
        tokens: 10, } satisfies AgentEvent);
    vi.runAllTimers();

    const messages = getTestActiveMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("persisted-msg-id");
    expect(messages[0].content).toBe("Hello world");
    expect(messages[0].tokens_used).toBe(10);
  });
});

describe("session.textDelta", () => {
  /** Drain microtasks for mocked requestAnimationFrame (matches store assign-then-callback ordering). */
  async function flushRafChain(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    // Thread store coalesces deltas on rAF; fake timers don't run those frames,
    // and a stuck frame leaves pending state that leaks across examples.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback): number => {
      queueMicrotask(() => {
        cb(0);
      });
      return 1;
    });
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "thread-1" })] });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord() }],
      ]),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends delta to streamingByThread", async () => {
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent({ type: "textDelta", threadId: "thread-1", delta: "Hello" } satisfies AgentEvent);
    handleAgentEvent({ type: "textDelta", threadId: "thread-1", delta: " world" } satisfies AgentEvent);

    await flushRafChain();
    expect(getTestThreadStreaming("thread-1")).toBe("Hello world");
  });

  it("stores full text in streamingByThread and truncated preview in streamingPreviewByThread", async () => {
    const longText = "x".repeat(250);
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord(), streaming: longText }],
      ]),
    });
    const { handleAgentEvent } = useThreadStore.getState();

    handleAgentEvent({ type: "textDelta", threadId: "thread-1", delta: "end" } satisfies AgentEvent);

    await flushRafChain();
    // Full buffer is preserved
    const streaming = getTestThreadStreaming("thread-1");
    expect(streaming).toBe(longText + "end");
    expect(streaming?.length).toBe(253);
    // Preview is truncated to last 200 chars
    const preview = getTestThreadStreamingPreview("thread-1");
    expect(preview?.length).toBe(200);
    expect(preview?.endsWith("end")).toBe(true);
  });

  it("marks prior tool calls complete on first textDelta", async () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        ["thread-1", {
          ...createEmptyThreadRecord(),
          toolCalls: [
            { id: "tc-1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
          ],
        }],
      ]),
    });
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent({ type: "textDelta", threadId: "thread-1", delta: "Hi" } satisfies AgentEvent);

    await flushRafChain();
    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].isComplete).toBe(true);
  });

  it("does not affect other threads", async () => {
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent({ type: "textDelta", threadId: "thread-1", delta: "ping" } satisfies AgentEvent);

    await flushRafChain();
    expect(getTestThreadStreaming("thread-2")).toBeUndefined();
  });
});

describe("session.toolProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "thread-1" })] });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        ["thread-1", {
          ...createEmptyThreadRecord(),
          toolCalls: [
            { id: "tc1", toolName: "Bash", toolInput: {}, output: null, isError: false, isComplete: false },
          ],
        }],
      ]),
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("updates elapsedSeconds on the matching tool call", () => {
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent({ type: "toolProgress", threadId: "thread-1", toolCallId: "tc1", toolName: "Bash", elapsedSeconds: 5 } satisfies AgentEvent);

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].elapsedSeconds).toBe(5);
  });

  it("ignores toolProgress for unknown toolCallId", () => {
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent({ type: "toolProgress", threadId: "thread-1", toolCallId: "unknown", toolName: "Bash", elapsedSeconds: 3 } satisfies AgentEvent);

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].elapsedSeconds).toBeUndefined();
  });
});
