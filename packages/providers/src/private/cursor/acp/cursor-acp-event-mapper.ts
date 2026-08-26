/**
 * @internal
 * Maps ACP `session/update` notifications to mcode {@link AgentEvent} values.
 *
 * ACP tool calls differ fundamentally from `--print` stream-json:
 * - `tool_call` is a lifecycle marker with `kind`/`title` but often empty `rawInput`
 * - `_toolName` tools (e.g. updateTodos) carry no args; data arrives via ext methods
 * - Actual tool output arrives on `tool_call_update` via:
 *   - `rawOutput.content` for Read (file content)
 *   - `content[]` with `type: "diff"` for Edit (path, oldText, newText)
 *   - `rawOutput.{stdout,stderr,exitCode}` for Terminal/Bash
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import {
  extractCursorTodoEntries,
  normalizeCursorTodoEntry,
  reconcileCursorTodos,
  buildTodoWriteEvents,
  type CursorTodoSnapshot,
} from "../events/cursor-todo-snapshot.js";
import { normalizeMcodeCursorToolInput } from "../events/cursor-tool-input-normalize.js";
import type { CursorStreamAccumulator } from "../stream-json/cursor-stream-event-mapper.js";
import {
  enrichAcpToolInput,
  formatAcpToolResultOutput,
  type AcpDiffBlock,
  type PendingAcpToolMarker,
} from "./cursor-acp-tool-input-enrichment.js";
import {
  cursorTaskCompletionToAgentEvents,
  cursorTaskToolCallStartedToAgentEvents,
  isCursorTaskAcpTool,
} from "./cursor-acp-task.js";
import {
  extractCursorParentToolCallId,
  resolveCursorSubagentToolName,
} from "../events/cursor-subagent-detection.js";

/** Maps ACP `kind` field to Mcode tool names. */
const TOOL_NAME_BY_ACP_KIND: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  command: "Bash",
  execute: "Bash",
  search: "Grep",
  subagent: "Agent",
  delegate: "Agent",
  other: "Tool",
};

/** Maps `--print` style discriminator keys to Mcode tool names (legacy compat). */
const TOOL_NAME_BY_DISCRIMINATOR: Record<string, string> = {
  readToolCall: "Read",
  writeToolCall: "Write",
  editToolCall: "Edit",
  shellToolCall: "Bash",
  grepToolCall: "Grep",
  globToolCall: "Glob",
  lsToolCall: "LS",
  deleteToolCall: "Delete",
  webSearchToolCall: "WebSearch",
  fetchToolCall: "WebFetch",
  searchReplaceToolCall: "Edit",
  strReplaceToolCall: "Edit",
};

/** Maps ACP `title` strings to Mcode tool names as fallback. */
const TOOL_NAME_BY_TITLE: Record<string, string> = {
  "Read File": "Read",
  "Edit File": "Edit",
  "Write File": "Write",
  "Terminal": "Bash",
  "Find": "Glob",
  "Read Lints": "Read",
  "Search": "Grep",
};

