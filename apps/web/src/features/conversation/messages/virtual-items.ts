import type { AgentTurnStatus, PermissionDecision, TurnOutcome, TurnRuntimePhase } from "@mcode/contracts";
import type { Message, ToolCall, HookExecution, ToolCallRecord, ThoughtSegmentRecord, HookExecutionRecord } from "@/transport/types";
import type { ThoughtSegment, TurnFooterSummary } from "../narrative/types";
import { computeLiveStreamingText } from "../narrative/build-narrative";
import { buildPersistedNarrativeItems } from "../narrative/build-persisted-narrative";
import { isGoalStatusNotice } from "@/lib/goal-message";

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
  return messages.flatMap((message) => stableItemsForMessage(message, {
    persistedFilesChanged, latestTurnWithChanges, currentTurn, persistedNarrativeByMessage, turnSummariesByMessageId, currentAgentDisplayState,
  }));
}

interface StableItemInput {
  persistedFilesChanged?: Record<string, string[]>;
  latestTurnWithChanges?: string | null;
  currentTurn?: CurrentTurnResponseIdentity;
  persistedNarrativeByMessage?: PersistedNarrativeRecordsByMessage;
  turnSummariesByMessageId?: Record<string, TurnFooterSummary>;
  currentAgentDisplayState?: AgentDisplayState;
};

function persistedNarrativeItems(message: Message, input: StableItemInput): ChatVirtualItem[] {
  const records = message.role === "assistant" ? input.persistedNarrativeByMessage?.[message.id] : undefined;
  const rows = records ? buildPersistedNarrativeItems({ ...records, messageContent: message.content }) : undefined;
  return rows && rows.length > 0 ? [{ key: `persisted-narrative-${message.id}`, type: "persisted-narrative", messageId: message.id, messageContent: message.content }] : [];
}

function messageVirtualItem(message: Message, input: StableItemInput): ChatVirtualItem {
  const summary = input.turnSummariesByMessageId?.[message.id];
  const outcome = messageOutcome(message) ?? summary?.outcome;
  const display = message.role === "assistant"
    ? input.currentTurn?.messageId === message.id && input.currentAgentDisplayState
      ? input.currentAgentDisplayState
      : agentDisplayStateFromOutcome(outcome)
    : undefined;
  return { key: agentMessageItemKey(message, input.currentTurn), type: "message", message, ...(display ? { agentDisplayState: display } : {}) };
}

function footerSummary(message: Message, input: StableItemInput): TurnFooterSummary | undefined {
  const summary = input.turnSummariesByMessageId?.[message.id];
  const outcome = messageOutcome(message) ?? summary?.outcome;
  const outcomeExecutionId = messageOutcomeExecutionId(message) ?? summary?.outcomeExecutionId;
  return summary
    ? summaryWithOutcome(summary, outcome, outcomeExecutionId)
    : exceptionalOutcomeSummary(outcome, outcomeExecutionId);
}

function summaryWithOutcome(summary: TurnFooterSummary, outcome: ReturnType<typeof messageOutcome>, outcomeExecutionId: string | null | undefined): TurnFooterSummary {
  return { ...summary, ...(outcome === undefined ? {} : { outcome }), ...(outcomeExecutionId === undefined ? {} : { outcomeExecutionId }) };
}

function exceptionalOutcomeSummary(outcome: ReturnType<typeof messageOutcome>, outcomeExecutionId: string | null | undefined): TurnFooterSummary | undefined {
  return outcome != null && outcome !== "completed"
    ? { counts: { steps: 0, thoughts: 0, subagents: 0 }, durationMs: null, outcome, ...(outcomeExecutionId === undefined ? {} : { outcomeExecutionId }) }
    : undefined;
}

function lateHookItem(message: Message, records: PersistedNarrativeRecordsByMessage[string] | undefined): ChatVirtualItem | undefined {
  return records?.hooks.some((hook) => hook.phase === "stop")
    ? { key: `persisted-late-hooks-${message.id}`, type: "persisted-late-hooks", messageId: message.id }
    : undefined;
}

