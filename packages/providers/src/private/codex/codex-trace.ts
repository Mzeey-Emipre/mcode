/**
 * Opt-in Codex protocol tracing for debugging narrative and sub-agent wiring.
 *
 * Set `MCODE_CODEX_TRACE=1` before starting the server. Logs one `info` line per
 * ingested notification with redacted summaries (lengths and short previews only).
 */

import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";

const TRUTHY = new Set(["1", "true", "yes"]);

/** Returns true when `MCODE_CODEX_TRACE` requests Codex ingest logging. */
export function isCodexTraceEnabled(): boolean {
  const v = process.env.MCODE_CODEX_TRACE;
  if (v == null || v === "") return false;
  return TRUTHY.has(v.trim().toLowerCase());
}

function previewText(s: string, max = 72): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function previewDiagnostic(s: string): string {
  const redacted = s
    .replace(/\bBearer\s+[^\s,;}]+/gi, "Bearer [redacted]")
    .replace(/\b(token|api[_-]?key|secret|password|authorization)\s*[:=]\s*["']?[^\s,;}"']+/gi, "$1=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
  return previewText(redacted, 256);
}

/** Pulls correlation ids from notification params when present (Codex app-server payloads). */
function traceCorrelationIds(
  params: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!params || typeof params !== "object") return {};
  const out: Record<string, string> = {};
  for (const key of ["threadId", "turnId", "itemId"] as const) {
    const v = params[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}

/**
 * Builds a compact, log-safe summary of codex JSON-RPC notification params
 * (no full prompts or command bodies).
 */
export function summarizeCodexNotificationParams(
  method: string,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const ids = traceCorrelationIds(params);
  if (!params || typeof params !== "object") return { ...ids, paramKeys: [] };
  const summarize = CODEX_NOTIFICATION_SUMMARIZERS[method];
  if (summarize) return summarize(params, ids);
  return { ...ids, paramKeys: Object.keys(params).filter((key) => key !== "item").slice(0, 20) };
}

type CodexNotificationSummary = (params: Record<string, unknown>, ids: Record<string, string>) => Record<string, unknown>;

const CODEX_NOTIFICATION_SUMMARIZERS: Record<string, CodexNotificationSummary> = {
  "item/completed": summarizeCompletedCodexItem,
  "item/reasoning/textDelta": summarizeCodexDelta,
  "item/reasoning/summaryTextDelta": summarizeCodexDelta,
  "item/plan/delta": summarizeCodexDelta,
  "item/agentMessage/delta": summarizeCodexDelta,
  "item/started": summarizeStartedCodexItem,
  "turn/completed": summarizeCodexTurn,
  "turn/started": summarizeCodexTurn,
  "mcpServer/startupStatus/updated": summarizeCodexMcpStartup,
};

function summarizeCompletedCodexItem(
  params: Record<string, unknown>,
  ids: Record<string, string>,
): Record<string, unknown> {
  const item = asCodexTraceRecord(params.item);
  return { ...ids, itemType: codexTraceString(item?.type), itemId: codexTraceString(item?.id), toolKind: codexTraceString(item?.toolKind) ?? codexTraceString(item?.tool_kind), functionName: codexTraceString(item?.name) };
}

function summarizeCodexDelta(params: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const delta = codexTraceString(params.delta) ?? codexTraceString(params.text) ?? "";
  return { ...ids, deltaLen: delta.length, deltaPreview: delta.length > 0 ? previewText(delta, 64) : "" };
}

function summarizeStartedCodexItem(params: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const item = asCodexTraceRecord(params.item);
  return { ...ids, itemType: codexTraceString(item?.type), itemId: codexTraceString(item?.id) };
}

function summarizeCodexTurn(params: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const turn = asCodexTraceRecord(params.turn);
  return { ...ids, turnId: codexTraceString(turn?.id), status: codexTraceString(turn?.status) };
}

function summarizeCodexMcpStartup(params: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const error = codexTraceString(params.error);
  const failureReason = codexTraceString(params.failureReason);
  return { ...ids, name: codexTraceString(params.name), status: codexTraceString(params.status), errorPreview: error ? previewDiagnostic(error) : undefined, failureReasonPreview: failureReason ? previewDiagnostic(failureReason) : undefined };
}

function asCodexTraceRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function codexTraceString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Maps emitted `AgentEvent` objects to compact trace records (ToolUse parent ids, delta flags).
 */
export function summarizeAgentEventsForTrace(events: readonly AgentEvent[]): unknown[] {
  return events.map((e) => {
    switch (e.type) {
      case AgentEventType.TextDelta:
        return {
          type: "textDelta",
          isFinalResponse: e.isFinalResponse === true,
          len: e.delta.length,
          preview: e.delta.length > 0 ? previewText(e.delta, 64) : "",
        };
      case AgentEventType.ToolUse:
        return {
          type: "toolUse",
          toolName: e.toolName,
          toolCallId: e.toolCallId,
          parentToolCallId: e.parentToolCallId,
          toolInputKeys: Object.keys(e.toolInput ?? {}).slice(0, 12),
        };
      case AgentEventType.ToolResult:
        return {
          type: "toolResult",
          toolCallId: e.toolCallId,
          isError: e.isError,
          outputLen: e.output.length,
        };
      case AgentEventType.Message:
        return {
          type: "message",
          contentLen: e.content.length,
        };
      case AgentEventType.TurnComplete:
        return { type: "turnComplete", tokensIn: e.tokensIn, tokensOut: e.tokensOut };
      case AgentEventType.Error:
        return { type: "error", errorLen: e.error.length };
      default:
        return { type: e.type };
    }
  });
}

/**
 * Logs a single notification and its mapped agent events when tracing is enabled.
 */
export function traceCodexIngest(
  threadId: string,
  method: string | undefined,
  params: Record<string, unknown> | undefined,
  events: readonly AgentEvent[],
): void {
  if (!isCodexTraceEnabled()) return;
  logger.info("Codex trace ingest", {
    threadId,
    method: method ?? "",
    raw: summarizeCodexNotificationParams(method ?? "", params),
    mapped: summarizeAgentEventsForTrace(events),
    mappedCount: events.length,
  });
}
