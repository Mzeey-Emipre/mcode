import type { AgentTurnStatus, PermissionDecision, TurnOutcome, TurnRuntimePhase } from "@mcode/contracts";
import type { Message, ToolCall, HookExecution, ToolCallRecord, ThoughtSegmentRecord, HookExecutionRecord } from "@/transport/types";
import type { ThoughtSegment, TurnFooterSummary } from "../narrative/types";
import { computeLiveStreamingText } from "../narrative/build-narrative";
import { buildPersistedNarrativeItems } from "../narrative/build-persisted-narrative";
import { isGoalStatusNotice } from "@/lib/goal-message";

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
 * the saved Plan tab answer.
 */
function isPlanQuestionsMessage(content: string): boolean {
  return content.includes("```plan-questions");
}

const EMPTY_HOOKS: readonly HookExecution[] = [];
const EMPTY_THOUGHT_SEGMENTS: readonly ThoughtSegment[] = [];

/** Cached persisted narrative rows for an assistant message. */
export type PersistedNarrativeRecords = {
  tools: ToolCallRecord[];
  thoughts: ThoughtSegmentRecord[];
  hooks: HookExecutionRecord[];
} | undefined;

/** Persisted narrative cache keyed by assistant message id. */
export type PersistedNarrativeRecordsByMessage = Record<string, PersistedNarrativeRecords>;

/** State that lets the current turn's live and persisted assistant rows share one React key. */
export interface CurrentTurnResponseIdentity {
  threadId: string;
  messageId?: string;
  responseKey?: string;
  responseKeysByMessageId?: Record<string, string>;
}
/** UI state for one agent response, projected from its authoritative turn lifecycle. */
export type AgentDisplayState =
  | { phase: "streaming" }
  | { phase: "finalizing" }
  | { phase: "completed" }
  | { phase: "errored"; reason?: string }
  | { phase: "cancelled" }
  | { phase: "interrupted" };

/** Maps the runtime lifecycle for the current turn into transcript display state. */
export function agentDisplayStateFromRuntimePhase(
  phase: TurnRuntimePhase,
  reason?: string | null,
): AgentDisplayState | undefined {
  switch (phase) {
    case "idle":
      return undefined;
    case "running":
      return { phase: "streaming" };
    case "finalizing":
      return { phase: "finalizing" };
    case "completed":
      return { phase: "completed" };
    case "errored":
      return reason ? { phase: "errored", reason } : { phase: "errored" };
    case "cancelled":
      return { phase: "cancelled" };
    case "interrupted":
      return { phase: "interrupted" };
  }
}

/** Maps a canonical turn status into the shared transcript display state. */
export function agentDisplayStateFromCanonicalTurnStatus(
  status: AgentTurnStatus,
): AgentDisplayState {
  switch (status) {
    case "Pending":
    case "Running":
      return { phase: "streaming" };
    case "Completed":
      return { phase: "completed" };
    case "Cancelled":
      return { phase: "cancelled" };
    case "Interrupted":
      return { phase: "interrupted" };
    case "Errored":
      return { phase: "errored" };
  }
}

/** Returns the terminal display state for one persisted agent message. */
function agentDisplayStateFromOutcome(
  outcome: TurnOutcome | null | undefined,
): AgentDisplayState {
  switch (outcome) {
    case "errored":
      return { phase: "errored" };
    case "cancelled":
      return { phase: "cancelled" };
    case "interrupted":
      return { phase: "interrupted" };
    case "completed":
    case null:
    case undefined:
      return { phase: "completed" };
  }
}

/** Whether an agent display state still owns live narrative activity. */
export function isAgentDisplayActive(
  state: AgentDisplayState | undefined,
): boolean {
  return state?.phase === "streaming" || state?.phase === "finalizing";
}

