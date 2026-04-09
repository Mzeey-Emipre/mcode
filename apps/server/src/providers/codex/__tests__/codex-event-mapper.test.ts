import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { CodexEventMapper } from "../codex-event-mapper.js";

describe("CodexEventMapper", () => {
  let mapper: CodexEventMapper;

  beforeEach(() => {
    vi.clearAllMocks();
    mapper = new CodexEventMapper("test-thread");
  });

  it("emits textDelta for agent_message with new text", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "Hello" },
    });

    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Hello" },
    ]);
  });

  it("accumulates text and emits only new suffix on subsequent messages", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "Hello" },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "Hello world" },
    });

    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: " world" },
    ]);
  });

  it("returns empty array when agent_message has no new text", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "Hello" },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "Hello" },
    });

    expect(events).toEqual([]);
  });

  it("emits toolUse + toolResult for command_execution", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: {
        type: "command_execution",
        id: "cmd-1",
        command: "ls",
        aggregated_output: "file.txt",
        exit_code: 0,
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "toolUse",
      threadId: "test-thread",
      toolCallId: "cmd-1",
      toolName: "command_execution",
      toolInput: { command: "ls" },
    });
    expect(events[1]).toEqual({
      type: "toolResult",
      threadId: "test-thread",
      toolCallId: "cmd-1",
      output: "file.txt",
      isError: false,
    });
  });

  it("isError true when exit_code is nonzero", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: {
        type: "command_execution",
        id: "cmd-1",
        command: "ls",
        aggregated_output: "error output",
        exit_code: 1,
      },
    });

    const toolResult = events[1];
    expect(toolResult).toMatchObject({ type: "toolResult", isError: true });
  });

  it("emits toolUse + toolResult for file_change", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: {
        type: "file_change",
        id: "fc-1",
        changes: [{ path: "src/foo.ts", kind: "modified" }],
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "fc-1",
      toolName: "file_change",
      toolInput: { files: "src/foo.ts" },
    });
    expect(events[1]).toMatchObject({
      type: "toolResult",
      toolCallId: "fc-1",
      isError: false,
      output: "src/foo.ts",
    });
  });

  it("emits toolUse + toolResult for mcp_tool_call", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: {
        type: "mcp_tool_call",
        id: "mcp-1",
        server: "myserver",
        tool: "runQuery",
        arguments: { q: "test" },
        result: "42",
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "mcp-1",
      toolName: "mcp:myserver/runQuery",
      toolInput: { q: "test" },
    });
    expect(events[1]).toMatchObject({
      type: "toolResult",
      toolCallId: "mcp-1",
      isError: false,
      output: "42",
    });
  });

  it("emits error event with isError true for mcp_tool_call with error field", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: {
        type: "mcp_tool_call",
        id: "mcp-1",
        server: "myserver",
        tool: "runQuery",
        arguments: {},
        error: "something failed",
      },
    });

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "toolResult",
      isError: true,
      output: "something failed",
    });
  });

  it("returns empty array for reasoning, web_search, todo_list", () => {
    const reasoningEvents = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "reasoning" },
    });
    expect(reasoningEvents).toEqual([]);

    const webSearchEvents = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "web_search" },
    });
    expect(webSearchEvents).toEqual([]);

    const todoListEvents = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "todo_list" },
    });
    expect(todoListEvents).toEqual([]);
  });

  it("returns error event for turn.event/error", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "error", message: "something went wrong", willRetry: true },
    });

    expect(events).toEqual([
      { type: "error", threadId: "test-thread", error: "something went wrong" },
    ]);
  });

  it("returns message + turnComplete for turn.completed", () => {
    // Set lastAssistantText by sending an agent_message first
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "Hello world" },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.completed",
      params: {
        threadId: "test-thread",
        usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 20 },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "message",
      threadId: "test-thread",
      content: "Hello world",
      tokens: null,
    });
    expect(events[1]).toEqual({
      type: "turnComplete",
      threadId: "test-thread",
      reason: "end_turn",
      costUsd: null,
      tokensIn: 15,
      tokensOut: 20,
      contextWindow: undefined,
      totalProcessedTokens: 35,
    });
  });

  it("returns error event for turn.failed", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.failed",
      params: {
        threadId: "test-thread",
        error: { message: "turn failed!" },
      },
    });

    expect(events).toEqual([
      { type: "error", threadId: "test-thread", error: "turn failed!" },
    ]);
  });

  it("reset clears text accumulator", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "Hello" },
    });

    mapper.reset();

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "Hello" },
    });

    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Hello" },
    ]);
  });

  it("returns empty array for unrecognized turn.event type", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      // Cast to bypass TypeScript's exhaustive check in tests
      params: { type: "unknown_type" } as never,
    });

    expect(events).toEqual([]);
  });

  it("returns empty array and warns when agent_message text is not a suffix extension", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "Hello" },
    });
    // Send a completely different text (not a suffix of "Hello")
    const result = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "World" },
    });
    expect(result).toHaveLength(0);
    // Subsequent turn.completed should use the replaced text
    const completedEvents = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.completed",
      params: { threadId: "test-thread", usage: {} },
    });
    const msgEvent = completedEvents.find((e) => e.type === "message");
    expect(msgEvent).toBeDefined();
    expect((msgEvent as { content: string }).content).toBe("World");
  });

  it("omits message event in turn.completed when no text was accumulated", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn.completed",
      params: { threadId: "test-thread", usage: { input_tokens: 5, output_tokens: 3 } },
    });
    // Should have only turnComplete, no message event
    expect(events.some((e) => e.type === "message")).toBe(false);
    expect(events.some((e) => e.type === "turnComplete")).toBe(true);
  });
});
