import { useRef, useEffect, useLayoutEffect, useMemo, useCallback, memo, useState, type ReactNode, type WheelEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useShallow } from "zustand/shallow";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { recordThreadPositioned } from "@/lib/thread-switch-telemetry";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord, getThreadRecord, getHandoffStatus } from "../state";
import { MessageBubble } from "./MessageBubble";
import { ToolCallCard } from "@/components/chat/ToolCallCard";
import { StreamingIndicator } from "@/components/chat/StreamingIndicator";
import { StreamingCard } from "@/components/chat/StreamingCard";
import { TurnChangeSummary } from "@/components/chat/TurnChangeSummary";
import { PermissionRequestCard } from "@/components/chat/PermissionRequestCard";
import { HookActivitySection } from "@/components/chat/HookActivitySection";
import {
  buildStableItems,
  createVolatileItemsBuilder,
  createVirtualItemsBuilder,
  estimateItemHeight,
} from "./virtual-items";
import type { ChatVirtualItem } from "./virtual-items";
import type { ToolCall } from "@/transport/types";
import {
  rememberScrollTop,
  recallScrollPosition,
  type ThreadScrollPosition,
} from "@/components/chat/scrollPositionMemory";
import { NarrativeFlow, type SubagentRosterTarget } from "../narrative";
import { PersistedNarrative } from "../narrative/PersistedNarrative";
import { PersistedTurnFooter } from "../narrative/PersistedTurnFooter";
import { NarrativeIndicator } from "../narrative/NarrativeIndicator";
import { PersistedLateHooks } from "./PersistedLateHooks";
import { StickyUserMessage, STICKY_USER_MESSAGE_ESTIMATED_HEIGHT } from "@/components/chat/StickyUserMessage";
import { registerCommand } from "@/lib/command-registry";
import { isGoalStatusNotice } from "@/lib/goal-message";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { shouldShowStickyUserMessage, type StickyVisibilityVirtualizer } from "@/components/chat/sticky-user-message-visibility";
import { resolveUserMessagePreview } from "@/components/chat/user-message-preview";
import { isConversationVisible } from "../residency/conversation-residency";
import { projectCanonicalMessageList } from "./canonical-message-projection";
import {
  createSelectedTextCommentSource,
  type SelectedTextCommentSource,
} from "./selected-text-projection";
import {
  MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS,
  type SelectedTextComment,
} from "@mcode/contracts";

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

/** Keep the prior viewport and retained anchor mounted while history rows change indexes. */
export function preservePrependedVirtualRange(
  range: Range,
  prependedCount: number,
  retainedAnchorIndex = -1,
): number[] {
  const currentIndexes = defaultRangeExtractor(range);
  const previousViewportIndexes = prependedCount > 0
    ? currentIndexes
        .map((index) => index + prependedCount)
        .filter((index) => index < range.count)
    : [];
  const retainedAnchorIndexes = retainedAnchorIndex >= 0 && retainedAnchorIndex < range.count
    ? [retainedAnchorIndex]
    : [];
  return [...new Set([
    ...currentIndexes,
    ...previousViewportIndexes,
    ...retainedAnchorIndexes,
  ])].sort((left, right) => left - right);
}

