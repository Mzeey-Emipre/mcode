import { useRef, useEffect, useLayoutEffect, useMemo, useCallback, memo, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useShallow } from "zustand/shallow";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { MessageBubble } from "./MessageBubble";
import { ToolCallCard } from "./ToolCallCard";
import { StreamingIndicator } from "./StreamingIndicator";
import { StreamingCard } from "./StreamingCard";
import { ToolCallSummary } from "./ToolCallSummary";
import { TurnChangeSummary } from "./TurnChangeSummary";
import {
  buildStableItems,
  buildVolatileItems,
  buildVirtualItems,
  estimateItemHeight,
} from "./virtual-items";
import type { ChatVirtualItem } from "./virtual-items";
import type { ToolCall } from "@/transport/types";

const EMPTY_TOOL_CALLS: ToolCall[] = [];
const AUTO_SCROLL_THRESHOLD = 64;
const OVERSCAN = 8;
const DEFAULT_ITEM_HEIGHT = 80;
const PAGINATION_THRESHOLD = 200;

/** Renders a single virtual item based on its type discriminant. */
const VirtualItemRenderer = memo(function VirtualItemRenderer({ item }: { item: ChatVirtualItem }) {
  switch (item.type) {
    case "message":
      return <MessageBubble message={item.message} />;
    case "active-tools":
      return <ToolCallCard toolCalls={item.toolCalls} />;
    case "indicator":
      return (
        <StreamingIndicator
          startTime={item.startTime}
          activeToolCalls={item.activeToolCalls}
        />
      );
    case "streaming":
      return <StreamingCard text={item.text} />;
    case "tool-summary":
      return (
        <ToolCallSummary
          messageId={item.serverMessageId}
          toolCallCount={item.toolCallCount}
        />
      );
    case "turn-changes":
      return (
        <TurnChangeSummary
          messageId={item.messageId}
          filesChanged={item.filesChanged}
          isLatestTurn={item.isLatestTurn}
        />
      );
  }
}, (prev, next) => prev.item.key === next.item.key && prev.item === next.item);

