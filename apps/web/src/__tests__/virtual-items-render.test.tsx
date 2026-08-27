import { memo } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createTranscriptItemProjector,
  type ChatVirtualItem,
} from "@/features/conversation/messages/virtual-items";
import type { Message, ToolCall } from "@/transport/types";

const renderCounts = new Map<string, number>();

const Row = memo(function Row({ item }: { item: ChatVirtualItem }) {
  renderCounts.set(item.key, (renderCounts.get(item.key) ?? 0) + 1);
  return <div data-testid={item.key}>{item.type}</div>;
});

function ItemList({ items }: { items: readonly ChatVirtualItem[] }) {
  return (
    <>
      {items.map((item) => (
        <Row key={item.key} item={item} />
      ))}
    </>
  );
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    role: "assistant",
    content: "Settled response",
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
    output: "done",
    isError: false,
    isComplete: true,
    startedAt: 1,
    ...overrides,
  };
}

describe("virtual item render isolation", () => {
  it("re-renders only the typing row when final-response text changes", () => {
    renderCounts.clear();
    const projectTranscript = createTranscriptItemProjector();
    const toolCalls = [makeToolCall()];
    const hooks = [] as const;
    const thoughts = [] as const;
    const currentTurn = {
      threadId: "thread-1",
      responseKey: "turn-response:thread-1:typing",
    };
    const messages = [
      makeMessage({ id: "user-1", role: "user", content: "Prompt", sequence: 1 }),
      makeMessage({ id: "assistant-1", role: "assistant", sequence: 2 }),
    ];
    const firstItems = projectTranscript({
      messages,
      toolCalls,
      agentDisplayState: { phase: "streaming" },
      agentStartTime: 1000,
      streamingText: "first streamed answer",
      hooks,
      thoughtSegments: thoughts,
      currentTurn,
    });
    const { rerender } = render(<ItemList items={firstItems} />);

    const secondItems = projectTranscript({
      messages,
      toolCalls,
      agentDisplayState: { phase: "streaming" },
      agentStartTime: 1000,
      streamingText: "second streamed answer",
      hooks,
      thoughtSegments: thoughts,
      currentTurn,
    });
    rerender(<ItemList items={secondItems} />);

    expect(renderCounts.get("narrative-flow")).toBe(1);
    expect(renderCounts.get("narrative-indicator")).toBe(1);
    expect(renderCounts.get("turn-response:thread-1:typing")).toBe(2);
  });
});
