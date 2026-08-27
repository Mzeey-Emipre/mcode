import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Client,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent, PermissionDecision, PermissionRequest } from "@mcode/contracts";
import type { CursorProviderPorts } from "../../../factory-types.js";
import { buildCursorAskQuestionExtResponse } from "./cursor-acp-ask-question.js";
import {
  mapDecisionToAcpOutcome,
  pickFullAccessAllowOption,
  synthesizeCursorAcpPermissionRequest,
} from "./cursor-acp-permission-mapper.js";
import {
  shouldEmitCursorSessionTrace,
  summarizeCursorSessionNotification,
  summarizeEmittedAgentEventsForTrace,
} from "./cursor-acp-session-trace.js";
import { cursorTaskExtToAgentEvents } from "./cursor-acp-task.js";
import { extractCursorCreatePlanMarkdown } from "./cursor-create-plan.js";
import { mapCursorAcpSessionNotification } from "./cursor-acp-event-mapper.js";
import { cursorUpdateTodosExtNotificationToAgentEvents } from "../events/cursor-todo-snapshot.js";
import type { CursorAcpSessionEntry } from "../cursor-session-state.js";

const UNSUPPORTED_RESULT = Object.freeze({ outcome: { outcome: "unsupported" as const } });

type AcpExtMethodResponse = Awaited<ReturnType<NonNullable<Client["extMethod"]>>>;

interface PendingAcpPermission {
  mcodeSessionId: string;
  threadId: string;
  options: PermissionOption[];
  request: PermissionRequest;
  resolve: (value: RequestPermissionResponse) => void;
}

/** Supplies host-facing effects for the ACP client bridge. */
export interface CursorAcpClientBridgeDeps {
  settings: CursorProviderPorts["settings"];
  publishEvent: (entry: CursorAcpSessionEntry, event: AgentEvent) => void;
  emitPermissionRequest: (request: PermissionRequest) => void;
  emitPermissionResolved: (requestId: string, decision: PermissionDecision) => void;
  emitExitPlanMode: (args: { threadId: string; planMarkdown: string }) => void;
}

/** Bridges ACP callbacks to Mcode events, permissions, and workspace file access. */
export class CursorAcpClientBridge {
  private readonly pendingPermissions = new Map<string, PendingAcpPermission>();
  private readonly planQuestionModeThreads = new Set<string>();

  constructor(private readonly deps: CursorAcpClientBridgeDeps) {}

  /** Marks whether a thread should surface Cursor's native questions to the user. */
  setPlanQuestionMode(threadId: string, enabled: boolean): void {
    if (enabled) this.planQuestionModeThreads.add(threadId);
    else this.planQuestionModeThreads.delete(threadId);
  }

