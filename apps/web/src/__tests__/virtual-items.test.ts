import { describe, it, expect } from "vitest";
import {
  buildStableItems,
  buildVolatileItems,
  buildVirtualItems,
  createVolatileItemsBuilder,
  createVirtualItemsBuilder,
  estimateItemHeight,
  STREAMING_CARD_COLLAPSED_HEIGHT,
  assistantMessageItemKey,
  liveFinalResponseItemKey,
} from "@/features/conversation/messages/virtual-items";
import type { ChatVirtualItem } from "@/features/conversation/messages/virtual-items";
import type { ThoughtSegment } from "@/features/conversation/narrative/types";
import type { Message, ToolCall, HookExecution, ToolCallRecord, HookExecutionRecord } from "@/transport/types";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    role: "assistant",
    content: "Hello world",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: "2026-01-01T00:00:00Z",
    sequence: 1,
    attachments: null,
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc-1",
    toolName: "Read",
    toolInput: {},
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
}

function makeToolRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "record-tool-1",
    message_id: "a1",
    parent_tool_call_id: null,
    tool_name: "Read",
    input_summary: "",
    output_summary: "",
    status: "completed",
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:00:01Z",
    sort_order: 1,
    ...overrides,
  };
}

function makeHookRecord(overrides: Partial<HookExecutionRecord> = {}): HookExecutionRecord {
  return {
    id: "hook-1",
    message_id: "a1",
    hook_name: "PreToolUse",
    tool_name: "Bash",
    phase: "permission",
    payload: "{}",
    duration_ms: 12,
    did_block: false,
    started_at: "2026-01-01T00:00:00Z",
    ended_at: "2026-01-01T00:00:00.012Z",
    sort_order: 1,
    ...overrides,
  };
}

/** Helper: build virtual items from raw inputs using the 3-function API. */
function buildAll(
  messages: readonly Message[],
  toolCalls: readonly ToolCall[],
  streamingText: string | undefined,
  isAgentRunning: boolean,
  agentStartTime: number | undefined,
): ChatVirtualItem[] {
  const stable = buildStableItems(messages);
  const volatile = buildVolatileItems(toolCalls, isAgentRunning, agentStartTime, streamingText);
  return buildVirtualItems(stable, volatile, toolCalls.length > 0);
}

describe("buildStableItems", () => {
  it("does not emit empty persisted chrome before records are loaded", () => {
    const messages: Message[] = [
      makeMessage({ id: "u1", role: "user", content: "hi" }),
      makeMessage({ id: "a1", role: "assistant", content: "hello" }),
    ];
    const items = buildStableItems(messages);
    expect(items.map((i) => i.type)).toEqual(["message", "message"]);
  });

  it("emits persisted chrome only for visible loaded rows", () => {
    const messages: Message[] = [
      makeMessage({ id: "u1", role: "user", content: "hi" }),
      makeMessage({ id: "a1", role: "assistant", content: "hello" }),
    ];
    const items = buildStableItems(messages, undefined, undefined, undefined, {
      a1: {
        tools: [makeToolRecord({ message_id: "a1" })],
        thoughts: [],
        hooks: [makeHookRecord({ message_id: "a1", phase: "stop", sort_order: 2 })],
      },
    });
    expect(items.filter((i) => i.type === "persisted-narrative")).toHaveLength(1);
    expect(items.filter((i) => i.type === "persisted-late-hooks")).toHaveLength(1);
    expect(items.filter((i) => i.type === "persisted-turn-footer")).toHaveLength(1);
  });

  it("renders stop-only persisted hooks after the assistant message", () => {
    const messages: Message[] = [
      makeMessage({ id: "u1", role: "user", content: "hi" }),
      makeMessage({ id: "a1", role: "assistant", content: "hello" }),
    ];
    const items = buildStableItems(messages, undefined, undefined, undefined, {
      a1: {
        tools: [],
        thoughts: [],
        hooks: [makeHookRecord({ message_id: "a1", phase: "stop" })],
      },
    });

    expect(items.map((i) => i.type)).toEqual([
      "message",
      "message",
      "persisted-late-hooks",
    ]);
  });

  it("emits a completed-turn footer from canonical summary data", () => {
    const messages: Message[] = [
      makeMessage({ id: "u1", role: "user", content: "hi" }),
      makeMessage({ id: "a1", role: "assistant", content: "hello" }),
    ];
    const items = buildStableItems(messages, undefined, undefined, undefined, undefined, {
      a1: {
        counts: { steps: 1, thoughts: 0, subagents: 0 },
        durationMs: 1_250,
      },
    });

    expect(items.at(-1)).toEqual({
      key: "persisted-turn-footer-a1",
      type: "persisted-turn-footer",
      messageId: "a1",
      summary: {
        counts: { steps: 1, thoughts: 0, subagents: 0 },
        durationMs: 1_250,
      },
    });
  });
});

