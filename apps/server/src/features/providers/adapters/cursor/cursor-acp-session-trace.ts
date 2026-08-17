/**
 * Redacts and summarizes Cursor ACP `session/update` traffic for troubleshooting
 * when `provider.cursor.traceSessionUpdates` is enabled (see `cursor-provider`).
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";

/** Long strings inside rawInput/rawOutput swamp logs; truncate with a footprint note. */
const MAX_TRACE_CHARS = 2_048;
/** Arrays longer than this are summarized with `{ head, omitted }`. */
const MAX_TRACE_ARRAY_ITEMS = 40;
const MAX_SUMMARY_DEPTH = 8;

/**
 * Produce a structured JSON-safe blob for server logs without huge payloads.
 *
 * @param value Arbitrary Cursor / ACP JSON shape.
 */
export function sanitizeCursorTraceValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_SUMMARY_DEPTH) return "[max-depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;

  if (typeof value === "string") {
    if (value.length <= MAX_TRACE_CHARS) return value;
    return `${value.slice(0, MAX_TRACE_CHARS)}... (${value.length} chars total)`;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_TRACE_ARRAY_ITEMS) {
      return {
        head: value.slice(0, MAX_TRACE_ARRAY_ITEMS).map((x) =>
          sanitizeCursorTraceValue(x, depth + 1),
        ),
        omitted: value.length - MAX_TRACE_ARRAY_ITEMS,
      };
    }
    return value.map((x) => sanitizeCursorTraceValue(x, depth + 1));
  }

  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = sanitizeCursorTraceValue(v, depth + 1);
    return out;
  }

  return String(value);
}

/**
 * Narrow `SessionNotification` to the fields most useful when comparing Cursor
 * output to `mapCursorAcpSessionNotification` emissions.
 *
 * @param notification Inbound Cursor ACP session notification envelope.
 */
export function summarizeCursorSessionNotification(
  notification: SessionNotification,
): Record<string, unknown> {
  return sanitizeCursorTraceValue({
    sessionId: notification.sessionId,
    update: notification.update,
  }) as Record<string, unknown>;
}

/**
 * One log line worth of shape per outbound `AgentEvent` after Cursor mapping.
 *
 * @param events Events already mapped for the websocket pipeline.
 */
export function summarizeEmittedAgentEventsForTrace(events: AgentEvent[]): Record<string, unknown>[] {
  return events.map((ev) => {
    switch (ev.type) {
      case AgentEventType.ToolUse:
        return {
          type: ev.type,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          parentToolCallId: ev.parentToolCallId,
          toolInputKeys: Object.keys(ev.toolInput ?? {}).slice(0, 48),
          toolInputSize: Object.keys(ev.toolInput ?? {}).length,
        };
      case AgentEventType.ToolResult:
        return {
          type: ev.type,
          toolCallId: ev.toolCallId,
          isError: ev.isError,
          outputChars: typeof ev.output === "string" ? ev.output.length : 0,
        };
      case AgentEventType.System:
        return { type: ev.type, subtype: ev.subtype };
      case AgentEventType.TextDelta:
        return { type: ev.type, deltaChars: ev.delta?.length ?? 0 };
      case AgentEventType.ToolInputDelta:
        return {
          type: ev.type,
          partialChars: typeof ev.partialJson === "string" ? ev.partialJson.length : 0,
        };
      case AgentEventType.ToolProgress:
        return {
          type: ev.type,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          elapsedSeconds: ev.elapsedSeconds,
        };
      case AgentEventType.Message:
        return {
          type: ev.type,
          contentChars: typeof ev.content === "string" ? ev.content.length : 0,
          tokens: ev.tokens ?? null,
        };
      case AgentEventType.ContextEstimate:
        return { type: ev.type, tokensIn: ev.tokensIn, contextWindow: ev.contextWindow };
      case AgentEventType.CompactSummary:
        return {
          type: ev.type,
          summaryChars: typeof ev.summary === "string" ? ev.summary.length : 0,
        };
      case AgentEventType.TurnStarted:
      case AgentEventType.TurnComplete:
      case AgentEventType.Ended:
      case AgentEventType.Error:
      case AgentEventType.Compacting:
      case AgentEventType.ModelFallback:
      case AgentEventType.QuotaUpdate:
      case AgentEventType.ProviderUnavailable:
      case AgentEventType.RateLimited:
      case AgentEventType.ApiRetry:
      case AgentEventType.HookStarted:
      case AgentEventType.HookProgress:
      case AgentEventType.HookCompleted:
        return { type: ev.type };
      default:
        return { type: (ev as { type?: string }).type ?? "unknown" };
    }
  });
}

/**
 * Decide whether tracing should persist for one inbound Cursor envelope.
 *
 * @param notification Handed straight from Cursor ACP.
 * @param emittedEventsCount Mapped event count (`mapCursorAcpSessionNotification` output length).
 */
export function shouldEmitCursorSessionTrace(
  notification: SessionNotification,
  emittedEventsCount: number,
): boolean {
  const kind = notification.update.sessionUpdate;
  if (kind === "agent_message_chunk") return false;
  if (emittedEventsCount > 0) return true;
  return (
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "plan" ||
    kind === "agent_thought_chunk"
  );
}
