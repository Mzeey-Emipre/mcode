/**
 * @internal
 * Maps Cursor `cursor/task` ACP ext payloads to Mcode `Agent` tool events.
 *
 * Live ACP capture shows subagent delegations use `tool_call` markers with
 * `rawInput._toolName === "task"` and `title: "Task: Subagent task"`. Rich
 * description/prompt/model usually arrive on `cursor/task` after the subagent
 * finishes; we emit a provisional ToolUse on `tool_call` so the UI can show
 * in-progress rows immediately.
 */

import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import type { CursorAcpTurnState } from "./cursor-acp-event-mapper.js";

/** Metadata cached between `cursor/task` and the matching `tool_call_update`. */
export interface CursorTaskMeta {
  toolCallId: string;
  description: string;
  prompt: string;
  model?: string;
  agentId?: string;
  durationMs?: number;
}

/**
 * Derives a short description from an ACP Task `tool_call` title until `cursor/task` arrives.
 */
export function taskDescriptionFromAcpTitle(title: string | null | undefined): string {
  const t = (title ?? "").trim();
  if (!t) return "Subagent task";
  const stripped = t.replace(/^task:\s*/i, "").trim();
  return stripped.length > 0 ? stripped : "Subagent task";
}

/**
 * Emits a provisional {@link AgentEventType.ToolUse} when Cursor starts a Task tool_call.
 *
 * Cursor sends rich metadata on `cursor/task` only after the subagent finishes; without
 * this early event the narrative timeline shows delegations only at turn end.
 */
export function cursorTaskToolCallStartedToAgentEvents(
  threadId: string,
  toolCallId: string,
  title: string | null | undefined,
  state: CursorAcpTurnState,
): AgentEvent[] {
  state.suppressedToolCallIds.add(toolCallId);
  state.pendingTaskToolCallIds.add(toolCallId);
  state.toolNameByCallId.set(toolCallId, "Agent");

  const acc = state.accumulator;
  acc.toolStartTimes.set(toolCallId, Date.now());
  acc.pendingToolCalls.add(toolCallId);
  acc.hasFiredToolThisTurn = true;

  return [
    {
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId,
      toolName: "Agent",
      toolInput: {
        description: taskDescriptionFromAcpTitle(title),
        subagentProviderName: "Cursor",
      },
    },
  ];
}

/**
 * Returns true when an ACP `tool_call` is Cursor's internal Task / subagent tool.
 */
