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

  it("returns empty array for item/started", () => {
    const events = mapper.mapNotification({
      jsonrpc: "2.0",
      method: "item/started",
      params: {},
    });
    expect(events).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // item/agentMessage/delta – streaming text tokens
  // ---------------------------------------------------------------------------

  it("emits textDelta for item/agentMessage/delta and accumulates text", () => {
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
      { type: "textDelta", threadId: "test-thread", delta: "Hello" },
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
      { type: "textDelta", threadId: "test-thread", delta: "Hello from codex" },
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
      { type: "textDelta", threadId: "test-thread", delta: " world" },
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
      tokensIn: 15,
      tokensOut: 20,
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
      { type: "textDelta", threadId: "test-thread", delta: "Hello" },
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
