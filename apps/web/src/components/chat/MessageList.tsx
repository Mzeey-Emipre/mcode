import { useRef, useEffect, useLayoutEffect, useMemo, useCallback, memo, useState, type WheelEvent } from "react";
import { useReplyStore } from "@/stores/replyStore";
import { ArrowDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useShallow } from "zustand/shallow";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useActiveThreadRecord } from "@/stores/thread-selectors";
import { getThreadRecord, getHandoffStatus } from "@/stores/thread-record";
import { MessageBubble } from "./MessageBubble";
import { ToolCallCard } from "./ToolCallCard";
import { StreamingIndicator } from "./StreamingIndicator";
import { StreamingCard } from "./StreamingCard";
import { TurnChangeSummary } from "./TurnChangeSummary";
import { PermissionRequestCard } from "./PermissionRequestCard";
import { HookActivitySection } from "./HookActivitySection";
import {
  buildStableItems,
  buildVolatileItems,
  buildVirtualItems,
  estimateItemHeight,
} from "./virtual-items";
import type { ChatVirtualItem } from "./virtual-items";
import type { ToolCall } from "@/transport/types";
import { rememberScrollTop, recallScrollTop, forgetScrollTop } from "./scrollPositionMemory";
import { NarrativeFlow } from "./narrative";
import { PersistedNarrative } from "./narrative/PersistedNarrative";
import { PersistedTurnFooter } from "./narrative/PersistedTurnFooter";
import { NarrativeIndicator } from "./narrative/NarrativeIndicator";
import { PersistedLateHooks } from "./PersistedLateHooks";
import { StickyUserMessage, STICKY_USER_MESSAGE_ESTIMATED_HEIGHT } from "./StickyUserMessage";
import { registerCommand } from "@/lib/command-registry";
import { shouldShowStickyUserMessage, type StickyVisibilityVirtualizer } from "./sticky-user-message-visibility";
import { resolveUserMessagePreview } from "./user-message-preview";

const EMPTY_TOOL_CALLS: ToolCall[] = [];
const EMPTY_TURN_MAP: Record<string, string> = {};
const EMPTY_FILES_CHANGED: Record<string, string[]> = {};
const AUTO_SCROLL_THRESHOLD = 64;
/**
 * If the viewport is farther than this from the scroll tail, the user has left
 * "follow latest" mode: show the down control and do not auto-scroll on new content.
 * Kept near {@link AUTO_SCROLL_THRESHOLD} so this matches virtualizer tail tracking.
 */
const USER_AWAY_FROM_BOTTOM_PX = AUTO_SCROLL_THRESHOLD;
/** After the user scrolls up with the wheel, block streaming auto-scroll briefly
 * unless they are still glued to the bottom (avoids fighting a small nudge). */
const WHEEL_UP_FOLLOW_PAUSE_MS = 750;
const OVERSCAN = 8;
const DEFAULT_ITEM_HEIGHT = 80;
const PAGINATION_THRESHOLD = 200;
/** Top inset on the scroll container when the sticky user bar is hidden (`pt-4`). */
const MESSAGE_LIST_TOP_PADDING_PX = 16;
/**
 * Initial-load reveal is gated on the inner list height stabilizing across frames.
 * TanStack Virtual measures rows asynchronously after mount, so `scrollHeight`
 * grows for several frames after we first snap to it. Revealing during that
 * growth lands on a stale tail (the bug: long threads sit short of the bottom).
 *
 * STABLE: number of consecutive identical frames required before revealing.
 *   4 frames ≈ 67ms — imperceptible on the happy path (short threads).
 * MAX:    hard cap so a perpetually-growing list (e.g. lazy markdown that
 *   never settles within a second) cannot leave the user staring at a blank pane.
 *   60 frames ≈ 1s.
 */
const TAIL_SETTLE_STABLE_FRAMES = 4;
const TAIL_SETTLE_MAX_FRAMES = 60;

/** Renders a single virtual item based on its type discriminant. */
const VirtualItemRenderer = memo(function VirtualItemRenderer({
  item,
  turnExpandRef,
  onBranch,
  onReply,
  onScrollToMessage,
  currentTurnMessageIdByThread,
}: {
  item: ChatVirtualItem;
  turnExpandRef?: React.RefObject<Map<string, boolean>>;
  onBranch?: (messageId: string) => void;
  onReply?: (messageId: string, content: string, role: "user" | "assistant") => void;
  onScrollToMessage?: (messageId: string) => void;
  currentTurnMessageIdByThread: Record<string, string>;
}) {
  switch (item.type) {
    case "message": {
      const isJustPersisted =
        item.message.role === "assistant" &&
        currentTurnMessageIdByThread[item.message.thread_id] === item.message.id &&
        item.assistantState?.actionsVisible !== true;
      return (
        <div className={isJustPersisted ? "assistant-just-persisted" : ""}>
          <MessageBubble
            message={item.message}
            onBranch={item.assistantState?.actionsVisible === false ? undefined : onBranch}
            onReply={item.assistantState?.actionsVisible === false ? undefined : onReply}
            onScrollToMessage={onScrollToMessage}
            assistantStreaming={item.assistantState?.isStreaming}
            assistantActionsVisible={item.assistantState?.actionsVisible}
          />
        </div>
      );
    }
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
    case "turn-changes":
      return (
        <TurnChangeSummary
          messageId={item.messageId}
          filesChanged={item.filesChanged}
          isLatestTurn={item.isLatestTurn}
          manualExpandRef={turnExpandRef}
        />
      );
    case "permission-request":
      return (
        <PermissionRequestCard
          requestId={item.requestId}
          toolName={item.toolName}
          input={item.input}
          title={item.title}
          settled={item.settled}
          decision={item.decision}
        />
      );
    case "hook-activity":
      return <HookActivitySection hooks={item.hooks} />;
    case "narrative-flow":
      return (
        <NarrativeFlow
          toolCalls={item.toolCalls}
          hooks={item.hooks}
          thoughtSegments={item.thoughtSegments}
          streamingText={item.streamingText}
          isAgentRunning={item.isAgentRunning}
          startTime={item.startTime}
          committedAssistantBody={item.committedAssistantBody}
        />
      );
    case "persisted-narrative":
      return <PersistedNarrative messageId={item.messageId} messageContent={item.messageContent} />;
    case "persisted-late-hooks":
      return <PersistedLateHooks messageId={item.messageId} />;
    case "persisted-turn-footer":
      return <PersistedTurnFooter messageId={item.messageId} />;
    case "narrative-indicator":
      return (
        <NarrativeIndicator
          stepCount={item.stepCount}
          subagentCount={item.subagentCount}
          activeToolCalls={item.activeToolCalls}
          startTime={item.startTime}
        />
      );
  }
}, (prev, next) =>
  prev.item.key === next.item.key
  && prev.item === next.item
  && prev.turnExpandRef === next.turnExpandRef
  && prev.onBranch === next.onBranch
  && prev.onReply === next.onReply
  && prev.onScrollToMessage === next.onScrollToMessage
  && prev.currentTurnMessageIdByThread === next.currentTurnMessageIdByThread,
);