const IGNORED_ACP_SESSION_UPDATES = new Set<string>([
  "agent_thought_chunk",
  "user_message_chunk",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);

/**
 * Accumulator for streaming state during one ACP prompt turn on a thread.
 */
export interface CursorAcpTurnState {
  accumulator: CursorStreamAccumulator;
  /** Tool call IDs whose data arrives via ext methods, not session updates. */
  suppressedToolCallIds: Set<string>;
  /** Task/subagent tool_call ids awaiting `cursor/task` + completion (see cursor-acp-task.ts). */
  pendingTaskToolCallIds: Set<string>;
  /** Task ids that completed on ACP before `cursor/task` metadata arrived. */
  taskCompletedAwaitingMeta: Set<string>;
  /** Cached `cursor/task` metadata keyed by toolCallId until tool_call_update completes. */
  taskMetaByCallId: Map<string, import("./cursor-acp-task.js").CursorTaskMeta>;
  /** Tracks the ACP tool name (kind/title) per tool call ID for enriching updates. */
  toolNameByCallId: Map<string, string>;
  /** Kind/title from deferred lifecycle `tool_call` markers. */
  pendingToolMarkerByCallId: Map<string, PendingAcpToolMarker>;
}

/** Creates a fresh per-turn state bundle (wraps shared stream accumulator shape). */
export function createCursorAcpTurnState(): CursorAcpTurnState {
  return {
    accumulator: {
      assistantText: "",
      assistantFinalText: "",
      toolStartTimes: new Map(),
      chatId: null,
      pendingToolCalls: new Set(),
      hasFiredToolThisTurn: false,
    },
    suppressedToolCallIds: new Set(),
    pendingTaskToolCallIds: new Set(),
    taskCompletedAwaitingMeta: new Set(),
    taskMetaByCallId: new Map(),
    toolNameByCallId: new Map(),
    pendingToolMarkerByCallId: new Map(),
  };
}

/**
 * Converts a single `session/update` notification into zero or more agent events.
 */
export function mapCursorAcpSessionNotification(
  notification: SessionNotification,
  threadId: string,
  state: CursorAcpTurnState,
  todoSnapshot?: CursorTodoSnapshot,
): AgentEvent[] {
  const { update } = notification;
  const acc = state.accumulator;

  if (IGNORED_ACP_SESSION_UPDATES.has(update.sessionUpdate)) return [];
  if (update.sessionUpdate === "agent_message_chunk") return mapAgentLanguageChunk(threadId, acc, update);
  if (update.sessionUpdate === "plan") return mapAcpPlanUpdate(update, threadId, todoSnapshot);
  if (update.sessionUpdate === "tool_call") {
    return mapAcpToolCallStarted(update, threadId, state, acc, todoSnapshot);
  }
  if (update.sessionUpdate === "tool_call_update") return mapAcpToolCallUpdated(update, threadId, state, acc);
  return [];
}

// ---------------------------------------------------------------------------
// Text chunks
// ---------------------------------------------------------------------------

function mapAgentLanguageChunk(
  threadId: string,
  acc: CursorStreamAccumulator,
  update: import("@agentclientprotocol/sdk").ContentChunk & {
    sessionUpdate: "agent_message_chunk";
  },
): AgentEvent[] {
  if (update.content.type !== "text" || !update.content.text) return [];
  const text = update.content.text;
  acc.assistantText += text;
  // Tag as final-response when all tools have resolved and at least one fired.
  const isFinalResponse = acc.pendingToolCalls.size === 0 && acc.hasFiredToolThisTurn;
  if (isFinalResponse) acc.assistantFinalText += text;
  return [{
    type: AgentEventType.TextDelta,
    threadId,
    delta: text,
    ...(isFinalResponse && { isFinalResponse: true }),
  }];
}

// ---------------------------------------------------------------------------
// Tool call helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toolNameFromAcpKind(kind: unknown): string | undefined {
  if (typeof kind !== "string") return undefined;
  return TOOL_NAME_BY_ACP_KIND[kind];
}

function acpToolTitle(title: unknown): string | undefined {
  return typeof title === "string" ? title : undefined;
}

function toolNameFromDiscriminator(rawInput: unknown): string | undefined {
  const record = asRecord(rawInput);
  if (!record) return undefined;
  for (const key of Object.keys(record)) {
    if (key === "result" || key === "args" || key === "_toolName") continue;
    if (!asRecord(record[key])) continue;
    const toolName = TOOL_NAME_BY_DISCRIMINATOR[key];
    if (toolName) return toolName;
  }
  return undefined;
}

/** Resolve an ACP tool call to a Mcode tool name using kind → title → discriminator. */
function resolveAcpToolName(update: {
  kind?: unknown;
  title?: string | null;
  rawInput?: unknown;
}): string {
  const title = acpToolTitle(update.title);
  const kindToolName = toolNameFromAcpKind(update.kind);
  if (kindToolName) return kindToolName;
  const titleToolName = title ? TOOL_NAME_BY_TITLE[title] : undefined;
  if (titleToolName) return titleToolName;
  return toolNameFromDiscriminator(update.rawInput) ?? (title || "Tool");
}

function extractContentDiffs(update: Record<string, unknown>): AcpDiffBlock[] {
  const content = update.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (c): c is AcpDiffBlock =>
      c != null &&
      typeof c === "object" &&
      (c as Record<string, unknown>).type === "diff" &&
      typeof (c as Record<string, unknown>).path === "string",
  );
}

// ---------------------------------------------------------------------------
// Legacy --print helpers (kept for backward compat if mixed transports)
// ---------------------------------------------------------------------------

