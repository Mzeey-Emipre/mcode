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

  // ---------------------------------------------------------------------------
  // Lifecycle / silently-consumed notifications
  // ---------------------------------------------------------------------------

  it("returns empty array for turn/started", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {},
    });
    expect(events).toEqual([]);
  });

  it("emits Agent toolUse for item/started collabAgentToolCall", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "t",
        turnId: "u",
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          prompt: "Review security",
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "collab-1",
      toolName: "Agent",
      toolInput: { codexCollabKind: "spawnAgent", prompt: "Review security" },
    });
  });

  it("emits running toolUse for item/started commandExecution", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "x" } },
    });
    expect(events).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "x",
        toolName: "command_execution",
        toolInput: {},
      },
    ]);
  });

  it("emits live command start, enriched command use, then command result", () => {
    const started = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd-live" } },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-live",
          command: "echo hi",
          aggregatedOutput: "hi\n",
          exitCode: 0,
        },
      },
    });

    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "cmd-live",
        toolName: "command_execution",
        toolInput: {},
      },
    ]);
    expect(completed).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "cmd-live",
        toolName: "command_execution",
        toolInput: { command: "echo hi" },
      },
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "cmd-live",
        output: "hi\n",
        isError: false,
      },
    ]);
  });

  it("emits only toolResult at completion when command start already had full details", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd-known", command: "echo hi" } },
    });

    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-known",
          command: "echo hi",
          aggregatedOutput: "hi\n",
          exitCode: 0,
        },
      },
    });

    expect(completed).toEqual([
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "cmd-known",
        output: "hi\n",
        isError: false,
      },
    ]);
  });

  it("enriches sparse mcpToolCall start from completion details", () => {
    const started = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "mcpToolCall", id: "mcp-live" } },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "mcpToolCall",
          id: "mcp-live",
          server: "filesystem",
          tool: "read_file",
          arguments: JSON.stringify({ path: "README.md" }),
          result: "contents",
        },
      },
    });

    expect(started).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "mcp-live",
        toolName: "mcp:/unknown",
        toolInput: {},
      },
    ]);
    expect(completed[0]).toEqual({
      type: "toolUse",
      threadId: "test-thread",
      toolCallId: "mcp-live",
      toolName: "mcp:filesystem/read_file",
      toolInput: { path: "README.md" },
    });
    expect(completed[1]).toEqual({
      type: "toolResult",
      threadId: "test-thread",
      toolCallId: "mcp-live",
      output: "contents",
      isError: false,
    });
  });

  it("keeps completed-only commandExecution fallback when no item/started arrived", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-fallback",
          command: "pwd",
          aggregatedOutput: "/repo\n",
          exitCode: 0,
        },
      },
    });

    expect(events).toEqual([
      {
        type: "toolUse",
        threadId: "test-thread",
        toolCallId: "cmd-fallback",
        toolName: "command_execution",
        toolInput: { command: "pwd" },
      },
      {
        type: "toolResult",
        threadId: "test-thread",
        toolCallId: "cmd-fallback",
        output: "/repo\n",
        isError: false,
      },
    ]);
  });

  it("classifies text after completed-only commandExecution as final response", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-fallback",
          command: "pwd",
          aggregatedOutput: "/repo\n",
          exitCode: 0,
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "Done" },
    });

    expect(events).toEqual([
      {
        type: "textDelta",
        threadId: "test-thread",
        delta: "Done",
        isFinalResponse: true,
      },
    ]);
  });

  // ---------------------------------------------------------------------------
  // item/agentMessage/delta – streaming text tokens
  // ---------------------------------------------------------------------------

  it("emits textDelta WITHOUT isFinalResponse for pre-tool item/agentMessage/delta (thought)", () => {
    // No tool has fired this turn yet — every delta is a thought, matching
    // Claude/Cursor's tool-state-based classification.
    const e1 = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "t", turnId: "u", itemId: "i", delta: "Hello" },
    });
    const e2 = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "t", turnId: "u", itemId: "i", delta: "!" },
    });

    expect(e1).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "Hello" }]);
    expect(e2).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "!" }]);
  });

  it("emits textDelta WITH isFinalResponse:true for item/agentMessage/delta after tool completes", () => {
    // Tool fires and completes -> subsequent agentMessage deltas are the final reply.
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd1" } },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "cmd1", command: "echo hi", output: "hi", exitCode: 0 } },
    });
    const evt = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "Done" },
    });
    expect(evt).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "Done", isFinalResponse: true }]);
  });

  it("keeps pre-tool agentMessage delta as thought even while tools run", () => {
    // Some Codex turns interleave: preamble -> tool start -> more text -> tool complete -> final.
    // While a tool is in-flight, deltas are still thoughts (pendingToolItems > 0).
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd1" } },
    });
    const mid = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "thinking..." },
    });
    expect(mid).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "thinking..." }]);
  });

  it("emits Message with full accumulated text on turn/completed after deltas", () => {
    mapper.mapNotification({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "Hello" } as never });
    mapper.mapNotification({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: " world" } as never });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    const msg = events.find((e) => e.type === "message");
    expect(msg).toMatchObject({ type: "message", content: "Hello world" });
  });

  it("returns empty array for item/agentMessage/delta with empty delta", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "" },
    });
    expect(events).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // item/completed – message items (assistant text)
  // ---------------------------------------------------------------------------

  it("emits textDelta for item/completed message with output_text content", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello" }],
        },
      },
    });

    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Hello", isFinalResponse: true },
    ]);
  });

  it("emits textDelta for item/completed message with plain 'text' content type (codex format)", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from codex" }],
        },
      },
    });
    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Hello from codex", isFinalResponse: true },
    ]);
  });

  it("emits delta for new text in subsequent item/completed messages", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello world" }] },
      },
    });

    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: " world", isFinalResponse: true },
    ]);
  });

  it("returns empty array for item/completed message with no new text (same content)", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    expect(events).toEqual([]);
  });

  it("returns empty array for item/completed message with no content parts", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [] },
      },
    });
    expect(events).toEqual([]);
  });

  it("returns empty array for item/completed with no item", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {},
    });
    expect(events).toEqual([]);
  });

  it("returns empty array for item/completed userMessage (echo of user input)", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "userMessage",
          id: "msg-1",
          content: [{ type: "text", text: "hello" }],
        },
      },
    });
    expect(events).toEqual([]);
  });

  it("returns empty array for item/completed with unrecognized item type", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "unknown_item_type" } },
    });
    expect(events).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // item/completed – function_call items (tool use)
  // ---------------------------------------------------------------------------

  it("emits toolUse + toolResult for function_call item", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "function_call",
          id: "call-1",
          name: "bash",
          arguments: JSON.stringify({ command: "ls" }),
          output: "file.txt",
        },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "toolUse",
      threadId: "test-thread",
      toolCallId: "call-1",
      toolName: "bash",
      toolInput: { command: "ls" },
    });
    expect(events[1]).toEqual({
      type: "toolResult",
      threadId: "test-thread",
      toolCallId: "call-1",
      output: "file.txt",
      isError: false,
    });
  });

  it("handles function_call with invalid JSON arguments gracefully", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "function_call",
          id: "call-2",
          name: "bash",
          arguments: "not valid json",
          output: "",
        },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolInput: { arguments: "not valid json" },
    });
  });

  it("handles function_call with no output", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "function_call",
          id: "call-3",
          name: "bash",
          arguments: "{}",
        },
      },
    });

    expect(events[1]).toMatchObject({ type: "toolResult", output: "" });
  });

  it("after item/started collab, item/completed emits only toolResult", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          prompt: "Do work",
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          toolKind: "spawn_agent",
          prompt: "Do work",
          result: "Done",
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "toolResult",
      toolCallId: "collab-1",
      output: "Done",
      isError: false,
    });
  });

  it("nests commandExecution on Codex receiver thread via receiverThreadIds", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: { type: "collabAgentToolCall", id: "collab-a", tool: "spawnAgent", prompt: "x" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread-1"],
          result: "ok",
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread-1",
        item: {
          type: "commandExecution",
          id: "cmd-child",
          command: "git status",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "cmd-child",
      parentToolCallId: "collab-a",
    });
  });

  it("nests commandExecution under inner collab on a nested receiver thread (two-level sub-agents)", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: { type: "collabAgentToolCall", id: "collab-outer", tool: "spawnAgent", prompt: "outer" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-outer",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread-1"],
          result: "outer ok",
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "child-thread-1",
        item: { type: "collabAgentToolCall", id: "collab-inner", tool: "spawnAgent", prompt: "inner" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread-1",
        item: {
          type: "collabAgentToolCall",
          id: "collab-inner",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread-2"],
          result: "inner ok",
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread-2",
        item: {
          type: "commandExecution",
          id: "cmd-deep",
          command: "git status",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "cmd-deep",
      parentToolCallId: "collab-inner",
    });
  });

  it("nests commandExecution under open collab via parentToolCallId", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: { type: "collabAgentToolCall", id: "collab-p", tool: "spawnAgent", prompt: "x" },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "git status",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "cmd-1",
      parentToolCallId: "collab-p",
    });
  });

  it("maps collabAgentToolCall to Agent toolUse + toolResult for narrative nesting (legacy, no item/started)", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          toolKind: "spawn_agent",
          prompt: "Review security",
          result: "Done",
        },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "collab-1",
      toolName: "Agent",
      toolInput: { codexCollabKind: "spawn_agent", prompt: "Review security" },
    });
    expect(events[1]).toMatchObject({
      type: "toolResult",
      toolCallId: "collab-1",
      output: "Done",
      isError: false,
    });
  });

  it("after legacy collab completion, nests later commandExecution under collab via parentToolCallId", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "collab-legacy",
          tool: "spawnAgent",
          prompt: "Work",
          result: "ok",
        },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-after-legacy",
          command: "git status",
          aggregatedOutput: "clean",
          exitCode: 0,
        },
      },
    });

    expect(events[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "cmd-after-legacy",
      parentToolCallId: "collab-legacy",
    });
  });

  // ---------------------------------------------------------------------------
  // turn/completed
  // ---------------------------------------------------------------------------

  it("emits message + turnComplete for turn/completed when text was accumulated", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello world" }] },
      },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "test-thread",
        turn: { status: "completed", usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 20 } },
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
      tokensIn: 10,
      tokensOut: 20,
      cacheReadTokens: 5,
      providerId: "codex",
      contextWindow: undefined,
      totalProcessedTokens: 35,
    });
  });

  it("omits message event in turn/completed when no text was accumulated", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } } },
    });

    expect(events.some((e) => e.type === "message")).toBe(false);
    expect(events.some((e) => e.type === "turnComplete")).toBe(true);
  });

  it("resets text accumulator after turn/completed", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "First" }] },
      },
    });
    mapper.mapNotification({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });

    // Second turn: text accumulator should be empty
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  it("emits error event for turn/completed with status failed", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "test-thread",
        turn: {
          status: "failed",
          error: { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded" },
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      threadId: "test-thread",
      error: "You've hit your usage limit",
    });
  });

  it("falls back to generic error message when turn/completed failed has no error.message", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "failed" } },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
  });

  // ---------------------------------------------------------------------------
  // error notification
  // ---------------------------------------------------------------------------

  it("emits error event for error notification", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "error",
      params: { error: { message: "rate limit exceeded" } },
    });

    expect(events).toEqual([
      { type: "error", threadId: "test-thread", error: "rate limit exceeded" },
    ]);
  });

  it("emits fallback message for error notification with no message field", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "error",
      params: {},
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", threadId: "test-thread" });
  });

  // ---------------------------------------------------------------------------
  // reset()
  // ---------------------------------------------------------------------------

  it("reset() clears the text accumulator", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    mapper.reset();

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
      },
    });

    // After reset the accumulator is empty, so "Hello" is emitted as a full delta
    expect(events).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Hello", isFinalResponse: true },
    ]);
  });

  it("maps item/plan/delta to non-final text deltas (live planning / thinking stream)", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/plan/delta",
      params: { threadId: "t1", turnId: "u1", itemId: "p1", delta: "Checking repo layout…" },
    } as never);
    expect(events).toEqual([
      {
        type: "textDelta",
        threadId: "test-thread",
        delta: "Checking repo layout…",
        isFinalResponse: false,
      },
    ]);
  });

  it("maps reasoning stream notifications to non-final text deltas", () => {
    const eSummary = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/summaryTextDelta",
      params: { delta: "Plan: " },
    } as never);
    const eText = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { text: "step 1" },
    } as never);
    expect(eSummary).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "Plan: ", isFinalResponse: false },
    ]);
    expect(eText).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "step 1", isFinalResponse: false },
    ]);
    expect(mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/summaryPartAdded",
      params: {},
    } as never)).toEqual([]);
  });

  it("emits non-final textDelta for item/completed reasoning item (summary + content)", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "reasoning", id: "r1", summary: ["Plan step 1", "Plan step 2"], reasoningContent: ["Raw detail"] },
      },
    });
    expect(events).toEqual([
      {
        type: "textDelta",
        threadId: "test-thread",
        delta: "Plan step 1\nPlan step 2\nRaw detail",
        isFinalResponse: false,
      },
    ]);
  });

  it("dedupes item/completed reasoning against streamed reasoning deltas", () => {
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { delta: "Hello" },
    } as never);
    const rest = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "reasoning", summary: ["Hello world"], content: [] },
      },
    } as never);
    expect(rest).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: " world", isFinalResponse: false },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Thread-scoped routing
  // ---------------------------------------------------------------------------

  it("treats notifications with no thread id as main-thread notifications", () => {
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");

    const delta = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "main text" },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    expect(delta).toEqual([{ type: "textDelta", threadId: "test-thread", delta: "main text" }]);
    expect(completed.some((event) => event.type === "turnComplete")).toBe(true);
  });

  it("drops unknown-thread notifications before they mutate main turn state", async () => {
    const { logger } = await import("@mcode/shared");
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");

    const unknown = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "stray-thread",
        item: { type: "commandExecution", id: "cmd-stray", command: "pwd", aggregatedOutput: "x", exitCode: 0 },
      },
    });
    const main = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "main-codex-thread", turn: { status: "completed" } },
    });

    expect(unknown).toEqual([]);
    expect(main).toHaveLength(1);
    expect(main[0]).toMatchObject({ type: "turnComplete" });
    expect(logger.warn).toHaveBeenCalledWith(
      "CodexEventMapper: dropping unknown-thread notification",
      expect.objectContaining({ method: "item/completed", notificationThreadId: "stray-thread" }),
    );
  });

  it("consumes child-thread text and reasoning without adding it to the main final reply", () => {
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-codex-thread",
        item: { type: "collabAgentToolCall", id: "collab-a", tool: "spawnAgent" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-codex-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread"],
          result: "done",
        },
      },
    });

    const childText = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "child-thread", delta: "child private text" },
    });
    const childReasoning = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/reasoning/textDelta",
      params: { threadId: "child-thread", delta: "child private reasoning" },
    });
    const mainText = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "main-codex-thread", delta: "main final" },
    });
    const completed = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "main-codex-thread", turn: { status: "completed" } },
    });

    expect(childText).toEqual([]);
    expect(childReasoning).toEqual([]);
    expect(mainText).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "main final", isFinalResponse: true },
    ]);
    expect(completed.find((event) => event.type === "message")).toMatchObject({
      type: "message",
      content: "main final",
    });
  });

  it("does not let child turn/completed reset or latch the main turn", () => {
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-codex-thread",
        item: { type: "collabAgentToolCall", id: "collab-a", tool: "spawnAgent" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-codex-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread"],
          result: "done",
        },
      },
    });

    const childCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "child-thread", turn: { status: "completed" } },
    });
    const mainText = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "main-codex-thread", delta: "still streaming" },
    });
    const mainCompleted = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "main-codex-thread", turn: { status: "completed" } },
    });

    expect(childCompleted).toEqual([]);
    expect(mainText).toEqual([
      { type: "textDelta", threadId: "test-thread", delta: "still streaming", isFinalResponse: true },
    ]);
    expect(mainCompleted.filter((event) => event.type === "turnComplete")).toHaveLength(1);
  });

  it("still maps child-thread tools under the registered sub-agent row", () => {
    mapper = new CodexEventMapper("test-thread", "main-codex-thread");
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "main-codex-thread",
        item: { type: "collabAgentToolCall", id: "collab-a", tool: "spawnAgent" },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "main-codex-thread",
        item: {
          type: "collabAgentToolCall",
          id: "collab-a",
          tool: "spawnAgent",
          receiverThreadIds: ["child-thread"],
          result: "done",
        },
      },
    });
    mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/commandExecution/outputDelta",
      params: { threadId: "child-thread", itemId: "cmd-child", delta: "ok" },
    });

    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "child-thread",
        item: { type: "commandExecution", id: "cmd-child", command: "git status", exitCode: 0 },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "toolUse",
        toolCallId: "cmd-child",
        parentToolCallId: "collab-a",
      }),
      expect.objectContaining({
        type: "toolResult",
        toolCallId: "cmd-child",
        output: "ok",
      }),
    ]);
  });

  // ---------------------------------------------------------------------------
  // Unrecognized notification method
  // ---------------------------------------------------------------------------

  it("returns empty array and warns for unrecognized notification method", async () => {
    const { logger } = await import("@mcode/shared");
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "unknown/method",
      params: {},
    } as never);

    expect(events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "CodexEventMapper: unrecognized notification",
      expect.objectContaining({ method: "unknown/method" }),
    );
  });
});