describe("final response item keys", () => {
  it("derives the same key before and after the assistant message persists", () => {
    const liveKey = liveFinalResponseItemKey("thread-1", "turn-response:thread-1:abc");
    const persistedKey = assistantMessageItemKey(
      makeMessage({ id: "persisted-msg", thread_id: "thread-1" }),
      {
        threadId: "thread-1",
        messageId: "persisted-msg",
        responseKey: "turn-response:thread-1:abc",
      },
    );

    expect(persistedKey).toBe(liveKey);
  });

  it("falls back to the persisted message id outside the active turn", () => {
    expect(assistantMessageItemKey(makeMessage({ id: "persisted-msg" }))).toBe(
      "persisted-msg",
    );
  });

  it("keeps the inherited key after the active turn marker is cleared", () => {
    const persistedKey = assistantMessageItemKey(
      makeMessage({ id: "persisted-msg", thread_id: "thread-1" }),
      {
        threadId: "thread-1",
        responseKeysByMessageId: {
          "persisted-msg": "turn-response:thread-1:abc",
        },
      },
    );

    expect(persistedKey).toBe("turn-response:thread-1:abc");
  });
});

describe("buildVolatileItems", () => {
  it("returns narrative-flow item when agent is running with tool calls", () => {
    const toolCalls = [makeToolCall({ id: "t1" })];
    const items = buildVolatileItems(toolCalls, true, 1000, undefined);
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<(typeof items)[number], { type: "narrative-flow" }> | undefined;
    expect(narrativeItem).toBeDefined();
    expect(narrativeItem?.isAgentRunning).toBe(true);
    expect(narrativeItem?.toolCalls).toHaveLength(1);
  });

  it("returns empty array when no tool calls and agent not running", () => {
    const items = buildVolatileItems([], false, undefined, undefined);
    expect(items).toHaveLength(0);
  });

  it("returns empty array when streaming text is present but agent not running and no tool calls", () => {
    // With the narrative-flow consolidation, streaming text alone (no active agent, no tool calls)
    // does not produce a volatile item.
    const items = buildVolatileItems([], false, undefined, "partial...");
    expect(items).toHaveLength(0);
  });

  it("keeps final-response text in the live assistant item when agent is running", () => {
    const items = buildVolatileItems([], true, 1000, "streaming...");
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<(typeof items)[number], { type: "narrative-flow" }> | undefined;
    expect(narrativeItem).toBeDefined();
    expect(narrativeItem?.streamingText).toBe("");
    expect(narrativeItem?.isAgentRunning).toBe(true);
    const liveMessage = items.find((i) => i.type === "message" && i.assistantState?.isStreaming) as Extract<(typeof items)[number], { type: "message" }> | undefined;
    expect(liveMessage?.message.content).toBe("streaming...");
  });

  it("passes thoughtSegments through on narrative-flow items", () => {
    const thoughtSegments: ThoughtSegment[] = [{ text: "planning", startedAt: 42, endedAt: 100 }];
    const items = buildVolatileItems([makeToolCall({ id: "t1" })], true, 1000, undefined, undefined, [], thoughtSegments);
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<
      (typeof items)[number],
      { type: "narrative-flow" }
    >;
    expect(narrativeItem?.thoughtSegments).toEqual(thoughtSegments);
  });

  it("does not emit a live assistant message for explicit non-final narration", () => {
    const thoughtSegments: ThoughtSegment[] = [
      { text: "codex narration", startedAt: 42, isExplicitNonFinal: true },
    ];
    const items = buildVolatileItems(
      [],
      true,
      1000,
      "codex narration",
      undefined,
      [],
      thoughtSegments,
    );

    expect(
      items.some(
        (i) =>
          i.type === "message" &&
          i.message.role === "assistant" &&
          i.assistantState?.isStreaming,
      ),
    ).toBe(false);
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<
      (typeof items)[number],
      { type: "narrative-flow" }
    >;
    expect(narrativeItem?.thoughtSegments).toEqual(thoughtSegments);
  });

  it("memoized builder returns the same volatile item references for unchanged inputs", () => {
    const build = createVolatileItemsBuilder();
    const toolCalls = [makeToolCall({ id: "t1", isComplete: true })];
    const hooks: HookExecution[] = [];
    const thoughtSegments: ThoughtSegment[] = [];
    const currentTurn = {
      threadId: "thread-1",
      responseKey: "turn-response:thread-1:stable",
    };

    const first = build(
      toolCalls,
      true,
      1000,
      "answer",
      undefined,
      hooks,
      thoughtSegments,
      currentTurn,
    );
    const second = build(
      toolCalls,
      true,
      1000,
      "answer",
      undefined,
      hooks,
      thoughtSegments,
      currentTurn,
    );

    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
  });

  it("memoized builder changes only the live typing item on final-response text deltas", () => {
    const build = createVolatileItemsBuilder();
    const toolCalls = [makeToolCall({ id: "t1", isComplete: true })];
    const hooks: HookExecution[] = [];
    const thoughtSegments: ThoughtSegment[] = [];
    const currentTurn = {
      threadId: "thread-1",
      responseKey: "turn-response:thread-1:typing",
    };

    const first = build(
      toolCalls,
      true,
      1000,
      "answer one",
      undefined,
      hooks,
      thoughtSegments,
      currentTurn,
    );
    const second = build(
      toolCalls,
      true,
      1000,
      "answer two",
      undefined,
      hooks,
      thoughtSegments,
      currentTurn,
    );

    expect(second).not.toBe(first);
    expect(second.find((item) => item.type === "narrative-flow")).toBe(
      first.find((item) => item.type === "narrative-flow"),
    );
    expect(second.find((item) => item.type === "narrative-indicator")).toBe(
      first.find((item) => item.type === "narrative-indicator"),
    );
    expect(
      second.find((item) => item.type === "message" && item.assistantState?.isStreaming),
    ).not.toBe(
      first.find((item) => item.type === "message" && item.assistantState?.isStreaming),
    );
  });
});