function turnFooterItem(message: Message, records: PersistedNarrativeRecordsByMessage[string] | undefined, summary: TurnFooterSummary | undefined): ChatVirtualItem | undefined {
  return records?.tools.some((tool) => tool.parent_tool_call_id == null) || summary
    ? { key: `persisted-turn-footer-${message.id}`, type: "persisted-turn-footer", messageId: message.id, ...(summary ? { summary } : {}) }
    : undefined;
}

function turnChangesItem(message: Message, input: StableItemInput): ChatVirtualItem | undefined {
  const files = input.persistedFilesChanged?.[message.id];
  return files && files.length > 0
    ? { key: `turn-changes-${message.id}`, type: "turn-changes", messageId: message.id, filesChanged: files, isLatestTurn: message.id === input.latestTurnWithChanges }
    : undefined;
}

function assistantTailItems(message: Message, input: StableItemInput): ChatVirtualItem[] {
  if (message.role !== "assistant") return [];
  const records = input.persistedNarrativeByMessage?.[message.id];
  const summary = footerSummary(message, input);
  const items: Array<ChatVirtualItem | undefined> = [
    lateHookItem(message, records),
    turnFooterItem(message, records, summary),
    turnChangesItem(message, input),
  ];
  return items.filter((item): item is ChatVirtualItem => item !== undefined);
}

function stableItemsForMessage(message: Message, input: StableItemInput): ChatVirtualItem[] {
  return [...persistedNarrativeItems(message, input), messageVirtualItem(message, input), ...assistantTailItems(message, input)];
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

  return [
    narrativeFlowItem(toolCalls, resolvedHooks, resolvedThoughtSegments, resolvedStreamingText, liveText, isAgentRunning, agentStartTime, committedAssistantBody),
    liveResponseItem(liveText, currentTurn, agentDisplayState),
    narrativeIndicatorItem(toolCalls, isAgentRunning, agentStartTime),
    ...permissionRequestItems(permissions),
  ].filter((item): item is ChatVirtualItem => item !== undefined);
}

function narrativeFlowItem(toolCalls: readonly ToolCall[], hooks: readonly HookExecution[], thoughts: readonly ThoughtSegment[], streamingText: string, liveText: string, isAgentRunning: boolean, startTime: number | undefined, committedAssistantBody: string | undefined): ChatVirtualItem | undefined {
  return isAgentRunning || toolCalls.length > 0 ? { key: "narrative-flow", type: "narrative-flow", toolCalls, hooks, thoughtSegments: thoughts, streamingText: liveText.length > 0 ? "" : streamingText, isAgentRunning, startTime, committedAssistantBody } : undefined;
}

function liveResponseItem(liveText: string, currentTurn: CurrentTurnResponseIdentity | undefined, agentDisplayState: AgentDisplayState | undefined): ChatVirtualItem | undefined {
  if (liveText.length === 0) return undefined;
  const threadId = currentTurn?.threadId ?? "__active_thread__";
  const responseKey = liveFinalResponseItemKey(threadId, currentTurn?.responseKey);
  return { key: responseKey, type: "message", message: { id: responseKey, thread_id: threadId, role: "assistant", content: liveText, tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: new Date(0).toISOString(), sequence: Number.MAX_SAFE_INTEGER, attachments: null }, agentDisplayState: agentDisplayState?.phase === "finalizing" ? { phase: "finalizing" } : { phase: "streaming" } };
}

function narrativeIndicatorItem(toolCalls: readonly ToolCall[], isAgentRunning: boolean, startTime: number | undefined): ChatVirtualItem | undefined {
  if (!isAgentRunning && toolCalls.length === 0) return undefined;
  const topLevelTools = toolCalls.filter((toolCall) => toolCall.parentToolCallId == null);
  return { key: "narrative-indicator", type: "narrative-indicator", stepCount: topLevelTools.length, subagentCount: topLevelTools.filter((toolCall) => toolCall.toolName === "Agent").length, activeToolCalls: toolCalls.filter((toolCall) => !toolCall.isComplete && toolCall.parentToolCallId == null), startTime, isAgentRunning };
}

