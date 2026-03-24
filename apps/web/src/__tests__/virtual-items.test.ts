import { describe, it, expect } from "vitest";
import {
  buildVirtualItems,
  estimateItemHeight,
} from "@/components/chat/virtual-items";
import type { ChatVirtualItem } from "@/components/chat/virtual-items";
import type { Message, ToolCall } from "@/transport/types";

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

describe("buildVirtualItems", () => {
  it("empty messages returns empty array", () => {
    const result = buildVirtualItems([], [], [], undefined, false, undefined);
    expect(result).toEqual([]);
  });

  it("messages only: one 'message' item per message", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1 }),
      makeMessage({ id: "msg-2", sequence: 2, role: "user", content: "Hi" }),
    ];
    const result = buildVirtualItems(messages, [], [], undefined, false, undefined);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "message", key: "msg-1" });
    expect(result[1]).toMatchObject({ type: "message", key: "msg-2" });
  });

  it("active tool calls split the last assistant message after the tool call card", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "user", content: "start" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "assistant", content: "thinking" }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-1" })];
    const result = buildVirtualItems(messages, toolCalls, [], undefined, false, undefined);

    const types = result.map((item) => item.type);
    // msg-1, active-tools, msg-2 (split last assistant after tool card)
    expect(types).toEqual(["message", "active-tools", "message"]);
    expect(result[0]).toMatchObject({ type: "message", key: "msg-1" });
    expect(result[1]).toMatchObject({ type: "active-tools" });
    expect(result[2]).toMatchObject({ type: "message", key: "msg-2" });
  });

  it("fading tool calls (no active) insert fading-tools item", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "assistant", content: "done" }),
    ];
    const fadingToolCalls = [makeToolCall({ id: "tc-fade", isComplete: true })];
    const result = buildVirtualItems(messages, [], fadingToolCalls, undefined, false, undefined);

    const types = result.map((item) => item.type);
    expect(types).toContain("fading-tools");
    const fadingItem = result.find((item) => item.type === "fading-tools") as ChatVirtualItem & { type: "fading-tools" };
    expect(fadingItem.toolCalls).toHaveLength(1);
  });

  it("does not insert fading tools when active tools exist", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "assistant", content: "working" }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-active" })];
    const fadingToolCalls = [makeToolCall({ id: "tc-fade", isComplete: true })];
    const result = buildVirtualItems(messages, toolCalls, fadingToolCalls, undefined, false, undefined);

    const types = result.map((item) => item.type);
    expect(types).not.toContain("fading-tools");
    expect(types).toContain("active-tools");
  });

  it("streaming text adds a 'streaming' item at the end", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const result = buildVirtualItems(messages, [], [], "partial response...", false, undefined);

    const last = result[result.length - 1];
    expect(last.type).toBe("streaming");
    expect((last as ChatVirtualItem & { type: "streaming" }).content).toBe("partial response...");
  });

  it("indicator (running, no streaming) adds an 'indicator' item", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const startTime = 12345;
    const result = buildVirtualItems(messages, [], [], undefined, true, startTime);

    const last = result[result.length - 1];
    expect(last.type).toBe("indicator");
    const indicatorItem = last as ChatVirtualItem & { type: "indicator" };
    expect(indicatorItem.startTime).toBe(startTime);
  });

  it("does not append indicator when streaming text exists", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const result = buildVirtualItems(messages, [], [], "streaming...", true, undefined);

    const types = result.map((item) => item.type);
    expect(types).not.toContain("indicator");
    expect(types).toContain("streaming");
  });

  it("does not split when last message is not assistant role", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "assistant", content: "ok" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "user", content: "next prompt" }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-1" })];
    const result = buildVirtualItems(messages, toolCalls, [], undefined, false, undefined);

    // Both messages appear before active-tools, no split of last user message
    const types = result.map((item) => item.type);
    expect(types).toEqual(["message", "message", "active-tools"]);
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
    const result = buildVirtualItems(messages, toolCalls, [], "Here is my answer...", true, 99999);

    const types = result.map((item) => item.type);
    // user msg, active-tools, split assistant msg, streaming (no indicator because streaming exists)
    expect(types).toEqual(["message", "active-tools", "message", "streaming"]);
    expect(result[0]).toMatchObject({ key: "msg-1" });
    expect(result[2]).toMatchObject({ key: "msg-2" });
    const activeItem = result[1] as ChatVirtualItem & { type: "active-tools" };
    expect(activeItem.toolCalls).toHaveLength(2);
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
});
