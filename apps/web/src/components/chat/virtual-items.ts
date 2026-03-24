import type { Message, ToolCall } from "@/transport/types";

export type ChatVirtualItem =
  | { key: string; type: "message"; message: Message }
  | { key: string; type: "active-tools"; toolCalls: ToolCall[] }
  | { key: string; type: "fading-tools"; toolCalls: ToolCall[] }
  | { key: string; type: "streaming"; content: string }
  | {
      key: string;
      type: "indicator";
      startTime: number | undefined;
      activeToolCalls: ToolCall[];
    };

export function buildVirtualItems(
  messages: readonly Message[],
  toolCalls: readonly ToolCall[],
  fadingToolCalls: readonly ToolCall[],
  streamingText: string | undefined,
  isAgentRunning: boolean,
  agentStartTime: number | undefined,
): ChatVirtualItem[] {
  const items: ChatVirtualItem[] = [];
  const hasActiveToolCalls = toolCalls.length > 0;
  const hasFadingToolCalls = fadingToolCalls.length > 0;
  const showToolCalls = hasActiveToolCalls || hasFadingToolCalls;

  let beforeMessages: readonly Message[] = messages;
  let lastAssistantMsg: Message | null = null;

  if (showToolCalls && messages.length > 0) {
    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];
    if (last.role === "assistant") {
      beforeMessages = messages.slice(0, lastIdx);
      lastAssistantMsg = last;
    }
  }

  for (const msg of beforeMessages) {
    items.push({ key: msg.id, type: "message", message: msg });
  }

  if (hasActiveToolCalls) {
    items.push({
      key: "active-tools",
      type: "active-tools",
      toolCalls: toolCalls as ToolCall[],
    });
  }

  if (hasFadingToolCalls && !hasActiveToolCalls) {
    items.push({
      key: "fading-tools",
      type: "fading-tools",
      toolCalls: fadingToolCalls as ToolCall[],
    });
  }

  if (lastAssistantMsg) {
    items.push({
      key: lastAssistantMsg.id,
      type: "message",
      message: lastAssistantMsg,
    });
  }

  if (streamingText) {
    items.push({ key: "streaming", type: "streaming", content: streamingText });
  }

  if (isAgentRunning && !streamingText) {
    items.push({
      key: "indicator",
      type: "indicator",
      startTime: agentStartTime,
      activeToolCalls: toolCalls as ToolCall[],
    });
  }

  return items;
}

const LINE_HEIGHT = 22;
const CHARS_PER_LINE = 65;

export function estimateItemHeight(item: ChatVirtualItem): number {
  switch (item.type) {
    case "message": {
      const { message } = item;
      if (message.role === "system") return 40;
      const lines = Math.max(
        1,
        Math.ceil(message.content.length / CHARS_PER_LINE),
      );
      if (message.role === "user") return 52 + lines * LINE_HEIGHT;
      return 80 + lines * LINE_HEIGHT;
    }
    case "active-tools":
    case "fading-tools":
      return Math.min(item.toolCalls.length * 48, 400);
    case "streaming": {
      const lines = Math.max(
        1,
        Math.ceil(item.content.length / CHARS_PER_LINE),
      );
      return 80 + lines * LINE_HEIGHT;
    }
    case "indicator":
      return 48;
  }
}
