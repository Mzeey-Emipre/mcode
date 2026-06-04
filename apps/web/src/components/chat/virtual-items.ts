import type { PermissionDecision } from "@mcode/contracts";
import type { Message, ToolCall, HookExecution } from "@/transport/types";
import type { ThoughtSegment } from "./narrative/types";
import { computeLiveStreamingText } from "./narrative/build-narrative";

/** Compile-time exhaustive check; throws at runtime for unhandled discriminants. */
function assertNever(value: never): never {
  throw new Error(`Unhandled item type: ${(value as { type: string }).type}`);
}

/**
 * A plan-questions assistant message is a COMPLETED "ask the user" turn whose
 * bubble renders as the collapsed AnsweredSummary. Answering it creates no user
 * message, so it can be the trailing stable item while the NEXT turn generates
 * the plan. It is never the live turn's own response, so the in-flight narrative
 * must append AFTER it (preserving chronological order: questions answered → new
 * turn's actions → response) rather than being split in ABOVE it. Plan-output
 * bubbles are intentionally excluded — their own turn's narrative belongs above
 * the PlanCard answer.
 */
function isPlanQuestionsMessage(content: string): boolean {
  return content.includes("```plan-questions");
}

/** Estimated collapsed height (px) for a streaming card virtual item. */
export const STREAMING_CARD_COLLAPSED_HEIGHT = 56;

/** Represents an item rendered in the virtualized chat list: messages, tool indicators, or streaming text. */
export type ChatVirtualItem =
  | { key: string; type: "message"; message: Message }
  | { key: string; type: "active-tools"; toolCalls: readonly ToolCall[] }
  | {
      key: string;
      type: "indicator";
      startTime: number | undefined;
      activeToolCalls: readonly ToolCall[];
    }
  | { key: string; type: "streaming"; text: string }
  | {
      key: string;
      type: "turn-changes";
      messageId: string;
      filesChanged: string[];
      isLatestTurn: boolean;
    }
  | {
      key: string;
      type: "permission-request";
      requestId: string;
      toolName: string;
      input: unknown;
      title?: string;
      settled: boolean;
      decision?: PermissionDecision;
    }
  | {
      key: string;
      type: "hook-activity";
      hooks: readonly HookExecution[];
    }
  | {
      key: string;
      type: "narrative-flow";
      toolCalls: readonly ToolCall[];
      hooks: readonly HookExecution[];
      thoughtSegments: readonly ThoughtSegment[];
      streamingText: string;
      isAgentRunning: boolean;
      startTime: number | undefined;
      /** Last assistant bubble text when the turn finished; duplicate thoughts are hidden. */
      committedAssistantBody?: string;
    }
  | {
      key: string;
      type: "persisted-narrative";
      /** Assistant message id this persisted timeline belongs to. */
      messageId: string;
      /** Assistant message body — passed to the safety net that suppresses final-response thoughts. */
      messageContent: string;
    }
  | {
      key: string;
      type: "persisted-late-hooks";
      /**
       * Assistant message id whose late hooks (Stop / SessionEnd / PreCompact)
       * are rendered here -- i.e. between the assistant bubble and the
       * files-changed summary, giving the render order:
       *   narrative timeline → assistant text → stop hooks → files summary
       */
      messageId: string;
    }
  | {
      key: string;
      type: "persisted-turn-footer";
      /**
       * Assistant message id whose turn footer (step / sub-agent counts plus
       * duration) is rendered AFTER the message body, closing the turn.
       * Renders null until the persisted narrative records are loaded.
       */
      messageId: string;
    }
  | {
      key: string;
      type: "streaming-response";
      /**
       * Live, in-flight response text streaming character-by-character. Lives
       * in the virtual-item slot the persisted `MessageBubble` will occupy on
       * `session.message`, so the swap from streaming → persisted is a content
       * replacement rather than a position jump.
       */
      text: string;
    }
  | {
      key: string;
      type: "narrative-indicator";
      /**
       * "X steps · N subagents · phase…" status footer rendered BELOW the
       * live streaming-response so the writing-animation reads as the primary
       * surface and the progress meta sits underneath. Only emitted while the
       * agent is running.
       */
      stepCount: number;
      subagentCount: number;
      activeToolCalls: readonly ToolCall[];
      startTime: number | undefined;
    };

/**
 * Build the stable segment: messages with optional turn-change summaries.
 * This only changes when messages or persistedFilesChanged change (infrequent).
 */
