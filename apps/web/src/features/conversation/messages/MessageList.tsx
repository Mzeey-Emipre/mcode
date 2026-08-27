import { useRef, useEffect, useLayoutEffect, useCallback, useState, type ReactNode, type WheelEvent } from "react";
import { cn } from "@/lib/utils";
import { useVirtualizer, type Range } from "@tanstack/react-virtual";
import { recordThreadPositioned } from "@/lib/thread-switch-telemetry";
import {
  rememberScrollTop,
  recallScrollPosition,
  type ThreadScrollPosition,
} from "@/components/chat/scrollPositionMemory";
import type { SubagentRosterTarget } from "../narrative";
import { STICKY_USER_MESSAGE_ESTIMATED_HEIGHT } from "@/components/chat/StickyUserMessage";
import { registerCommand } from "@/lib/command-registry";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { shouldShowStickyUserMessage, type StickyVisibilityVirtualizer } from "@/components/chat/sticky-user-message-visibility";
import type { SelectedTextComment } from "@mcode/contracts";
import {
  isMessageListPerformanceBuild,
  measureMessageListPerformance,
} from "@/performance/message-list-performance";
import { TranscriptItemRenderer } from "./timeline/TranscriptItemRenderer";
import { MessageListOverlays } from "./MessageListOverlays";
import {
  canLoadNewerHistory,
  canLoadOlderHistory,
  findViewportMessageAnchor,
  reconcileTranscriptTail,
  shouldReleaseHistoryTrailingSpace,
  trailingMessageSpace,
} from "./message-list-scroll";
import {
  applyHistoryWindowAction,
  getHistoryWindowAction,
  recallEvictedHistoryPosition,
  settleHistoryAnchor,
  snapshotHistoryWindow,
} from "./message-list-history";
import {
  getScrollRestorePlan,
  settleRestoredReadingAnchor,
} from "./message-list-scroll-restore";
import { useMessageListData } from "./useMessageListData";
import { useMessageListItems } from "./useMessageListItems";
import {
  DEFAULT_MESSAGE_LIST_ITEM_HEIGHT,
  countPrependedVirtualItems,
  estimateMessageListItemHeight,
  findMessageListItemIndex,
  preservePrependedVirtualRange,
} from "./message-list-virtualization";

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

function reservedStickyTop(
  isStickyVisible: boolean,
  isPositioned: boolean,
  stickyBarHeight: number,
): number {
  if (!isStickyVisible || !isPositioned) return 0;
  return stickyBarHeight || STICKY_USER_MESSAGE_ESTIMATED_HEIGHT;
}

function resolveEffectiveStickyTopInset(stickyReservedTop: number): number {
  return stickyReservedTop || MESSAGE_LIST_TOP_PADDING_PX;
}

/** Props for the virtualized conversation transcript. */
export interface MessageListProps {
  /** Thread whose resident transcript is rendered while the selected thread hydrates. */
  displayThreadId?: string;
  /** Content that must appear before all persisted transcript messages. */
  leadingContent?: ReactNode;
  /** Called when the user clicks the branch icon on a message. */
  onBranch?: (messageId: string) => void;
  /** Called when the user uses a message reply control. */
  onReply?: (messageId: string, content: string, role: "user" | "assistant") => void;
  /** Adds one selected-text comment to the active Composer draft. */
  onSelectedTextComment?: (comment: SelectedTextComment) => void;
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
  /** Prefills the composer with `Continue` for an interrupted turn. */
  onContinue?: () => void | Promise<void>;
  /** Retries one turn with its exact persisted execution identity. */
  onRetry?: (executionId: string) => void | Promise<void>;
  /** Whether child prompts display their parent-agent provenance label. */
  showParentAgentProvenance?: boolean;
}

