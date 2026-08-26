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

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return mapAgentLanguageChunk(threadId, acc, update);
    case "plan":
      return mapAcpPlanUpdate(update, threadId, todoSnapshot);
    case "agent_thought_chunk":
    case "user_message_chunk":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      return [];
    case "tool_call":
      return mapAcpToolCallStarted(update, threadId, state, acc, todoSnapshot);
    case "tool_call_update":
      return mapAcpToolCallUpdated(update, threadId, state, acc);
    default:
      return [];
  }
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

/** Resolve an ACP tool call to a Mcode tool name using kind → title → discriminator. */
function resolveAcpToolName(update: {
  kind?: unknown;
  title?: string | null;
  rawInput?: unknown;
}): string {
  // 1. ACP `kind` field (most reliable for ACP-native calls)
  if (typeof update.kind === "string" && TOOL_NAME_BY_ACP_KIND[update.kind]) {
    return TOOL_NAME_BY_ACP_KIND[update.kind];
  }

  // 2. Title-based lookup
  const title = typeof update.title === "string" ? update.title : null;
  if (title && TOOL_NAME_BY_TITLE[title]) {
    return TOOL_NAME_BY_TITLE[title];
  }

  // 3. Legacy discriminator in rawInput (--print compat)
  if (update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)) {
    const rec = update.rawInput as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key === "result" || key === "args" || key === "_toolName") continue;
      if (rec[key] && typeof rec[key] === "object" && !Array.isArray(rec[key])) {
        if (TOOL_NAME_BY_DISCRIMINATOR[key]) return TOOL_NAME_BY_DISCRIMINATOR[key];
      }
    }
  }

  return title || "Tool";
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
  const rawInputRecord =
    update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
      ? (update.rawInput as Record<string, unknown>)
      : undefined;

  // ACP `_toolName` tools carry no args on `tool_call`; data arrives via ext methods.
  const acpToolName = rawInputRecord?._toolName;
  if (typeof acpToolName === "string" || isCursorTaskAcpTool(rawInputRecord, update.title)) {
    if (acpToolName === "task" || isCursorTaskAcpTool(rawInputRecord, update.title)) {
      return cursorTaskToolCallStartedToAgentEvents(
        threadId,
        update.toolCallId,
        update.title,
        state,
      );
    }
    state.suppressedToolCallIds.add(update.toolCallId);
    return [];
  }

  // Legacy --print discriminator (updateTodosToolCall, shellToolCall, etc.)
  const raw = rawInputRecord ? extractToolCallDiscriminator(rawInputRecord) : { discriminator: null, payload: undefined };
  if (raw.discriminator === "updateTodosToolCall") {
    const args = coercePayloadArgs(raw.payload);
    const entries = extractCursorTodoEntries(args);
    if (!entries || entries.length === 0) return [];
    const merge = args.merge === true;
    const incoming = entries.map((entry, index) => normalizeCursorTodoEntry(entry, index));
    const todos = reconcileCursorTodos(incoming, merge, todoSnapshot);
    acc.toolStartTimes.set(update.toolCallId, Date.now());
    acc.pendingToolCalls.add(update.toolCallId);
    acc.hasFiredToolThisTurn = true;
    return [
      {
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId: update.toolCallId,
        toolName: "TodoWrite",
        toolInput: { todos },
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
    ];
  }

  // Resolve tool name from ACP kind/title/discriminator
  let toolName = raw.discriminator
    ? (TOOL_NAME_BY_DISCRIMINATOR[raw.discriminator] ?? raw.discriminator)
    : resolveAcpToolName(update);
  toolName = resolveCursorSubagentToolName(toolName, raw.discriminator, update.title);

  // Build toolInput from rawInput if available
  let toolInput: Record<string, unknown> =
    raw.payload ? coercePayloadArgs(raw.payload) : {};
  if (Object.keys(toolInput).length === 0 && rawInputRecord) {
    const { _toolName: _, ...rest } = rawInputRecord;
    if (Object.keys(rest).length > 0) toolInput = rest;
  }

  if (toolName === "Edit" || toolName === "Write") {
    toolInput = normalizeMcodeCursorToolInput(toolName, toolInput);
  }

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
  acc.toolStartTimes.set(update.toolCallId, Date.now());
  acc.pendingToolCalls.add(update.toolCallId);
  acc.hasFiredToolThisTurn = true;

  return [
    {
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId: update.toolCallId,
      toolName,
      toolInput,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    },
  ];
}