function extractToolCallDiscriminator(toolCall: Record<string, unknown> | undefined): {
  discriminator: string | null;
  payload: Record<string, unknown> | undefined;
} {
  if (!toolCall || typeof toolCall !== "object") return { discriminator: null, payload: undefined };
  for (const key of Object.keys(toolCall)) {
    if (key === "result" || key === "args") continue;
    const v = toolCall[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return { discriminator: key, payload: v as Record<string, unknown> };
    }
  }
  return { discriminator: null, payload: undefined };
}

function extractArgs(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const v = payload.args;
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

function coercePayloadArgs(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) return {};
  const nested = extractArgs(payload);
  if (nested && Object.keys(nested).length > 0) return { ...nested };
  const { result: _omitResult, ...rest } = payload;
  return { ...rest };
}

function toolUseEvent(
  threadId: string,
  toolCallId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  parentToolCallId: string | undefined,
): AgentEvent {
  return {
    type: AgentEventType.ToolUse,
    threadId,
    toolCallId,
    toolName,
    toolInput,
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}

function markAcpToolCallStarted(acc: CursorStreamAccumulator, toolCallId: string): void {
  acc.toolStartTimes.set(toolCallId, Date.now());
  acc.pendingToolCalls.add(toolCallId);
  acc.hasFiredToolThisTurn = true;
}

function mapSpecialAcpToolCall(
  update: { rawInput?: unknown; toolCallId: string; title: string },
  threadId: string,
  state: CursorAcpTurnState,
  rawInput: Record<string, unknown> | undefined,
): AgentEvent[] | null {
  const isTask = isCursorTaskAcpTool(rawInput, update.title);
  if (typeof rawInput?._toolName !== "string" && !isTask) return null;
  if (isTask) {
    return cursorTaskToolCallStartedToAgentEvents(threadId, update.toolCallId, update.title, state);
  }
  state.suppressedToolCallIds.add(update.toolCallId);
  return [];
}

function mapLegacyTodoToolCall(
  update: { toolCallId: string },
  threadId: string,
  parentToolCallId: string | undefined,
  raw: { discriminator: string | null; payload: Record<string, unknown> | undefined },
  acc: CursorStreamAccumulator,
  todoSnapshot: CursorTodoSnapshot | undefined,
): AgentEvent[] | null {
  if (raw.discriminator !== "updateTodosToolCall") return null;
  const args = coercePayloadArgs(raw.payload);
  const entries = extractCursorTodoEntries(args);
  if (!entries || entries.length === 0) return [];
  const incoming = entries.map((entry, index) => normalizeCursorTodoEntry(entry, index));
  const todos = reconcileCursorTodos(incoming, args.merge === true, todoSnapshot);
  markAcpToolCallStarted(acc, update.toolCallId);
  return [toolUseEvent(threadId, update.toolCallId, "TodoWrite", { todos }, parentToolCallId)];
}

function initialAcpToolName(
  update: { kind?: unknown; rawInput?: unknown; title?: string | null },
  discriminator: string | null,
): string {
  let toolName = resolveAcpToolName(update);
  if (discriminator) toolName = TOOL_NAME_BY_DISCRIMINATOR[discriminator] ?? discriminator;
  return resolveCursorSubagentToolName(toolName, discriminator, update.title);
}

function normalizeInitialAcpToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return toolName === "Edit" || toolName === "Write"
    ? normalizeMcodeCursorToolInput(toolName, toolInput)
    : toolInput;
}

function initialAcpToolInput(
  rawInput: Record<string, unknown> | undefined,
  payload: Record<string, unknown> | undefined,
  toolName: string,
): Record<string, unknown> {
  let toolInput = payload ? coercePayloadArgs(payload) : {};
  if (Object.keys(toolInput).length === 0 && rawInput) {
    const { _toolName: _, ...rest } = rawInput;
    if (Object.keys(rest).length > 0) toolInput = rest;
  }
  return normalizeInitialAcpToolInput(toolName, toolInput);
}

// ---------------------------------------------------------------------------
// tool_call (initial)
// ---------------------------------------------------------------------------