function permissionRequestItems(permissions: Parameters<typeof buildVolatileItems>[4]): ChatVirtualItem[] {
  return permissions?.map((permission) => ({ key: `permission-${permission.requestId}`, type: "permission-request" as const, requestId: permission.requestId, toolName: permission.toolName, input: permission.input, title: permission.title, settled: permission.settled, decision: permission.decision })) ?? [];
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
  return [
    left.id === right.id,
    left.thread_id === right.thread_id,
    left.role === right.role,
    left.content === right.content,
    left.tool_calls === right.tool_calls,
    left.files_changed === right.files_changed,
    left.cost_usd === right.cost_usd,
    left.tokens_used === right.tokens_used,
    left.timestamp === right.timestamp,
    left.sequence === right.sequence,
    left.attachments === right.attachments,
    left.tool_call_count === right.tool_call_count,
    left.reply_to_message_id === right.reply_to_message_id,
    left.quoted_text === right.quoted_text,
    left.model === right.model,
    left.is_internal === right.is_internal,
  ].every(Boolean);
}

function sameMessageVirtualItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "message" && right.type === "message" && sameMessage(left.message, right.message) && sameAgentDisplayState(left.agentDisplayState, right.agentDisplayState);
}

function sameActiveToolsItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "active-tools" && right.type === "active-tools" && left.toolCalls === right.toolCalls;
}

function sameIndicatorItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "indicator" && right.type === "indicator" && left.startTime === right.startTime && sameArrayItems(left.activeToolCalls, right.activeToolCalls);
}

function sameStreamingItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "streaming" && right.type === "streaming" && left.text === right.text;
}

function sameTurnChangesItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "turn-changes" && right.type === "turn-changes" && [left.messageId === right.messageId, left.filesChanged === right.filesChanged, left.isLatestTurn === right.isLatestTurn].every(Boolean);
}

function samePermissionRequestItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "permission-request" && right.type === "permission-request" && [left.requestId === right.requestId, left.toolName === right.toolName, left.input === right.input, left.title === right.title, left.settled === right.settled, left.decision === right.decision].every(Boolean);
}

function sameHookActivityItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "hook-activity" && right.type === "hook-activity" && left.hooks === right.hooks;
}

function sameNarrativeFlowItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "narrative-flow" && right.type === "narrative-flow" && [left.toolCalls === right.toolCalls, left.hooks === right.hooks, left.thoughtSegments === right.thoughtSegments, left.streamingText === right.streamingText, left.isAgentRunning === right.isAgentRunning, left.startTime === right.startTime, left.committedAssistantBody === right.committedAssistantBody].every(Boolean);
}

function samePersistedNarrativeItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "persisted-narrative" && right.type === "persisted-narrative" && left.messageId === right.messageId && left.messageContent === right.messageContent;
}

function samePersistedLateHooksItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "persisted-late-hooks" && right.type === "persisted-late-hooks" && left.messageId === right.messageId;
}

function samePersistedTurnFooterItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "persisted-turn-footer" && right.type === "persisted-turn-footer" && left.messageId === right.messageId && sameTurnFooterSummary(left.summary, right.summary);
}

function sameTurnFooterSummary(left: TurnFooterSummary | undefined, right: TurnFooterSummary | undefined): boolean {
  return sameTurnFooterCounts(left, right) && sameTurnFooterResult(left, right);
}

function sameTurnFooterCounts(left: TurnFooterSummary | undefined, right: TurnFooterSummary | undefined): boolean {
  return [left?.counts.steps === right?.counts.steps, left?.counts.thoughts === right?.counts.thoughts, left?.counts.subagents === right?.counts.subagents].every(Boolean);
}

function sameTurnFooterResult(left: TurnFooterSummary | undefined, right: TurnFooterSummary | undefined): boolean {
  return [left?.durationMs === right?.durationMs, left?.outcome === right?.outcome, left?.outcomeExecutionId === right?.outcomeExecutionId].every(Boolean);
}

function sameNarrativeIndicatorItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "narrative-indicator" && right.type === "narrative-indicator" && [left.stepCount === right.stepCount, left.subagentCount === right.subagentCount, sameArrayItems(left.activeToolCalls, right.activeToolCalls), left.startTime === right.startTime, left.isAgentRunning === right.isAgentRunning].every(Boolean);
}