export function buildStableItems(
  messages: readonly Message[],
  persistedFilesChanged?: Record<string, string[]>,
  latestTurnWithChanges?: string | null,
): ChatVirtualItem[] {
  const items: ChatVirtualItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // Persisted narrative timeline appears immediately BEFORE each
    // assistant message so the audit trail visually precedes the response
    // text - matching the live narrative-flow placement. The component
    // renders `null` until records are fetched, so emitting a placeholder
    // here doesn't cause layout jitter once records land.
    if (msg.role === "assistant") {
      items.push({
        key: `persisted-narrative-${msg.id}`,
        type: "persisted-narrative",
        messageId: msg.id,
        messageContent: msg.content,
      });
    }
    items.push({ key: msg.id, type: "message", message: msg });

    if (msg.role === "assistant") {
      // Late stop hooks (Stop / SessionEnd / PreCompact) render immediately
      // after the assistant bubble, before the files-changed summary.
      // The component renders null when no late hooks are present, so this
      // placeholder costs nothing for turns without stop hooks.
      items.push({
        key: `persisted-late-hooks-${msg.id}`,
        type: "persisted-late-hooks",
        messageId: msg.id,
      });

      // Turn footer (step / sub-agent counts + duration) renders AFTER the
      // assistant body — closing the turn rather than separating its actions
      // from its answer.
      items.push({
        key: `persisted-turn-footer-${msg.id}`,
        type: "persisted-turn-footer",
        messageId: msg.id,
      });

      // File change summary appears after the late hook rows
      const files = persistedFilesChanged?.[msg.id];
      if (files && files.length > 0) {
        items.push({
          key: `turn-changes-${msg.id}`,
          type: "turn-changes",
          messageId: msg.id,
          filesChanged: files,
          isLatestTurn: msg.id === latestTurnWithChanges,
        });
      }
    }
  }
  return items;
}

/**
 * Build the volatile segment: permission requests and a single narrative-flow item
 * that consolidates tool calls, hooks, thought segments, streaming text, and indicator.
 * This changes on every tool call event but doesn't depend on messages.
 */
export function buildVolatileItems(
  toolCalls: readonly ToolCall[],
  isAgentRunning: boolean,
  agentStartTime: number | undefined,
  streamingText: string | undefined,
  permissions?: readonly {
    requestId: string;
    toolName: string;
    input?: unknown;
    title?: string;
    settled: boolean;
    decision?: PermissionDecision;
  }[],
  hooks?: readonly HookExecution[],
  thoughtSegments?: readonly ThoughtSegment[],
): ChatVirtualItem[] {
  const items: ChatVirtualItem[] = [];

  // Emit the narrative flow item when agent is running or has tool calls.
  // This replaces the separate "active-tools", "hook-activity", "indicator",
  // and "streaming" items with a single unified item.
  if (isAgentRunning || toolCalls.length > 0) {
    items.push({
      key: "narrative-flow",
      type: "narrative-flow",
      toolCalls,
      hooks: hooks ?? [],
      thoughtSegments: thoughtSegments ?? [],
      streamingText: streamingText ?? "",
      isAgentRunning,
      startTime: agentStartTime,
    });
  }

  // Streaming response item — fills the slot where the persisted MessageBubble
  // will appear on `session.message`. Keeps the live typing text in the same
  // virtual-list position the persisted bubble lands in, so the swap is a
  // content replacement rather than a jump.
  const liveText = computeLiveStreamingText({
    thoughtSegments: thoughtSegments ?? [],
    streamingText: streamingText ?? "",
    isAgentRunning,
    toolCalls,
  });
  if (liveText.length > 0) {
    items.push({
      key: "streaming-response",
      type: "streaming-response",
      text: liveText,
    });
  }

  // Narrative indicator — "X steps · N subagents · phase… (0:22)" — rendered
  // as its own virtual-item slot BELOW the streaming-response so the writing
  // animation reads as the primary surface and the meta status sits underneath
  // it (rather than above, between the actions molecule and the response).
  // Only emitted while the agent is running.
  if (isAgentRunning) {
    const topLevelTools = toolCalls.filter((tc) => tc.parentToolCallId == null);
    // Match `buildNarrativeItems` / `NarrativeCounts.steps`: top-level tool
    // calls only. Thought segments are tracked separately in the footer.
    const stepCount = topLevelTools.length;
    const subagentCount = topLevelTools.filter((tc) => tc.toolName === "Agent").length;
    const activeToolCalls = toolCalls.filter(
      (tc) => !tc.isComplete && tc.parentToolCallId == null,
    );
    items.push({
      key: "narrative-indicator",
      type: "narrative-indicator",
      stepCount,
      subagentCount,
      activeToolCalls,
      startTime: agentStartTime,
    });
  }

  // Show all permission requests (settled and unsettled) so the user gets
  // visual confirmation of their allow/deny decision. Settled cards collapse
  // to a single-line badge. The full permissionsByThread entry is cleared
  // when the agent turn ends, so settled cards never trail below the agent's
  // persisted message.
  if (permissions && permissions.length > 0) {
    for (const p of permissions) {
      items.push({
        key: `permission-${p.requestId}`,
        type: "permission-request" as const,
        requestId: p.requestId,
        toolName: p.toolName,
        input: p.input,
        title: p.title,
        settled: p.settled,
        decision: p.decision,
      });
    }
  }

  return items;
}