// ---------------------------------------------------------------------------
// tool_call_update (progress + completion)
// ---------------------------------------------------------------------------

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
  const parentToolCallId = extractCursorParentToolCallId(update as unknown as Record<string, unknown>);
  // Suppress lifecycle-only tool calls (handled by ext methods)
  if (state.suppressedToolCallIds.has(update.toolCallId)) {
    const isTerminal = update.status === "completed" || update.status === "failed";
    if (isTerminal && state.pendingTaskToolCallIds.has(update.toolCallId)) {
      if (state.taskMetaByCallId.has(update.toolCallId)) {
        return cursorTaskCompletionToAgentEvents(
          threadId,
          update.toolCallId,
          state,
          update.status === "failed",
        );
      }
      // `cursor/task` often arrives after the completed tool_call_update.
      state.taskCompletedAwaitingMeta.add(update.toolCallId);
      return [];
    }
    acc.toolStartTimes.delete(update.toolCallId);
    if (isTerminal) {
      state.suppressedToolCallIds.delete(update.toolCallId);
      acc.pendingToolCalls.delete(update.toolCallId);
    }
    return [];
  }

  // Skip in-progress updates that carry no data
  const hasData =
    update.rawOutput !== undefined ||
    (Array.isArray(update.content) && (update.content as unknown[]).length > 0) ||
    update.status === "completed" ||
    update.status === "failed";
  if (!hasData) return [];

  const events: AgentEvent[] = [];
  const isError = update.status === "failed";
  const knownToolName = state.toolNameByCallId.get(update.toolCallId);
  const rawInputRecord =
    update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
      ? (update.rawInput as Record<string, unknown>)
      : undefined;
  const derivedDiscriminator = rawInputRecord
    ? extractToolCallDiscriminator(rawInputRecord).discriminator
    : null;

  const diffs = extractContentDiffs(update as Record<string, unknown>);
  const marker = state.pendingToolMarkerByCallId.get(update.toolCallId);

  let toolName = knownToolName ?? resolveAcpToolName(update);
  toolName = resolveCursorSubagentToolName(toolName, derivedDiscriminator, update.title);
  const toolInput = enrichAcpToolInput(
    toolName,
    marker,
    update.rawInput,
    update.rawOutput,
    diffs,
  );
  const output = formatAcpToolResultOutput(toolName, update.rawOutput, diffs);

  // Emit ToolUse with actual data only if the initial tool_call deferred it
  // (rawInput was empty). If tool_call already emitted ToolUse, skip to avoid
  // duplicate tool-call cards.
  if (!acc.toolStartTimes.has(update.toolCallId)) {
    events.push({
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId: update.toolCallId,
      toolName,
      toolInput,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    });
    acc.hasFiredToolThisTurn = true;
  }

  acc.toolStartTimes.delete(update.toolCallId);
  acc.pendingToolCalls.delete(update.toolCallId);
  state.toolNameByCallId.delete(update.toolCallId);
  state.pendingToolMarkerByCallId.delete(update.toolCallId);

  events.push({
    type: AgentEventType.ToolResult,
    threadId,
    toolCallId: update.toolCallId,
    output,
    isError,
    ...(diffs.length > 0 && Array.isArray(toolInput._mcodeFileMutations)
      ? {
          toolInput: {
            _mcodeToolName: toolName,
            _mcodeFileMutations: toolInput._mcodeFileMutations,
          },
        }
      : {}),
  });
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