/** Virtualized list of chat messages, tool calls, and streaming indicators. */
export function MessageList() {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsLengthRef = useRef(0);
  const prevMessageCountRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  /** Tracks the first message ID to detect real prepends vs appends. */
  const firstMessageIdRef = useRef<string | null>(null);
  /** True until initial messages are positioned at the bottom after a thread switch. */
  const isInitialLoadRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  /** True when new content arrived while the user was scrolled up. */
  const [hasNewContent, setHasNewContent] = useState(false);
  /** Ref mirror of showScrollBtn so scroll-trigger effects avoid stale closures. */
  const isScrolledUpRef = useRef(false);
  /** Controls container visibility: hidden while positioning to prevent top-to-bottom flash. */
  const [isPositioned, setIsPositioned] = useState(false);

  const messages = useThreadStore((s) => s.messages);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const isAgentRunning = useThreadStore((s) =>
    activeThreadId ? s.runningThreadIds.has(activeThreadId) : false,
  );
  const agentStartTime = useThreadStore((s) =>
    activeThreadId ? s.agentStartTimes[activeThreadId] : undefined,
  );
  const streamingText = useThreadStore((s) =>
    activeThreadId ? s.streamingPreviewByThread[activeThreadId] : undefined,
  );
  const toolCallsRaw = useThreadStore((s) =>
    activeThreadId ? s.toolCallsByThread[activeThreadId] : undefined,
  );
  const persistedToolCallCounts = useThreadStore(
    useShallow((s) => s.persistedToolCallCounts),
  );
  const serverMessageIds = useThreadStore(
    useShallow((s) => s.serverMessageIds),
  );
  const persistedFilesChanged = useThreadStore(
    useShallow((s) => s.persistedFilesChanged),
  );
  const latestTurnWithChanges = useThreadStore(
    (s) => s.latestTurnWithChanges,
  );
  const hasMore = useThreadStore((s) =>
    activeThreadId ? s.hasMoreMessages[activeThreadId] ?? false : false,
  );
  const isLoadingMore = useThreadStore((s) =>
    activeThreadId ? s.isLoadingMore[activeThreadId] ?? false : false,
  );
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);

  const toolCalls = toolCallsRaw ?? EMPTY_TOOL_CALLS;

  /** Track scroll-to-bottom button visibility and trigger upward pagination near the top. */
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceFromBottom > 200;
    isScrolledUpRef.current = scrolledUp;
    setShowScrollBtn(scrolledUp);
    // Clear new-content highlight once the user reaches the bottom
    if (!scrolledUp) setHasNewContent(false);

    // Trigger loading older messages when near the top
    if (
      el.scrollTop < PAGINATION_THRESHOLD &&
      activeThreadId &&
      hasMore &&
      !isLoadingMore
    ) {
      loadOlderMessages(activeThreadId);
    }
  }, [activeThreadId, hasMore, isLoadingMore, loadOlderMessages]);

  const stableItems = useMemo(
    () => buildStableItems(messages, persistedToolCallCounts, serverMessageIds, persistedFilesChanged, latestTurnWithChanges),
    [messages, persistedToolCallCounts, serverMessageIds, persistedFilesChanged, latestTurnWithChanges],
  );

  const volatileItems = useMemo(
    () => buildVolatileItems(toolCalls, isAgentRunning, agentStartTime, streamingText),
    [toolCalls, isAgentRunning, agentStartTime, streamingText],
  );

  const hasToolCalls = toolCalls.length > 0;
  const items = useMemo(
    () => buildVirtualItems(stableItems, volatileItems, hasToolCalls),
    [stableItems, volatileItems, hasToolCalls],
  );

  itemsLengthRef.current = items.length;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const item = items[index];
      return item ? estimateItemHeight(item) : DEFAULT_ITEM_HEIGHT;
    },
    getItemKey: (index) => items[index]?.key ?? String(index),
    overscan: OVERSCAN,
  });

  // Don't adjust scroll when near bottom -- prevents jitter during streaming.
  // Assigned on the stable virtualizer instance (TanStack Virtual v3 API);
  // not available as a useVirtualizer option in the current type definitions.
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

  // Throttled scroll-to-bottom using virtualizer.
  // Uses refs to avoid stale closures: itemsLengthRef always has the
  // current count when the timer fires, even if messages arrived after
  // the timer was scheduled.
  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      if (scrollTimerRef.current) return;
      scrollTimerRef.current = setTimeout(() => {
        scrollTimerRef.current = null;
        const count = itemsLengthRef.current;
        if (count === 0) return;
        virtualizer.scrollToIndex(count - 1, {
          align: "end",
          behavior: smooth ? "smooth" : "auto",
        });
        // Fallback nudge for items whose size is not yet measured.
        // Only for instant scroll to avoid cancelling smooth animations.
        if (!smooth) {
          requestAnimationFrame(() => {
            const el = containerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          });
        }
      }, 200);
    },
    [virtualizer],
  );

  // Clean up pending scroll timer on unmount
  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
    };
  }, []);

  // On thread switch, invalidate the virtualizer's cached sizes so
  // stale heights from the previous thread don't cause overlap.
  // Also reset positioning state so the container stays hidden until
  // new messages are scrolled to the bottom.
  useEffect(() => {
    isInitialLoadRef.current = true;
    setIsPositioned(false);
    virtualizer.measure();
  }, [activeThreadId, virtualizer]);

  // Stabilize scroll position when older messages are prepended.
  // Detects real prepends by comparing the first message ID before and after
  // the render, avoiding false positives from appends while near the top.
  useEffect(() => {
    const el = containerRef.current;
    const prevCount = prevMessageCountRef.current;
    const prevFirstId = firstMessageIdRef.current;
    prevMessageCountRef.current = messages.length;
    firstMessageIdRef.current = messages.length > 0 ? messages[0].id : null;

    if (!el || messages.length <= prevCount || prevCount === 0) {
      prevScrollHeightRef.current = el?.scrollHeight ?? 0;
      return;
    }

    // A prepend occurred if the first message ID changed (new items at the front)
    const wasPrepend = prevFirstId !== null && messages[0].id !== prevFirstId;
    if (wasPrepend) {
      // After React renders the new items, restore scroll position
      requestAnimationFrame(() => {
        const newScrollHeight = el.scrollHeight;
        const addedHeight = newScrollHeight - prevScrollHeightRef.current;
        if (addedHeight > 0) {
          el.scrollTop += addedHeight;
        }
        prevScrollHeightRef.current = newScrollHeight;
      });
    } else {
      prevScrollHeightRef.current = el.scrollHeight;
    }
  }, [messages]);

  // Initial load: position at the bottom before paint to avoid top-to-bottom flash.
  // useLayoutEffect fires after DOM mutations but before the browser paints.
  const loading = useThreadStore((s) => s.loading);
  useLayoutEffect(() => {
    if (!isInitialLoadRef.current) return;

    // If loading finished with no items (empty thread), just reveal.
    if (!loading && items.length === 0) {
      isInitialLoadRef.current = false;
      setIsPositioned(true);
      return;
    }

    if (items.length === 0) return;
    if (loading) return; // don't position until persisted messages are loaded

    isInitialLoadRef.current = false;

    virtualizer.scrollToIndex(items.length - 1, {
      align: "end",
      behavior: "auto",
    });

    // Fallback nudge + reveal: the virtualizer may not have measured all items
    // yet, so force scrollTop to the absolute bottom and then show the container.
    requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      setIsPositioned(true);
    });
  }, [items.length, loading, virtualizer]);

  // Discrete events (new message, tool call) -> scroll if at bottom, else highlight button
  useEffect(() => {
    if (isInitialLoadRef.current) return;
    if (isScrolledUpRef.current) {
      setHasNewContent(true);
    } else {
      scrollToBottom(true);
    }
  }, [messages.length, toolCalls.length, isAgentRunning, scrollToBottom]);

  // Streaming deltas -> scroll if at bottom, else highlight button
  useEffect(() => {
    if (!streamingText || isInitialLoadRef.current) return;
    if (isScrolledUpRef.current) {
      setHasNewContent(true);
    } else {
      scrollToBottom(false);
    }
  }, [streamingText, scrollToBottom]);

  return (
    <div className="relative h-full">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto pt-4 transition-opacity duration-75"
        style={{ opacity: isPositioned ? 1 : 0 }}
      >
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
                className="absolute left-0 w-full px-8 py-3"
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <div className="mx-auto w-full max-w-4xl">
                  <VirtualItemRenderer item={item} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Loading spinner overlay for scroll-up pagination */}
      {isLoadingMore && (
        <div className="absolute top-2 left-1/2 z-10 -translate-x-1/2">
          <div className="rounded-full bg-muted/80 p-2 shadow-md ring-1 ring-border/40 backdrop-blur-sm">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        </div>
      )}

      {/* Scroll-to-bottom floating button — pulses when new content arrives */}
      {showScrollBtn && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => {
            setHasNewContent(false);
            scrollToBottom(true);
          }}
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 h-8 w-8 rounded-full shadow-md ring-1 backdrop-blur-sm transition-all hover:bg-muted hover:text-foreground ${
            hasNewContent
              ? "bg-primary text-primary-foreground ring-primary/50 animate-bounce"
              : "bg-muted/80 text-muted-foreground ring-border/40"
          }`}
          aria-label={hasNewContent ? "New messages below" : "Scroll to bottom"}
        >
          <ArrowDown size={14} />
        </Button>
      )}
    </div>
  );
}