const VIRTUAL_ITEM_EQUALITY: Record<ChatVirtualItem["type"], (left: ChatVirtualItem, right: ChatVirtualItem) => boolean> = {
  message: sameMessageVirtualItem,
  "active-tools": sameActiveToolsItem,
  indicator: sameIndicatorItem,
  streaming: sameStreamingItem,
  "turn-changes": sameTurnChangesItem,
  "permission-request": samePermissionRequestItem,
  "hook-activity": sameHookActivityItem,
  "narrative-flow": sameNarrativeFlowItem,
  "persisted-narrative": samePersistedNarrativeItem,
  "persisted-late-hooks": samePersistedLateHooksItem,
  "persisted-turn-footer": samePersistedTurnFooterItem,
  "narrative-indicator": sameNarrativeIndicatorItem,
};

function sameVirtualItem(left: ChatVirtualItem | undefined, right: ChatVirtualItem): boolean {
  return left !== undefined && left.key === right.key && left.type === right.type && VIRTUAL_ITEM_EQUALITY[right.type](left, right);
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
  const deduped = dedupeVolatileItems(stableItems, volatileItems);
  if (volatileItems.length === 0 || !hasToolCalls || deduped.length === 0) return [...stableItems, ...deduped];
  const assistantIndex = lastAssistantItemIndex(stableItems);
  return spliceNarrativeItems(stableItems, deduped, assistantIndex) ?? [...stableItems, ...deduped];
}

function dedupeVolatileItems(stableItems: readonly ChatVirtualItem[], volatileItems: readonly ChatVirtualItem[]): ChatVirtualItem[] {
  const stableKeys = new Set(stableItems.map((item) => item.key));
  return volatileItems.filter((item) => item.type !== "message" || !isAgentDisplayActive(item.agentDisplayState) || !stableKeys.has(item.key));
}

function trailingStableChrome(item: ChatVirtualItem): boolean {
  return item.type === "turn-changes" || item.type === "persisted-late-hooks" || item.type === "persisted-turn-footer" || item.type === "persisted-narrative";
}

function isSkippableStableItem(item: ChatVirtualItem): boolean {
  return trailingStableChrome(item) || (item.type === "message" && item.message.role === "assistant" && isGoalStatusNotice(item.message.content));
}

function lastAssistantItemIndex(items: readonly ChatVirtualItem[]): number {
  let index = items.length - 1;
  while (index >= 0 && isSkippableStableItem(items[index]!)) index--;
  return index;
}

function isAssistantInsertionPoint(item: ChatVirtualItem | undefined): item is Extract<ChatVirtualItem, { type: "message" }> {
  return item?.type === "message" && item.message.role === "assistant" && !isPlanQuestionsMessage(item.message.content);
}

function isNarrativeHeadItem(item: ChatVirtualItem): boolean {
  return item.type === "narrative-flow" || (item.type === "message" && item.message.role === "assistant" && isAgentDisplayActive(item.agentDisplayState));
}

function withoutAdjacentPersistedNarrative(items: readonly ChatVirtualItem[], assistantIndex: number, messageId: string): ChatVirtualItem[] {
  return items.filter((item, index) => item.type !== "persisted-narrative" || item.messageId !== messageId || index !== assistantIndex - 1);
}

function spliceNarrativeItems(stableItems: readonly ChatVirtualItem[], volatileItems: readonly ChatVirtualItem[], assistantIndex: number): ChatVirtualItem[] | undefined {
  const assistantItem = stableItems[assistantIndex];
  if (!isAssistantInsertionPoint(assistantItem)) return undefined;
  const filteredStable = withoutAdjacentPersistedNarrative(stableItems, assistantIndex, assistantItem.message.id);
  const filteredAssistantIndex = filteredStable.findIndex((item) => item.type === "message" && item.message.id === assistantItem.message.id);
  if (filteredAssistantIndex < 0) return undefined;
  const headItems = volatileItems.filter(isNarrativeHeadItem);
  const indicatorItems = volatileItems.filter((item) => item.type === "narrative-indicator");
  const tailItems = volatileItems.filter((item) => !isNarrativeHeadItem(item) && item.type !== "narrative-indicator");
  return [...filteredStable.slice(0, filteredAssistantIndex), ...headItems, filteredStable[filteredAssistantIndex]!, ...indicatorItems, ...filteredStable.slice(filteredAssistantIndex + 1), ...tailItems];
}
