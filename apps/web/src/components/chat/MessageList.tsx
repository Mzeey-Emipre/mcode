import { useRef, useEffect, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { MessageBubble } from "./MessageBubble";
import { ToolCallCard } from "./ToolCallCard";
import { StreamingIndicator } from "./StreamingIndicator";
import { StreamingBubble } from "./StreamingBubble";
import {
  buildVirtualItems,
  estimateItemHeight,
} from "./virtual-items";
import type { ChatVirtualItem } from "./virtual-items";
import type { ToolCall } from "@/transport/types";

const EMPTY_TOOL_CALLS: ToolCall[] = [];
const AUTO_SCROLL_THRESHOLD = 64;
const OVERSCAN = 8;

function VirtualItemRenderer({ item }: { item: ChatVirtualItem }) {
  switch (item.type) {
    case "message":
      return <MessageBubble message={item.message} />;
    case "active-tools":
      return <ToolCallCard toolCalls={item.toolCalls} />;
    case "fading-tools":
      return (
        <div className="animate-fade-out">
          <ToolCallCard toolCalls={item.toolCalls} />
        </div>
      );
    case "streaming":
      return <StreamingBubble content={item.content} />;
    case "indicator":
      return (
        <StreamingIndicator
          startTime={item.startTime}
          activeToolCalls={item.activeToolCalls}
        />
      );
    default: {
      // @ts-ignore - exhaustive check for all ChatVirtualItem types
      const _exhaustive: never = item;
      return null;
    }
  }
}

export function MessageList() {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messages = useThreadStore((s) => s.messages);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const agentStartTimes = useThreadStore((s) => s.agentStartTimes);
  const streamingText = useThreadStore((s) =>
    activeThreadId ? s.streamingByThread[activeThreadId] : undefined,
  );
  const toolCallsRaw = useThreadStore((s) =>
    activeThreadId ? s.toolCallsByThread[activeThreadId] : undefined,
  );
  const fadingToolCallsRaw = useThreadStore((s) =>
    activeThreadId ? s.fadingToolCallsByThread[activeThreadId] : undefined,
  );
  const toolCalls = toolCallsRaw ?? EMPTY_TOOL_CALLS;
  const fadingToolCalls = fadingToolCallsRaw ?? EMPTY_TOOL_CALLS;
  const isAgentRunning = activeThreadId
    ? runningThreadIds.has(activeThreadId)
    : false;
  const agentStartTime = activeThreadId
    ? agentStartTimes[activeThreadId]
    : undefined;

  const items = useMemo(
    () =>
      buildVirtualItems(
        messages,
        toolCalls,
        fadingToolCalls,
        streamingText,
        isAgentRunning,
        agentStartTime,
      ),
    [
      messages,
      toolCalls,
      fadingToolCalls,
      streamingText,
      isAgentRunning,
      agentStartTime,
    ],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => estimateItemHeight(items[index]),
    getItemKey: (index) => items[index]?.key ?? String(index),
    overscan: OVERSCAN,
  });

  // Don't adjust scroll when near bottom -- prevents jitter during streaming
  // Safe to assign in render body: useVirtualizer returns a stable instance
  // (TanStack Virtual v3) so the property is set before the next measurement.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
    _item,
    _delta,
    instance,
  ) => {
    const viewportHeight = instance.scrollRect?.height ?? 0;
    const scrollOffset = instance.scrollOffset ?? 0;
    const remaining =
      instance.getTotalSize() - (scrollOffset + viewportHeight);
    return remaining > AUTO_SCROLL_THRESHOLD;
  };

  // Throttled scroll-to-bottom using virtualizer
  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      if (scrollTimerRef.current) return;
      scrollTimerRef.current = setTimeout(() => {
        scrollTimerRef.current = null;
        if (items.length === 0) return;
        virtualizer.scrollToIndex(items.length - 1, {
          align: "end",
          behavior: smooth ? "smooth" : "auto",
        });
        // Fallback nudge for items whose size is not yet measured
        requestAnimationFrame(() => {
          const el = containerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }, 200);
    },
    [items.length, virtualizer],
  );

  // Discrete events (new message, tool call) -> smooth scroll
  useEffect(() => {
    scrollToBottom(true);
  }, [messages.length, toolCalls.length, isAgentRunning, scrollToBottom]);

  // Streaming deltas -> instant scroll (no animation lag)
  useEffect(() => {
    if (streamingText) scrollToBottom(false);
  }, [streamingText, scrollToBottom]);

  return (
    <div ref={containerRef} className="h-full overflow-y-auto">
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const item = items[vi.index];
          return (
            <div
              key={vi.key}
              ref={virtualizer.measureElement}
              data-index={vi.index}
              className="absolute left-0 w-full px-4 py-2"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <VirtualItemRenderer item={item} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