describe("buildVirtualItems (combined)", () => {
  it("memoized splicer returns the same array for unchanged stable and volatile inputs", () => {
    const build = createVirtualItemsBuilder();
    const stable = buildStableItems([makeMessage({ id: "msg-1" })]);
    const volatile = buildVolatileItems([], true, 1000, "typing");

    const first = build(stable, volatile, false);
    const second = build(stable, volatile, false);

    expect(second).toBe(first);
  });

  it("memoized splicer keeps new order when same-key items reorder", () => {
    const build = createVirtualItemsBuilder();
    const firstStable = buildStableItems([
      makeMessage({ id: "msg-1", role: "user", content: "First", sequence: 1 }),
      makeMessage({ id: "msg-2", role: "user", content: "Second", sequence: 2 }),
    ]);
    const secondStable = buildStableItems([
      makeMessage({ id: "msg-2", role: "user", content: "Second", sequence: 2 }),
      makeMessage({ id: "msg-1", role: "user", content: "First", sequence: 1 }),
    ]);

    build(firstStable, [], false);
    const second = build(secondStable, [], false);

    expect(second.map((item) => item.key)).toEqual(["msg-2", "msg-1"]);
  });

  it("memoized splicer does not swallow message metadata-only updates", () => {
    const build = createVirtualItemsBuilder();
    const firstStable = buildStableItems([
      makeMessage({ id: "msg-1", model: "claude-old", tokens_used: 1 }),
    ]);
    const secondStable = buildStableItems([
      makeMessage({ id: "msg-1", model: "claude-new", tokens_used: 2 }),
    ]);

    const first = build(firstStable, [], false);
    const second = build(secondStable, [], false);
    const firstMessage = first.find((item) => item.type === "message") as
      | Extract<ChatVirtualItem, { type: "message" }>
      | undefined;
    const secondMessage = second.find((item) => item.type === "message") as
      | Extract<ChatVirtualItem, { type: "message" }>
      | undefined;

    expect(second).not.toBe(first);
    expect(secondMessage).not.toBe(firstMessage);
    expect(secondMessage?.message.model).toBe("claude-new");
    expect(secondMessage?.message.tokens_used).toBe(2);
  });

  it("empty messages returns empty array", () => {
    const result = buildAll([], [], undefined, false, undefined);
    expect(result).toEqual([]);
  });

  it("messages only: one 'message' item per message when persisted records are missing", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1 }), // assistant by default
      makeMessage({ id: "msg-2", sequence: 2, role: "user", content: "Hi" }),
    ];
    const result = buildAll(messages, [], undefined, false, undefined);
    expect(result.map((i) => i.type)).toEqual(["message", "message"]);
    expect(result[0]).toMatchObject({ type: "message", key: "msg-1" });
    expect(result[1]).toMatchObject({ type: "message", key: "msg-2" });
  });

  it("active tool calls split the last assistant message after the narrative-flow item", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "user", content: "start" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "assistant", content: "thinking" }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-1" })];
    const result = buildAll(messages, toolCalls, undefined, false, undefined);

    const types = result.map((item) => item.type);
    // Persisted chrome is absent until records load and contain visible rows.
    // The narrative-indicator lingers after the turn (isAgentRunning=false,
    // tool calls still volatile) so it can play its exit transition, and sits
    // right after the bubble.
    expect(types).toEqual([
      "message",
      "narrative-flow",
      "message",
      "narrative-indicator",
    ]);
    expect(result[0]).toMatchObject({ type: "message", key: "msg-1" });
    expect(result[1]).toMatchObject({ type: "narrative-flow" });
    expect(result[2]).toMatchObject({ type: "message", key: "msg-2" });
    expect(result[3]).toMatchObject({ type: "narrative-indicator", isAgentRunning: false });
  });

  it("streaming text with agent running emits narrative-flow and live assistant message items", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const result = buildAll(messages, [], "partial response...", true, undefined);

    const narrative = result.find((i) => i.type === "narrative-flow") as
      | (ChatVirtualItem & { type: "narrative-flow" })
      | undefined;
    expect(narrative).toBeDefined();
    expect(narrative?.streamingText).toBe("");

    // The streaming text also surfaces as a provisional assistant message so
    // the persisted MessageBubble keeps the same component and key.
    const streaming = result.find(
      (i) => i.type === "message" && i.message.role === "assistant" && i.assistantState?.isStreaming,
    ) as
      | (ChatVirtualItem & { type: "message" })
      | undefined;
    expect(streaming).toBeDefined();
    expect(streaming?.message.content).toBe("partial response...");
  });

  it("does not duplicate the current assistant response key after persistence", () => {
    const responseKey = "turn-response:thread-1:response-1";
    const messages = [
      makeMessage({ id: "u1", sequence: 1, role: "user", content: "start" }),
      makeMessage({ id: "a1", sequence: 2, role: "assistant", content: "persisted response" }),
    ];
    const stable = buildStableItems(messages, undefined, null, {
      threadId: "thread-1",
      messageId: "a1",
      responseKey,
      responseKeysByMessageId: { a1: responseKey },
    });
    const volatile = buildVolatileItems(
      [makeToolCall({ id: "tc-1", isComplete: true })],
      true,
      1000,
      "live response",
      undefined,
      undefined,
      undefined,
      {
        threadId: "thread-1",
        messageId: "a1",
        responseKey,
        responseKeysByMessageId: { a1: responseKey },
      },
    );

    const result = buildVirtualItems(stable, volatile, true);
    const responseItems = result.filter((item) => item.key === responseKey);

    expect(responseItems).toHaveLength(1);
    expect(responseItems[0]).toMatchObject({
      type: "message",
      message: { id: "a1", content: "persisted response" },
      assistantState: { isStreaming: false },
    });
  });

  it("drops duplicate live response keys even when no tools are present", () => {
    const responseKey = "turn-response:thread-1:response-2";
    const messages = [
      makeMessage({ id: "a1", sequence: 1, role: "assistant", content: "persisted response" }),
    ];
    const stable = buildStableItems(messages, undefined, null, {
      threadId: "thread-1",
      messageId: "a1",
      responseKey,
      responseKeysByMessageId: { a1: responseKey },
    });
    const volatile = buildVolatileItems(
      [],
      true,
      1000,
      "live response",
      undefined,
      undefined,
      undefined,
      {
        threadId: "thread-1",
        messageId: "a1",
        responseKey,
        responseKeysByMessageId: { a1: responseKey },
      },
    );

    const result = buildVirtualItems(stable, volatile, false);

    expect(result.filter((item) => item.key === responseKey)).toHaveLength(1);
    expect(
      result.some(
        (item) =>
          item.type === "message" &&
          item.assistantState?.isStreaming &&
          item.key === responseKey,
      ),
    ).toBe(false);
  });

  it("orders narrative-flow → live assistant message → narrative-indicator when agent is running with streaming text", () => {
    // Regression for the bug where the indicator sat ABOVE the typewriter
    // streaming. The fix gives the indicator its own virtual-item slot below
    // the live assistant message so the writing animation reads as the primary
    // surface and the progress meta sits underneath it.
    const messages = [makeMessage({ id: "msg-1" })];
    const result = buildAll(messages, [], "writing animation text...", true, 1000);

    const narrativeFlowIdx = result.findIndex((i) => i.type === "narrative-flow");
    const streamingResponseIdx = result.findIndex(
      (i) => i.type === "message" && i.message.role === "assistant" && i.assistantState?.isStreaming,
    );
    const indicatorIdx = result.findIndex((i) => i.type === "narrative-indicator");

    expect(narrativeFlowIdx).toBeGreaterThanOrEqual(0);
    expect(streamingResponseIdx).toBeGreaterThan(narrativeFlowIdx);
    expect(indicatorIdx).toBeGreaterThan(streamingResponseIdx);
  });

  it("indicator stepCount counts top-level tools only, not thought segments", () => {
    const toolCalls: ToolCall[] = [
      makeToolCall({ id: "tc-1", toolName: "Read" }),
      makeToolCall({ id: "tc-2", toolName: "Bash" }),
    ];
    const thoughtSegments: ThoughtSegment[] = [
      { text: "preamble one", startedAt: 1, endedAt: 2 },
      { text: "preamble two", startedAt: 3, endedAt: 4 },
    ];
    const items = buildVolatileItems(
      toolCalls,
      true,
      1000,
      undefined,
      undefined,
      undefined,
      thoughtSegments,
    );
    const indicator = items.find((i) => i.type === "narrative-indicator") as
      | (ChatVirtualItem & { type: "narrative-indicator" })
      | undefined;
    expect(indicator?.stepCount).toBe(2);
  });

  it("indicator subagentCount counts all dispatched Agent calls, not only in-flight", () => {
    const toolCalls: ToolCall[] = [
      makeToolCall({ id: "a1", toolName: "Agent", isComplete: true }),
      makeToolCall({ id: "a2", toolName: "Agent", isComplete: false }),
      makeToolCall({ id: "read-1", toolName: "Read", parentToolCallId: "a1" }),
    ];
    const items = buildVolatileItems(toolCalls, true, 1000, undefined);
    const indicator = items.find((i) => i.type === "narrative-indicator") as
      | (ChatVirtualItem & { type: "narrative-indicator" })
      | undefined;
    expect(indicator?.subagentCount).toBe(2);
  });

  it("does not emit a narrative-indicator when not running and no tool calls remain", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const result = buildAll(messages, [], undefined, false, undefined);
    expect(result.some((i) => i.type === "narrative-indicator")).toBe(false);
  });

  it("keeps the narrative-indicator (isAgentRunning=false) while tool calls are still volatile", () => {
    // Regression for issue #695: removing the indicator item at turnComplete
    // made it vanish in a single frame. It now stays emitted through the
    // turn's volatile tail so NarrativeIndicator can animate out; the
    // component renders null once the exit completes.
    const toolCalls = [makeToolCall({ id: "tc-1", isComplete: true })];
    const items = buildVolatileItems(toolCalls, false, 1000, undefined);
    const indicator = items.find((i) => i.type === "narrative-indicator") as
      | (ChatVirtualItem & { type: "narrative-indicator" })
      | undefined;
    expect(indicator).toBeDefined();
    expect(indicator?.isAgentRunning).toBe(false);
  });

  it("indicator (running, no streaming) appends narrative-flow followed by narrative-indicator", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const startTime = 12345;
    const result = buildAll(messages, [], undefined, true, startTime);

    const narrativeFlowIdx = result.findIndex((i) => i.type === "narrative-flow");
    const narrativeIndicatorIdx = result.findIndex(
      (i) => i.type === "narrative-indicator",
    );
    expect(narrativeFlowIdx).toBeGreaterThanOrEqual(0);
    expect(narrativeIndicatorIdx).toBeGreaterThan(narrativeFlowIdx);

    const narrativeItem = result[narrativeFlowIdx] as ChatVirtualItem & {
      type: "narrative-flow";
    };
    expect(narrativeItem.startTime).toBe(startTime);
    expect(narrativeItem.isAgentRunning).toBe(true);

    const indicatorItem = result[narrativeIndicatorIdx] as ChatVirtualItem & {
      type: "narrative-indicator";
    };
    expect(indicatorItem.startTime).toBe(startTime);
  });

  it("omits persisted chrome for unloaded assistant narrative records", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "user", content: "hi" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "assistant", content: "done" }),
    ];
    const result = buildAll(messages, [], undefined, false, undefined);
    expect(result.map((item) => item.type)).toEqual(["message", "message"]);
  });

  it("includes narrative-flow with both streaming and running state when agent running and streaming", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const result = buildAll(messages, [], "streaming...", true, undefined);

    const types = result.map((item) => item.type);
    expect(types).toContain("narrative-flow");
    const narrative = result.find((i) => i.type === "narrative-flow") as (ChatVirtualItem & { type: "narrative-flow" }) | undefined;
    expect(narrative?.streamingText).toBe("");
    expect(narrative?.isAgentRunning).toBe(true);
  });

  it("does not split when last message is not assistant role", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "assistant", content: "ok" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "user", content: "next prompt" }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-1" })];
    const result = buildAll(messages, toolCalls, undefined, false, undefined);

    // Persisted chrome is absent until loaded records contain visible rows.
    // The live narrative is appended at the tail because the trailing message
    // is not an assistant.
    const types = result.map((item) => item.type);
    expect(types).toEqual([
      "message",
      "message",
      "narrative-flow",
      "narrative-indicator",
    ]);
  });

  it("full scenario: messages + tools + streaming", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "user", content: "please help" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "assistant", content: "reading files" }),
    ];
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "Read" }),
      makeToolCall({ id: "tc-2", toolName: "Write" }),
    ];
    const result = buildAll(messages, toolCalls, "Here is my answer...", true, 99999);

    const types = result.map((item) => item.type);
    // user msg, narrative-flow (before split assistant msg), split assistant
    // msg, narrative-indicator (status footer below the response — it stays
    // under the bubble through the persist swap so its exit transition plays
    // in place). Persisted chrome is absent until records load.
    // live assistant response is suppressed because a tool is still running —
    // `computeLiveStreamingText` returns "" while any top-level tool is in
    // flight, since the model isn't streaming user-facing text during tool
    // execution. persisted-turn-footer is NOT suppressed because it sits
    // AFTER the bubble; it owns the post-response summary that closes the
    // turn.
    expect(types).toEqual([
      "message",
      "narrative-flow",
      "message",
      "narrative-indicator",
    ]);
    expect(result[0]).toMatchObject({ key: "msg-1" });
    expect(result[2]).toMatchObject({ key: "msg-2" });
    const narrativeItem = result[1] as ChatVirtualItem & { type: "narrative-flow" };
    expect(narrativeItem.toolCalls).toHaveLength(2);
    expect(narrativeItem.streamingText).toBe("Here is my answer...");
    expect(narrativeItem.isAgentRunning).toBe(true);
  });

  it("keeps a trailing answered plan-questions bubble ABOVE the live generation turn", () => {
    // Regression: answering plan questions creates no user message, so the
    // trailing stable item is the plan-questions assistant bubble (rendered as
    // the collapsed AnsweredSummary). That is a COMPLETED prior turn — the next
    // turn generates the plan. The in-flight narrative must append AFTER the
    // answered-questions bubble, preserving chronological order (questions
    // answered → new turn's actions → response), not split in ABOVE it.
    const messages = [
      makeMessage({ id: "u1", sequence: 1, role: "user", content: "build X" }),
      makeMessage({
        id: "a1",
        sequence: 2,
        role: "assistant",
        content: "```plan-questions\n[]\n```",
      }),
    ];
    // A completed top-level tool lets the live plan-output text stream through
    // computeLiveStreamingText, mirroring the real generation turn.
    const toolCalls = [makeToolCall({ id: "tc-1", isComplete: true })];
    const result = buildAll(messages, toolCalls, "## Plan\n\n1. do it", true, 1000);

    const a1Idx = result.findIndex((i) => i.type === "message" && i.key === "a1");
    const narrativeIdx = result.findIndex((i) => i.type === "narrative-flow");
    const streamingIdx = result.findIndex(
      (i) => i.type === "message" && i.message.role === "assistant" && i.assistantState?.isStreaming,
    );

    expect(a1Idx).toBeGreaterThanOrEqual(0);
    expect(narrativeIdx).toBeGreaterThan(a1Idx);
    expect(streamingIdx).toBeGreaterThan(a1Idx);
  });

  it("still splits before a trailing plan-output message so its narrative sits above it", () => {
    // A persisted plan-output-only message is suppressed by MessageBubble. Its own
    // turn's narrative legitimately belongs ABOVE it, so the split must still
    // apply here — only plan-questions bubbles are excluded.
    const messages = [
      makeMessage({ id: "u1", sequence: 1, role: "user", content: "build X" }),
      makeMessage({
        id: "a1",
        sequence: 2,
        role: "assistant",
        content: "```plan-output\n{}\n```",
      }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-1" })];
    const result = buildAll(messages, toolCalls, undefined, false, undefined);

    const a1Idx = result.findIndex((i) => i.type === "message" && i.key === "a1");
    const narrativeIdx = result.findIndex((i) => i.type === "narrative-flow");
    expect(narrativeIdx).toBeGreaterThanOrEqual(0);
    expect(narrativeIdx).toBeLessThan(a1Idx);
  });

  it("narrative-flow is present when live tool calls exist", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "assistant", content: "done" }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-1" })];
    const result = buildAll(messages, toolCalls, undefined, false, undefined);

    expect(result.map((item) => item.type)).toContain("narrative-flow");
  });
});

