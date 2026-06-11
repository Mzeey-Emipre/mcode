import { describe, expect, it } from "vitest";
import {
  buildVirtualItems,
  estimateItemHeight,
  type ChatVirtualItem,
} from "../virtual-items";
import type { Message } from "@/transport/types";

function mkAssistantMessage(id: string, content: string): Message {
  return {
    id,
    thread_id: "thread-1",
    role: "assistant",
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    sequence: 1,
    attachments: null,
  } as Message;
}

describe("chat virtual items", () => {
  it("keeps current-turn assistant height estimates stable across persist", () => {
    const message = mkAssistantMessage("assistant-1", "Final response text.");
    const streaming: ChatVirtualItem = {
      key: "turn-response:thread-1:response-1",
      type: "message",
      message,
      assistantState: { isStreaming: true, actionsVisible: false },
    };
    const justPersisted: ChatVirtualItem = {
      ...streaming,
      message: { ...message, id: "assistant-1" },
      assistantState: { isStreaming: false, actionsVisible: false },
    };

    expect(estimateItemHeight(justPersisted)).toBe(estimateItemHeight(streaming));
  });

  it("places an exiting narrative indicator after the persisted assistant response", () => {
    const assistant = mkAssistantMessage("assistant-1", "Final response text.");
    const stableItems: ChatVirtualItem[] = [
      {
        key: "persisted-narrative-assistant-1",
        type: "persisted-narrative",
        messageId: assistant.id,
        messageContent: assistant.content,
      },
      {
        key: assistant.id,
        type: "message",
        message: assistant,
        assistantState: { isStreaming: false, actionsVisible: false },
      },
    ];
    const volatileItems: ChatVirtualItem[] = [
      {
        key: "narrative-flow",
        type: "narrative-flow",
        toolCalls: [],
        hooks: [],
        thoughtSegments: [],
        streamingText: "",
        isAgentRunning: false,
        startTime: 1000,
      },
      {
        key: "narrative-indicator-exit",
        type: "narrative-indicator",
        stepCount: 1,
        subagentCount: 0,
        activeToolCalls: [],
        startTime: 1000,
        isExiting: true,
      },
    ];

    const items = buildVirtualItems(stableItems, volatileItems, true);
    const assistantIndex = items.findIndex(
      (item) => item.type === "message" && item.message.id === assistant.id,
    );
    const indicatorIndex = items.findIndex((item) => item.key === "narrative-indicator-exit");

    expect(indicatorIndex).toBeGreaterThan(assistantIndex);
  });
});