/** Renders a single virtual item based on its type discriminant. */
const VirtualItemRenderer = memo(function VirtualItemRenderer({
  item,
  turnExpandRef,
  onBranch,
  onReply,
  onSubagentSelect,
  onOpenSubagents,
  onContinue,
  onRetry,
  onScrollToMessage,
  currentTurnMessageIdByThread,
  threadId,
  showParentAgentProvenance,
}: {
  item: ChatVirtualItem;
  turnExpandRef?: React.RefObject<Map<string, boolean>>;
  onBranch?: (messageId: string) => void;
  onReply?: (messageId: string, content: string, role: "user" | "assistant") => void;
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
  onContinue?: () => void | Promise<void>;
  onRetry?: (executionId: string) => void | Promise<void>;
  onScrollToMessage?: (messageId: string) => void;
  currentTurnMessageIdByThread: Record<string, string>;
  threadId: string | null | undefined;
  showParentAgentProvenance: boolean;
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
            showParentAgentProvenance={showParentAgentProvenance}
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
          onSubagentSelect={onSubagentSelect}
          onOpenSubagents={onOpenSubagents}
        />
      );
    case "persisted-narrative":
      return (
        <PersistedNarrative
          threadId={threadId}
          messageId={item.messageId}
          messageContent={item.messageContent}
          onSubagentSelect={onSubagentSelect}
          onOpenSubagents={onOpenSubagents}
        />
      );
    case "persisted-late-hooks":
      return <PersistedLateHooks threadId={threadId} messageId={item.messageId} />;
    case "persisted-turn-footer":
      return (
        <PersistedTurnFooter
          threadId={threadId}
          messageId={item.messageId}
          summary={item.summary}
          onContinue={onContinue}
          onRetry={onRetry}
        />
      );
    case "narrative-indicator":
      return (
        <NarrativeIndicator
          stepCount={item.stepCount}
          subagentCount={item.subagentCount}
          activeToolCalls={item.activeToolCalls}
          startTime={item.startTime}
          isAgentRunning={item.isAgentRunning}
        />
      );
  }
}, (prev, next) =>
  prev.item.key === next.item.key
  && prev.item === next.item
  && prev.turnExpandRef === next.turnExpandRef
  && prev.onBranch === next.onBranch
  && prev.onReply === next.onReply
  && prev.onSubagentSelect === next.onSubagentSelect
  && prev.onOpenSubagents === next.onOpenSubagents
  && prev.onContinue === next.onContinue
  && prev.onRetry === next.onRetry
  && prev.onScrollToMessage === next.onScrollToMessage
  && prev.currentTurnMessageIdByThread === next.currentTurnMessageIdByThread
  && prev.threadId === next.threadId
  && prev.showParentAgentProvenance === next.showParentAgentProvenance,
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

type MessageListItem = ChatVirtualItem | {
  readonly key: "leading-content";
  readonly type: "leading-content";
  readonly content: ReactNode;
};

