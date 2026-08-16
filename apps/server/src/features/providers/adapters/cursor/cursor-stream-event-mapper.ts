/**
 * Maps {@link CursorStreamEvent} objects produced by the cursor-agent
 * `--print --output-format stream-json` parser into {@link AgentEvent}
 * values.
 *
 * **`--print` only.** The Cursor provider uses `agent acp` for normal chat;
 * ACP notification mapping lives in `cursor-acp-event-mapper.ts`.
 *
 * Preserves the streaming contract (TextDelta, ToolUse, ToolResult, TodoWrite
 * synthesis for `updateTodosToolCall`) consumed by `AgentService`.
 *
 * The terminal `result` event resolves the runner's per-turn promise out of
 * band; the mapper returns `[]` for it so no agent event is emitted.
 */

import { AgentEventType } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { AgentEvent } from "@mcode/contracts";
import {
  extractCursorTodoEntries,
  normalizeCursorTodoEntry,
  reconcileCursorTodos,
} from "./cursor-todo-snapshot.js";
import { normalizeMcodeCursorToolInput } from "./cursor-tool-input-normalize.js";
import type { CursorTodoSnapshot } from "./cursor-todo-snapshot.js";
import {
  extractCursorParentToolCallId,
  resolveCursorSubagentToolName,
} from "./cursor-subagent-detection.js";
import type {
  CursorStreamAssistant,
  CursorStreamContentBlock,
  CursorStreamEvent,
  CursorStreamSystemInit,
  CursorStreamToolCallCompleted,
  CursorStreamToolCallStarted,
} from "./cursor-stream-json-types.js";

/**
 * Per-turn streaming state passed across mapper invocations within a
 * single `cursor-agent --print` subprocess lifetime.
 */
export interface CursorStreamAccumulator {
  /** Concatenated assistant text seen so far this turn. */
  assistantText: string;
  /**
   * Text from {@link AgentEventType.TextDelta} chunks tagged
   * `isFinalResponse` (post-tool user-facing reply). Used to persist the
   * assistant message without repeating pre-tool text that Mcode already
   * records as thought segments.
   */
  assistantFinalText: string;
  /**
   * Tool start times keyed by call_id. Presence of a key also signals a
   * `ToolUse` has already been emitted, so a downstream `completed` event
   * does not need to synthesize one. Used for ToolProgress elapsed metrics
   * by future heartbeat support.
   */
  toolStartTimes: Map<string, number>;
  /** Captured persistent chat id from the system/init event, used for resume. */
  chatId: string | null;
  /**
   * call_ids for tool calls that have started but not yet completed.
   * Mirrors ClaudeProvider's pendingToolUses for the same purpose: detecting
   * when all tools have resolved so subsequent text deltas can be tagged
   * isFinalResponse.
   */
  pendingToolCalls: Set<string>;
  /**
   * True once the first tool call for this turn has been registered.
   * Distinguishes pre-tool preamble text from final-response text, both of
   * which have pendingToolCalls empty.
   */
  hasFiredToolThisTurn: boolean;
}

/** Factory for a fresh per-turn accumulator. */
export function createCursorStreamAccumulator(): CursorStreamAccumulator {
  return {
    assistantText: "",
    assistantFinalText: "",
    toolStartTimes: new Map(),
    chatId: null,
    pendingToolCalls: new Set(),
    hasFiredToolThisTurn: false,
  };
}

/**
 * Returns the assistant message body to persist for Cursor: final-response
 * slices when present, otherwise the full streamed transcript (tool-free
 * turns and other cases where nothing was tagged final).
 */
export function resolveCursorAssistantMessageContent(acc: CursorStreamAccumulator): string {
  const trimmedFinal = acc.assistantFinalText.trim();
  if (trimmedFinal.length > 0) return trimmedFinal;
  return acc.assistantText.trim();
}

/**
 * Friendly tool-name overrides for known cursor stream-json discriminators.
 * Anything not in this table falls back to the discriminator itself, so
 * forward-compatibility is preserved when cursor-agent ships new tools.
 */
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

/**
 * Maps a single stream-json event to zero or more {@link AgentEvent}s.
 *
 * @param event - Parsed event from {@link CursorStreamJsonParser}.
 * @param threadId - Mcode thread id (caller is responsible for stripping any
 *   provider prefix).
 * @param acc - Running per-turn accumulator. Mutated in place.
 * @param todoSnapshot - Optional per-thread snapshot for `updateTodos`
 *   merge:true semantics. When omitted, behavior degrades to "always
 *   replace" — correct but loses prior context across patches.
 */
