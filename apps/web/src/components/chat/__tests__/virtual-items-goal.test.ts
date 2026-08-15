import { describe, expect, it } from "vitest";
import type { Message, ToolCall } from "@/transport/types";
import {
  buildStableItems,
  buildVirtualItems,
  buildVolatileItems,
  createVirtualItemsBuilder,
} from "@/features/conversation/messages/virtual-items";

function message(
  id: string,
  role: Message["role"],
  content: string,
  sequence: number,
): Message {
  return {
    id,
    thread_id: "thread-1",
    role,
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: "2026-06-29T00:00:00.000Z",
    sequence,
    attachments: null,
  };
}

function toolCall(): ToolCall {
  return {
    id: "tool-1",
    toolName: "Read",
    toolInput: {},
    isComplete: true,
    isError: false,
    output: null,
    parentToolCallId: undefined,
    startedAt: 1,
  };
}

describe("goal notices in chat virtual items", () => {
  it("anchors live turn artifacts to the assistant answer before a goal receipt", () => {
    const messages = [
      message("user-1", "user", "/goal fix rendering", 1),
      message("answer-1", "assistant", "The rendering bug is fixed.", 2),
      message("goal-1", "assistant", "Goal achieved in 19s.", 3),
    ];
    const stableItems = buildStableItems(messages);
    const volatileItems = buildVolatileItems(
      [toolCall()],
      false,
      1,
      "",
      [],
      [],
      [],
      { threadId: "thread-1" },
      "The rendering bug is fixed.",
    );

    const items = buildVirtualItems(stableItems, volatileItems, true);
    const narrativeIndex = items.findIndex((item) => item.type === "narrative-flow");
    const answerIndex = items.findIndex(
      (item) => item.type === "message" && item.message.id === "answer-1",
    );
    const receiptIndex = items.findIndex(
      (item) => item.type === "message" && item.message.id === "goal-1",
    );

    expect(narrativeIndex).toBeGreaterThan(-1);
    expect(answerIndex).toBeGreaterThan(-1);
    expect(receiptIndex).toBeGreaterThan(-1);
    expect(narrativeIndex).toBeLessThan(answerIndex);
    expect(answerIndex).toBeLessThan(receiptIndex);
  });
});

describe("history prepends", () => {
  it("retains existing row identity when older messages are inserted", () => {
    const first = message("first", "user", "First", 1);
    const second = message("second", "assistant", "Second", 2);
    const builder = createVirtualItemsBuilder();
    const initial = builder(buildStableItems([first, second]), [], false);

    const prepended = builder(
      buildStableItems([message("older", "user", "Older", 0), first, second]),
      [],
      false,
    );

    expect(prepended.find((item) => item.key === first.id)).toBe(
      initial.find((item) => item.key === first.id),
    );
    expect(prepended.find((item) => item.key === second.id)).toBe(
      initial.find((item) => item.key === second.id),
    );
  });
});