function estimateMessageListItemHeight(item: MessageListItem): number {
  return item.type === "leading-content" ? DEFAULT_ITEM_HEIGHT : estimateItemHeight(item);
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
  const [selectedTextContextMenu, setSelectedTextContextMenu] = useState<{
    source: SelectedTextCommentSource;
    x: number;
    y: number;
  } | null>(null);
  const [selectedTextCopyAnnouncement, setSelectedTextCopyAnnouncement] = useState("");
  const [commentEditorSource, setCommentEditorSource] = useState<SelectedTextCommentSource | null>(null);
  const [commentNote, setCommentNote] = useState("");
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

  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const renderedThreadId = displayThreadId ?? activeThreadId;
  const isRenderedConversationVisible = displayThreadId
    ? isConversationVisible(displayThreadId)
    : renderedThreadId === activeThreadId;
  const legacyMessages = useThreadRecord(renderedThreadId, (r) => r.messages);
  const loading = useThreadRecord(renderedThreadId, (r) => r.loading);
  const legacyIsAgentRunning = useThreadStore((s) =>
    renderedThreadId ? s.runningThreadIds.has(renderedThreadId) : false,
  );
  const legacyAgentStartTime = useThreadRecord(renderedThreadId, (r) => r.agentStartTime);
  const streamingText = useThreadRecord(renderedThreadId, (r) => r.streaming);
  const legacyToolCalls = useThreadRecord(renderedThreadId, (r) => r.toolCalls);
  const legacyThoughtSegments = useThreadRecord(renderedThreadId, (r) => r.thoughtSegments);
  const canonicalAgentState = useThreadRecord(renderedThreadId, (r) => r.canonicalAgent.state);
  const canonicalProjection = useMemo(
    () => displayThreadId && renderedThreadId
      ? projectCanonicalMessageList({
          threadId: renderedThreadId,
          state: canonicalAgentState,
          messages: legacyMessages,
          toolCalls: legacyToolCalls,
          thoughtSegments: legacyThoughtSegments,
        })
      : undefined,
    [
      canonicalAgentState,
      displayThreadId,
      legacyMessages,
      legacyThoughtSegments,
      legacyToolCalls,
      renderedThreadId,
    ],
  );
  const messages = canonicalProjection?.messages ?? legacyMessages;
  const isAgentRunning = canonicalProjection?.isAgentRunning ?? legacyIsAgentRunning;
  const agentStartTime = canonicalProjection?.agentStartTime ?? legacyAgentStartTime;
  const toolCalls = canonicalProjection?.toolCalls ?? legacyToolCalls ?? EMPTY_TOOL_CALLS;
  const thoughtSegments = canonicalProjection?.thoughtSegments ?? legacyThoughtSegments;
  const persistedFilesChanged = useThreadStore(
    useShallow((s) => {
      if (!renderedThreadId) return EMPTY_FILES_CHANGED;
      const rec = getThreadRecord(s.records, renderedThreadId);
      if (rec.messages.length === 0) return EMPTY_FILES_CHANGED;
      const out: Record<string, string[]> = {};
      for (const m of rec.messages) {
        const v = rec.persistedFilesChanged[m.id];
        if (v) out[m.id] = v;
      }
      return out;
    }),
  );
  const latestTurnWithChanges = useThreadRecord(renderedThreadId, (r) => r.latestTurnWithChanges);
  const hasMore = useThreadRecord(renderedThreadId, (r) => r.hasMoreMessages);
  const hasNewer = useThreadRecord(renderedThreadId, (r) => r.hasNewerMessages);
  const handoffStatus = useThreadStore((s) =>
    renderedThreadId ? getHandoffStatus(getThreadRecord(s.records, renderedThreadId)) : undefined,
  );
  const isLoadingMore = useThreadRecord(renderedThreadId, (r) => r.isLoadingMore);
  const isLoadingNewer = useThreadRecord(renderedThreadId, (r) => r.isLoadingNewer);
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);
  const loadNewerMessages = useThreadStore((s) => s.loadNewerMessages);
  const transcriptThreadId = messages[0]?.thread_id ?? null;
  const permissions = useThreadRecord(renderedThreadId, (r) => r.permissions);
  const hooks = useThreadRecord(renderedThreadId, (r) => r.hooks);
  const persistedNarrativeByMessage = useThreadRecord(renderedThreadId, (r) => r.narrativeByMessage);
  const loadNarrativeForMessage = useThreadStore((s) => s.loadNarrativeForMessage);
  const isNarrativeLoaded = useThreadStore((s) => s.isNarrativeLoaded);
  const legacyCurrentTurnMessageId = useThreadRecord(renderedThreadId, (r) => r.currentTurnMessageId);
  const legacyCurrentTurnResponseKey = useThreadRecord(renderedThreadId, (r) => r.currentTurnResponseKey);
  const legacyAssistantResponseKeys = useThreadRecord(renderedThreadId, (r) => r.assistantResponseKeys);
  const currentTurnMessageId = canonicalProjection?.currentTurnMessageId ?? legacyCurrentTurnMessageId;
  const currentTurnResponseKey = canonicalProjection?.currentTurnResponseKey ?? legacyCurrentTurnResponseKey;
  const assistantResponseKeys = canonicalProjection?.assistantResponseKeys ?? legacyAssistantResponseKeys;
  const currentTurnMessageIdByThread = useMemo(
    () => (renderedThreadId && currentTurnMessageId
      ? { [renderedThreadId]: currentTurnMessageId }
      : EMPTY_TURN_MAP),
    [renderedThreadId, currentTurnMessageId],
  );

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
    if (
      !olderHistoryRequestedRef.current ||
      !el ||
      el.scrollTop >= PAGINATION_THRESHOLD ||
      !renderedThreadId ||
      !isRenderedConversationVisible ||
      !hasMore ||
      isLoadingMore
    ) {
      return;
    }

    olderHistoryRequestedRef.current = false;
    const viewportTop = el.getBoundingClientRect().top;
    const messageElements = [...el.querySelectorAll<HTMLElement>("[data-message-id]")];
    const anchor = messageElements
      .find((node) => node.getBoundingClientRect().bottom > viewportTop + 2);
    const lastMessage = messageElements.at(-1);
    if (lastMessage) {
      const trailingSpace = Math.max(
        historyAnchorTrailingSpace,
        el.getBoundingClientRect().bottom - lastMessage.getBoundingClientRect().bottom,
      );
      historyAnchorTrailingSpaceRef.current = trailingSpace;
      setHistoryAnchorTrailingSpace(trailingSpace);
    }
    pendingHistoryAnchorRef.current = anchor
      ? {
          messageId: anchor.getAttribute("data-message-id") ?? "",
          top: anchor.getBoundingClientRect().top,
        }
      : null;
    void loadOlderMessages(renderedThreadId);
  }, [activeThreadId, renderedThreadId, hasMore, historyAnchorTrailingSpace, isLoadingMore, loadOlderMessages, isRenderedConversationVisible]);

  /** Load newer messages only after a downward gesture reaches the bottom threshold. */
  const loadNewerHistoryWhenRequested = useCallback(() => {
    const el = containerRef.current;
    if (
      !newerHistoryRequestedRef.current
      || !el
      || el.scrollHeight - el.scrollTop - el.clientHeight >= PAGINATION_THRESHOLD
      || !renderedThreadId
      || !isRenderedConversationVisible
      || !hasNewer
      || isLoadingNewer
    ) {
      return;
    }

    newerHistoryRequestedRef.current = false;
    const viewportTop = el.getBoundingClientRect().top;
    const anchor = [...el.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((node) => node.getBoundingClientRect().bottom > viewportTop + 2);
    pendingHistoryAnchorRef.current = anchor
      ? {
          messageId: anchor.getAttribute("data-message-id") ?? "",
          top: anchor.getBoundingClientRect().top,
        }
      : null;
    void loadNewerMessages(renderedThreadId);
  }, [activeThreadId, hasNewer, isLoadingNewer, loadNewerMessages, renderedThreadId, isRenderedConversationVisible]);

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
    const wasScrolledUp = isScrolledUpRef.current;
    const completedTailScroll = scrollToTailIntentRef.current && !awayFromTail;
    if (completedTailScroll) {
      scrollToTailIntentRef.current = false;
    }
    const scrolledUp = awayFromTail && !scrollToTailIntentRef.current;
    if (awayFromTail) {
      pinListTailRef.current = false;
    } else if (pinListTailRef.current || wasScrolledUp || completedTailScroll) {
      pinListTailRef.current = true;
      pinTailBaselineMaxScrollRef.current = maxScroll;
    }
    isScrolledUpRef.current = scrolledUp;
    setShowScrollBtn(scrolledUp);
    if (
      renderedThreadId
      && transcriptThreadId === renderedThreadId
      && !suppressPassiveAutoBottomScrollRef.current
    ) {
      const viewportTop = el.getBoundingClientRect().top;
      const anchor = [...el.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((node) => node.getBoundingClientRect().bottom > viewportTop + 2);
      rememberScrollTop(
        renderedThreadId,
        el.scrollTop,
        !awayFromTail,
        anchor
          ? {
              messageId: anchor.getAttribute("data-message-id") ?? "",
              top: anchor.getBoundingClientRect().top,
            }
          : undefined,
      );
    }
    if (!awayFromTail) {
      streamingFollowPauseUntilRef.current = 0;
    }
    // Clear new-content highlight once the user reaches the bottom
    if (!awayFromTail) setHasNewContent(false);

    syncStickyUserMessageVisibility();

    loadOlderHistoryWhenRequested();
    loadNewerHistoryWhenRequested();

    if (
      historyAnchorTrailingSpaceRef.current > 0
      && pendingHistoryAnchorRef.current === null
      && el.scrollTop > prevScrollTopRef.current + 0.5
    ) {
      historyAnchorTrailingSpaceRef.current = 0;
      setHistoryAnchorTrailingSpace(0);
    }

    prevScrollTopRef.current = el.scrollTop;
  }, [historyAnchorTrailingSpace, renderedThreadId, loadNewerHistoryWhenRequested, loadOlderHistoryWhenRequested, transcriptThreadId, syncStickyUserMessageVisibility]);

  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (renderedThreadId && isNarrativeLoaded(renderedThreadId, message.id)) continue;
      void loadNarrativeForMessage(message.id, renderedThreadId ?? undefined);
    }
  }, [messages, persistedNarrativeByMessage, isNarrativeLoaded, loadNarrativeForMessage, renderedThreadId]);

  const stableItems = useMemo(
    () => buildStableItems(messages, persistedFilesChanged, latestTurnWithChanges, {
      threadId: renderedThreadId ?? "",
      messageId: currentTurnMessageId || undefined,
      responseKey: currentTurnResponseKey || undefined,
      responseKeysByMessageId: assistantResponseKeys,
    }, persistedNarrativeByMessage, canonicalProjection?.turnSummariesByMessageId),
    [
      messages,
      persistedFilesChanged,
      latestTurnWithChanges,
      renderedThreadId,
      currentTurnMessageId,
      currentTurnResponseKey,
      assistantResponseKeys,
      persistedNarrativeByMessage,
      canonicalProjection?.turnSummariesByMessageId,
    ],
  );

  const volatileItemsBuilderRef = useRef<ReturnType<typeof createVolatileItemsBuilder> | null>(null);
  if (volatileItemsBuilderRef.current == null) {
    volatileItemsBuilderRef.current = createVolatileItemsBuilder();
  }
  const virtualItemsBuilderRef = useRef<ReturnType<typeof createVirtualItemsBuilder> | null>(null);
  if (virtualItemsBuilderRef.current == null) {
    virtualItemsBuilderRef.current = createVirtualItemsBuilder();
  }

  const volatileItems = useMemo(() => {
    const lastAssistantAnswer = [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && !isGoalStatusNotice(message.content));
    const committedAssistantBody =
      renderedThreadId && !isAgentRunning && lastAssistantAnswer
        ? lastAssistantAnswer.content
        : undefined;
    return volatileItemsBuilderRef.current!(
      toolCalls,
      isAgentRunning,
      agentStartTime,
      streamingText,
      permissions,
      hooks,
      thoughtSegments,
      renderedThreadId
        ? {
            threadId: renderedThreadId,
            messageId: currentTurnMessageId || undefined,
            responseKey: currentTurnResponseKey || undefined,
            responseKeysByMessageId: assistantResponseKeys,
          }
        : undefined,
      committedAssistantBody,
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
    renderedThreadId,
    currentTurnMessageId,
    currentTurnResponseKey,
    assistantResponseKeys,
  ]);

  const hasToolCalls = toolCalls.length > 0;
  const virtualItems = useMemo(
    () => virtualItemsBuilderRef.current!(stableItems, volatileItems, hasToolCalls),
    [stableItems, volatileItems, hasToolCalls],
  );
  const items = useMemo<MessageListItem[]>(
    () => leadingContent == null
      ? virtualItems
      : [{ key: "leading-content", type: "leading-content", content: leadingContent }, ...virtualItems],
    [leadingContent, virtualItems],
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

  const previousVirtualItemCount = previousVirtualItemCountRef.current;
  pendingPrependCountRef.current =
    previousVirtualItemCount > 0
    && items.length > previousVirtualItemCount
    && firstVirtualItemKeyRef.current !== null
    && items[0]?.key !== firstVirtualItemKeyRef.current
      ? items.length - previousVirtualItemCount
      : 0;
  const pendingAnchorMessageId = pendingHistoryAnchorRef.current?.messageId;
  pendingHistoryAnchorIndexRef.current = pendingAnchorMessageId
    ? items.findIndex((item) =>
        item.type === "message" && item.message.id === pendingAnchorMessageId)
    : -1;
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
      return item ? estimateMessageListItemHeight(item) : DEFAULT_ITEM_HEIGHT;
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
    }

    if (loading && messages.length === 0) {
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

    if (loading && messages.length > 0) {
      // A tail commit is already paintable even while background history continues.
      setIsPositioned(true);
    }

    // Cache hit: keep the virtualizer's measurement cache (those rows have the
    // same item keys and dimensions — re-estimating would defeat the optimization).
    // With a remembered offset, restore it in a later effect. On thread switch
    // with no memory, jump to the bottom synchronously so the discrete-messages
    // effect does not run a visible smooth scroll from a stale offset. This block
    // still runs when `loading` flips true→false on the same thread; the
    // `isThreadSwitch` guard on the bottom branch avoids clobbering initial load.
    const rememberedPosition = isThreadSwitch || prevId === null
      ? recallScrollPosition(renderedThreadId)
      : undefined;
    if (rememberedPosition) {
      isInitialLoadRef.current = false;
      setIsPositioned(true);
      pendingScrollRestoreRef.current = rememberedPosition;
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
      positionAtBottom({ measureFirst: true, revealEarly: true });
    }
  }, [renderedThreadId, loading, messages.length, virtualizer, positionAtBottom, items.length]);

  // Stabilize scroll position when directional pagination shifts the resident window.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const prevCount = prevMessageCountRef.current;
    const prevFirstId = firstMessageIdRef.current;
    const prevLastId = lastMessageIdRef.current;
    const nextFirstId = messages[0]?.id ?? null;
    const nextLastId = messages.at(-1)?.id ?? null;
    prevMessageCountRef.current = messages.length;
    firstMessageIdRef.current = nextFirstId;
    lastMessageIdRef.current = nextLastId;

    if (!el || prevCount === 0) {
      pendingPrependCountRef.current = 0;
      if (!isLoadingMore && !isLoadingNewer) {
        pendingHistoryAnchorRef.current = null;
      }
      prevScrollHeightRef.current = el?.scrollHeight ?? 0;
      return;
    }

    const windowChanged = messages.length !== prevCount
      || nextFirstId !== prevFirstId
      || nextLastId !== prevLastId;
    if (!windowChanged) {
      if (!isLoadingMore && !isLoadingNewer) pendingHistoryAnchorRef.current = null;
      prevScrollHeightRef.current = el.scrollHeight;
      return;
    }

    const newScrollHeight = el.scrollHeight;
    const rememberedPosition = renderedThreadId && messages.length < prevCount
      ? recallScrollPosition(renderedThreadId)
      : undefined;
    const anchorSnapshot = pendingHistoryAnchorRef.current ?? (
      rememberedPosition?.anchorMessageId && rememberedPosition.anchorTop != null
        ? {
            messageId: rememberedPosition.anchorMessageId,
            top: rememberedPosition.anchorTop,
          }
        : null
    );
    const findAnchor = () => anchorSnapshot
      ? [...el.querySelectorAll<HTMLElement>("[data-message-id]")]
          .find((node) => node.getAttribute("data-message-id") === anchorSnapshot.messageId)
      : undefined;
    const measureAnchorDrift = (): number | null => {
      const anchor = findAnchor();
      if (!anchor || !anchorSnapshot) return null;
      return anchor.getBoundingClientRect().top - anchorSnapshot.top;
    };

    if (anchorSnapshot) {
      const anchorIndex = pendingHistoryAnchorIndexRef.current;
      if (!findAnchor() && anchorIndex >= 0) {
        virtualizer.scrollToIndex(anchorIndex, { align: "start" });
      }
      const generation = ++historyAnchorSettleGenerationRef.current;
      let stableFrames = 0;
      let attempts = 0;
      const measureAnchor = () => {
        if (historyAnchorSettleGenerationRef.current !== generation) return;
        attempts += 1;
        const drift = measureAnchorDrift();
        stableFrames = drift !== null && Math.abs(drift) <= 0.5
          ? stableFrames + 1
          : 0;
        if (stableFrames >= 3) {
          pendingHistoryAnchorRef.current = null;
          return;
        }
        if (drift !== null && Math.abs(drift) > 0.5) {
          requestAnimationFrame(() => {
            if (historyAnchorSettleGenerationRef.current !== generation) return;
            el.scrollTop += drift;
            if (attempts >= 12) pendingHistoryAnchorRef.current = null;
            else requestAnimationFrame(measureAnchor);
          });
          return;
        }
        if (attempts >= 12) {
          pendingHistoryAnchorRef.current = null;
          return;
        }
        requestAnimationFrame(measureAnchor);
      };
      requestAnimationFrame(measureAnchor);
    } else if (messages.length > prevCount && prevFirstId !== nextFirstId) {
      const addedHeight = newScrollHeight - prevScrollHeightRef.current;
      if (addedHeight > 0) el.scrollTop += addedHeight;
      pendingHistoryAnchorRef.current = null;
    } else {
      pendingHistoryAnchorRef.current = null;
    }
    prevScrollHeightRef.current = newScrollHeight;
    pendingPrependCountRef.current = 0;
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
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const withinTail =
      target.scrollTop <= maxScroll && maxScroll - target.scrollTop <= AUTO_SCROLL_THRESHOLD;
    const hasHistoryAnchor =
      !target.atTail
      && !!target.anchorMessageId
      && target.anchorTop != null;
    const snapToTail = target.atTail || (!hasHistoryAnchor && (withinTail || target.scrollTop > maxScroll));
    pendingScrollRestoreRef.current = null;
    scrollToTailIntentRef.current = false;

    if (snapToTail) {
      pinListTailRef.current = true;
      el.scrollTop = el.scrollHeight;
      pinTailBaselineMaxScrollRef.current = Math.max(0, el.scrollHeight - el.clientHeight);
      isScrolledUpRef.current = false;
      setShowScrollBtn(false);
      streamingFollowPauseUntilRef.current = 0;
      setHasNewContent(false);
      requestAnimationFrame(() => {
        const el2 = containerRef.current;
        if (el2) {
          el2.scrollTop = el2.scrollHeight;
          pinTailBaselineMaxScrollRef.current = Math.max(0, el2.scrollHeight - el2.clientHeight);
        }
        scheduleEndSuppressPassiveAutoBottomScroll();
      });
      return;
    }

    pinListTailRef.current = false;
    el.scrollTop = target.scrollTop;
    isScrolledUpRef.current = true;
    setShowScrollBtn(true);
    if (!hasHistoryAnchor) {
      scheduleEndSuppressPassiveAutoBottomScroll();
      return;
    }
    const generation = ++scrollRestoreGenerationRef.current;
    let stableFrames = 0;
    let attempts = 0;
    const settleReadingAnchor = () => {
      if (scrollRestoreGenerationRef.current !== generation) return;
      attempts += 1;
      const anchor = hasHistoryAnchor
        ? [...el.querySelectorAll<HTMLElement>("[data-message-id]")]
            .find((node) => node.getAttribute("data-message-id") === target.anchorMessageId)
        : undefined;
      if (anchor && target.anchorTop != null) {
        const delta = anchor.getBoundingClientRect().top - target.anchorTop;
        if (Math.abs(delta) > 0.5) {
          el.scrollTop += delta;
          stableFrames = 0;
        } else {
          stableFrames += 1;
        }
      }
      if (stableFrames >= 3 || attempts >= 20) {
        scheduleEndSuppressPassiveAutoBottomScroll();
        return;
      }
      requestAnimationFrame(settleReadingAnchor);
    };
    requestAnimationFrame(settleReadingAnchor);
  }, [renderedThreadId, items.length, loading, transcriptThreadId, beginSuppressPassiveAutoBottomScroll, scheduleEndSuppressPassiveAutoBottomScroll]);

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

  const handleTranscriptPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const selection = window.getSelection();
    if (!selection) return;
    const source = createSelectedTextCommentSource(selection, event.target);
    if (!source) return;
    setSelectedTextContextMenu({ source, x: event.clientX, y: event.clientY });
  }, []);

  const handleCopySelectedText = useCallback(async () => {
    const quote = selectedTextContextMenu?.source.quote;
    if (!quote) return;
    try {
      await navigator.clipboard.writeText(quote);
      setSelectedTextCopyAnnouncement("Selected text copied.");
    } catch {
      setSelectedTextCopyAnnouncement("Could not copy selected text.");
    }
  }, [selectedTextContextMenu]);

  const openSelectedTextCommentEditor = useCallback(() => {
    const source = selectedTextContextMenu?.source;
    if (!source) return;
    setSelectedTextContextMenu(null);
    setCommentEditorSource(source);
    setCommentNote("");
  }, [selectedTextContextMenu]);

  const closeSelectedTextCommentEditor = useCallback(() => {
    setCommentEditorSource(null);
    setCommentNote("");
  }, []);

  const saveSelectedTextComment = useCallback(() => {
    if (!commentEditorSource || !onSelectedTextComment || !commentNote.trim()) return;
    onSelectedTextComment({
      id: crypto.randomUUID(),
      displayNumber: 1,
      source: commentEditorSource,
      note: commentNote,
      mentions: [],
    });
    setCommentEditorSource(null);
    setCommentNote("");
  }, [commentEditorSource, commentNote, onSelectedTextComment]);

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
    <div className="relative h-full" data-testid="message-list" onPointerUp={handleTranscriptPointerUp}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {selectedTextCopyAnnouncement}
      </div>
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
          {virtualizer.getVirtualItems().map((vi) => {
            const item = items[vi.index];
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                className="absolute left-0 w-full px-4 py-2 sm:px-8"
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <div className={cn(PRIMARY_CONTENT_RAIL_CLASS, "min-w-0 overflow-x-hidden")}>
                  {item.type === "leading-content" ? (
                    <div data-testid="message-list-leading-content">{item.content}</div>
                  ) : (
                    <VirtualItemRenderer item={item} turnExpandRef={turnExpandRef} onBranch={onBranch} onReply={onReply} onSubagentSelect={onSubagentSelect} onOpenSubagents={onOpenSubagents} onContinue={onContinue} onRetry={onRetry} onScrollToMessage={scrollToMessage} currentTurnMessageIdByThread={currentTurnMessageIdByThread} threadId={renderedThreadId} showParentAgentProvenance={showParentAgentProvenance} />
                  )}
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
        <div className="px-4 py-4 sm:px-8">
          <div className={cn(PRIMARY_CONTENT_RAIL_CLASS, "space-y-2")}>
            <Skeleton className="h-3.5 w-3/4 animate-pulse rounded" />
            <Skeleton className="h-3.5 w-1/2 animate-pulse rounded" />
            <Skeleton className="h-3.5 w-2/3 animate-pulse rounded" />
          </div>
        </div>
      )}

      {/* Loading spinner overlay for scroll-up pagination */}
      {isLoadingMore && (
        <div className="absolute top-2 left-1/2 z-10 -translate-x-1/2">
          <div className="rounded-md border border-border/40 bg-background/80 px-2 py-1 backdrop-blur-sm">
            <Spinner size={14} className="text-muted-foreground/70" />
          </div>
        </div>
      )}

      {isLoadingNewer && (
        <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2">
          <div className="rounded-md border border-border/40 bg-background/80 px-2 py-1 backdrop-blur-sm">
            <Spinner size={14} className="text-muted-foreground/70" />
          </div>
        </div>
      )}

      {selectedTextContextMenu && (
        <ContextMenu
          x={selectedTextContextMenu.x}
          y={selectedTextContextMenu.y}
          items={[
            { label: "Copy", onClick: () => { void handleCopySelectedText(); } },
            { label: "Add comment", onClick: openSelectedTextCommentEditor },
          ]}
          onClose={() => setSelectedTextContextMenu(null)}
        />
      )}

      <Popover
        open={commentEditorSource !== null}
        modal={false}
        onOpenChange={(open) => {
          if (!open) closeSelectedTextCommentEditor();
        }}
      >
        <PopoverTrigger
          nativeButton={false}
          render={<span aria-hidden className="pointer-events-none absolute bottom-4 left-4 size-px sm:left-8" />}
        />
        {commentEditorSource && (
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            role="dialog"
            aria-label="Comment on selected text"
            initialFocus={() => document.getElementById("selected-text-comment-note")}
            finalFocus={false}
            className="w-[min(26rem,calc(100vw-2rem))] p-3"
          >
            <p className="text-sm font-medium">Comment on selected text</p>
            <blockquote className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground">
              {commentEditorSource.quote}
            </blockquote>
            <Textarea
              id="selected-text-comment-note"
              className="mt-3 min-h-20"
              aria-label="Comment note"
              value={commentNote}
              maxLength={MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS}
              onChange={(event) => setCommentNote(event.target.value)}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={closeSelectedTextCommentEditor}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!commentNote.trim()}
                onClick={saveSelectedTextComment}
              >
                Add comment
              </Button>
            </div>
          </PopoverContent>
        )}
      </Popover>

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