export function mapCursorStreamEvent(
  event: CursorStreamEvent,
  threadId: string,
  acc: CursorStreamAccumulator,
  todoSnapshot?: CursorTodoSnapshot,
): AgentEvent[] {
  switch (event.type) {
    case "system":
      return mapSystemEvent(event as CursorStreamSystemInit, threadId, acc);
    case "assistant":
      return mapAssistantEvent(event as CursorStreamAssistant, threadId, acc);
    case "user":
      // Echo of the user prompt — UI already has it.
      return [];
    case "tool_call":
      return mapToolCallEvent(
        event as CursorStreamToolCallStarted | CursorStreamToolCallCompleted,
        threadId,
        acc,
        todoSnapshot,
      );
    case "result":
      // Terminal: runner consumes this directly to resolve its turn promise.
      return [];
    default:
      return [];
  }
}

function mapSystemEvent(
  event: CursorStreamSystemInit,
  threadId: string,
  acc: CursorStreamAccumulator,
): AgentEvent[] {
  if (event.subtype !== "init") return [];
  const sessionId = typeof event.session_id === "string" ? event.session_id : "";
  if (!sessionId) return [];
  acc.chatId = sessionId;
  return [
    {
      type: AgentEventType.System,
      threadId,
      subtype: `sdk_session_id:${sessionId}`,
    },
  ];
}

function mapAssistantEvent(
  event: CursorStreamAssistant,
  threadId: string,
  acc: CursorStreamAccumulator,
): AgentEvent[] {
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  const text = concatTextBlocks(blocks);
  if (!text) return [];

  // Determine whether this text is the final user-facing response. All pending
  // tool calls must have resolved AND at least one tool must have fired this
  // turn (to distinguish post-tool final-response from pre-tool preamble).
  const isFinalResponse =
    acc.pendingToolCalls.size === 0 && acc.hasFiredToolThisTurn;

  // Per-token delta: emit immediately and remember the running total.
  if (typeof event.timestamp_ms === "number") {
    acc.assistantText += text;
    if (isFinalResponse) acc.assistantFinalText += text;
    return [{
      type: AgentEventType.TextDelta,
      threadId,
      delta: text,
      ...(isFinalResponse && { isFinalResponse: true }),
    }];
  }

  // Terminal full-message echo. If we already accumulated deltas this turn,
  // suppress to avoid duplicating text in the assistant message body. If we
  // have no prior text (caller didn't pass --stream-partial-output, or this
  // is a single-shot tool turn) emit it as a one-shot delta so nothing is
  // lost.
  if (acc.assistantText.length > 0) {
    acc.assistantText = text;
    // Do not append to assistantFinalText: streaming should already have
    // captured final-response slices; the echo is the full transcript.
    return [];
  }
  acc.assistantText = text;
  if (isFinalResponse) acc.assistantFinalText += text;
  return [{
    type: AgentEventType.TextDelta,
    threadId,
    delta: text,
    ...(isFinalResponse && { isFinalResponse: true }),
  }];
}

