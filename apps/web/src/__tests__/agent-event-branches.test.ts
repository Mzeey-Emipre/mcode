import type { AgentEvent } from "@mcode/contracts";
import {
  resetThreadStoreForTests,
  getTestActiveMessages,
  getTestThreadToolCalls,
  getTestThreadError,
  getTestThreadLastFallback,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { countActiveSubagentCalls, useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useToastStore } from "@/stores/toastStore";
import { useTaskStore } from "@/stores/taskStore";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("handleAgentEvent branches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({
      activeThreadId: "thread-1",
      threads: [createMockThread({ id: "thread-1" })],
    });
    useTaskStore.setState({ tasksByThread: {} });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            messages: [],
            loading: false,
            agentStartTime: new Date("2026-01-01T00:00:00Z").getTime(),
          },
        ],
      ]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("session.error clears thread running state and sets error", () => {
    useThreadStore.getState().handleAgentEvent({ type: "error", threadId: "thread-1", error: "Out of tokens" } as AgentEvent);

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
    expect(getTestThreadError("thread-1")).toBe("Out of tokens");
  });

  it("session.system sdk_session_invalidated appends a reset hairline message", () => {
    useThreadStore.getState().handleAgentEvent({ type: "system", threadId: "thread-1", subtype: "sdk_session_invalidated" } as AgentEvent);

    const messages = getTestActiveMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe(
      "Session reset. Earlier context cleared. Send again to continue.",
    );
  });

  it("session.system with an unknown subtype appends no message", () => {
    useThreadStore.getState().handleAgentEvent({ type: "system", threadId: "thread-1", subtype: "some_other_subtype" } as AgentEvent);

    expect(getTestActiveMessages()).toHaveLength(0);
  });

  it("session.turnComplete without streaming content clears state only", () => {
    useThreadStore.getState().handleAgentEvent({ type: "turnComplete", threadId: "thread-1", reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 } as AgentEvent);
    vi.runAllTimers();

    const state = useThreadStore.getState();
    expect(getTestActiveMessages()).toHaveLength(0);
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
  });

  it("flushes same-frame textDelta before turnComplete persists assistant content", () => {
    useThreadStore.getState().handleAgentEvent({
      type: "textDelta",
      threadId: "thread-1",
      delta: "final assistant answer",
      isFinalResponse: true,
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: "thread-1",
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } as AgentEvent);

    expect(getTestActiveMessages().find((message) => message.role === "assistant")?.content)
      .toBe("final assistant answer");
  });

  it("flushes same-frame background textDelta before turnComplete persists content", () => {
    const backgroundThreadId = "thread-background-complete";
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1", backgroundThreadId]),
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord() }],
        [backgroundThreadId, { ...createEmptyThreadRecord() }],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({
      type: "textDelta",
      threadId: backgroundThreadId,
      delta: "background final answer",
      isFinalResponse: true,
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: backgroundThreadId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } as AgentEvent);

    expect(readThreadField(backgroundThreadId, (thread) => thread.messages)
      .find((message) => message.role === "assistant")?.content)
      .toBe("background final answer");
  });

  it("session.toolUse adds tool call to toolCallsByThread", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "tc1", toolName: "Read", toolInput: { path: "/foo" } } as AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("Read");
    expect(calls[0].id).toBe("tc1");
    expect(calls[0].toolInput).toEqual({ path: "/foo" });
    expect(calls[0].isComplete).toBe(false);
  });

  it("deduplicates sequenced replay events while accepting a first sequence above one", () => {
    const handleAgentEvent = useThreadStore.getState().handleAgentEvent;

    handleAgentEvent({
      type: "toolUse",
      threadId: "thread-1",
      sequence: 17,
      toolCallId: "seq-tool-1",
      toolName: "Read",
      toolInput: { path: "/first" },
    } as AgentEvent);
    handleAgentEvent({
      type: "toolUse",
      threadId: "thread-1",
      sequence: 17,
      toolCallId: "seq-tool-1",
      toolName: "Read",
      toolInput: { path: "/replay" },
    } as AgentEvent);
    handleAgentEvent({
      type: "toolUse",
      threadId: "thread-1",
      sequence: 18,
      toolCallId: "seq-tool-2",
      toolName: "Write",
      toolInput: { path: "/second" },
    } as AgentEvent);

    const record = readThreadField("thread-1", (thread) => thread);
    expect(record.lastAgentEventSequence).toBe(18);
    expect(record.toolCalls.map((call) => call.id)).toEqual(["seq-tool-1", "seq-tool-2"]);
    expect(record.toolCalls[0]?.toolInput).toEqual({ path: "/first" });
  });

  it("resets sequence authority when server event epoch changes", () => {
    const handleAgentEvent = useThreadStore.getState().handleAgentEvent;
    handleAgentEvent({
      type: "toolUse", threadId: "thread-1", epoch: "00000000-0000-4000-8000-000000000001",
      sequence: 9, toolCallId: "old", toolName: "Read", toolInput: {},
    } as AgentEvent);
    handleAgentEvent({
      type: "toolUse", threadId: "thread-1", epoch: "00000000-0000-4000-8000-000000000002",
      sequence: 1, toolCallId: "new", toolName: "Write", toolInput: {},
    } as AgentEvent);
    expect(readThreadField("thread-1", (thread) => thread.lastAgentEventSequence)).toBe(1);
    expect(readThreadField("thread-1", (thread) => thread.lastAgentEventEpoch))
      .toBe("00000000-0000-4000-8000-000000000002");
  });

  it("retains hook progress for an inactive thread", () => {
    const backgroundThreadId = "thread-background-hook";
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1", backgroundThreadId]),
      records: new Map([
        ["thread-1", createEmptyThreadRecord()],
        [backgroundThreadId, createEmptyThreadRecord()],
      ]),
    });

    const handleAgentEvent = useThreadStore.getState().handleAgentEvent;
    handleAgentEvent({
      type: "hookStarted",
      threadId: backgroundThreadId,
      hookName: "format",
      hookType: "stop",
    } as AgentEvent);
    handleAgentEvent({
      type: "hookProgress",
      threadId: backgroundThreadId,
      hookName: "format",
      output: "line one\nline two",
    } as AgentEvent);

    expect(readThreadField(backgroundThreadId, (thread) => thread.hooks[0]?.outputLines))
      .toEqual(["line one", "line two"]);
  });

  it("background textDelta keeps streaming state without growing narrative state", async () => {
    const backgroundThreadId = "thread-deferred";
    const backgroundToolCall = {
      id: "background-tool",
      toolName: "Read",
      toolInput: { path: "/tmp/background" },
      output: null,
      isError: false,
      isComplete: false,
    };
    const backgroundThought = { text: "existing thought", startedAt: 1, endedAt: 2 };
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1", backgroundThreadId]),
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord() }],
        [backgroundThreadId, {
          ...createEmptyThreadRecord(),
          streaming: "",
          thoughtSegments: [backgroundThought],
          toolCalls: [backgroundToolCall],
        }],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({
      type: "textDelta",
      threadId: backgroundThreadId,
      delta: "background text",
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "toolProgress",
      threadId: backgroundThreadId,
      toolCallId: backgroundToolCall.id,
      elapsedSeconds: 1,
    } as AgentEvent);
    await Promise.resolve();
    vi.runAllTimers();

    const record = readThreadField(backgroundThreadId, (thread) => thread);
    expect(record.streaming).toBe("background text");
    expect(record.thoughtSegments).toEqual([backgroundThought]);
    expect(record.toolCalls).toEqual([backgroundToolCall]);
  });

  it("materializes deferred events at the count cap without reordering or duplication", () => {
    const backgroundThreadId = "thread-deferred-count-cap";
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1", backgroundThreadId]),
      records: new Map([
        ["thread-1", createEmptyThreadRecord()],
        [backgroundThreadId, createEmptyThreadRecord()],
      ]),
    });

    const deltas = Array.from({ length: 2049 }, (_, index) => `event-${index}|`);
    for (const delta of deltas) {
      useThreadStore.getState().handleAgentEvent({
        type: "textDelta",
        threadId: backgroundThreadId,
        delta,
      } as AgentEvent);
    }
    vi.runAllTimers();

    const materializedBeforeActivation = readThreadField(
      backgroundThreadId,
      (thread) => thread.thoughtSegments.map((segment) => segment.text).join(""),
    );
    expect(materializedBeforeActivation).toBe(deltas.slice(0, 2048).join(""));

    useThreadStore.setState({ currentThreadId: backgroundThreadId });
    useThreadStore.getState().handleAgentEvent({
      type: "toolProgress",
      threadId: backgroundThreadId,
      toolCallId: "missing-tool",
      elapsedSeconds: 0,
    } as AgentEvent);

    const materialized = readThreadField(
      backgroundThreadId,
      (thread) => thread.thoughtSegments.map((segment) => segment.text).join(""),
    );
    expect(materialized).toBe(deltas.join(""));
    expect(materialized.match(/event-/g)).toHaveLength(2049);
  });

  it("materializes deferred events at the byte cap without losing content", () => {
    const backgroundThreadId = "thread-deferred-byte-cap";
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1", backgroundThreadId]),
      records: new Map([
        ["thread-1", createEmptyThreadRecord()],
        [backgroundThreadId, createEmptyThreadRecord()],
      ]),
    });

    const deltas = ["A".repeat(100_000), "B".repeat(100_000)];
    for (const delta of deltas) {
      useThreadStore.getState().handleAgentEvent({
        type: "textDelta",
        threadId: backgroundThreadId,
        delta,
      } as AgentEvent);
    }
    vi.runAllTimers();

    expect(readThreadField(
      backgroundThreadId,
      (thread) => thread.thoughtSegments.map((segment) => segment.text).join(""),
    )).toBe(deltas[0]);

    useThreadStore.setState({ currentThreadId: backgroundThreadId });
    useThreadStore.getState().handleAgentEvent({
      type: "toolProgress",
      threadId: backgroundThreadId,
      toolCallId: "missing-tool",
      elapsedSeconds: 0,
    } as AgentEvent);

    expect(readThreadField(
      backgroundThreadId,
      (thread) => thread.thoughtSegments.map((segment) => segment.text).join(""),
    )).toBe(deltas.join(""));
  });

  it("splits an oversized deferred textDelta into bounded ordered chunks", () => {
    const backgroundThreadId = "thread-deferred-oversized-delta";
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1", backgroundThreadId]),
      records: new Map([
        ["thread-1", createEmptyThreadRecord()],
        [backgroundThreadId, createEmptyThreadRecord()],
      ]),
    });

    const maxChunkLength = Math.floor((256 * 1024 - 32) / 2);
    const delta = "x".repeat(maxChunkLength + 17);
    useThreadStore.getState().handleAgentEvent({
      type: "textDelta",
      threadId: backgroundThreadId,
      delta,
    } as AgentEvent);
    vi.runAllTimers();

    expect(readThreadField(
      backgroundThreadId,
      (thread) => thread.thoughtSegments.map((segment) => segment.text).join(""),
    )).toBe(delta.slice(0, maxChunkLength));

    useThreadStore.setState({ currentThreadId: backgroundThreadId });
    useThreadStore.getState().handleAgentEvent({
      type: "toolProgress",
      threadId: backgroundThreadId,
      toolCallId: "missing-tool",
      elapsedSeconds: 0,
    } as AgentEvent);

    expect(readThreadField(
      backgroundThreadId,
      (thread) => thread.thoughtSegments.map((segment) => segment.text).join(""),
    )).toBe(delta);
  });

  it("promotes deferred text, boundaries, and tool progress once in source order", async () => {
    const backgroundThreadId = "thread-2";
    const backgroundToolCall = {
      id: "background-tool",
      toolName: "Read",
      toolInput: { path: "/tmp/background" },
      output: null,
      isError: false,
      isComplete: false,
    };
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1", backgroundThreadId]),
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord() }],
        [backgroundThreadId, { ...createEmptyThreadRecord(), toolCalls: [backgroundToolCall] }],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({
      type: "textDelta",
      threadId: backgroundThreadId,
      delta: "first sentence that is deliberately long enough to stay closed.",
      isFinalResponse: false,
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "assistantMessageBoundary",
      threadId: backgroundThreadId,
      isFinalResponse: false,
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "textDelta",
      threadId: backgroundThreadId,
      delta: "Second",
      isFinalResponse: false,
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "toolProgress",
      threadId: backgroundThreadId,
      toolCallId: backgroundToolCall.id,
      elapsedSeconds: 3,
    } as AgentEvent);
    vi.runAllTimers();

    useThreadStore.setState({ currentThreadId: backgroundThreadId });
    useThreadStore.getState().handleTurnPersisted({
      threadId: backgroundThreadId,
      messageId: "server-message",
      toolCallCount: 0,
      filesChanged: [],
    });

    const promoted = readThreadField(backgroundThreadId, (thread) => thread);
    expect(promoted.thoughtSegments.map((segment) => segment.text)).toEqual([
      "first sentence that is deliberately long enough to stay closed.",
      "Second",
    ]);
    expect(promoted.thoughtSegments[0]?.endedAt).toBeDefined();
    expect(promoted.toolCalls[0]?.elapsedSeconds).toBe(3);

    useThreadStore.getState().handleAgentEvent({
      type: "toolProgress",
      threadId: backgroundThreadId,
      toolCallId: "missing-tool",
      elapsedSeconds: 0,
    } as AgentEvent);
    expect(readThreadField(backgroundThreadId, (thread) => thread.thoughtSegments))
      .toHaveLength(2);
  });

  it("promotes inactive text before projecting its following toolUse", () => {
    const backgroundThreadId = "thread-tool-boundary";
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1", backgroundThreadId]),
      records: new Map([
        ["thread-1", createEmptyThreadRecord()],
        [backgroundThreadId, createEmptyThreadRecord()],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({
      type: "textDelta",
      threadId: backgroundThreadId,
      delta: "Before the tool call.",
      isFinalResponse: false,
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "toolUse",
      threadId: backgroundThreadId,
      toolCallId: "background-tool",
      toolName: "Read",
      toolInput: { path: "/tmp/background" },
    } as AgentEvent);

    const beforeSwitch = readThreadField(backgroundThreadId, (thread) => thread);
    expect(beforeSwitch.thoughtSegments.map((segment) => segment.text)).toEqual([
      "Before the tool call.",
    ]);
    expect(beforeSwitch.thoughtSegments[0]?.endedAt).toBeDefined();
    expect(beforeSwitch.toolCalls.map((call) => call.id)).toEqual(["background-tool"]);

    useThreadStore.setState({ currentThreadId: backgroundThreadId });
    const afterSwitch = readThreadField(backgroundThreadId, (thread) => thread);
    expect(afterSwitch.thoughtSegments.map((segment) => segment.text)).toEqual([
      "Before the tool call.",
    ]);
    expect(afterSwitch.thoughtSegments[0]?.endedAt).toBeDefined();
    expect(afterSwitch.toolCalls.map((call) => call.id)).toEqual(["background-tool"]);
  });

  it("does not treat null selection as active for multiple running threads", async () => {
    resetThreadStoreForTests({
      currentThreadId: null,
      runningThreadIds: new Set(["thread-2", "thread-3"]),
      records: new Map<string, ThreadRecord>([
        ["thread-2", { ...createEmptyThreadRecord() }],
        ["thread-3", { ...createEmptyThreadRecord() }],
      ]),
    });

    for (const threadId of ["thread-2", "thread-3"]) {
      useThreadStore.getState().handleAgentEvent({
        type: "textDelta",
        threadId,
        delta: `background-${threadId}`,
      } as AgentEvent);
    }
    vi.runAllTimers();

    for (const threadId of ["thread-2", "thread-3"]) {
      const record = readThreadField(threadId, (thread) => thread);
      expect(record.streaming).toBe(`background-${threadId}`);
      expect(record.thoughtSegments).toEqual([]);
    }
  });

  it("does not promote final-response deltas into thought segments", () => {
    const backgroundThreadId = "thread-final-response";
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1", backgroundThreadId]),
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord() }],
        [backgroundThreadId, { ...createEmptyThreadRecord() }],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({
      type: "textDelta",
      threadId: backgroundThreadId,
      delta: "final response",
      isFinalResponse: true,
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "assistantMessageBoundary",
      threadId: backgroundThreadId,
      isFinalResponse: true,
    } as AgentEvent);
    vi.runAllTimers();

    useThreadStore.setState({ currentThreadId: backgroundThreadId });
    useThreadStore.getState().handleTurnPersisted({
      threadId: backgroundThreadId,
      messageId: "server-message",
      toolCallCount: 0,
      filesChanged: [],
    });

    expect(readThreadField(backgroundThreadId, (thread) => thread.thoughtSegments)).toEqual([]);
  });

  it("session.toolUse ignores duplicate toolCallId (defense in depth)", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "dup", toolName: "Read", toolInput: { path: "/a" } } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "dup", toolName: "Read", toolInput: { path: "/b" } } as AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolInput).toEqual({ path: "/a" });
  });

  it("session.toolUse merges enriched Agent toolInput for duplicate toolCallId", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "agent-1",
        toolName: "Agent",
        toolInput: { description: "Subagent task" }, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "agent-1",
        toolName: "Agent",
        toolInput: {
          description: "Read detection file",
          prompt: "Read cursor-subagent-detection.ts",
          model: "composer-2.5-fast",
        }, } as AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolInput).toMatchObject({
      description: "Read detection file",
      prompt: "Read cursor-subagent-detection.ts",
      model: "composer-2.5-fast",
    });
    expect(calls[0].isComplete).toBe(false);
  });

  it("session.toolUse updates tasks when duplicate TodoWrite enriches sparse input", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "todo-1",
        toolName: "TodoWrite",
        toolInput: {}, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "todo-1",
        toolName: "TodoWrite",
        toolInput: {
          todos: [
            { id: "a", content: "Run mapper tests", status: "in_progress" },
          ],
        }, } as AgentEvent);

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolInput).toEqual({
      todos: [
        { id: "a", content: "Run mapper tests", status: "in_progress" },
      ],
    });
    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "a",
        content: "Run mapper tests",
        status: "in_progress",
        group: "Tasks",
      },
    ]);
  });

  it("session.toolUse keeps sub-agent task grouping when duplicate TodoWrite omits parent", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "agent-1",
        toolName: "Agent",
        toolInput: { description: "Audit child scope" }, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "todo-child",
        toolName: "TodoWrite",
        toolInput: {},
        parentToolCallId: "agent-1", } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "todo-child",
        toolName: "TodoWrite",
        toolInput: {
          todos: [
            { id: "child-a", content: "Trace child scope", status: "in_progress" },
          ],
        }, } as AgentEvent);

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls.find((call) => call.id === "todo-child")?.parentToolCallId).toBe("agent-1");
    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "child-a",
        content: "Trace child scope",
        status: "in_progress",
        group: "Audit child scope",
      },
    ]);
  });

  it("session.toolUse updates tasks from TaskCreate tool calls", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-create-1",
        toolName: "TaskCreate",
        toolInput: {
          subject: "Buy groceries",
          description: "Pick up milk, eggs, bread",
        }, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-create-2",
        toolName: "TaskCreate",
        toolInput: {
          subject: "Clean the kitchen",
          description: "Dishes, counters, floor",
        }, } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "task-create-1",
        content: "Buy groceries - Pick up milk, eggs, bread",
        status: "pending",
        group: "Tasks",
      },
      {
        id: "task-create-2",
        content: "Clean the kitchen - Dishes, counters, floor",
        status: "pending",
        group: "Tasks",
      },
    ]);
  });

  it("session.toolUse groups sub-agent TaskCreate calls by parent Agent", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "agent-1",
        toolName: "Agent",
        toolInput: { description: "Prepare child tasks" }, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-create-child",
        toolName: "TaskCreate",
        toolInput: { subject: "Check child output" },
        parentToolCallId: "agent-1", } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "task-create-child",
        content: "Check child output",
        status: "pending",
        group: "Prepare child tasks",
      },
    ]);
  });

  it("captures the harness task id from a TaskCreate result", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-create-1",
        toolName: "TaskCreate",
        toolInput: { subject: "Buy groceries", description: "milk, eggs", activeForm: "Buying groceries" }, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "task-create-1",
        output: "Task #1 created successfully: Buy groceries",
        isError: false, } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "task-create-1",
        harnessTaskId: "1",
        content: "Buy groceries - milk, eggs",
        status: "pending",
        activeForm: "Buying groceries",
        group: "Tasks",
      },
    ]);
  });

  it("applies a TaskUpdate status transition by harness task id", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-create-1",
        toolName: "TaskCreate",
        toolInput: { subject: "Buy groceries", description: "milk, eggs" }, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "task-create-1", output: "Task #1 created successfully", isError: false } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-update-1",
        toolName: "TaskUpdate",
        toolInput: { taskId: "1", status: "in_progress", activeForm: "Buying groceries" }, } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "task-create-1",
        harnessTaskId: "1",
        content: "Buy groceries - milk, eggs",
        status: "in_progress",
        activeForm: "Buying groceries",
        group: "Tasks",
      },
    ]);
  });

  it("removes a task when a TaskUpdate sets status deleted", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-create-1",
        toolName: "TaskCreate",
        toolInput: { subject: "Buy groceries" }, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "task-create-1", output: "Task #1 created successfully", isError: false } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-update-1",
        toolName: "TaskUpdate",
        toolInput: { taskId: "1", status: "deleted" }, } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([]);
  });

  it("ignores a TaskUpdate that matches no known task", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-update-orphan",
        toolName: "TaskUpdate",
        toolInput: { taskId: "99", status: "completed" }, } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toBeUndefined();
  });

  it("leaves both tasks untouched when a TaskUpdate id collides across groups and the resolved group matches neither", () => {
    // Two sub-agents each number their own list, so harness id "1" exists in two
    // groups. An update whose group resolves to "Tasks" (no parent Agent call)
    // matches neither sub-agent group, so the ambiguous collision must be a no-op
    // rather than silently mutating an arbitrary one of the two.
    useTaskStore.getState().setTaskGroup("thread-1", "Sub-agent A", [
      { id: "sa-1", harnessTaskId: "1", content: "child A", status: "pending", group: "Sub-agent A" },
    ]);
    useTaskStore.getState().setTaskGroup("thread-1", "Sub-agent B", [
      { id: "sb-1", harnessTaskId: "1", content: "child B", status: "pending", group: "Sub-agent B" },
    ]);

    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "task-update-collide",
        toolName: "TaskUpdate",
        toolInput: { taskId: "1", status: "completed" }, } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      { id: "sa-1", harnessTaskId: "1", content: "child A", status: "pending", group: "Sub-agent A" },
      { id: "sb-1", harnessTaskId: "1", content: "child B", status: "pending", group: "Sub-agent B" },
    ]);
  });

  it("session.toolUse updates parent scope tasks from Codex update_plan calls", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "update-plan-1",
        toolName: "update_plan",
        toolInput: {
          plan: [
            { status: "pending", step: "Test todo item one with CODE-A1 and CODE-B1" },
            { status: "inProgress", step: "Test todo item two with CODE-A2 and CODE-B2" },
            { status: "completed", step: "Test todo item three with CODE-A3 and CODE-B3" },
          ],
        }, } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "0",
        content: "Test todo item one with CODE-A1 and CODE-B1",
        status: "pending",
        group: "Tasks",
      },
      {
        id: "1",
        content: "Test todo item two with CODE-A2 and CODE-B2",
        status: "in_progress",
        group: "Tasks",
      },
      {
        id: "2",
        content: "Test todo item three with CODE-A3 and CODE-B3",
        status: "completed",
        group: "Tasks",
      },
    ]);
  });

  it("session.toolUse updates Codex update_plan tasks when duplicate enriches sparse input", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "update-plan-1",
        toolName: "update_plan",
        toolInput: {}, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "update-plan-1",
        toolName: "update_plan",
        toolInput: {
          plan: [{ status: "in_progress", step: "Fill plan after completion" }],
        }, } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "0",
        content: "Fill plan after completion",
        status: "in_progress",
        group: "Tasks",
      },
    ]);
  });

  it("session.toolUse keeps child Codex update_plan tasks out of the parent group", () => {
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "agent-1",
        toolName: "Agent",
        toolInput: { description: "Child work" }, } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "update-plan-child",
        toolName: "update_plan",
        toolInput: {
          plan: [{ status: "pending", step: "Child-only plan item" }],
        },
        parentToolCallId: "agent-1", } as AgentEvent);

    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "0",
        content: "Child-only plan item",
        status: "pending",
        group: "Child work",
      },
    ]);
  });

  it("toolResult fallback does not mark an Agent call complete when it has active children", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              // Parent Agent call — should NOT be matched by fallback
              { id: "agent-1", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
              // Child call with no ID match — this result is for this child
              { id: "child-1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false, parentToolCallId: "agent-1" },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "no-match", output: "file contents", isError: false } as AgentEvent);

    const calls = getTestThreadToolCalls("thread-1");
    const agentCall = calls.find((c) => c.id === "agent-1");
    // The Agent call must NOT be marked complete
    expect(agentCall?.isComplete).toBe(false);
    // Derived count stays at 1 while the Agent row stays incomplete
    expect(countActiveSubagentCalls(getTestThreadToolCalls("thread-1"))).toBe(
      1,
    );
    // The child call MUST be marked complete — fallback resolves to it, not the Agent
    const childCall = calls.find((c) => c.id === "child-1");
    expect(childCall?.isComplete).toBe(true);
    expect(childCall?.output).toBe("file contents");
  });

  it("records provider activity time for tool progress and results", () => {
    vi.setSystemTime(1_000);
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "read-1", toolName: "Read", toolInput: { file_path: "README.md" } } as AgentEvent);

    vi.setSystemTime(2_000);
    useThreadStore.getState().handleAgentEvent({ type: "toolProgress", threadId: "thread-1", toolCallId: "read-1", elapsedSeconds: 1 } as AgentEvent);
    expect(getTestThreadToolCalls("thread-1").find((call) => call.id === "read-1")?.lastActivityAt).toBe(2_000);

    vi.setSystemTime(3_000);
    useThreadStore.getState().handleAgentEvent({ type: "toolProgress", threadId: "thread-1", toolCallId: "read-1", elapsedSeconds: 1 } as AgentEvent);
    expect(getTestThreadToolCalls("thread-1").find((call) => call.id === "read-1")?.lastActivityAt).toBe(3_000);

    vi.setSystemTime(4_000);
    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "read-1", output: "done", isError: false } as AgentEvent);
    expect(getTestThreadToolCalls("thread-1").find((call) => call.id === "read-1")?.lastActivityAt).toBe(4_000);
  });
});