/**
 * Combine stable and volatile segments into the final virtual item array.
 * When tool calls exist, the narrative-flow item is placed before the last
 * assistant message while permission-request items remain after it.
 */
export function buildVirtualItems(
  stableItems: readonly ChatVirtualItem[],
  volatileItems: readonly ChatVirtualItem[],
  hasToolCalls: boolean,
): ChatVirtualItem[] {
  if (!hasToolCalls || volatileItems.length === 0) {
    return [...stableItems, ...volatileItems];
  }

  // Split volatile items: narrative-flow goes before the last assistant
  // message; permission requests go after it.

  // Find the last assistant message, skipping any trailing items that appear
  // after the message bubble (turn-changes, persisted-late-hooks,
  // persisted-turn-footer).
  let lastAssistantIdx = stableItems.length - 1;
  while (lastAssistantIdx >= 0) {
    const item = stableItems[lastAssistantIdx];
    if (
      item.type === "turn-changes" ||
      item.type === "persisted-late-hooks" ||
      item.type === "persisted-turn-footer"
    ) {
      lastAssistantIdx--;
      continue;
    }
    break;
  }

  const lastItem = stableItems[lastAssistantIdx];
  if (
    lastItem?.type === "message" &&
    lastItem.message.role === "assistant" &&
    !isPlanQuestionsMessage(lastItem.message.content)
  ) {
    // narrative-flow, streaming-response, and narrative-indicator all go
    // BEFORE the last assistant message bubble so the user reads
    // top-to-bottom: actions → response → progress meta. streaming-response
    // sits under narrative-flow (mirroring where the MessageBubble lands on
    // persist), and the indicator sits under the streaming-response so the
    // writing animation reads as the primary surface.
    const headItems = volatileItems.filter(
      (v) =>
        v.type === "narrative-flow" ||
        v.type === "streaming-response" ||
        v.type === "narrative-indicator",
    );
    const tailItems = volatileItems.filter(
      (v) =>
        v.type !== "narrative-flow" &&
        v.type !== "streaming-response" &&
        v.type !== "narrative-indicator",
    );
    // Drop the persisted-narrative placeholder for the message that has live
    // narrative-flow above it, to avoid double-rendering the same timeline
    // while volatile records are still in-memory. The persisted-turn-footer
    // is NOT suppressed because it sits AFTER the assistant message bubble —
    // it owns the post-response summary that closes the turn, regardless of
    // whether the live narrative-flow is still mounted above the bubble.
    const lastAssistantMessageId = lastItem.message.id;
    const filteredStable = stableItems.filter(
      (it, idx) =>
        !(
          it.type === "persisted-narrative" &&
          it.messageId === lastAssistantMessageId &&
          // Only filter the one immediately preceding the message - older
          // persisted narratives for prior turns must still render.
          idx === lastAssistantIdx - 1
        ),
    );
    // Recompute index after the filter.
    const newLastAssistantIdx = filteredStable.findIndex(
      (it, idx) =>
        it.type === "message" &&
        it.message.id === lastAssistantMessageId &&
        idx >= 0,
    );
    if (newLastAssistantIdx === -1) {
      return [...stableItems, ...volatileItems];
    }
    return [
      ...filteredStable.slice(0, newLastAssistantIdx),
      ...headItems,
      ...filteredStable.slice(newLastAssistantIdx),
      ...tailItems,
    ];
  }

  return [...stableItems, ...volatileItems];
}

const LIST_ITEM_RE = /^[-*]\s|^\d+\.\s/;
const LINE_HEIGHT = 22;
const CHARS_PER_LINE = 65;
const TABLE_ROW_HEIGHT = 44;
const CODE_BLOCK_PADDING = 32;
const HEADING_EXTRA = 16;
const LIST_ITEM_HEIGHT = 28;