/** Props for {@link ScrollToBottomButton}. */
export interface ScrollToBottomButtonProps {
  /** Whether new content arrived while the user was scrolled up. */
  hasNewContent: boolean;
  /** Called when the button is clicked. */
  onScrollToBottom: () => void;
}

/**
 * Floating button anchored at the bottom-center of the message list.
 * Pulses when new content has arrived while the user is scrolled up.
 */
export function ScrollToBottomButton({ hasNewContent, onScrollToBottom }: ScrollToBottomButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onScrollToBottom}
      className={`absolute bottom-4 left-1/2 -translate-x-1/2 h-7 w-7 rounded-md border backdrop-blur-sm transition-colors ${
        hasNewContent
          ? "border-primary/40 bg-primary/15 text-primary hover:bg-primary/25"
          : "border-border/40 bg-background/80 text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground"
      }`}
      aria-label={hasNewContent ? "New messages below" : "Scroll to bottom"}
    >
      <ArrowDown size={13} />
    </Button>
  );
}

/** Props for {@link MessageList}. */
interface MessageListProps {
  /** Called when the user clicks the branch icon on a message. */
  onBranch?: (messageId: string) => void;
  /** Called when the user clicks the reply button or selects text in a message. */
  onReply?: (messageId: string, content: string, role: "user" | "assistant") => void;
}