describe("session.modelFallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const thread = createMockThread({ id: "thread-1", model: "claude-opus-4-6" });
    useWorkspaceStore.setState({
      threads: [thread],
      activeWorkspaceId: thread.workspace_id,
      activeThreadId: "thread-1",
      workspaces: [],
    });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            messages: [],
            loading: false,
            agentStartTime: Date.now(),
          },
        ],
      ]),
    });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores transient fallback info without mutating thread.model", () => {
    useThreadStore.getState().handleAgentEvent({ type: "modelFallback", threadId: "thread-1", requestedModel: "claude-opus-4-6",
        actualModel: "claude-sonnet-4-6", } as AgentEvent);

    // thread.model must NOT be changed
    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "thread-1");
    expect(thread?.model).toBe("claude-opus-4-6");

    // Fallback stored transiently
    const fallback = getTestThreadLastFallback("thread-1");
    expect(fallback).toEqual({
      requestedModel: "claude-opus-4-6",
      actualModel: "claude-sonnet-4-6",
    });
  });

  it("shows an info toast on fallback", () => {
    useThreadStore.getState().handleAgentEvent({ type: "modelFallback", threadId: "thread-1", requestedModel: "claude-opus-4-6",
        actualModel: "claude-sonnet-4-6", } as AgentEvent);

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe("info");
    expect(toasts[0].title).toContain("Sonnet");
  });

  it("normalizes dated SDK variant in transient fallback info", () => {
    useThreadStore.getState().handleAgentEvent({ type: "modelFallback", threadId: "thread-1", requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001", } as AgentEvent);

    // thread.model unchanged
    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "thread-1");
    expect(thread?.model).toBe("claude-opus-4-6");

    // Fallback normalized
    const fallback = getTestThreadLastFallback("thread-1");
    expect(fallback?.actualModel).toBe("claude-haiku-4-5");
  });

  it("shows human-readable label in toast for dated SDK variant", () => {
    useThreadStore.getState().handleAgentEvent({ type: "modelFallback", threadId: "thread-1", requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001", } as AgentEvent);

    const toasts = useToastStore.getState().toasts;
    expect(toasts[0].title).toContain("Haiku");
    expect(toasts[0].title).not.toContain("20251001");
  });

  it("does not show toast for unknown model IDs (uses raw ID)", () => {
    useThreadStore.getState().handleAgentEvent({ type: "modelFallback", threadId: "thread-1", requestedModel: "claude-unknown-model",
        actualModel: "claude-another-unknown", } as AgentEvent);

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toContain("claude-another-unknown");
  });
});

describe("subagent count via markPriorToolCallsComplete", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            messages: [],
            toolCalls: [
              { id: "agent-1", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("does NOT complete an in-flight Agent call when a peer top-level toolUse arrives", () => {
    // A subagent's child tool calls keep arriving on the same thread after a
    // peer top-level event. Completing the parent Agent here would zero the
    // subagent counter and hide the live LiveAgentGroup mid-run.
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "tc2", toolName: "Read", toolInput: {} } as AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls.find((c) => c.id === "agent-1")?.isComplete).toBe(false);

    expect(countActiveSubagentCalls(getTestThreadToolCalls("thread-1"))).toBe(
      1,
    );
  });

  it("leaves multiple in-flight Agent calls untouched while sweeping non-Agent peers", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "agent-1", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "agent-2", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "read-1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "thread-1", toolCallId: "tc3", toolName: "Bash", toolInput: {} } as AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    // Both Agent calls remain live
    expect(calls.find((c) => c.id === "agent-1")?.isComplete).toBe(false);
    expect(calls.find((c) => c.id === "agent-2")?.isComplete).toBe(false);
    // The non-Agent peer is swept as expected
    expect(calls.find((c) => c.id === "read-1")?.isComplete).toBe(true);
    expect(countActiveSubagentCalls(getTestThreadToolCalls("thread-1"))).toBe(
      2,
    );
  });

  it("does not let goal receipts claim current turn response identity", () => {
    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: "thread-1", messageId: "answer-1", content: "The rendering bug is fixed." } as AgentEvent);

    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: "thread-1", messageId: "goal-1", content: "Goal achieved in 19s." } as AgentEvent);

    const rec = readThreadField("thread-1", (record) => record);
    expect(rec.currentTurnMessageId).toBe("answer-1");
    expect(rec.assistantResponseKeys["answer-1"]).toBeDefined();
    expect(rec.assistantResponseKeys["goal-1"]).toBeUndefined();
    expect(rec.messages.map((message) => message.id)).toEqual(["answer-1", "goal-1"]);
  });

  it("keeps near-match goal receipt text as a normal assistant response", () => {
    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: "thread-1", messageId: "answer-1", content: "Goal achieved in 19s. Here is the summary." } as AgentEvent);

    const rec = readThreadField("thread-1", (record) => record);
    expect(rec.currentTurnMessageId).toBe("answer-1");
    expect(rec.assistantResponseKeys["answer-1"]).toBeDefined();
  });

  it("clears active goal state when a goal update is complete", () => {
    useThreadStore.getState().handleAgentEvent({ type: "goalUpdated", threadId: "thread-1", goal: {
          objective: "fix rendering",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
          source: "claude",
          controls: { canInspect: true, canClear: true },
        }, } as AgentEvent);
    expect(readThreadField("thread-1", (record) => record.goal?.status)).toBe("active");

    useThreadStore.getState().handleAgentEvent({ type: "goalUpdated", threadId: "thread-1", goal: {
          objective: "fix rendering",
          status: "complete",
          tokenBudget: null,
          tokensUsed: 10,
          timeUsedSeconds: 19,
          createdAt: 1,
          updatedAt: 20,
          source: "codex",
          controls: { canInspect: true, canClear: false },
        }, } as AgentEvent);

    expect(readThreadField("thread-1", (record) => record.goal)).toBeNull();
  });

  it("clears active goal state when a goalCleared event arrives", () => {
    useThreadStore.getState().handleAgentEvent({ type: "goalUpdated", threadId: "thread-1", goal: {
          objective: "say hi",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
          source: "codex",
          controls: { canInspect: true, canClear: true },
        }, } as AgentEvent);
    expect(readThreadField("thread-1", (record) => record.goal?.objective)).toBe("say hi");

    useThreadStore.getState().handleAgentEvent({ type: "goalCleared", threadId: "thread-1", providerId: "codex", reason: "completed" } as AgentEvent);

    expect(readThreadField("thread-1", (record) => record.goal)).toBeNull();
  });
});