/** Virtualized list of chat messages, tool calls, and streaming indicators. */
export function MessageList({
  displayThreadId,
  leadingContent,
  onBranch,
  onReply,
  onSelectedTextComment,
  onSubagentSelect,
  onOpenSubagents,
  onContinue,
  onRetry,
  showParentAgentProvenance = true,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** Survives virtualizer remounts: remembers manual expand/collapse toggles by messageId. */
  const turnExpandRef = useRef<Map<string, boolean>>(new Map());
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsLengthRef = useRef(0);
  const prevMessageCountRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  /** Tracks the first message ID to detect real prepends vs appends. */
  const firstMessageIdRef = useRef<string | null>(null);
  /** Tracks the last message ID to detect a bounded window shift. */
  const lastMessageIdRef = useRef<string | null>(null);
  /** Number of inserted rows whose previous viewport must remain mounted until layout compensation. */
  const pendingPrependCountRef = useRef(0);
  /** Previous virtual row count used to translate retained keys after a prepend. */
  const previousVirtualItemCountRef = useRef(0);
  /** Previous first virtual key distinguishes a prepend from an append. */
  const firstVirtualItemKeyRef = useRef<string | null>(null);
  /** Visible message and viewport offset held steady while older history settles. */
  const pendingHistoryAnchorRef = useRef<{ messageId: string; top: number } | null>(null);
  /** Current virtual row index for the retained pagination anchor. */
  const pendingHistoryAnchorIndexRef = useRef(-1);
  /** Invalidates stale history-anchor settle loops after navigation or another prepend. */
  const historyAnchorSettleGenerationRef = useRef(0);
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
  const pendingScrollRestoreRef = useRef<ThreadScrollPosition | null>(null);
  /** Invalidates stale reading-position settle loops after another navigation. */
  const scrollRestoreGenerationRef = useRef(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  /** True when new content arrived while the user was scrolled up. */
  const [hasNewContent, setHasNewContent] = useState(false);
  const [historyAnchorTrailingSpace, setHistoryAnchorTrailingSpace] = useState(0);
  const historyAnchorTrailingSpaceRef = useRef(0);
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
  /** Prevents layout-driven scroll events from consuming warm history before the user asks for it. */
  const olderHistoryRequestedRef = useRef(false);
  /** Prevents layout-driven scroll events from reloading evicted newer history. */
  const newerHistoryRequestedRef = useRef(false);
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

  const {
    activeThreadId,
    renderedThreadId,
    isRenderedVisible: isRenderedConversationVisible,
    messages,
    loading,
    agentDisplayState,
    isAgentRunning,
    agentStartTime,
    streamingText,
    toolCalls,
    thoughtSegments,
    persistedFilesChanged,
    latestTurnWithChanges,
    hasMore,
    hasNewer,
    handoffStatus,
    isLoadingMore,
    isLoadingNewer,
    loadOlderMessages,
    loadNewerMessages,
    transcriptThreadId,
    permissions,
    hooks,
    persistedNarrativeByMessage,
    loadNarrativeForMessage,
    isNarrativeLoaded,
    currentTurnMessageId,
    currentTurnResponseKey,
    assistantResponseKeys,
    currentTurnMessageIdByThread,
    turnSummariesByMessageId,
  } = useMessageListData(displayThreadId);

  useLayoutEffect(() => {
    isPositionedRef.current = isPositioned;
  }, [isPositioned]);

  useLayoutEffect(() => {
    if (!isPositioned || !activeThreadId || renderedThreadId !== activeThreadId) return;
    if (transcriptThreadId && transcriptThreadId !== activeThreadId) return;
    recordThreadPositioned(activeThreadId);
  }, [activeThreadId, isPositioned, renderedThreadId, transcriptThreadId]);

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

  /** Load older messages only after an upward gesture reaches the top threshold. */
  const loadOlderHistoryWhenRequested = useCallback(() => {
    const el = containerRef.current;
    if (!el || !renderedThreadId) return;
    if (!canLoadOlderHistory({
      isRequested: olderHistoryRequestedRef.current,
      element: el,
      threadId: renderedThreadId,
      isVisible: isRenderedConversationVisible,
      hasMore,
      isLoading: isLoadingMore,
      threshold: PAGINATION_THRESHOLD,
    })) return;

    olderHistoryRequestedRef.current = false;
    const measuredTrailingSpace = trailingMessageSpace(el);
    if (measuredTrailingSpace !== undefined) {
      const nextTrailingSpace = Math.max(
        historyAnchorTrailingSpace,
        measuredTrailingSpace,
      );
      historyAnchorTrailingSpaceRef.current = nextTrailingSpace;
      setHistoryAnchorTrailingSpace(nextTrailingSpace);
    }
    pendingHistoryAnchorRef.current = findViewportMessageAnchor(el) ?? null;
    void loadOlderMessages(renderedThreadId);
  }, [renderedThreadId, hasMore, historyAnchorTrailingSpace, isLoadingMore, loadOlderMessages, isRenderedConversationVisible]);

  /** Load newer messages only after a downward gesture reaches the bottom threshold. */
  const loadNewerHistoryWhenRequested = useCallback(() => {
    const el = containerRef.current;
    if (!el || !renderedThreadId) return;
    if (!canLoadNewerHistory({
      isRequested: newerHistoryRequestedRef.current,
      element: el,
      threadId: renderedThreadId,
      isVisible: isRenderedConversationVisible,
      hasNewer,
      isLoading: isLoadingNewer,
      threshold: PAGINATION_THRESHOLD,
    })) return;

    newerHistoryRequestedRef.current = false;
    pendingHistoryAnchorRef.current = findViewportMessageAnchor(el) ?? null;
    void loadNewerMessages(renderedThreadId);
  }, [hasNewer, isLoadingNewer, loadNewerMessages, renderedThreadId, isRenderedConversationVisible]);

  /** Clears tail pin when the user scrolls content upward (wheel / trackpad). */
  const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      olderHistoryRequestedRef.current = true;
      const interruptedPendingTailScroll = scrollTimerRef.current !== null;
      scrollToTailIntentRef.current = false;
      pinListTailRef.current = false;
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
      if (interruptedPendingTailScroll) {
        isScrolledUpRef.current = true;
        setShowScrollBtn(true);
      }
      streamingFollowPauseUntilRef.current = Date.now() + WHEEL_UP_FOLLOW_PAUSE_MS;
      loadOlderHistoryWhenRequested();
    } else if (e.deltaY > 0) {
      newerHistoryRequestedRef.current = true;
      loadNewerHistoryWhenRequested();
    }
  }, [loadNewerHistoryWhenRequested, loadOlderHistoryWhenRequested]);

  /** Track scroll-to-bottom button visibility and trigger upward pagination near the top. */
  const handleScroll = useCallback(() => {
    if (!isPositionedRef.current) return;
    const el = containerRef.current;
    if (!el) return;

    const reconciliation = reconcileTranscriptTail(el, {
      isPinned: pinListTailRef.current,
      baselineMaxScroll: pinTailBaselineMaxScrollRef.current,
      hasScrollToTailIntent: scrollToTailIntentRef.current,
      previousScrollTop: prevScrollTopRef.current,
      wasScrolledUp: isScrolledUpRef.current,
    }, USER_AWAY_FROM_BOTTOM_PX);
    pinListTailRef.current = reconciliation.state.isPinned;
    pinTailBaselineMaxScrollRef.current = reconciliation.state.baselineMaxScroll;
    scrollToTailIntentRef.current = reconciliation.state.hasScrollToTailIntent;
    isScrolledUpRef.current = reconciliation.state.isScrolledUp;
    setShowScrollBtn(reconciliation.state.isScrolledUp);
    if (
      renderedThreadId
      && transcriptThreadId === renderedThreadId
      && !suppressPassiveAutoBottomScrollRef.current
    ) {
      const anchor = findViewportMessageAnchor(el);
      rememberScrollTop(
        renderedThreadId,
        el.scrollTop,
        !reconciliation.awayFromTail,
        anchor,
      );
    }
    if (!reconciliation.awayFromTail) {
      streamingFollowPauseUntilRef.current = 0;
      setHasNewContent(false);
    }

    syncStickyUserMessageVisibility();

    loadOlderHistoryWhenRequested();
    loadNewerHistoryWhenRequested();

    if (shouldReleaseHistoryTrailingSpace({
      trailingSpace: historyAnchorTrailingSpaceRef.current,
      hasPendingAnchor: pendingHistoryAnchorRef.current !== null,
      currentScrollTop: el.scrollTop,
      previousScrollTop: prevScrollTopRef.current,
    })) {
      historyAnchorTrailingSpaceRef.current = 0;
      setHistoryAnchorTrailingSpace(0);
    }

    prevScrollTopRef.current = el.scrollTop;
  }, [historyAnchorTrailingSpace, renderedThreadId, loadNewerHistoryWhenRequested, loadOlderHistoryWhenRequested, transcriptThreadId, syncStickyUserMessageVisibility]);

  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (isMessageListPerformanceBuild() && persistedNarrativeByMessage[message.id]) continue;
      if (renderedThreadId && isNarrativeLoaded(renderedThreadId, message.id)) continue;
      void loadNarrativeForMessage(message.id, renderedThreadId ?? undefined);
    }
  }, [messages, persistedNarrativeByMessage, isNarrativeLoaded, loadNarrativeForMessage, renderedThreadId]);

  const {
    items,
    lastUserMessage,
    lastUserMessagePreview,
    lastUserMessageItemIndex,
  } = useMessageListItems({
    agentDisplayState,
    agentStartTime,
    assistantResponseKeys,
    currentTurnMessageId,
    currentTurnResponseKey,
    hooks,
    isAgentRunning,
    latestTurnWithChanges,
    leadingContent,
    messages,
    permissions,
    persistedFilesChanged,
    persistedNarrativeByMessage,
    renderedThreadId,
    streamingText,
    thoughtSegments,
    toolCalls,
    turnSummariesByMessageId,
  });

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

  pendingPrependCountRef.current = countPrependedVirtualItems(
    previousVirtualItemCountRef.current,
    items,
    firstVirtualItemKeyRef.current,
  );
  const pendingAnchorMessageId = pendingHistoryAnchorRef.current?.messageId;
  pendingHistoryAnchorIndexRef.current = findMessageListItemIndex(items, pendingAnchorMessageId);
  const rangeExtractor = useCallback(
    (range: Range) => preservePrependedVirtualRange(
      range,
      pendingPrependCountRef.current,
      pendingHistoryAnchorIndexRef.current,
    ),
    [],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    onChange: syncStickyUserMessageVisibility,
    estimateSize: (index) => {
      const item = items[index];
      return item ? estimateMessageListItemHeight(item) : DEFAULT_MESSAGE_LIST_ITEM_HEIGHT;
    },
    getItemKey: (index) => items[index]?.key ?? String(index),
    overscan: OVERSCAN,
    rangeExtractor,
    // Opt out of react-virtual's flushSync(rerender) on sync measurement. It
    // fires inside the library's commit-phase layout effect and trips React's
    // "flushSync called from inside a lifecycle method" warning. Scroll-tail
    // compensation is unaffected: shouldAdjustScrollPositionOnItemSizeChange
    // adjusts scrollOffset inside virtual-core before onChange, so only the
    // React re-render is deferred from sync to React's normal batching.
    useFlushSync: false,
  });
  virtualizerRef.current = virtualizer;
  const virtualTotalSize = virtualizer.getTotalSize();
  const virtualRows = measureMessageListPerformance(
    "tanstackVirtualItems",
    () => virtualizer.getVirtualItems(),
  );

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

  useLayoutEffect(() => {
    previousVirtualItemCountRef.current = items.length;
    firstVirtualItemKeyRef.current = items[0]?.key ?? null;
  }, [items]);

  /** Pins the visible transcript to the current measured tail before paint. */
  const snapToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    pinListTailRef.current = true;
    el.scrollTop = el.scrollHeight;
    pinTailBaselineMaxScrollRef.current = Math.max(0, el.scrollHeight - el.clientHeight);
    requestAnimationFrame(() => {
      const current = containerRef.current;
      if (!current || !pinListTailRef.current) return;
      current.scrollTop = current.scrollHeight;
      pinTailBaselineMaxScrollRef.current = Math.max(
        0,
        current.scrollHeight - current.clientHeight,
      );
    });
  }, []);

  useLayoutEffect(() => {
    if (!pinListTailRef.current) return;
    snapToBottom();
  }, [items.length, snapToBottom, virtualTotalSize]);

  /**
   * Programmatic scroll to the list tail. Auto-follow uses the scroll element
   * directly (no virtualizer reconcile, no CSS smooth). The floating button
   * passes smooth=true for intentional animation.
   */
  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      if (!smooth) {
        if (scrollTimerRef.current) return;
        snapToBottom();
        return;
      }
      if (scrollTimerRef.current) return;
      scrollTimerRef.current = setTimeout(() => {
        scrollTimerRef.current = null;
        const count = itemsLengthRef.current;
        if (count === 0) return;
        virtualizer.scrollToIndex(count - 1, {
          align: "end",
          behavior: "smooth",
        });
      }, 200);
    },
    [snapToBottom, virtualizer],
  );

  /**
   * Pins the scroll element to the list tail. Cache-miss navigation may reveal
   * after two frames while the same loop continues settling later row measurements;
   * other callers reveal after the inner height stabilizes or reaches the hard cap.
   *
   * Why a settle loop: TanStack Virtual measures rows after mount via its
   * internal ResizeObserver. On long threads the estimated total size can be
   * significantly less than the measured total. A single (or few) `scrollTop =
   * scrollHeight` snap revealed before measurements complete leaves the user
   * sitting *above* the real tail. ResizeObserver-based pinning fires too late
   * to fix the perceived first paint. The loop keeps snapping until
   * `scrollHeight` and `virtualizer.getTotalSize()` stop changing. Regular
   * positioning stays hidden during that work; cache-miss navigation reveals
   * the anchored tail early while the same loop continues below the viewport.
   *
   * @param options.measureFirst - Re-measures and anchors the virtualizer to the tail.
   * @param options.revealEarly - Reveals the anchored tail after two frames while
   *   the pin loop continues to absorb later row measurements.
   */
  const positionAtBottom = useCallback((options?: {
    measureFirst?: boolean;
    revealEarly?: boolean;
  }) => {
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

    if (options?.revealEarly) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (tailSettleGenRef.current !== settleGen) return;
          snap();
          setIsPositioned(true);
        });
      });
    }

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

  const resetThreadScopedViewportState = useCallback(() => {
    pinListTailRef.current = false;
    if (scrollTimerRef.current) {
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = null;
    }
    turnExpandRef.current.clear();
    scrollToTailIntentRef.current = false;
    olderHistoryRequestedRef.current = false;
    newerHistoryRequestedRef.current = false;
    pendingHistoryAnchorRef.current = null;
    historyAnchorTrailingSpaceRef.current = 0;
    setHistoryAnchorTrailingSpace(0);
    historyAnchorSettleGenerationRef.current += 1;
    scrollRestoreGenerationRef.current += 1;
    prevMessageCountRef.current = 0;
    firstMessageIdRef.current = null;
    lastMessageIdRef.current = null;
    prevScrollHeightRef.current = 0;
    isScrolledUpRef.current = false;
    setShowScrollBtn(false);
    setHasNewContent(false);
    showStickyUserMessageRef.current = false;
    setShowStickyUserMessage(false);
    setStickyBarHeight(0);
    prevStickyTopInsetRef.current = MESSAGE_LIST_TOP_PADDING_PX;
  }, []);

  const resetForInitialThreadLoad = useCallback(() => {
    if (!loading || messages.length > 0) return false;
    isInitialLoadRef.current = true;
    setIsPositioned(false);
    setShowScrollBtn(false);
    setHasNewContent(false);
    pendingScrollRestoreRef.current = null;
    virtualizer.measure();
    return true;
  }, [loading, messages.length, virtualizer]);

  const positionLoadedThread = useCallback((
    threadId: string,
    isThreadSwitch: boolean,
    previousThreadId: string | null,
  ) => {
    const rememberedPosition = isThreadSwitch || previousThreadId === null
      ? recallScrollPosition(threadId)
      : undefined;
    if (rememberedPosition) {
      isInitialLoadRef.current = false;
      setIsPositioned(true);
      pendingScrollRestoreRef.current = rememberedPosition;
      return;
    }
    if (isThreadSwitch) {
      pendingScrollRestoreRef.current = null;
      positionAtBottom();
      return;
    }
    if (!isInitialLoadRef.current || items.length === 0) return;
    pendingScrollRestoreRef.current = null;
    positionAtBottom({ measureFirst: true, revealEarly: true });
  }, [items.length, positionAtBottom]);

  // Save the outgoing thread's scrollTop, then reset per-thread UI state.
  // Cache-miss vs cache-hit is inferred from `loading`: the threadStore sets
  // loading=true synchronously on miss and false synchronously on hit.
  // Uses useLayoutEffect so pendingScrollRestoreRef is set before the scroll
  // restoration useLayoutEffect reads it.
  useLayoutEffect(() => {
    const prevId = prevActiveThreadIdRef.current;
    const isThreadSwitch = !!prevId && prevId !== renderedThreadId;
    prevActiveThreadIdRef.current = renderedThreadId ?? null;

    if (!renderedThreadId) return;

    if (isThreadSwitch) resetThreadScopedViewportState();
    if (resetForInitialThreadLoad()) return;

    if (loading && messages.length > 0) {
      // A tail commit is already paintable even while background history continues.
      setIsPositioned(true);
    }
    positionLoadedThread(renderedThreadId, isThreadSwitch, prevId);
  }, [
    renderedThreadId,
    loading,
    messages.length,
    positionLoadedThread,
    resetForInitialThreadLoad,
    resetThreadScopedViewportState,
  ]);

  // Stabilize scroll position when directional pagination shifts the resident window.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const previousWindow = {
      count: prevMessageCountRef.current,
      firstMessageId: firstMessageIdRef.current,
      lastMessageId: lastMessageIdRef.current,
    };
    const nextWindow = snapshotHistoryWindow(messages);
    prevMessageCountRef.current = nextWindow.count;
    firstMessageIdRef.current = nextWindow.firstMessageId;
    lastMessageIdRef.current = nextWindow.lastMessageId;
    const rememberedPosition = recallEvictedHistoryPosition(
      renderedThreadId,
      nextWindow.count,
      previousWindow.count,
    );
    const action = getHistoryWindowAction({
      element: el,
      previous: previousWindow,
      next: nextWindow,
      previousScrollHeight: prevScrollHeightRef.current,
      pendingAnchor: pendingHistoryAnchorRef.current,
      rememberedPosition,
    });

    applyHistoryWindowAction({
      action,
      isLoading: isLoadingMore || isLoadingNewer,
      resetPrepend: () => { pendingPrependCountRef.current = 0; },
      clearAnchor: () => { pendingHistoryAnchorRef.current = null; },
      updateScrollHeight: (scrollHeight) => { prevScrollHeightRef.current = scrollHeight; },
      settleAnchor: (anchor) => {
        if (!el) return;
        settleHistoryAnchor({
          element: el,
          anchor,
          anchorIndex: pendingHistoryAnchorIndexRef.current,
          virtualizer,
          generationRef: historyAnchorSettleGenerationRef,
          clearAnchor: () => { pendingHistoryAnchorRef.current = null; },
        });
      },
      adjustPrepend: (addedHeight) => {
        if (addedHeight > 0 && el) el.scrollTop += addedHeight;
      },
    });
  }, [isLoadingMore, isLoadingNewer, messages]);

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

  const restoreTailPosition = useCallback((element: HTMLElement) => {
    pinListTailRef.current = true;
    element.scrollTop = element.scrollHeight;
    pinTailBaselineMaxScrollRef.current = Math.max(0, element.scrollHeight - element.clientHeight);
    isScrolledUpRef.current = false;
    setShowScrollBtn(false);
    streamingFollowPauseUntilRef.current = 0;
    setHasNewContent(false);
    requestAnimationFrame(() => {
      const current = containerRef.current;
      if (current) {
        current.scrollTop = current.scrollHeight;
        pinTailBaselineMaxScrollRef.current = Math.max(0, current.scrollHeight - current.clientHeight);
      }
      scheduleEndSuppressPassiveAutoBottomScroll();
    });
  }, [scheduleEndSuppressPassiveAutoBottomScroll]);

  const restoreReadingPosition = useCallback((
    element: HTMLElement,
    plan: Extract<ReturnType<typeof getScrollRestorePlan>, { kind: "reading" }>,
  ) => {
    pinListTailRef.current = false;
    element.scrollTop = plan.scrollTop;
    isScrolledUpRef.current = true;
    setShowScrollBtn(true);
    if (!plan.anchorMessageId || plan.anchorTop == null) {
      scheduleEndSuppressPassiveAutoBottomScroll();
      return;
    }
    settleRestoredReadingAnchor({
      element,
      anchorMessageId: plan.anchorMessageId,
      anchorTop: plan.anchorTop,
      generationRef: scrollRestoreGenerationRef,
      scheduleEnd: scheduleEndSuppressPassiveAutoBottomScroll,
    });
  }, [scheduleEndSuppressPassiveAutoBottomScroll]);

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
    if (transcriptThreadId && transcriptThreadId !== renderedThreadId) return;
    beginSuppressPassiveAutoBottomScroll();
    pendingScrollRestoreRef.current = null;
    scrollToTailIntentRef.current = false;
    const plan = getScrollRestorePlan(el, target, AUTO_SCROLL_THRESHOLD);
    if (plan.kind === "tail") {
      restoreTailPosition(el);
      return;
    }
    restoreReadingPosition(el, plan);
  }, [
    renderedThreadId,
    items.length,
    loading,
    transcriptThreadId,
    beginSuppressPassiveAutoBottomScroll,
    restoreReadingPosition,
    restoreTailPosition,
  ]);

  // Discrete events (new message, tool call) -> scroll if at bottom, else highlight button
  useLayoutEffect(() => {
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
  }, [renderedThreadId, messages.length, toolCalls.length, isAgentRunning, scrollToBottom]);

  // Streaming deltas -> scroll before paint when following the tail, else highlight button.
  useLayoutEffect(() => {
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
  }, [streamingText, renderedThreadId, scrollToBottom]);

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
  }, [renderedThreadId, loading]);

  const handleJumpToLastUserMessage = useCallback(() => {
    if (lastUserMessage) scrollToMessage(lastUserMessage.id);
  }, [lastUserMessage, scrollToMessage]);

  const handleScrollToBottom = useCallback(() => {
    setHasNewContent(false);
    streamingFollowPauseUntilRef.current = 0;
    scrollToTailIntentRef.current = true;
    isScrolledUpRef.current = false;
    setShowScrollBtn(false);
    scrollToBottom(true);
  }, [scrollToBottom]);

  const stickyReservedTop = reservedStickyTop(
    showStickyUserMessage,
    isPositioned,
    stickyBarHeight,
  );
  const effectiveStickyTopInset = resolveEffectiveStickyTopInset(stickyReservedTop);

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
          style={{ height: virtualTotalSize + historyAnchorTrailingSpace }}
        >
          {virtualRows.map((vi) => {
            const item = items[vi.index];
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                data-performance-virtual-item-key={
                  isMessageListPerformanceBuild() ? item.key : undefined
                }
                className="absolute left-0 w-full px-4 py-2 sm:px-8"
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <div className={cn(PRIMARY_CONTENT_RAIL_CLASS, "min-w-0 overflow-x-hidden")}>
                  {item.type === "leading-content" ? (
                    <div data-testid="message-list-leading-content">{item.content}</div>
                  ) : (
                    <TranscriptItemRenderer item={item} turnExpandRef={turnExpandRef} onBranch={onBranch} onReply={onReply} onSubagentSelect={onSubagentSelect} onOpenSubagents={onOpenSubagents} onContinue={onContinue} onRetry={onRetry} onScrollToMessage={scrollToMessage} currentTurnMessageIdByThread={currentTurnMessageIdByThread} threadId={renderedThreadId} showParentAgentProvenance={showParentAgentProvenance} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <MessageListOverlays
        handoffStatus={handoffStatus}
        messages={messages}
        isLoadingMore={isLoadingMore}
        isLoadingNewer={isLoadingNewer}
        onSelectedTextComment={onSelectedTextComment}
        stickyPreview={lastUserMessagePreview}
        isStickyVisible={showStickyUserMessage && isPositioned}
        onJumpToLastUserMessage={handleJumpToLastUserMessage}
        onStickyHeightChange={handleStickyHeightChange}
        showScrollToBottom={showScrollBtn && isPositioned}
        hasNewContent={hasNewContent}
        onScrollToBottom={handleScrollToBottom}
      />
    </div>
  );
}