/** Virtualized list of chat messages, tool calls, and streaming indicators. */
export function MessageList({ onBranch, onReply }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** Survives virtualizer remounts: remembers manual expand/collapse toggles by messageId. */
  const turnExpandRef = useRef<Map<string, boolean>>(new Map());
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsLengthRef = useRef(0);
  const prevMessageCountRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  /** Tracks the first message ID to detect real prepends vs appends. */
  const firstMessageIdRef = useRef<string | null>(null);
  /** True until initial messages are positioned at the bottom after a thread switch. */
  const isInitialLoadRef = useRef(true);
  /**
   * Blocks discrete/streaming auto bottom-scroll while a navigation applies scroll.
   * One-shot skip flags miss follow-up effect runs when stores settle after revisit.
   */
  const suppressPassiveAutoBottomScrollRef = useRef(false);
  /** Cancels stale triple-rAF clears when another navigation starts. */
  const suppressPassiveAutoBottomGenRef = useRef(0);
  /** Cancels in-flight tail-settle rAF loops when a new navigation calls `positionAtBottom`. */
  const tailSettleGenRef = useRef(0);
  /**
   * While true, list height growth snaps the viewport to the tail so virtual rows
   * and async layout cannot leave the thread short of the bottom after open.
   */
  const pinListTailRef = useRef(false);
  /**
   * Last `scrollHeight - clientHeight` when we believed the viewport sat on the pinned
   * tail. Used to tell virtualizer measurement growth (`scrollTop` stale vs old max)
   * from the user leaving the tail (`scrollTop` below this baseline).
   */
  const pinTailBaselineMaxScrollRef = useRef(0);
  /** Tracks the previous activeThreadId so we can save its scrollTop before switching. */
  const prevActiveThreadIdRef = useRef<string | null>(null);
  /** Holds the scrollTop value to restore on the next layout effect. */
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  /** True when new content arrived while the user was scrolled up. */
  const [hasNewContent, setHasNewContent] = useState(false);
  /** Ref mirror of showScrollBtn so scroll-trigger effects avoid stale closures. */
  const isScrolledUpRef = useRef(false);
  /** Controls container visibility: hidden while positioning to prevent top-to-bottom flash. */
  const [isPositioned, setIsPositioned] = useState(false);
  /** Mirrors `isPositioned` for `handleScroll` so affordances do not run while the scroller is opacity-0. */
  const isPositionedRef = useRef(false);
  /** Blocks streaming/discrete tail snaps briefly after wheel-up while not at the tail. */
  const streamingFollowPauseUntilRef = useRef(0);
  /**
   * True while a smooth jump-to-bottom is in flight so scroll handlers do not
   * treat mid-animation offsets as "reading history" and re-show the chip.
   */
  const scrollToTailIntentRef = useRef(false);
  /** Previous `scrollTop` from the last `onScroll` pass; detects upward interrupts during smooth tail scroll. */
  const prevScrollTopRef = useRef(0);
  /** Ref mirror of sticky-user-message visibility to avoid redundant setState on scroll. */
  const showStickyUserMessageRef = useRef(false);
  /** Previous effective top padding; used to compensate scrollTop when padding changes. */
  const prevStickyTopInsetRef = useRef(MESSAGE_LIST_TOP_PADDING_PX);
  const [showStickyUserMessage, setShowStickyUserMessage] = useState(false);
  /** Reserved top inset while the sticky user-message bar is visible. */
  const [stickyBarHeight, setStickyBarHeight] = useState(0);
  /** Target message for sticky preview; kept in a ref so handleScroll stays stable. */
  const stickyUserMessageTargetRef = useRef<{ id: string; itemIndex: number } | null>(null);
  /** Latest virtualizer instance for scroll-time sticky visibility checks. */
  const virtualizerRef = useRef<StickyVisibilityVirtualizer | null>(null);

  const messages = useActiveThreadRecord((r) => r.messages);
  const loading = useActiveThreadRecord((r) => r.loading);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const isAgentRunning = useThreadStore((s) =>
    activeThreadId ? s.runningThreadIds.has(activeThreadId) : false,
  );
  const agentStartTime = useActiveThreadRecord((r) => r.agentStartTime);
  const streamingText = useActiveThreadRecord((r) => r.streaming);
  const toolCallsRaw = useActiveThreadRecord((r) => r.toolCalls);
  const persistedFilesChanged = useThreadStore(
    useShallow((s) => {
      const id = s.currentThreadId;
      if (!id) return EMPTY_FILES_CHANGED;
      const rec = getThreadRecord(s.records, id);
      if (rec.messages.length === 0) return EMPTY_FILES_CHANGED;
      const out: Record<string, string[]> = {};
      for (const m of rec.messages) {
        const v = rec.persistedFilesChanged[m.id];
        if (v) out[m.id] = v;
      }
      return out;
    }),
  );
  const latestTurnWithChanges = useActiveThreadRecord((r) => r.latestTurnWithChanges);
  const hasMore = useActiveThreadRecord((r) => r.hasMoreMessages);
  const handoffStatus = useThreadStore((s) =>
    activeThreadId ? getHandoffStatus(getThreadRecord(s.records, activeThreadId)) : undefined,
  );
  const isLoadingMore = useActiveThreadRecord((r) => r.isLoadingMore);
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);
  const currentThreadId = activeThreadId;
  const permissions = useActiveThreadRecord((r) => r.permissions);
  const hooks = useActiveThreadRecord((r) => r.hooks);
  const thoughtSegments = useActiveThreadRecord((r) => r.thoughtSegments);
  const currentTurnMessageId = useActiveThreadRecord((r) => r.currentTurnMessageId);
  const currentTurnResponseKey = useActiveThreadRecord((r) => r.currentTurnResponseKey);
  const assistantResponseKeys = useActiveThreadRecord((r) => r.assistantResponseKeys);
  const currentTurnMessageIdByThread = useMemo(
    () => (currentThreadId && currentTurnMessageId
      ? { [currentThreadId]: currentTurnMessageId }
      : EMPTY_TURN_MAP),
    [currentThreadId, currentTurnMessageId],
  );

  const toolCalls = toolCallsRaw ?? EMPTY_TOOL_CALLS;

  useLayoutEffect(() => {
    isPositionedRef.current = isPositioned;
  }, [isPositioned]);

  /** Syncs sticky preview visibility with the current scroll position. */
  const syncStickyUserMessageVisibility = useCallback(() => {
    if (!isPositionedRef.current) {
      if (showStickyUserMessageRef.current) {
        showStickyUserMessageRef.current = false;
        setShowStickyUserMessage(false);
      }
      return;
    }
    const el = containerRef.current;
    const virtualizerInstance = virtualizerRef.current;
    const stickyTarget = stickyUserMessageTargetRef.current;
    if (!el || !virtualizerInstance || !stickyTarget) {
      if (showStickyUserMessageRef.current) {
        showStickyUserMessageRef.current = false;
        setShowStickyUserMessage(false);
      }
      return;
    }
    const shouldShowSticky = shouldShowStickyUserMessage(
      el,
      stickyTarget.id,
      stickyTarget.itemIndex,
      virtualizerInstance,
      showStickyUserMessageRef.current,
    );
    if (shouldShowSticky !== showStickyUserMessageRef.current) {
      showStickyUserMessageRef.current = shouldShowSticky;
      setShowStickyUserMessage(shouldShowSticky);
      if (!shouldShowSticky) {
        setStickyBarHeight(0);
      }
    }
  }, []);

  const handleStickyHeightChange = useCallback((height: number) => {
    setStickyBarHeight((prev) => (prev === height ? prev : height));
  }, []);

  const beginSuppressPassiveAutoBottomScroll = useCallback(() => {
    suppressPassiveAutoBottomScrollRef.current = true;
  }, []);

  /** Ends passive auto bottom-scroll suppression after layout settles across frames. */
  const scheduleEndSuppressPassiveAutoBottomScroll = useCallback(() => {
    const gen = ++suppressPassiveAutoBottomGenRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (suppressPassiveAutoBottomGenRef.current === gen) {
            suppressPassiveAutoBottomScrollRef.current = false;
          }
        });
      });
    });
  }, []);

  /** Clears tail pin when the user scrolls content upward (wheel / trackpad). */
  const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      scrollToTailIntentRef.current = false;
      pinListTailRef.current = false;
      streamingFollowPauseUntilRef.current = Date.now() + WHEEL_UP_FOLLOW_PAUSE_MS;
    }
  }, []);

  /** Track scroll-to-bottom button visibility and trigger upward pagination near the top. */
  const handleScroll = useCallback(() => {
    if (!isPositionedRef.current) return;
    const el = containerRef.current;
    if (!el) return;

    if (
      scrollToTailIntentRef.current
      && el.scrollTop < prevScrollTopRef.current
    ) {
      scrollToTailIntentRef.current = false;
    }

    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);

    if (pinListTailRef.current) {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap > AUTO_SCROLL_THRESHOLD) {
        if (el.scrollTop < pinTailBaselineMaxScrollRef.current - 1) {
          pinListTailRef.current = false;
        } else {
          el.scrollTop = el.scrollHeight;
          pinTailBaselineMaxScrollRef.current = maxScroll;
        }
      } else {
        pinTailBaselineMaxScrollRef.current = maxScroll;
      }
    }

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const awayFromTail = distanceFromBottom > USER_AWAY_FROM_BOTTOM_PX;
    if (scrollToTailIntentRef.current && !awayFromTail) {
      scrollToTailIntentRef.current = false;
    }
    const scrolledUp = awayFromTail && !scrollToTailIntentRef.current;
    if (awayFromTail) pinListTailRef.current = false;
    isScrolledUpRef.current = scrolledUp;
    setShowScrollBtn(scrolledUp);
    if (!awayFromTail) {
      streamingFollowPauseUntilRef.current = 0;
    }
    // Clear new-content highlight once the user reaches the bottom
    if (!awayFromTail) setHasNewContent(false);

    syncStickyUserMessageVisibility();

    // Trigger loading older messages when near the top
    if (
      el.scrollTop < PAGINATION_THRESHOLD &&
      activeThreadId &&
      hasMore &&
      !isLoadingMore
    ) {
      loadOlderMessages(activeThreadId);
    }

    prevScrollTopRef.current = el.scrollTop;
  }, [activeThreadId, hasMore, isLoadingMore, loadOlderMessages, syncStickyUserMessageVisibility]);

  const stableItems = useMemo(
    () => buildStableItems(messages, persistedFilesChanged, latestTurnWithChanges, {
      threadId: currentThreadId ?? "",
      messageId: currentTurnMessageId || undefined,
      responseKey: currentTurnResponseKey || undefined,
      responseKeysByMessageId: assistantResponseKeys,
    }),
    [
      messages,
      persistedFilesChanged,
      latestTurnWithChanges,
      currentThreadId,
      currentTurnMessageId,
      currentTurnResponseKey,
      assistantResponseKeys,
    ],
  );

  const volatileItems = useMemo(() => {
    const base = buildVolatileItems(
      toolCalls,
      isAgentRunning,
      agentStartTime,
      streamingText,
      permissions,
      hooks,
      thoughtSegments,
      currentThreadId
        ? {
            threadId: currentThreadId,
            messageId: currentTurnMessageId || undefined,
            responseKey: currentTurnResponseKey || undefined,
            responseKeysByMessageId: assistantResponseKeys,
          }
        : undefined,
    );
    const lastMsg = messages[messages.length - 1];
    const committedAssistantBody =
      currentThreadId && !isAgentRunning && lastMsg?.role === "assistant"
        ? lastMsg.content
        : undefined;
    if (!committedAssistantBody) {
      return base;
    }
    return base.map((item) =>
      item.type === "narrative-flow"
        ? { ...item, committedAssistantBody }
        : item,
    );
  }, [
    toolCalls,
    isAgentRunning,
    agentStartTime,
    streamingText,
    permissions,
    hooks,
    thoughtSegments,
    messages,
    currentThreadId,
    currentTurnMessageId,
    currentTurnResponseKey,
    assistantResponseKeys,
  ]);

  const hasToolCalls = toolCalls.length > 0;
  const items = useMemo(
    () => buildVirtualItems(stableItems, volatileItems, hasToolCalls),
    [stableItems, volatileItems, hasToolCalls],
  );

  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user" && !message.is_internal) {
        return message;
      }
    }
    return null;
  }, [messages]);

  const lastUserMessagePreview = useMemo(
    () => (lastUserMessage ? resolveUserMessagePreview(lastUserMessage) : null),
    [lastUserMessage],
  );

  const lastUserMessageItemIndex = useMemo(() => {
    if (!lastUserMessage) return -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === "message" && item.message.id === lastUserMessage.id) {
        return i;
      }
    }
    return -1;
  }, [items, lastUserMessage]);

  useLayoutEffect(() => {
    if (
      lastUserMessage
      && lastUserMessagePreview
      && lastUserMessageItemIndex >= 0
    ) {
      stickyUserMessageTargetRef.current = {
        id: lastUserMessage.id,
        itemIndex: lastUserMessageItemIndex,
      };
      return;
    }
    stickyUserMessageTargetRef.current = null;
    if (showStickyUserMessageRef.current) {
      showStickyUserMessageRef.current = false;
      setShowStickyUserMessage(false);
    }
  }, [lastUserMessage, lastUserMessagePreview, lastUserMessageItemIndex]);

  useLayoutEffect(() => {
    if (!isPositioned) return;
    syncStickyUserMessageVisibility();
  }, [
    isPositioned,
    items.length,
    lastUserMessage?.id,
    lastUserMessagePreview,
    syncStickyUserMessageVisibility,
  ]);

  itemsLengthRef.current = items.length;

  // Mirror items in a ref so scrollToMessage can read the latest list
  // without adding items to its dependency array (which would re-create
  // the callback on every streaming token).
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const item = items[index];
      return item ? estimateItemHeight(item) : DEFAULT_ITEM_HEIGHT;
    },
    getItemKey: (index) => items[index]?.key ?? String(index),
    overscan: OVERSCAN,
    // Opt out of react-virtual's flushSync(rerender) on sync measurement. It
    // fires inside the library's commit-phase layout effect and trips React's
    // "flushSync called from inside a lifecycle method" warning. Scroll-tail
    // compensation is unaffected: shouldAdjustScrollPositionOnItemSizeChange
    // adjusts scrollOffset inside virtual-core before onChange, so only the
    // React re-render is deferred from sync to React's normal batching.
    useFlushSync: false,
  });
  virtualizerRef.current = virtualizer;

  // Pinned to tail: always compensate for size changes so the viewport tracks
  // the bottom as rows measure. Adjusting by +delta when at scrollOffset = oldMaxScroll
  // gives newScrollOffset = oldMaxScroll + delta = newMaxScroll, exactly the new tail.
  // Near the tail (not pinned): adjust within AUTO_SCROLL_THRESHOLD so a small
  // user-induced scroll-up can still settle on the true bottom as items measure.
  // Farther up: keep default above-viewport anchoring so history reading stays stable.
  // Assigned on the stable virtualizer instance (TanStack Virtual v3 API);
  // not available as a useVirtualizer option in the current type definitions.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
    item,
    _delta,
    instance,
  ) => {
    if (pinListTailRef.current) return true;
    const viewportHeight = instance.scrollRect?.height ?? 0;
    const scrollOffset = instance.scrollOffset ?? 0;
    const remaining =
      instance.getTotalSize() - (scrollOffset + viewportHeight);
    if (remaining <= AUTO_SCROLL_THRESHOLD) {
      return true;
    }
    return item.start < scrollOffset;
  };

  /**
   * Programmatic scroll to the list tail. Auto-follow uses the scroll element
   * directly (no virtualizer reconcile, no CSS smooth). The floating button
   * passes smooth=true for intentional animation.
   */
  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      if (scrollTimerRef.current) return;
      const delay = smooth ? 200 : 0;
      scrollTimerRef.current = setTimeout(() => {
        scrollTimerRef.current = null;
        const count = itemsLengthRef.current;
        if (count === 0) return;
        const el = containerRef.current;
        if (smooth) {
          virtualizer.scrollToIndex(count - 1, {
            align: "end",
            behavior: "smooth",
          });
          return;
        }
        if (el) {
          pinListTailRef.current = true;
          el.scrollTop = el.scrollHeight;
          pinTailBaselineMaxScrollRef.current = Math.max(0, el.scrollHeight - el.clientHeight);
          requestAnimationFrame(() => {
            const el2 = containerRef.current;
            if (el2) {
              el2.scrollTop = el2.scrollHeight;
              pinTailBaselineMaxScrollRef.current = Math.max(0, el2.scrollHeight - el2.clientHeight);
            }
          });
        }
      }, delay);
    },
    [virtualizer],
  );

  /**
   * Pins the scroll element to the list tail and reveals only after the inner
   * list height has been stable for {@link TAIL_SETTLE_STABLE_FRAMES} consecutive
   * frames (or {@link TAIL_SETTLE_MAX_FRAMES} hard cap, whichever comes first).
   *
   * Why a settle loop: TanStack Virtual measures rows after mount via its
   * internal ResizeObserver. On long threads the estimated total size can be
   * significantly less than the measured total. A single (or few) `scrollTop =
   * scrollHeight` snap revealed before measurements complete leaves the user
   * sitting *above* the real tail. ResizeObserver-based pinning fires too late
   * to fix the perceived first paint. Hiding the list (opacity: 0) until both
   * `scrollHeight` and `virtualizer.getTotalSize()` stop changing means the
   * very first thing the user sees is already at the true bottom.
   *
   * @param options.measureFirst - When true, runs `virtualizer.measure()` and
   *   `scrollToIndex(n-1, end, auto)` to anchor the virtualizer to the tail
   *   before rows finish measuring. Used on cache-miss completion and first
   *   open. Cache-hit switches omit this so the cached measurement state stays
   *   warm and we land exactly where the cache says the tail is.
   */
  const positionAtBottom = useCallback((options?: { measureFirst?: boolean }) => {
    beginSuppressPassiveAutoBottomScroll();
    const settleGen = ++tailSettleGenRef.current;
    pinListTailRef.current = true;
    isInitialLoadRef.current = false;

    if (options?.measureFirst) {
      virtualizer.measure();
      const n = itemsLengthRef.current;
      if (n > 0) {
        virtualizer.scrollToIndex(n - 1, { align: "end", behavior: "auto" });
      }
    }

    const snap = () => {
      const el = containerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      pinTailBaselineMaxScrollRef.current = Math.max(0, el.scrollHeight - el.clientHeight);
    };

    // Synchronous first snap so non-rAF environments (jsdom in unit tests)
    // still see scrollTop applied before the rAF-based settle loop runs.
    snap();

    let lastScrollHeight = -1;
    let lastTotalSize = -1;
    let stableFrames = 0;
    let frame = 0;

    const reveal = () => {
      snap();
      setIsPositioned(true);
      scheduleEndSuppressPassiveAutoBottomScroll();
    };

    const tick = () => {
      if (tailSettleGenRef.current !== settleGen) return;
      // If the user cleared the pin (wheel up, scrollbar drag) during settle,
      // reveal immediately so they can interact with whatever they've scrolled to.
      if (!pinListTailRef.current) {
        setIsPositioned(true);
        scheduleEndSuppressPassiveAutoBottomScroll();
        return;
      }
      frame++;
      snap();
      const el = containerRef.current;
      if (!el) {
        setIsPositioned(true);
        scheduleEndSuppressPassiveAutoBottomScroll();
        return;
      }
      const h = el.scrollHeight;
      const total = virtualizer.getTotalSize();
      // Both scrollHeight (DOM) and getTotalSize (virtualizer state) must be
      // unchanged. They can drift by one frame: the virtualizer updates its
      // internal total first, then React re-renders the inner div with the new
      // height. Requiring both to match for STABLE_FRAMES proves no measurement
      // is in flight.
      if (h === lastScrollHeight && total === lastTotalSize) {
        stableFrames++;
      } else {
        stableFrames = 0;
      }
      lastScrollHeight = h;
      lastTotalSize = total;
      if (stableFrames >= TAIL_SETTLE_STABLE_FRAMES || frame >= TAIL_SETTLE_MAX_FRAMES) {
        reveal();
        return;
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }, [beginSuppressPassiveAutoBottomScroll, scheduleEndSuppressPassiveAutoBottomScroll, virtualizer]);

  // Clean up pending scroll timer on unmount.
  //
  // Do NOT bump `tailSettleGenRef` here. In React StrictMode dev the unmount
  // cleanup fires between mount-1 and mount-2 of the initial mount; if we
  // bumped the gen we would invalidate the in-flight settle rAF scheduled by
  // mount-1, and mount-2 would not re-call `positionAtBottom` (because
  // `isInitialLoadRef.current` was already flipped to false). The list would
  // then sit at opacity:0 forever. A real unmount makes `containerRef.current`
  // null, which the settle tick already handles by revealing and bailing.
  // The gen is still bumped by each new `positionAtBottom` call, which is what
  // we actually need to cancel a stale tick when the user navigates.
  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
    };
  }, []);

  /** Scrolls to a message by ID, then briefly flashes it to orient the user. */
  const scrollToMessage = useCallback((messageId: string) => {
    const idx = itemsRef.current.findIndex(
      (item) => item.type === "message" && item.message.id === messageId,
    );
    if (idx !== -1) {
      pinListTailRef.current = false;
      scrollToTailIntentRef.current = false;
      virtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
      setTimeout(() => {
        const element = document.querySelector(`[data-message-id="${messageId}"]`);
        if (element) {
          element.classList.add("animate-flash-highlight");
          setTimeout(() => element.classList.remove("animate-flash-highlight"), 1500);
        }
      }, 300);
    }
  }, [virtualizer]);

  const lastUserMessageRef = useRef(lastUserMessage);
  lastUserMessageRef.current = lastUserMessage;

  useEffect(() => {
    const stickyVisible =
      showStickyUserMessage && isPositioned && !!lastUserMessagePreview;
    if (!stickyVisible) return;
    const dispose = registerCommand({
      id: "stickyUserMessage.jump",
      title: "Jump to Last User Message",
      category: "Navigation",
      handler: () => {
        const target = lastUserMessageRef.current;
        if (target) scrollToMessage(target.id);
      },
    });
    return dispose;
  }, [
    showStickyUserMessage,
    isPositioned,
    lastUserMessagePreview,
    scrollToMessage,
  ]);

  // Save the outgoing thread's scrollTop, then reset per-thread UI state.
  // Cache-miss vs cache-hit is inferred from `loading`: the threadStore sets
  // loading=true synchronously on miss and false synchronously on hit.
  // Uses useLayoutEffect so pendingScrollRestoreRef is set before the scroll
  // restoration useLayoutEffect reads it.
  useLayoutEffect(() => {
    const prevId = prevActiveThreadIdRef.current;
    const isThreadSwitch = !!prevId && prevId !== activeThreadId;
    if (isThreadSwitch && prevId) {
      const el = containerRef.current;
      if (el) rememberScrollTop(prevId, el.scrollTop);
    }
    prevActiveThreadIdRef.current = activeThreadId ?? null;

    if (!activeThreadId) return;

    if (isThreadSwitch) {
      // Reset thread-scoped refs and affordance state so the prepend-detection
      // effect, scroll-affordance UI, and turn-expand map don't carry stale
      // measurements from the previous thread into the new one.
      pinListTailRef.current = false;
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
      turnExpandRef.current.clear();
      scrollToTailIntentRef.current = false;
      prevMessageCountRef.current = 0;
      firstMessageIdRef.current = null;
      prevScrollHeightRef.current = 0;
      isScrolledUpRef.current = false;
      setShowScrollBtn(false);
      setHasNewContent(false);
      showStickyUserMessageRef.current = false;
      setShowStickyUserMessage(false);
      setStickyBarHeight(0);
      prevStickyTopInsetRef.current = MESSAGE_LIST_TOP_PADDING_PX;
    }

    if (loading) {
      // Cache miss: full reset path. Hide until messages are positioned at bottom,
      // and clear stale measurements so previous-thread heights don't bleed in.
      isInitialLoadRef.current = true;
      setIsPositioned(false);
      setShowScrollBtn(false);
      setHasNewContent(false);
      pendingScrollRestoreRef.current = null;
      virtualizer.measure();
      return;
    }

    // Cache hit: keep the virtualizer's measurement cache (those rows have the
    // same item keys and dimensions — re-estimating would defeat the optimization).
    // With a remembered offset, restore it in a later effect. On thread switch
    // with no memory, jump to the bottom synchronously so the discrete-messages
    // effect does not run a visible smooth scroll from a stale offset. This block
    // still runs when `loading` flips true→false on the same thread; the
    // `isThreadSwitch` guard on the bottom branch avoids clobbering initial load.
    const rememberedScrollTop = recallScrollTop(activeThreadId);
    if (rememberedScrollTop != null) {
      isInitialLoadRef.current = false;
      setIsPositioned(true);
      pendingScrollRestoreRef.current = rememberedScrollTop;
    } else if (isThreadSwitch) {
      // Cache hit on switch with no saved offset: avoid leaving stale scroll and
      // throttled smooth scroll from the discrete-messages effect.
      pendingScrollRestoreRef.current = null;
      positionAtBottom();
    } else if (isInitialLoadRef.current && items.length > 0) {
      // Cache miss (or same-thread load): when `loading` becomes false, `prevId`
      // already matches `activeThreadId`, so `isThreadSwitch` is false. First open
      // also hits this branch. Pin the tail here so it tracks the same path as a
      // cache-hit switch (lazy markdown and measured row heights included).
      pendingScrollRestoreRef.current = null;
      positionAtBottom({ measureFirst: true });
    }
  }, [activeThreadId, loading, virtualizer, positionAtBottom, items.length]);

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

  // Empty thread: reveal without a tail jump. Non-empty initial tail positioning
  // runs in the active-thread useLayoutEffect so cache-miss completion (same
  // `activeThreadId` as `prevId`) is not skipped when `isThreadSwitch` is false.
  useLayoutEffect(() => {
    if (!isInitialLoadRef.current) return;

    // If loading finished with no items (empty thread), just reveal.
    if (!loading && items.length === 0) {
      isInitialLoadRef.current = false;
      setIsPositioned(true);
      return;
    }

    if (items.length === 0) return;
    if (loading) return;
  }, [items.length, loading]);

  // Apply the remembered scrollTop after the virtualizer has rendered the
  // restored items. useLayoutEffect runs before paint, so the user never sees
  // the bottom of the list flash before the restore.
  useLayoutEffect(() => {
    const target = pendingScrollRestoreRef.current;
    if (target == null) return;
    const el = containerRef.current;
    if (!el) return;
    // Only restore if items are actually loaded. On cache misses, this prevents
    // restoring before items have arrived, which would cause the wrong scroll position
    // to be briefly visible. When items load, items.length will change and trigger
    // another effect pass where loading is false.
    if (loading) return;
    beginSuppressPassiveAutoBottomScroll();
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const withinTail =
      target <= maxScroll && maxScroll - target <= AUTO_SCROLL_THRESHOLD;
    const snapToTail = withinTail || target > maxScroll;
    if (snapToTail) {
      pinListTailRef.current = true;
      el.scrollTop = el.scrollHeight;
      pinTailBaselineMaxScrollRef.current = Math.max(0, el.scrollHeight - el.clientHeight);
    } else {
      pinListTailRef.current = false;
      el.scrollTop = target;
    }
    pendingScrollRestoreRef.current = null;
    scrollToTailIntentRef.current = false;
    // Recall is for one-shot restore when entering a thread. The layout effect
    // also depends on items.length (initial hydrate); without forgetting, every
    // new message re-queues the same offset and yanks the viewport off the tail.
    if (activeThreadId) forgetScrollTop(activeThreadId);
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceFromBottom > USER_AWAY_FROM_BOTTOM_PX;
    isScrolledUpRef.current = scrolledUp;
    setShowScrollBtn(scrolledUp);
    if (!scrolledUp) {
      streamingFollowPauseUntilRef.current = 0;
      setHasNewContent(false);
    }
    requestAnimationFrame(() => {
      const el2 = containerRef.current;
      if (el2 && snapToTail) {
        el2.scrollTop = el2.scrollHeight;
        pinTailBaselineMaxScrollRef.current = Math.max(0, el2.scrollHeight - el2.clientHeight);
      }
      scheduleEndSuppressPassiveAutoBottomScroll();
    });
  }, [activeThreadId, items.length, loading, beginSuppressPassiveAutoBottomScroll, scheduleEndSuppressPassiveAutoBottomScroll]);

  // Discrete events (new message, tool call) -> scroll if at bottom, else highlight button
  useEffect(() => {
    if (isInitialLoadRef.current) return;
    if (suppressPassiveAutoBottomScrollRef.current) return;
    if (isScrolledUpRef.current) {
      setHasNewContent(true);
      return;
    }
    const el = containerRef.current;
    const dist = el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0;
    const nearTailWhilePaused =
      Date.now() < streamingFollowPauseUntilRef.current
      && dist <= USER_AWAY_FROM_BOTTOM_PX;
    if (Date.now() < streamingFollowPauseUntilRef.current && !nearTailWhilePaused) {
      setHasNewContent(true);
      return;
    }
    scrollToBottom(false);
  }, [activeThreadId, messages.length, toolCalls.length, isAgentRunning, scrollToBottom]);

  // Streaming deltas -> scroll if at bottom, else highlight button
  useEffect(() => {
    if (suppressPassiveAutoBottomScrollRef.current) return;
    if (!streamingText || isInitialLoadRef.current) return;
    if (isScrolledUpRef.current) {
      setHasNewContent(true);
      return;
    }
    const el = containerRef.current;
    const dist = el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0;
    const nearTailWhilePaused =
      Date.now() < streamingFollowPauseUntilRef.current
      && dist <= USER_AWAY_FROM_BOTTOM_PX;
    if (Date.now() < streamingFollowPauseUntilRef.current && !nearTailWhilePaused) {
      setHasNewContent(true);
      return;
    }
    scrollToBottom(false);
  }, [streamingText, activeThreadId, scrollToBottom]);

  // Capture text selections in message bubbles and activate reply mode for the selected text.
  // Only triggers when Ctrl (or Cmd on Mac) is held during mouseup so casual
  // highlights don't accidentally activate the reply bar.
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return;

      const anchorNode = selection.anchorNode;
      if (!anchorNode) return;
      const msgElement = (anchorNode instanceof Element ? anchorNode : anchorNode.parentElement)
        ?.closest("[data-message-id]");
      if (!msgElement) return;

      const messageId = msgElement.getAttribute("data-message-id");
      const messageRoleRaw = msgElement.getAttribute("data-message-role");
      if (!messageId || !messageRoleRaw || messageRoleRaw === "system") return;
      const messageRole = messageRoleRaw as "user" | "assistant";

      const selectedText = selection.toString().trim();
      if (!selectedText) return;

      const threadId = msgElement.getAttribute("data-thread-id");
      if (threadId) {
        useReplyStore.getState().setReply(
          threadId,
          messageId,
          messageRole,
          selectedText.slice(0, 150),
          selectedText.slice(0, 2000),
        );
      }
    };

    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, []);

  /**
   * While {@link pinListTailRef} is set (open or tail restore), keep the viewport on the tail as row heights stabilize.
   * Re-run when `loading` clears so the observer attaches after the list inner exists and has non-zero size.
   */
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const outer = containerRef.current;
    const inner = outer?.firstElementChild as HTMLElement | undefined;
    if (!outer || !inner) return;
    const ro = new ResizeObserver(() => {
      if (!pinListTailRef.current) return;
      outer.scrollTop = outer.scrollHeight;
      pinTailBaselineMaxScrollRef.current = Math.max(0, outer.scrollHeight - outer.clientHeight);
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [activeThreadId, loading]);

  const stickyReservedTop =
    showStickyUserMessage && isPositioned
      ? stickyBarHeight > 0
        ? stickyBarHeight
        : STICKY_USER_MESSAGE_ESTIMATED_HEIGHT
      : 0;

  const effectiveStickyTopInset =
    stickyReservedTop > 0 ? stickyReservedTop : MESSAGE_LIST_TOP_PADDING_PX;

  // When the sticky bar reserves more top padding, bump scrollTop so the transcript
  // does not jump and re-trigger visibility at the clip boundary (padding feedback loop).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !isPositioned) return;
    const delta = effectiveStickyTopInset - prevStickyTopInsetRef.current;
    if (delta !== 0) {
      el.scrollTop = Math.max(0, el.scrollTop + delta);
      prevScrollTopRef.current = el.scrollTop;
    }
    prevStickyTopInsetRef.current = effectiveStickyTopInset;
  }, [effectiveStickyTopInset, isPositioned]);

  return (
    <div className="relative h-full" data-testid="message-list">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        className={cn(
          "h-full overflow-y-auto transition-opacity duration-75",
          stickyReservedTop === 0 && "pt-4",
        )}
        style={{
          opacity: isPositioned ? 1 : 0,
          paddingTop: stickyReservedTop > 0 ? stickyReservedTop : undefined,
        }}
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
                className="absolute left-0 w-full px-8 py-2"
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <div className="mx-auto w-full min-w-0 max-w-4xl overflow-x-hidden">
                  <VirtualItemRenderer item={item} turnExpandRef={turnExpandRef} onBranch={onBranch} onReply={onReply} onScrollToMessage={scrollToMessage} currentTurnMessageIdByThread={currentTurnMessageIdByThread} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Skeleton placeholder shown while the handoff context is being generated for a child thread.
          Conditions: handoff still generating and only the initial user message has been submitted
          (no assistant reply yet), so the user sees something happening rather than an empty thread. */}
      {handoffStatus === "generating" && messages.filter((m) => m.role !== "system").length <= 1 && (
        <div className="px-8 py-4">
          <div className="mx-auto w-full max-w-4xl space-y-2">
            <div className="h-3.5 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        </div>
      )}

      {/* Loading spinner overlay for scroll-up pagination */}
      {isLoadingMore && (
        <div className="absolute top-2 left-1/2 z-10 -translate-x-1/2">
          <div className="rounded-md border border-border/40 bg-background/80 px-2 py-1 backdrop-blur-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/70" />
          </div>
        </div>
      )}

      {lastUserMessagePreview && (
        <StickyUserMessage
          preview={lastUserMessagePreview}
          visible={showStickyUserMessage && isPositioned}
          onJumpToMessage={() => {
            if (lastUserMessage) scrollToMessage(lastUserMessage.id);
          }}
          onHeightChange={handleStickyHeightChange}
        />
      )}

      {/* Scroll-to-bottom floating button — pulses when new content arrives */}
      {showScrollBtn && isPositioned && (
        <ScrollToBottomButton
          hasNewContent={hasNewContent}
          onScrollToBottom={() => {
            setHasNewContent(false);
            streamingFollowPauseUntilRef.current = 0;
            scrollToTailIntentRef.current = true;
            isScrolledUpRef.current = false;
            setShowScrollBtn(false);
            scrollToBottom(true);
          }}
        />
      )}
    </div>
  );
}