function mapAcpToolCallStarted(
  update: {
    rawInput?: unknown;
    toolCallId: string;
    title: string;
    kind?: unknown;
  },
  threadId: string,
  state: CursorAcpTurnState,
  acc: CursorStreamAccumulator,
  todoSnapshot: CursorTodoSnapshot | undefined,
): AgentEvent[] {
  const parentToolCallId = extractCursorParentToolCallId(update as unknown as Record<string, unknown>);
  const rawInputRecord = asRecord(update.rawInput);
  const specialEvents = mapSpecialAcpToolCall(update, threadId, state, rawInputRecord);
  if (specialEvents) return specialEvents;

  // Legacy --print discriminator (updateTodosToolCall, shellToolCall, etc.)
  const raw = rawInputRecord
    ? extractToolCallDiscriminator(rawInputRecord)
    : { discriminator: null, payload: undefined };
  const todoEvents = mapLegacyTodoToolCall(
    update,
    threadId,
    parentToolCallId,
    raw,
    acc,
    todoSnapshot,
  );
  if (todoEvents) return todoEvents;

  const toolName = initialAcpToolName(update, raw.discriminator);
  const toolInput = initialAcpToolInput(rawInputRecord, raw.payload, toolName);

  state.toolNameByCallId.set(update.toolCallId, toolName);
  state.pendingToolMarkerByCallId.set(update.toolCallId, {
    kind: typeof update.kind === "string" ? update.kind : undefined,
    title: update.title,
  });

  // ACP tool_calls with empty rawInput are lifecycle markers; actual data
  // arrives on tool_call_update (content blocks or rawOutput). Defer ToolUse
  // so we emit one event with real data instead of an empty one now + duplicate later.
  if (Object.keys(toolInput).length === 0) {
    return [];
  }

  // Align with {@link CursorStreamAccumulator}: only set once a ToolUse is emitted
  // so `tool_call_update` can orphan-synthesize a card like stream-json completions.
  markAcpToolCallStarted(acc, update.toolCallId);
  return [toolUseEvent(threadId, update.toolCallId, toolName, toolInput, parentToolCallId)];
}

// ---------------------------------------------------------------------------
// tool_call_update (progress + completion)
// ---------------------------------------------------------------------------

function isTerminalAcpToolCallStatus(status: unknown): boolean {
  return status === "completed" || status === "failed";
}

function mapTerminalSuppressedAcpToolCallUpdate(
  update: { status?: unknown; toolCallId: string },
  threadId: string,
  state: CursorAcpTurnState,
  acc: CursorStreamAccumulator,
): AgentEvent[] {
  if (state.pendingTaskToolCallIds.has(update.toolCallId)) {
    if (state.taskMetaByCallId.has(update.toolCallId)) {
      return cursorTaskCompletionToAgentEvents(
        threadId,
        update.toolCallId,
        state,
        update.status === "failed",
      );
    }
    state.taskCompletedAwaitingMeta.add(update.toolCallId);
    return [];
  }
  acc.toolStartTimes.delete(update.toolCallId);
  state.suppressedToolCallIds.delete(update.toolCallId);
  acc.pendingToolCalls.delete(update.toolCallId);
  return [];
}

function mapSuppressedAcpToolCallUpdate(
  update: { status?: unknown; toolCallId: string },
  threadId: string,
  state: CursorAcpTurnState,
  acc: CursorStreamAccumulator,
): AgentEvent[] | null {
  if (!state.suppressedToolCallIds.has(update.toolCallId)) return null;
  if (isTerminalAcpToolCallStatus(update.status)) {
    return mapTerminalSuppressedAcpToolCallUpdate(update, threadId, state, acc);
  }
  acc.toolStartTimes.delete(update.toolCallId);
  return [];
}

function acpToolCallUpdateHasData(update: {
  content?: unknown;
  rawOutput?: unknown;
  status?: unknown;
}): boolean {
  if (update.rawOutput !== undefined) return true;
  if (Array.isArray(update.content) && update.content.length > 0) return true;
  return isTerminalAcpToolCallStatus(update.status);
}

function updatedAcpToolName(
  update: { kind?: unknown; rawInput?: unknown; title?: string | null; toolCallId: string },
  state: CursorAcpTurnState,
): { toolName: string; discriminator: string | null } {
  const rawInput = asRecord(update.rawInput);
  const discriminator = rawInput ? extractToolCallDiscriminator(rawInput).discriminator : null;
  let toolName = state.toolNameByCallId.get(update.toolCallId);
  if (!toolName) toolName = resolveAcpToolName(update);
  return {
    toolName: resolveCursorSubagentToolName(toolName, discriminator, update.title),
    discriminator,
  };
}