/** Inputs for projecting one transcript into stable and volatile virtual rows. */
export interface TranscriptProjectionInput {
  /** Persisted conversation messages in chronological order. */
  messages: readonly Message[];
  /** Persisted file changes keyed by assistant message id. */
  persistedFilesChanged?: Record<string, string[]>;
  /** Assistant message that owns the latest file-change disclosure. */
  latestTurnWithChanges?: string | null;
  /** Identity that keeps live and persisted assistant rows in one React slot. */
  currentTurn?: CurrentTurnResponseIdentity;
  /** Authoritative lifecycle projected into the current agent response state. */
  agentDisplayState?: AgentDisplayState;
  /** Persisted narrative records keyed by assistant message id. */
  persistedNarrativeByMessage?: PersistedNarrativeRecordsByMessage;
  /** Canonical child turn summaries keyed by assistant message id. */
  turnSummariesByMessageId?: Record<string, TurnFooterSummary>;
  /** In-memory tool calls for the active turn. */
  toolCalls: readonly ToolCall[];
  /** Start time for active-turn timing displays. */
  agentStartTime: number | undefined;
  /** Latest streamed assistant text. */
  streamingText: string | undefined;
  /** Permission requests for the active turn. */
  permissions?: Parameters<typeof buildVolatileItems>[4];
  /** Hook events for the active turn. */
  hooks?: readonly HookExecution[];
  /** Reasoning segments for the active turn. */
  thoughtSegments?: readonly ThoughtSegment[];
  /** Persisted assistant text that remains visible while volatile rows settle. */
  committedAssistantBody?: string;
}

function messageOutcome(message: Message): TurnOutcome | null | undefined {
  return (message as Message & { outcome?: TurnOutcome | null }).outcome;
}

function messageOutcomeExecutionId(message: Message): string | null | undefined {
  return (message as Message & { outcomeExecutionId?: string | null }).outcomeExecutionId;
}

/** Returns the stable final-response key for a live turn. */
export function liveFinalResponseItemKey(
  threadId: string,
  responseKey?: string,
): string {
  return responseKey || `turn-response:${threadId}:pending`;
}

/** Returns the agent message item key, preserving the current turn's live key after persistence. */
export function agentMessageItemKey(
  message: Message,
  currentTurn?: CurrentTurnResponseIdentity,
): string {
  const mappedKey = currentTurn?.responseKeysByMessageId?.[message.id];
  if (message.role === "assistant" && mappedKey) {
    return liveFinalResponseItemKey(currentTurn.threadId, mappedKey);
  }
  if (
    message.role === "assistant" &&
    currentTurn?.messageId === message.id &&
    currentTurn.responseKey
  ) {
    return liveFinalResponseItemKey(currentTurn.threadId, currentTurn.responseKey);
  }
  return message.id;
}

/**
 * Creates a transcript projector with separate stable and volatile caches.
 * Callers provide one explicit transcript state instead of coordinating three builders.
 */
export function createTranscriptItemProjector(): (input: TranscriptProjectionInput) => ChatVirtualItem[] {
  const buildVolatile = createVolatileItemsBuilder();
  const buildVirtual = createVirtualItemsBuilder();
  let previousStableInput:
    | Pick<
      TranscriptProjectionInput,
      | "messages"
      | "persistedFilesChanged"
      | "latestTurnWithChanges"
      | "currentTurn"
      | "agentDisplayState"
      | "persistedNarrativeByMessage"
      | "turnSummariesByMessageId"
    >
    | undefined;
  let previousStableItems: ChatVirtualItem[] = [];

  return (input) => {
    const stableInput = {
      messages: input.messages,
      persistedFilesChanged: input.persistedFilesChanged,
      latestTurnWithChanges: input.latestTurnWithChanges,
      currentTurn: input.currentTurn,
      agentDisplayState: input.agentDisplayState,
      persistedNarrativeByMessage: input.persistedNarrativeByMessage,
      turnSummariesByMessageId: input.turnSummariesByMessageId,
    };
    const stableItems = previousStableInput
      && previousStableInput.messages === stableInput.messages
      && previousStableInput.persistedFilesChanged === stableInput.persistedFilesChanged
      && previousStableInput.latestTurnWithChanges === stableInput.latestTurnWithChanges
      && previousStableInput.currentTurn === stableInput.currentTurn
      && previousStableInput.agentDisplayState === stableInput.agentDisplayState
      && previousStableInput.persistedNarrativeByMessage === stableInput.persistedNarrativeByMessage
      && previousStableInput.turnSummariesByMessageId === stableInput.turnSummariesByMessageId
      ? previousStableItems
      : buildStableItems(
        stableInput.messages,
        stableInput.persistedFilesChanged,
        stableInput.latestTurnWithChanges,
        stableInput.currentTurn,
        stableInput.persistedNarrativeByMessage,
        stableInput.turnSummariesByMessageId,
        stableInput.agentDisplayState,
      );
    previousStableInput = stableInput;
    previousStableItems = stableItems;

    const volatileItems = buildVolatile(
      input.toolCalls,
      input.agentDisplayState,
      input.agentStartTime,
      input.streamingText,
      input.permissions,
      input.hooks,
      input.thoughtSegments,
      input.currentTurn,
      input.committedAssistantBody,
    );
    return buildVirtual(stableItems, volatileItems, input.toolCalls.length > 0);
  };
}