/**
 * Estimate rendered height from markdown content.
 * Accounts for tables, code blocks, headings, and lists that render
 * much taller than their raw character count suggests.
 */
function estimateMarkdownHeight(content: string): number {
  let height = 0;
  let inCodeBlock = false;
  let start = 0;

  while (start <= content.length) {
    let end = content.indexOf("\n", start);
    if (end === -1) end = content.length;
    const line = content.substring(start, end);
    const trimmed = line.trimStart();

    if (trimmed.startsWith("```")) {
      height += CODE_BLOCK_PADDING / 2;
      inCodeBlock = !inCodeBlock;
      start = end + 1;
      continue;
    }

    if (inCodeBlock) {
      height += LINE_HEIGHT;
      start = end + 1;
      continue;
    }

    // Table rows (| col | col |) and separator rows (|---|---|)
    if (trimmed.startsWith("|")) {
      height += trimmed.includes("---") ? 4 : TABLE_ROW_HEIGHT;
      start = end + 1;
      continue;
    }

    // Headings
    if (trimmed.startsWith("#")) {
      height += LINE_HEIGHT + HEADING_EXTRA;
      start = end + 1;
      continue;
    }

    // List items
    if (LIST_ITEM_RE.test(trimmed)) {
      const wrappedLines = Math.max(1, Math.ceil(trimmed.length / CHARS_PER_LINE));
      height += LIST_ITEM_HEIGHT + (wrappedLines - 1) * LINE_HEIGHT;
      start = end + 1;
      continue;
    }

    // Empty line = paragraph break
    if (trimmed.length === 0) {
      height += 12;
      start = end + 1;
      continue;
    }

    // Regular text, may wrap
    const wrappedLines = Math.max(1, Math.ceil(trimmed.length / CHARS_PER_LINE));
    height += wrappedLines * LINE_HEIGHT;
    start = end + 1;
  }

  return Math.max(LINE_HEIGHT, height);
}

/** Estimate pixel height for a virtual item before `measureElement` fires. */
export function estimateItemHeight(item: ChatVirtualItem): number {
  switch (item.type) {
    case "message": {
      const { message } = item;
      if (message.role === "system") return 40;
      const contentHeight = estimateMarkdownHeight(message.content);
      if (message.role === "user") return 52 + contentHeight;
      return 80 + contentHeight;
    }
    case "active-tools":
      return Math.min(item.toolCalls.length * 48, 400);
    case "indicator":
      return 48;
    case "streaming":
      return STREAMING_CARD_COLLAPSED_HEIGHT;
    case "turn-changes": {
      // Collapsed: ~44px. Expanded: 44px header + 32px per file row (capped at 50) + overflow link.
      const visibleFiles = Math.min(item.filesChanged.length, 50);
      const overflowRow = item.filesChanged.length > 50 ? 28 : 0;
      return item.isLatestTurn ? 44 + visibleFiles * 32 + overflowRow : 44;
    }
    case "permission-request":
      return item.settled ? 36 : 120;
    case "hook-activity":
      // Header (28px) + one row (28px) per hook, capped at 300px
      return Math.min(28 + item.hooks.length * 28, 300);
    case "narrative-flow": {
      const segCount = item.thoughtSegments.length;
      const toolCount = item.toolCalls.length;
      const hookCount = item.hooks.length;
      return Math.min(segCount * 60 + toolCount * 32 + hookCount * 28 + 48, 600);
    }
    case "persisted-narrative":
      // Conservative estimate: most turns produce a handful of rows. The
      // virtualizer re-measures once mounted, so this only affects scrollbar
      // initial sizing. Setting too small causes scroll-jump on settle;
      // setting too large wastes pre-allocated space.
      return 120;
    case "persisted-late-hooks":
      // Most turns have zero late hooks; the component renders null in that
      // case. The virtualizer will re-measure on mount, so a small default
      // keeps pre-allocated space tight for the common (no-late-hooks) path.
      return 0;
    case "persisted-turn-footer":
      // One-line summary plus margin; the component renders null when records
      // are still loading or when the turn had no structured activity.
      return 24;
    case "streaming-response":
      // Same shape as a small assistant MessageBubble — virtualizer re-measures
      // once mounted; this estimate keeps the slot from being too cramped on
      // first paint while text is still streaming in.
      return Math.max(estimateMarkdownHeight(item.text), 48);
    case "narrative-indicator":
      // One-line status bar (dot/layers icon + "X steps … 0:22"). 36px keeps
      // pre-allocation tight; the virtualizer re-measures once mounted.
      return 36;
    default:
      return assertNever(item);
  }
}
