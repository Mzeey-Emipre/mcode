import * as NodeCrypto from "node:crypto";
import type { z } from "zod";
import type { codexNoticeSchemas } from "./codex-notification-validation.js";
import { AgentEventType, type AgentEvent, type SystemNoticeMetadata } from "@mcode/contracts";
import type { CodexNotification } from "./codex-types.js";

type NoticeEvent = Extract<AgentEvent, { type: "system" }>;
const bound = (value: string, limit = 1_000): string => value.slice(0, limit);
const key = (parts: unknown[]): string => NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function worldWritableMessage(p: z.infer<typeof codexNoticeSchemas["windows/worldWritableWarning"]>): string {
  const paths = p.samplePaths.slice(0, 3).map((path) => bound(path, 200)).join(", ");
  const finding = p.failedScan ? "Codex could not complete the world-writable workspace scan." : "Codex found world-writable workspace paths.";
  return `${finding}${paths ? ` Affected paths: ${paths}.` : ""}${p.extraCount ? ` Additional paths: ${Math.min(p.extraCount, 1_000_000)}.` : ""}`;
}

function configLocation(p: z.infer<typeof codexNoticeSchemas.configWarning>): Partial<SystemNoticeMetadata> {
  const range = p.range && Object.values(p.range).every((point) => point.line <= 1_000_000 && point.column <= 1_000_000) ? p.range : undefined;
  return {
    ...(p.path != null ? { configPath: bound(p.path, 1_024) } : {}),
    ...(range ? { configRange: { startLine: range.start.line, startColumn: range.start.column, endLine: range.end.line, endColumn: range.end.column } } : {}),
  };
}

function summaryWithDetails(p: { summary: string; details?: string | null }): string {
  return `${bound(p.summary, 700)}${p.details ? ` ${bound(p.details, 299)}` : ""}`;
}

/** Projects a validated native notice into bounded provider-neutral fields. */
export function mapCodexNotice(notification: CodexNotification, threadId: string, sessionId: string): NoticeEvent | undefined {
  if (notification.unrecognized) return undefined;
  const method = notification.method;
  function notice(kind: SystemNoticeMetadata["kind"], message: string, extra: Partial<SystemNoticeMetadata> = {}): NoticeEvent {
    const scope = kind === "configuration" || kind === "deprecation" ? "session" : "turn";
    return { type: AgentEventType.System, threadId, subtype: `provider.notice.${kind}`, message: bound(message), systemNotice: {
      kind, scope, presentation: kind === "model-rerouted" ? "toast" : "timeline", sessionId,
      noticeKey: key([sessionId, method, message, extra]), ...extra,
    } };
  }
  switch (notification.method) {
    case "warning": {
      const p = notification.params;
      return notice("warning", p.message);
    }
    case "guardianWarning": {
      const p = notification.params;
      return notice("security", p.message);
    }
    case "windows/worldWritableWarning": {
      return notice("security", worldWritableMessage(notification.params));
    }
    case "model/rerouted": {
      const p = notification.params;
      const fromModel = bound(p.fromModel, 128);
      const toModel = bound(p.toModel, 128);
      // The sole upstream reason is a safety reroute, not availability fallback.
      return notice("model-rerouted", `Codex rerouted this turn from ${fromModel} to ${toModel} due to a high-risk cyber safety check.`, {
        fromModel, toModel, reason: "safety", noticeKey: key([sessionId, method, p.turnId]),
      });
    }
    case "configWarning": {
      const p = notification.params;
      return notice("configuration", summaryWithDetails(p), configLocation(p));
    }
    case "deprecationNotice": {
      const p = notification.params;
      return notice("deprecation", summaryWithDetails(p));
    }
    case "modelProvider/authRecoveryCompleted": {
      const p = notification.params;
      return notice("authentication-recovered", `${bound(p.provider, 128)}: ${bound(p.message, 870)}`, { noticeKey: key([sessionId, method, p.turnId, p.provider]) });
    }
    default: return undefined;
  }
}