function deferredAcpToolUse(
  threadId: string,
  toolCallId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  parentToolCallId: string | undefined,
  acc: CursorStreamAccumulator,
): AgentEvent[] {
  if (acc.toolStartTimes.has(toolCallId)) return [];
  acc.hasFiredToolThisTurn = true;
  return [toolUseEvent(threadId, toolCallId, toolName, toolInput, parentToolCallId)];
}

function resultToolInput(
  toolName: string,
  diffs: readonly AcpDiffBlock[],
  toolInput: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (diffs.length === 0 || !Array.isArray(toolInput._mcodeFileMutations)) return undefined;
  return {
    _mcodeToolName: toolName,
    _mcodeFileMutations: toolInput._mcodeFileMutations,
  };
}

function acpToolResultEvent(
  threadId: string,
  toolCallId: string,
  output: string,
  isError: boolean,
  toolInput: Record<string, unknown> | undefined,
): AgentEvent {
  return {
    type: AgentEventType.ToolResult,
    threadId,
    toolCallId,
    output,
    isError,
    ...(toolInput ? { toolInput } : {}),
  };
}

function clearAcpToolCallUpdate(state: CursorAcpTurnState, acc: CursorStreamAccumulator, toolCallId: string): void {
  acc.toolStartTimes.delete(toolCallId);
  acc.pendingToolCalls.delete(toolCallId);
  state.toolNameByCallId.delete(toolCallId);
  state.pendingToolMarkerByCallId.delete(toolCallId);
}

function mapAcpToolCallUpdated(
  update: {
    rawInput?: unknown;
    rawOutput?: unknown;
    content?: unknown;
    status?: unknown;
    toolCallId: string;
    title?: string | null;
    kind?: unknown;
  },
  threadId: string,
  state: CursorAcpTurnState,
  acc: CursorStreamAccumulator,
): AgentEvent[] {
  const suppressedEvents = mapSuppressedAcpToolCallUpdate(update, threadId, state, acc);
  if (suppressedEvents) return suppressedEvents;
  if (!acpToolCallUpdateHasData(update)) return [];

  const parentToolCallId = extractCursorParentToolCallId(update as unknown as Record<string, unknown>);
  const diffs = extractContentDiffs(update as Record<string, unknown>);
  const marker = state.pendingToolMarkerByCallId.get(update.toolCallId);
  const { toolName } = updatedAcpToolName(update, state);
  const toolInput = enrichAcpToolInput(toolName, marker, update.rawInput, update.rawOutput, diffs);
  const output = formatAcpToolResultOutput(toolName, update.rawOutput, diffs);
  const events = deferredAcpToolUse(
    threadId,
    update.toolCallId,
    toolName,
    toolInput,
    parentToolCallId,
    acc,
  );

  clearAcpToolCallUpdate(state, acc, update.toolCallId);
  events.push(
    acpToolResultEvent(
      threadId,
      update.toolCallId,
      output,
      update.status === "failed",
      resultToolInput(toolName, diffs, toolInput),
    ),
  );
  return events;
}

// ---------------------------------------------------------------------------
// Plan session update → TodoWrite
// ---------------------------------------------------------------------------

function mapAcpPlanUpdate(
  update: { entries: Array<{ content: string; status: string; priority?: string }> },
  threadId: string,
  todoSnapshot: CursorTodoSnapshot | undefined,
): AgentEvent[] {
  if (!update.entries || update.entries.length === 0) return [];

  const incoming = update.entries.map((entry, i) => ({
    id: String(i),
    content: entry.content?.trim() || `Step ${i + 1}`,
    status: normalizePlanStatus(entry.status),
    priority: entry.priority,
  }));

  const todos = reconcileCursorTodos(incoming, false, todoSnapshot);
  return buildTodoWriteEvents(todos, threadId);
}

function normalizePlanStatus(
  status: string,
): "pending" | "in_progress" | "completed" | "cancelled" {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "in_progress":
    case "inProgress":
    case "in-progress":
      return "in_progress";
    default:
      return "pending";
  }
}