function makeHook(overrides: Partial<HookExecution> = {}): HookExecution {
  return {
    hookName: "pre-commit",
    hookType: "permission",
    status: "running",
    outputLines: [],
    fullOutput: [],
    startedAt: 1000,
    ...overrides,
  };
}

describe("buildVolatileItems with hooks", () => {
  it("includes hooks inside narrative-flow when agent is running and hooks are present", () => {
    const hooks = [makeHook()];
    const items = buildVolatileItems([], true, 1000, undefined, undefined, hooks);
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<(typeof items)[number], { type: "narrative-flow" }> | undefined;
    expect(narrativeItem).toBeDefined();
    expect(narrativeItem?.hooks).toHaveLength(1);
  });

  it("omits narrative-flow when no tool calls and agent not running (even with hooks)", () => {
    // Hooks alone (without agent running or tool calls) do not trigger a narrative-flow item.
    const hooks = [makeHook()];
    const items = buildVolatileItems([], false, undefined, undefined, undefined, hooks);
    expect(items.some((i) => i.type === "narrative-flow")).toBe(false);
  });

  it("narrative-flow appears before permission-request items", () => {
    const hooks = [makeHook()];
    const permissions = [{ requestId: "p1", toolName: "Edit", settled: false }];
    const items = buildVolatileItems([], true, 1000, undefined, permissions, hooks);
    const types = items.map((i) => i.type);
    const narrativeIdx = types.indexOf("narrative-flow");
    const permIdx = types.indexOf("permission-request");
    expect(narrativeIdx).toBeLessThan(permIdx);
  });

  it("narrative-flow item carries the hooks array", () => {
    const hooks = [makeHook({ hookName: "lint" }), makeHook({ hookName: "test", status: "completed", exitCode: 0, durationMs: 150 })];
    const items = buildVolatileItems([], true, 1000, undefined, undefined, hooks);
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<(typeof items)[number], { type: "narrative-flow" }>;
    expect(narrativeItem.hooks).toHaveLength(2);
    expect(narrativeItem.hooks[0].hookName).toBe("lint");
  });
});