  /** Resolves an outstanding Cursor permission request. */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    this.deps.emitPermissionResolved(requestId, decision);
    pending.resolve({ outcome: mapDecisionToAcpOutcome(decision, pending.options) });
    return true;
  }

  /** Lists outstanding permission requests for one thread. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    return [...this.pendingPermissions.values()]
      .filter((pending) => pending.threadId === threadId)
      .map((pending) => pending.request);
  }

  /** Cancels permissions owned by a session that is stopping. */
  cancelPendingForSession(mcodeSessionId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.mcodeSessionId !== mcodeSessionId) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.deps.emitPermissionResolved(requestId, "cancelled");
    }
  }

  /** Cancels every permission request during provider shutdown. */
  cancelAllPending(): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.deps.emitPermissionResolved(requestId, "cancelled");
    }
    this.pendingPermissions.clear();
    this.planQuestionModeThreads.clear();
  }

  /** Creates the ACP client callbacks for one Cursor subprocess. */
  createClient(entry: CursorAcpSessionEntry): Client {
    const emitAcpEvent = (event: AgentEvent): void => {
      this.deps.publishEvent(entry, event);
    };
    return {
      requestPermission: async (request) => this.requestPermission(entry, request),
      sessionUpdate: async (params) => this.deliverSessionUpdate(entry, params),
      readTextFile: async (request) => ({ content: this.readWorkspaceFile(entry.cwd, request.path) }),
      writeTextFile: async (request) => {
        this.writeWorkspaceFile(entry.cwd, request.path, request.content);
        return {};
      },
      extMethod: async (method, params) => this.handleExtMethod(entry, emitAcpEvent, method, params),
      extNotification: async (method, params) => {
        const record = toRecord(params);
        if (method !== "cursor/update_todos" || !record) return;
        for (const event of cursorUpdateTodosExtNotificationToAgentEvents(
          entry.threadId,
          record,
          entry.todoSnapshot,
        )) {
          emitAcpEvent(event);
        }
      },
    };
  }

  private handleExtMethod(
    entry: CursorAcpSessionEntry,
    emitAcpEvent: (event: AgentEvent) => void,
    method: string,
    params: unknown,
  ): AcpExtMethodResponse {
    switch (method) {
      case "cursor/ask_question":
        return this.handleAskQuestionExtMethod(entry, emitAcpEvent, params);
      case "cursor/create_plan":
        return this.handleCreatePlanExtMethod(entry, params);
      case "cursor/task":
        return this.handleTaskExtMethod(entry, emitAcpEvent, params);
      case "cursor/update_todos":
        return this.handleUpdateTodosExtMethod(entry, emitAcpEvent, params);
      default:
        logger.debug("Cursor ACP extMethod unhandled", { threadId: entry.threadId, method });
        return UNSUPPORTED_RESULT;
    }
  }

  private handleAskQuestionExtMethod(
    entry: CursorAcpSessionEntry,
    emitAcpEvent: (event: AgentEvent) => void,
    params: unknown,
  ): AcpExtMethodResponse {
    const cursorPrefs = this.deps.settings.get().provider.cursor;
    const record = toRecord(params) ?? {};
    const autoAnswer =
      !this.planQuestionModeThreads.has(entry.threadId) && cursorPrefs.autoAnswerAskQuestions;
    return buildCursorAskQuestionExtResponse(record, autoAnswer, (summary) => {
      logger.info("Cursor ask_question resolved automatically", {
        threadId: entry.threadId,
        detail: summary.lines,
      });
      if (!cursorPrefs.echoAskQuestionsToTimeline) return;
      const clip = summary.lines.join(" · ").slice(0, 900);
      emitAcpEvent({
        type: AgentEventType.System,
        threadId: entry.threadId,
        subtype: `cursor:ask_question:auto:${clip}`,
      } satisfies AgentEvent);
    });
  }

  private handleCreatePlanExtMethod(
    entry: CursorAcpSessionEntry,
    params: unknown,
  ): AcpExtMethodResponse {
    const record = toRecord(params) ?? {};
    const planMarkdown = extractCursorCreatePlanMarkdown(record);
    if (planMarkdown) {
      this.deps.emitExitPlanMode({ threadId: entry.threadId, planMarkdown });
    } else {
      logger.warn("cursor/create_plan missing plan markdown", {
        threadId: entry.threadId,
        keys: Object.keys(record),
      });
    }
    return { outcome: { outcome: "accepted" } };
  }

  private handleTaskExtMethod(
    entry: CursorAcpSessionEntry,
    emitAcpEvent: (event: AgentEvent) => void,
    params: unknown,
  ): AcpExtMethodResponse {
    const record = toRecord(params);
    if (!entry.activeTurnState || !record) return UNSUPPORTED_RESULT;
    for (const event of cursorTaskExtToAgentEvents(entry.threadId, record, entry.activeTurnState)) {
      emitAcpEvent(event);
    }
    return {};
  }

  private handleUpdateTodosExtMethod(
    entry: CursorAcpSessionEntry,
    emitAcpEvent: (event: AgentEvent) => void,
    params: unknown,
  ): AcpExtMethodResponse {
    const record = toRecord(params);
    if (!record) return UNSUPPORTED_RESULT;
    for (const event of cursorUpdateTodosExtNotificationToAgentEvents(
      entry.threadId,
      record,
      entry.todoSnapshot,
    )) {
      emitAcpEvent(event);
    }
    return {};
  }

  /** Handles a protocol permission request for one live Cursor session. */
  async requestPermission(
    entry: CursorAcpSessionEntry,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (entry.permissionMode === "full") {
      const optionId = pickFullAccessAllowOption(params.options);
      return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
    }

    const requestId = randomUUID();
    const toolTitle = typeof params.toolCall.title === "string" ? params.toolCall.title : "Tool";
    const request = synthesizeCursorAcpPermissionRequest({
      requestId,
      threadId: entry.threadId,
      toolTitle,
      rawToolInput: params.toolCall.rawInput,
    });
    return await new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        mcodeSessionId: entry.mcodeSessionId,
        threadId: entry.threadId,
        options: params.options,
        request,
        resolve,
      });
      queueMicrotask(() => this.deps.emitPermissionRequest(request));
    });
  }

  /** Maps an ACP session notification only while its originating turn is active. */
  async deliverSessionUpdate(
    entry: CursorAcpSessionEntry,
    params: SessionNotification,
  ): Promise<void> {
    if (!entry.acpSessionId || params.sessionId !== entry.acpSessionId || !entry.activeTurnState) return;
    const mapped = mapCursorAcpSessionNotification(
      params,
      entry.threadId,
      entry.activeTurnState,
      entry.todoSnapshot,
    );
    const cursorCfg = this.deps.settings.get().provider.cursor;
    if (cursorCfg.traceSessionUpdates && shouldEmitCursorSessionTrace(params, mapped.length)) {
      logger.info("Cursor ACP session/update trace", {
        threadId: entry.threadId,
        mappedCount: mapped.length,
        notification: summarizeCursorSessionNotification(params),
        mappedEvents: summarizeEmittedAgentEventsForTrace(mapped),
      });
    }
    for (const event of mapped) {
      this.deps.publishEvent(entry, event);
    }
  }

  /** Reads a UTF-8 file only when its resolved path stays inside the workspace. */
  readWorkspaceFile(cwd: string, filePath: string): string {
    const root = path.resolve(cwd);
    const resolved = path.resolve(root, filePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return "";
    try {
      return existsSync(resolved) ? readFileSync(resolved, "utf-8") : "";
    } catch {
      return "";
    }
  }

  /** Writes a UTF-8 file only when its resolved path stays inside the workspace. */
  writeWorkspaceFile(cwd: string, filePath: string, content: string): void {
    const root = path.resolve(cwd);
    const resolved = path.resolve(root, filePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("Path outside workspace root");
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, content, "utf-8");
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