export function isCursorTaskAcpTool(
  rawInput: Record<string, unknown> | undefined,
  title: string | null | undefined,
): boolean {
  if (rawInput && typeof rawInput._toolName === "string" && rawInput._toolName === "task") {
    return true;
  }
  const t = (title ?? "").trim();
  if (/^task:/i.test(t)) return true;
  if (/subagent/i.test(t)) return true;
  return false;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function cursorTaskMetaFromParams(params: Record<string, unknown>): CursorTaskMeta | undefined {
  const toolCallId = stringField(params, "toolCallId");
  if (!toolCallId) return undefined;
  const duration = params.durationMs;
  return {
    toolCallId,
    description: stringField(params, "description") ?? "Subagent task",
    prompt: stringField(params, "prompt") ?? "",
    model: stringField(params, "model"),
    agentId: stringField(params, "agentId"),
    durationMs: typeof duration === "number" && Number.isFinite(duration) ? duration : undefined,
  };
}

function cacheCursorTaskMeta(state: CursorAcpTurnState, meta: CursorTaskMeta): void {
  state.taskMetaByCallId.set(meta.toolCallId, meta);
  state.toolNameByCallId.set(meta.toolCallId, "Agent");
  state.suppressedToolCallIds.add(meta.toolCallId);
  state.pendingTaskToolCallIds.add(meta.toolCallId);
}

function markCursorTaskStarted(state: CursorAcpTurnState, toolCallId: string): boolean {
  const alreadyStarted = state.accumulator.pendingToolCalls.has(toolCallId);
  if (alreadyStarted) return true;
  state.accumulator.toolStartTimes.set(toolCallId, Date.now());
  state.accumulator.pendingToolCalls.add(toolCallId);
  state.accumulator.hasFiredToolThisTurn = true;
  return false;
}

function cursorTaskToolInput(
  params: Record<string, unknown>,
  meta: CursorTaskMeta,
): Record<string, unknown> {
  const toolInput: Record<string, unknown> = {
    description: meta.description,
    prompt: meta.prompt,
    subagentProviderName: "Cursor",
  };
  if (meta.model) toolInput.model = meta.model;
  if (meta.agentId) toolInput.agentId = meta.agentId;
  if (params.subagentType !== undefined) toolInput.subagentType = params.subagentType;
  if (meta.durationMs != null) toolInput.durationMs = meta.durationMs;
  return toolInput;
}

function cursorTaskUseEvent(
  threadId: string,
  meta: CursorTaskMeta,
  toolInput: Record<string, unknown>,
): AgentEvent {
  return {
    type: AgentEventType.ToolUse,
    threadId,
    toolCallId: meta.toolCallId,
    toolName: "Agent",
    toolInput,
  };
}

function completionAfterTaskMetadata(
  threadId: string,
  toolCallId: string,
  state: CursorAcpTurnState,
): AgentEvent[] {
  if (!state.taskCompletedAwaitingMeta.has(toolCallId)) return [];
  state.taskCompletedAwaitingMeta.delete(toolCallId);
  return cursorTaskCompletionToAgentEvents(threadId, toolCallId, state, false);
}

/**
 * Builds {@link AgentEvent} values from a `cursor/task` ext method/request payload.
 *
 * @param threadId - Mcode thread id.
 * @param params - Cursor `cursor/task` JSON params.
 * @param state - Active ACP turn state (caches meta for ToolResult on completion).
 */
export function cursorTaskExtToAgentEvents(
  threadId: string,
  params: Record<string, unknown>,
  state: CursorAcpTurnState,
): AgentEvent[] {
  const meta = cursorTaskMetaFromParams(params);
  if (!meta) return [];
  cacheCursorTaskMeta(state, meta);
  const earlyToolUseEmitted = markCursorTaskStarted(state, meta.toolCallId);
  const toolInput = cursorTaskToolInput(params, meta);
  const events = completionAfterTaskMetadata(threadId, meta.toolCallId, state);
  // When tool_call already fired a provisional ToolUse, emit again so the client can merge
  // enriched description/prompt/model without waiting for completion.
  if (!earlyToolUseEmitted || Object.keys(toolInput).length > 1) {
    events.unshift(cursorTaskUseEvent(threadId, meta, toolInput));
  }
  return events;
}

/**
 * Emits {@link AgentEventType.ToolResult} when a suppressed Task tool_call completes.
 *
 * @param threadId - Mcode thread id.
 * @param toolCallId - ACP tool call id.
 * @param state - Turn state with cached {@link CursorTaskMeta}.
 * @param isError - Whether ACP reported `failed`.
 */
export function cursorTaskCompletionToAgentEvents(
  threadId: string,
  toolCallId: string,
  state: CursorAcpTurnState,
  isError: boolean,
): AgentEvent[] {
  if (!state.pendingTaskToolCallIds.has(toolCallId)) return [];

  const meta = state.taskMetaByCallId.get(toolCallId);
  state.pendingTaskToolCallIds.delete(toolCallId);
  state.taskMetaByCallId.delete(toolCallId);
  state.suppressedToolCallIds.delete(toolCallId);
  state.toolNameByCallId.delete(toolCallId);

  const acc = state.accumulator;
  acc.toolStartTimes.delete(toolCallId);
  acc.pendingToolCalls.delete(toolCallId);

  const output =
    meta?.description && meta.description.length > 0
      ? meta.description
      : "Subagent finished";

  return [
    {
      type: AgentEventType.ToolResult,
      threadId,
      toolCallId,
      output,
      isError,
    },
  ];
}