describe("estimateItemHeight", () => {
  it("system message returns 40", () => {
    const item: ChatVirtualItem = {
      key: "sys-1",
      type: "message",
      message: makeMessage({ role: "system", content: "You are an assistant." }),
    };
    expect(estimateItemHeight(item)).toBe(40);
  });

  it("short user message returns compact height (>= 74, < 200)", () => {
    const item: ChatVirtualItem = {
      key: "user-1",
      type: "message",
      message: makeMessage({ role: "user", content: "Hello!" }),
    };
    const height = estimateItemHeight(item);
    expect(height).toBeGreaterThanOrEqual(74);
    expect(height).toBeLessThan(200);
  });

  it("long assistant message returns taller estimate (> 200)", () => {
    const longContent = "This is a very long response. ".repeat(30);
    const item: ChatVirtualItem = {
      key: "asst-1",
      type: "message",
      message: makeMessage({ role: "assistant", content: longContent }),
    };
    const height = estimateItemHeight(item);
    expect(height).toBeGreaterThan(200);
  });

  it("many tool calls height capped at 400", () => {
    const toolCalls = Array.from({ length: 20 }, (_, i) =>
      makeToolCall({ id: `tc-${i}` }),
    );
    const item: ChatVirtualItem = {
      key: "active-tools",
      type: "active-tools",
      toolCalls,
    };
    expect(estimateItemHeight(item)).toBe(400);
  });

  it("indicator returns 48", () => {
    const item: ChatVirtualItem = {
      key: "indicator",
      type: "indicator",
      startTime: undefined,
      activeToolCalls: [],
    };
    expect(estimateItemHeight(item)).toBe(48);
  });

  it("streaming item returns 56", () => {
    const item: ChatVirtualItem = {
      key: "streaming",
      type: "streaming",
      text: "Hello world",
    };
    expect(estimateItemHeight(item)).toBe(STREAMING_CARD_COLLAPSED_HEIGHT);
  });

  it("estimates the streaming slot and the persisted assistant bubble identically", () => {
    // Regression for issue #695: the streaming provisional bubble and the
    // persisted assistant message share a virtual-item key and render the
    // same chrome, so their estimates must match — a difference reflows the
    // virtualizer and nudges the scroll position at persist time.
    const content = "A response body.\n\nWith a second paragraph and a list:\n- one\n- two\n";
    const streaming: ChatVirtualItem = {
      key: "turn-response:thread-1:abc",
      type: "message",
      message: makeMessage({ content }),
      assistantState: { isStreaming: true, actionsVisible: false },
    };
    const persisted: ChatVirtualItem = {
      key: "turn-response:thread-1:abc",
      type: "message",
      message: makeMessage({ content }),
      assistantState: { isStreaming: false, actionsVisible: true },
    };
    expect(estimateItemHeight(streaming)).toBe(estimateItemHeight(persisted));
  });
});