/** Represents an item rendered in the virtualized chat list: messages, tool indicators, or streaming text. */
export type ChatVirtualItem =
  | {
      key: string;
      type: "message";
      message: Message;
      agentDisplayState?: AgentDisplayState;
    }
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
       * Uses canonical summary data or persisted narrative records.
      */
      messageId: string;
      /** Canonical summary supplied directly when no legacy narrative cache exists. */
      summary?: TurnFooterSummary;
    }
  | {
      key: string;
      type: "narrative-indicator";
      /**
       * "X steps · N subagents · phase…" status footer rendered BELOW the
       * live assistant response so the writing animation reads as the primary
       * surface and the progress meta sits underneath. Emitted while the agent
       * is running and kept through the turn's volatile tail (tool calls still
       * in memory) so the component can animate out instead of vanishing in a
       * single frame; it renders nothing once its exit completes.
       */
      stepCount: number;
      subagentCount: number;
      activeToolCalls: readonly ToolCall[];
      startTime: number | undefined;
      /** False once the turn ended — tells the component to play its exit. */
      isAgentRunning: boolean;
    };

/**
 * Build the stable segment: messages with optional turn-change summaries.
 * This only changes when messages or persistedFilesChanged change (infrequent).
 */
export function buildStableItems(
  messages: readonly Message[],
  persistedFilesChanged?: Record<string, string[]>,
  latestTurnWithChanges?: string | null,
  currentTurn?: CurrentTurnResponseIdentity,
  persistedNarrativeByMessage?: PersistedNarrativeRecordsByMessage,
  turnSummariesByMessageId?: Record<string, TurnFooterSummary>,
  currentAgentDisplayState?: AgentDisplayState,
): ChatVirtualItem[] {
  const items: ChatVirtualItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const persistedRecords =
      msg.role === "assistant" ? persistedNarrativeByMessage?.[msg.id] : undefined;
    const persistedRows =
      persistedRecords && msg.role === "assistant"
        ? buildPersistedNarrativeItems({ ...persistedRecords, messageContent: msg.content })
        : undefined;
    const hasPersistedNarrativeRows =
      persistedRows != null && persistedRows.length > 0;
    const hasLateHookRows =
      persistedRecords?.hooks.some((h) => h.phase === "stop") === true;
    const hasPersistedFooter =
      persistedRecords?.tools.some((t) => t.parent_tool_call_id == null) === true;
    const canonicalSummary = turnSummariesByMessageId?.[msg.id];
    const explicitOutcome = messageOutcome(msg);
    const outcome = explicitOutcome ?? canonicalSummary?.outcome;
    const outcomeExecutionId = messageOutcomeExecutionId(msg) ?? canonicalSummary?.outcomeExecutionId;

    // Persisted narrative timeline appears immediately BEFORE each assistant
    // message so the audit trail visually precedes the response text. Only
    // visible persisted chrome is emitted; lazy loading is handled by
    // MessageList so null renderers do not reserve virtualized rail height.
    if (msg.role === "assistant") {
      if (hasPersistedNarrativeRows) {
        items.push({
          key: `persisted-narrative-${msg.id}`,
          type: "persisted-narrative",
          messageId: msg.id,
          messageContent: msg.content,
        });
      }
    }
    const isCurrentAgentMessage =
      msg.role === "assistant" &&
      currentTurn?.messageId === msg.id;
    const agentDisplayState = msg.role === "assistant"
      ? isCurrentAgentMessage && currentAgentDisplayState
        ? currentAgentDisplayState
        : agentDisplayStateFromOutcome(outcome)
      : undefined;
    items.push({
      key: agentMessageItemKey(msg, currentTurn),
      type: "message",
      message: msg,
      ...(agentDisplayState
        ? { agentDisplayState }
        : {}),
    });

    if (msg.role === "assistant") {
      // Late stop hooks (Stop / SessionEnd / PreCompact) render immediately
      // after the assistant bubble, before the files-changed summary.
      // The component renders null when no late hooks are present, so this
      // placeholder costs nothing for turns without stop hooks.
      if (hasLateHookRows) {
        items.push({
          key: `persisted-late-hooks-${msg.id}`,
          type: "persisted-late-hooks",
          messageId: msg.id,
        });
      }

      // Turn footer (step / sub-agent counts + duration) renders AFTER the
      // assistant body — closing the turn rather than separating its actions
      // from its answer.
      const turnSummary = canonicalSummary
        ? {
            ...canonicalSummary,
            ...(outcome !== undefined ? { outcome } : {}),
            ...(outcomeExecutionId !== undefined ? { outcomeExecutionId } : {}),
          }
        : outcome != null && outcome !== "completed"
          ? {
              counts: { steps: 0, thoughts: 0, subagents: 0 },
              durationMs: null,
              outcome,
              ...(outcomeExecutionId !== undefined ? { outcomeExecutionId } : {}),
            }
          : undefined;
      if (hasPersistedFooter || turnSummary) {
        items.push({
          key: `persisted-turn-footer-${msg.id}`,
          type: "persisted-turn-footer",
          messageId: msg.id,
          ...(turnSummary ? { summary: turnSummary } : {}),
        });
      }

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
  agentDisplayState: AgentDisplayState | undefined,
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
  currentTurn?: CurrentTurnResponseIdentity,
  committedAssistantBody?: string,
): ChatVirtualItem[] {
  const items: ChatVirtualItem[] = [];
  const isAgentRunning = isAgentDisplayActive(agentDisplayState);
  const resolvedHooks = hooks ?? EMPTY_HOOKS;
  const resolvedThoughtSegments = thoughtSegments ?? EMPTY_THOUGHT_SEGMENTS;
  const resolvedStreamingText = streamingText ?? "";
  const liveText = computeLiveStreamingText({
    thoughtSegments: resolvedThoughtSegments,
    streamingText: resolvedStreamingText,
    isAgentRunning,
    toolCalls,
  });

  // Emit the narrative flow item when agent is running or has tool calls.
  // This replaces the separate "active-tools", "hook-activity", "indicator",
  // and "streaming" items with a single unified item.
  if (isAgentRunning || toolCalls.length > 0) {
    items.push({
      key: "narrative-flow",
      type: "narrative-flow",
      toolCalls,
      hooks: resolvedHooks,
      thoughtSegments: resolvedThoughtSegments,
      streamingText: liveText.length > 0 ? "" : resolvedStreamingText,
      isAgentRunning,
      startTime: agentStartTime,
      committedAssistantBody,
    });
  }

  // Provisional assistant message — fills the slot where the persisted
  // MessageBubble will remain on `session.message`. Keeping the item type and
  // key stable lets React update the same subtree instead of remounting it.
  if (liveText.length > 0) {
    const threadId = currentTurn?.threadId ?? "__active_thread__";
    const responseKey = liveFinalResponseItemKey(threadId, currentTurn?.responseKey);
    items.push({
      key: responseKey,
      type: "message",
      message: {
        id: responseKey,
        thread_id: threadId,
        role: "assistant",
        content: liveText,
        tool_calls: null,
        files_changed: null,
        cost_usd: null,
        tokens_used: null,
        timestamp: new Date(0).toISOString(),
        sequence: Number.MAX_SAFE_INTEGER,
        attachments: null,
      },
      agentDisplayState: agentDisplayState?.phase === "finalizing"
        ? { phase: "finalizing" }
        : { phase: "streaming" },
    });
  }

  // Narrative indicator — "X steps · N subagents · phase… (0:22)" — rendered
  // as its own virtual-item slot BELOW the live assistant response so the writing
  // animation reads as the primary surface and the meta status sits underneath
  // it (rather than above, between the actions molecule and the response).
  // Kept emitted after the turn ends (while the turn's tool calls are still in
  // volatile memory) so NarrativeIndicator can animate out; it renders null
  // once the exit transition completes.
  if (isAgentRunning || toolCalls.length > 0) {
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
      isAgentRunning,
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

function sameArrayItems<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameAgentDisplayState(
  left: Extract<ChatVirtualItem, { type: "message" }>["agentDisplayState"],
  right: Extract<ChatVirtualItem, { type: "message" }>["agentDisplayState"],
): boolean {
  if (left === right) return true;
  if (left?.phase !== right?.phase) return false;
  const leftReason = left?.phase === "errored" ? left.reason : undefined;
  const rightReason = right?.phase === "errored" ? right.reason : undefined;
  return leftReason === rightReason;
}

function sameMessage(left: Message, right: Message): boolean {
  return (
    left.id === right.id &&
    left.thread_id === right.thread_id &&
    left.role === right.role &&
    left.content === right.content &&
    left.tool_calls === right.tool_calls &&
    left.files_changed === right.files_changed &&
    left.cost_usd === right.cost_usd &&
    left.tokens_used === right.tokens_used &&
    left.timestamp === right.timestamp &&
    left.sequence === right.sequence &&
    left.attachments === right.attachments &&
    left.tool_call_count === right.tool_call_count &&
    left.reply_to_message_id === right.reply_to_message_id &&
    left.quoted_text === right.quoted_text &&
    left.model === right.model &&
    left.is_internal === right.is_internal
  );
}

function sameVirtualItem(
  left: ChatVirtualItem | undefined,
  right: ChatVirtualItem,
): boolean {
  if (!left || left.key !== right.key || left.type !== right.type) return false;
  switch (right.type) {
    case "message":
      return (
        left.type === "message" &&
        sameMessage(left.message, right.message) &&
        sameAgentDisplayState(left.agentDisplayState, right.agentDisplayState)
      );
    case "active-tools":
      return left.type === "active-tools" && left.toolCalls === right.toolCalls;
    case "indicator":
      return (
        left.type === "indicator" &&
        left.startTime === right.startTime &&
        sameArrayItems(left.activeToolCalls, right.activeToolCalls)
      );
    case "streaming":
      return left.type === "streaming" && left.text === right.text;
    case "turn-changes":
      return (
        left.type === "turn-changes" &&
        left.messageId === right.messageId &&
        left.filesChanged === right.filesChanged &&
        left.isLatestTurn === right.isLatestTurn
      );
    case "permission-request":
      return (
        left.type === "permission-request" &&
        left.requestId === right.requestId &&
        left.toolName === right.toolName &&
        left.input === right.input &&
        left.title === right.title &&
        left.settled === right.settled &&
        left.decision === right.decision
      );
    case "hook-activity":
      return left.type === "hook-activity" && left.hooks === right.hooks;
    case "narrative-flow":
      return (
        left.type === "narrative-flow" &&
        left.toolCalls === right.toolCalls &&
        left.hooks === right.hooks &&
        left.thoughtSegments === right.thoughtSegments &&
        left.streamingText === right.streamingText &&
        left.isAgentRunning === right.isAgentRunning &&
        left.startTime === right.startTime &&
        left.committedAssistantBody === right.committedAssistantBody
      );
    case "persisted-narrative":
      return (
        left.type === "persisted-narrative" &&
        left.messageId === right.messageId &&
        left.messageContent === right.messageContent
      );
    case "persisted-late-hooks":
      return left.type === "persisted-late-hooks" && left.messageId === right.messageId;
    case "persisted-turn-footer":
      return (
        left.type === "persisted-turn-footer" &&
        left.messageId === right.messageId &&
        left.summary?.counts.steps === right.summary?.counts.steps &&
        left.summary?.counts.thoughts === right.summary?.counts.thoughts &&
        left.summary?.counts.subagents === right.summary?.counts.subagents &&
        left.summary?.durationMs === right.summary?.durationMs &&
        left.summary?.outcome === right.summary?.outcome &&
        left.summary?.outcomeExecutionId === right.summary?.outcomeExecutionId
      );
    case "narrative-indicator":
      return (
        left.type === "narrative-indicator" &&
        left.stepCount === right.stepCount &&
        left.subagentCount === right.subagentCount &&
        sameArrayItems(left.activeToolCalls, right.activeToolCalls) &&
        left.startTime === right.startTime &&
        left.isAgentRunning === right.isAgentRunning
      );
    default:
      return assertNever(right);
  }
}

function reuseVirtualItems(
  previous: readonly ChatVirtualItem[],
  next: ChatVirtualItem[],
): ChatVirtualItem[] {
  if (previous.length === 0) return next;
  const previousByKey = new Map(previous.map((item) => [item.key, item]));
  let changed = previous.length !== next.length;
  const reused = next.map((item, index) => {
    const prior = previousByKey.get(item.key);
    if (sameVirtualItem(prior, item)) {
      if (previous[index]?.key !== item.key) {
        changed = true;
      }
      return prior!;
    }
    changed = true;
    return item;
  });
  if (!changed) return previous as ChatVirtualItem[];
  return reused;
}

/** Creates a volatile item builder that preserves slot object identity across unchanged inputs. */
export function createVolatileItemsBuilder(): typeof buildVolatileItems {
  let previous: readonly ChatVirtualItem[] = [];
  return (...args) => {
    const next = buildVolatileItems(...args);
    previous = reuseVirtualItems(previous, next);
    return previous as ChatVirtualItem[];
  };
}

/** Creates a virtual item splicer that returns the same array when the splice inputs are unchanged. */
export function createVirtualItemsBuilder(): typeof buildVirtualItems {
  let previousStable: readonly ChatVirtualItem[] | undefined;
  let previousVolatile: readonly ChatVirtualItem[] | undefined;
  let previousHasToolCalls: boolean | undefined;
  let previousResult: readonly ChatVirtualItem[] = [];
  return (stableItems, volatileItems, hasToolCalls) => {
    if (
      previousStable === stableItems &&
      previousVolatile === volatileItems &&
      previousHasToolCalls === hasToolCalls
    ) {
      return previousResult as ChatVirtualItem[];
    }
    previousStable = stableItems;
    previousVolatile = volatileItems;
    previousHasToolCalls = hasToolCalls;
    previousResult = reuseVirtualItems(
      previousResult,
      buildVirtualItems(stableItems, volatileItems, hasToolCalls),
    );
    return previousResult as ChatVirtualItem[];
  };
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
  if (volatileItems.length === 0) {
    return [...stableItems];
  }

  // During session.message handoff, the live provisional bubble and persisted
  // assistant bubble intentionally share a key. Only one can be in React's
  // sibling list at a time.
  const stableKeys = new Set(stableItems.map((item) => item.key));
  const dedupedVolatileItems = volatileItems.filter(
    (item) =>
      !(
        item.type === "message" &&
        isAgentDisplayActive(item.agentDisplayState) &&
        stableKeys.has(item.key)
      ),
  );

  if (!hasToolCalls || dedupedVolatileItems.length === 0) {
    return [...stableItems, ...dedupedVolatileItems];
  }

  // Split volatile items: narrative-flow goes before the last assistant
  // message; permission requests go after it.

  // Find the last assistant answer, skipping trailing chrome and goal notices.
  let lastAssistantIdx = stableItems.length - 1;
  while (lastAssistantIdx >= 0) {
    const item = stableItems[lastAssistantIdx];
    if (
      item.type === "turn-changes" ||
      item.type === "persisted-late-hooks" ||
      item.type === "persisted-turn-footer" ||
      item.type === "persisted-narrative"
    ) {
      lastAssistantIdx--;
      continue;
    }
    if (
      item.type === "message" &&
      item.message.role === "assistant" &&
      isGoalStatusNotice(item.message.content)
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
    // narrative-flow and the live assistant message go BEFORE the last
    // assistant message bubble so the user reads top-to-bottom: actions →
    // response. The live assistant sits under narrative-flow (mirroring where
    // the MessageBubble lands on persist). The narrative-indicator goes
    // immediately AFTER the bubble so the progress meta stays underneath the
    // response — including through the persist swap, where it now lingers to
    // play its exit transition instead of jumping above the bubble.
    const headItems = dedupedVolatileItems.filter(
      (v) =>
        v.type === "narrative-flow" ||
        (v.type === "message" && v.message.role === "assistant" && isAgentDisplayActive(v.agentDisplayState)),
    );
    const indicatorItems = dedupedVolatileItems.filter(
      (v) => v.type === "narrative-indicator",
    );
    const tailItems = dedupedVolatileItems.filter(
      (v) =>
        v.type !== "narrative-flow" &&
        !(v.type === "message" && v.message.role === "assistant" && isAgentDisplayActive(v.agentDisplayState)) &&
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
      return [...stableItems, ...dedupedVolatileItems];
    }
    return [
      ...filteredStable.slice(0, newLastAssistantIdx),
      ...headItems,
      filteredStable[newLastAssistantIdx],
      ...indicatorItems,
      ...filteredStable.slice(newLastAssistantIdx + 1),
      ...tailItems,
    ];
  }

  return [...stableItems, ...dedupedVolatileItems];
}