function concatTextBlocks(blocks: CursorStreamContentBlock[]): string {
  let out = "";
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

function mapToolCallEvent(
  event: CursorStreamToolCallStarted | CursorStreamToolCallCompleted,
  threadId: string,
  acc: CursorStreamAccumulator,
  todoSnapshot: CursorTodoSnapshot | undefined,
): AgentEvent[] {
  if (typeof event.call_id !== "string" || event.call_id.length === 0) {
    logger.info("Cursor stream tool_call missing call_id", { subtype: event.subtype });
    return [];
  }

  const { discriminator, payload } = extractToolCallDiscriminator(event.tool_call);
  if (!discriminator) return [];

  if (event.subtype === "started") {
    return mapToolCallStarted(event.call_id, discriminator, payload, threadId, acc, todoSnapshot, event);
  }
  return mapToolCallCompleted(event.call_id, discriminator, payload, threadId, acc, event);
}

/**
 * Pulls the first non-result key out of a `tool_call` envelope. Cursor
 * stream-json wraps each tool's payload under a discriminator key
 * (`readToolCall`, `shellToolCall`, …); the value is itself an object
 * carrying `args` and (on completed) `result`.
 */
function extractToolCallDiscriminator(toolCall: Record<string, unknown> | undefined): {
  discriminator: string | null;
  payload: Record<string, unknown> | undefined;
} {
  if (!toolCall || typeof toolCall !== "object") return { discriminator: null, payload: undefined };
  for (const key of Object.keys(toolCall)) {
    // Skip transport-level fields the parser didn't reshape (defensive).
    if (key === "result" || key === "args") continue;
    const v = toolCall[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return { discriminator: key, payload: v as Record<string, unknown> };
    }
  }
  return { discriminator: null, payload: undefined };
}

function mapToolCallStarted(
  callId: string,
  discriminator: string,
  payload: Record<string, unknown> | undefined,
  threadId: string,
  acc: CursorStreamAccumulator,
  todoSnapshot: CursorTodoSnapshot | undefined,
  streamEvent: CursorStreamToolCallStarted,
): AgentEvent[] {
  const args = extractArgs(payload);
  const parentToolCallId = extractCursorParentToolCallId(streamEvent as unknown as Record<string, unknown>);

  if (discriminator === "updateTodosToolCall") {
    return mapUpdateTodosStarted(callId, args, threadId, acc, todoSnapshot, parentToolCallId);
  }

  const toolName = resolveCursorSubagentToolName(
    TOOL_NAME_BY_DISCRIMINATOR[discriminator] ?? discriminator,
    discriminator,
    undefined,
  );
  acc.toolStartTimes.set(callId, Date.now());
  acc.pendingToolCalls.add(callId);
  acc.hasFiredToolThisTurn = true;
  const toolInput =
    toolName === "Edit" || toolName === "Write"
      ? normalizeMcodeCursorToolInput(toolName, args ?? {})
      : args ?? {};

  return [
    {
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId: callId,
      toolName,
      toolInput,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    },
  ];
}

function mapUpdateTodosStarted(
  callId: string,
  args: Record<string, unknown> | undefined,
  threadId: string,
  acc: CursorStreamAccumulator,
  todoSnapshot: CursorTodoSnapshot | undefined,
  parentToolCallId?: string,
): AgentEvent[] {
  const entries = extractCursorTodoEntries(args);
  if (!entries || entries.length === 0) return [];
  const merge = args?.merge === true;
  const incoming = entries.map((entry, index) => normalizeCursorTodoEntry(entry, index));
  const todos = reconcileCursorTodos(incoming, merge, todoSnapshot);
  acc.toolStartTimes.set(callId, Date.now());
  acc.pendingToolCalls.add(callId);
  acc.hasFiredToolThisTurn = true;
  return [
    {
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId: callId,
      toolName: "TodoWrite",
      toolInput: { todos },
      ...(parentToolCallId ? { parentToolCallId } : {}),
    },
  ];
}

function mapToolCallCompleted(
  callId: string,
  discriminator: string,
  payload: Record<string, unknown> | undefined,
  threadId: string,
  acc: CursorStreamAccumulator,
  streamEvent: CursorStreamToolCallCompleted,
): AgentEvent[] {
  const result = extractResult(payload);
  const isError = result?.rejected != null || result?.failure != null;
  const output = formatResultOutput(result);

  const events: AgentEvent[] = [];
  const parentToolCallId = extractCursorParentToolCallId(streamEvent as unknown as Record<string, unknown>);

  // Synthesize a ToolUse if completed arrives without a prior started
  // (orphan recovery — better to render the result against a placeholder
  // ToolUse than to drop it entirely).
  if (!acc.toolStartTimes.has(callId)) {
    if (discriminator !== "updateTodosToolCall") {
      let toolName = TOOL_NAME_BY_DISCRIMINATOR[discriminator] ?? discriminator;
      toolName = resolveCursorSubagentToolName(toolName, discriminator, undefined);
      const orphanArgs = extractArgs(payload) ?? {};
      const toolInput =
        toolName === "Edit" || toolName === "Write"
          ? normalizeMcodeCursorToolInput(toolName, orphanArgs)
          : orphanArgs;
      events.push({
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId: callId,
        toolName,
        toolInput,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      });
    }
  }

  acc.toolStartTimes.delete(callId);
  acc.pendingToolCalls.delete(callId);

  if (discriminator === "updateTodosToolCall") {
    // Reuse the same one-line result format as ACP for parity.
    events.push({
      type: AgentEventType.ToolResult,
      threadId,
      toolCallId: callId,
      output: output || "Updated todos",
      isError,
    });
    return events;
  }

  events.push({
    type: AgentEventType.ToolResult,
    threadId,
    toolCallId: callId,
    output,
    isError,
  });
  return events;
}

/** Extract the `args` sub-object from a tool payload, tolerating absence. */
function extractArgs(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const v = payload.args;
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

/** Extract the `result` sub-object from a tool payload. */
function extractResult(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const v = payload.result;
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

/**
 * Renders a tool result envelope into a human-readable string for the UI's
 * generic tool-result card. Prefers the success/rejected/failure body, falls
 * back to the entire result envelope as JSON.
 */
function formatResultOutput(result: Record<string, unknown> | undefined): string {
  if (!result) return "";
  const body = result.success ?? result.rejected ?? result.failure;
  if (body == null) return safeStringify(result);
  if (typeof body === "string") return body;
  return safeStringify(body);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
