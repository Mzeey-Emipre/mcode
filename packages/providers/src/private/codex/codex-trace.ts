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

  if (!params || typeof params !== "object") {
    return { ...ids, paramKeys: [] };
  }
  const baseKeys = Object.keys(params).filter((k) => k !== "item").slice(0, 20);

  if (method === "item/completed") {
    const item = params.item as Record<string, unknown> | undefined;
    const itemType = typeof item?.type === "string" ? item.type : undefined;
    const itemId = typeof item?.id === "string" ? item.id : undefined;
    const toolKind =
      typeof item?.toolKind === "string"
        ? item.toolKind
        : typeof item?.tool_kind === "string"
          ? item.tool_kind
          : undefined;
    const name = typeof item?.name === "string" ? item.name : undefined;
    return {
      ...ids,
      itemType,
      itemId,
      toolKind,
      functionName: name,
    };
  }

  if (
    method === "item/reasoning/textDelta"
    || method === "item/reasoning/summaryTextDelta"
    || method === "item/plan/delta"
    || method === "item/agentMessage/delta"
  ) {
    const rawDelta =
      typeof params.delta === "string"
        ? params.delta
        : typeof params.text === "string"
          ? params.text
          : "";
    return {
      ...ids,
      deltaLen: rawDelta.length,
      deltaPreview: rawDelta.length > 0 ? previewText(rawDelta, 64) : "",
    };
  }

  if (method === "item/started") {
    const item = params.item as Record<string, unknown> | undefined;
    return {
      ...ids,
      itemType: typeof item?.type === "string" ? item.type : undefined,
      itemId: typeof item?.id === "string" ? item.id : undefined,
    };
  }

  if (method === "turn/completed" || method === "turn/started") {
    const turn = params.turn as Record<string, unknown> | undefined;
    return {
      ...ids,
      turnId: typeof turn?.id === "string" ? turn.id : undefined,
      status: typeof turn?.status === "string" ? turn.status : undefined,
    };
  }

  if (method === "mcpServer/startupStatus/updated") {
    return {
      ...ids,
      name: typeof params.name === "string" ? params.name : undefined,
      status: typeof params.status === "string" ? params.status : undefined,
      errorPreview: typeof params.error === "string" ? previewDiagnostic(params.error) : undefined,
      failureReasonPreview:
        typeof params.failureReason === "string" ? previewDiagnostic(params.failureReason) : undefined,
    };
  }

  return { ...ids, paramKeys: baseKeys };
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
