import { createHash, randomUUID } from "crypto";
import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type {
  AgentEvent,
  CodexChildEvidence,
  CodexCollaborationEvidence,
  CodexContinuationEvidence,
  GoalState,
  ProviderFileMutationStart,
  ProviderRuntimeEvent,
} from "@mcode/contracts";
import {
  BoundedToolOutputBuffer,
  boundToolOutput,
  type BoundedToolOutputResult,
} from "../../bounded-tool-output.js";
import type {
  CodexNotification,
  CompletedItem,
  McpServerStartupStatus,
  ThreadGoal,
  ThreadSettingsUpdatedPayload,
} from "./codex-types.js";

type CodexMappedEvent = AgentEvent & {
  codexChild?: CodexChildEvidence;
  codexContinuation?: CodexContinuationEvidence;
};
type ToolResultAgentEvent = Extract<CodexMappedEvent, { type: typeof AgentEventType.ToolResult }>;
type ChildNotificationContext = {
  childThreadId: string | undefined;
  parentCollaborationItemId: string | undefined;
  nativeTurnId: string | undefined;
};

/** Notification methods that produce no agent events (module-level to avoid per-call allocation). */
const SILENCED_METHODS = new Set([
  "turn/diff/updated",
  "skills/changed", "model/rerouted",
  "deprecationNotice", "configWarning",
  "item/fileChange/outputDelta",
  "item/autoApprovalReview/started", "item/autoApprovalReview/completed",
  "item/mcpToolCall/progress",
  "remoteControl/status/changed",
  // Observed against codex-cli 0.130.0; see docs/guides/codex-app-server-trace.md
  "thread/started", "thread/status/changed",
  "account/rateLimits/updated", "thread/tokenUsage/updated",
]);

/** Item types from item/completed that produce no agent events (module-level to avoid per-call allocation). */
const SILENT_ITEM_TYPES = new Set([
  "webSearch", "plan", "imageView", "imageGeneration",
  "contextCompaction", "enteredReviewMode", "exitedReviewMode",
]);

/**
 * Maps raw JSON-RPC 2.0 notifications from the Codex app-server into
 * strongly-typed `AgentEvent` objects consumed by the rest of the mcode system.
 *
 * Handles the actual notification protocol from codex app-server >= 0.104.0.
 * Source: codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts
 *
 * Tool lifecycle: `item/started` emits a running tool row when Codex gives us
 * a stable item id, even if the payload is sparse. `item/completed` enriches
 * that row with full input details and emits the matching result.
 *
 * Subagent nesting: `item/started` for `spawnAgent` collabs emits the `Agent`
 * tool row early, but the spawn item's own completion is suppressed because it
 * only means the child thread was created. The row completes from the child
 * thread's `turn/completed`, or from `wait`'s per-child `agentsStates`,
 * whichever arrives first. `wait` itself is parent-thread plumbing and never
 * emits a row. Parent turn completion does not synthesize sub-agent results;
 * some rejected spawn attempts have no receiver thread and no later completion.
 * Child tools on the parent thread use `collabScopeStack` (single open collab
 * only; parallel collabs omit stack peek to avoid mis-attribution). Child tools
 * on Codex receiver threads use `receiverThreadIds` from completed `spawnAgent`
 * collabs mapped to the collab item id.
 *
 * Thinking stream: `item/reasoning/*` plus experimental `item/plan/delta` map to non-final
 * text deltas (`AgentEventType.TextDelta` with `isFinalResponse: false`) so the UI can show thought segments.
 *
 * Assistant text classification: Codex does not expose a stop reason. The mapper
 * streams every assistant message as narration and retroactively promotes only
 * the last assistant item to the final reply when the main turn completes.
 */
/** Item types that appear as user-visible tools in the narrative. */
const TOOL_LIKE_ITEM_TYPES = new Set([
  "commandExecution", "mcpToolCall", "dynamicToolCall",
  "fileChange", "collabAgentToolCall", "function_call", "webSearch",
]);

const CODEX_TASK_NAME_LINE = /^task_name:\s*([a-z0-9_]{1,96})$/i;
const CODEX_NAMED_CHILD_PROMPT = /^You are the child agent named ([a-z0-9_]{1,96})\.(?:\s|$)/i;

const FALLBACK_ASSISTANT_ITEM_ID = "__codex_assistant_message__";
const MAX_EARLY_CHILD_THREADS = 8;
const MAX_EARLY_CHILD_NOTIFICATIONS = 64;
const MAX_RETAINED_CHILD_THREADS = 32;
const SUBAGENT_LIFECYCLE_TOOL_NAME = "__McodeSubagentLifecycle";
const MAX_LIFECYCLE_PARENT_ID_LENGTH = 128;

function dispatchNativeHandler<T>(handlers: object, key: unknown): T | undefined {
  if (typeof key !== "string" || !Object.hasOwn(handlers, key)) return undefined;
  const handler = (handlers as Record<string, unknown>)[key];
  return typeof handler === "function" ? (handler as () => T)() : undefined;
}

const EARLY_CHILD_FILE_TOOL_NAMES = new Set([
  "apply_patch", "create", "delete", "edit", "move", "remove", "rename",
  "searchreplace", "strreplace", "write",
]);

/** Maps Codex app-server notifications into Mcode agent events. */
export class CodexEventMapper {
  /** Main-thread assistant text buffers keyed by Codex item id. */
  private readonly assistantTextByItemId = new Map<string, string>();
  /** The assistant item currently receiving streamed text. */
  private currentAssistantItemId: string | undefined;
  /** Text for the current assistant item, used when old Codex builds omit item ids. */
  private currentAssistantItemText = "";
  /** Last completed assistant item on the main Codex thread. Promoted on turn completion. */
  private lastCompletedAssistantText = "";
  /** Held assistant-message boundary waiting for one-event lookahead. */
  private pendingAssistantBoundaryItemId: string | undefined;
  /** Dedupes `item/completed` reasoning payloads against streamed reasoning deltas. */
  private lastReasoningText = "";
  /** Per-turn sequence for synthetic update_plan tool calls from turn/plan/updated. */
  private planUpdateSeq = 0;
  private readonly threadId: string;
  /** Codex app-server's own main thread id. Distinct from Mcode's persisted thread UUID. */
  private mainCodexThreadId: string | undefined;
  /** Per-item streaming command output buffers, keyed by itemId. */
  private readonly commandOutputBuffers = new Map<string, BoundedToolOutputBuffer>();
  /** Start-time ToolUse signatures, so completion enrichment only emits when details changed. */
  private readonly startedToolUseSignatures = new Map<string, string>();
  /**
   * Open `collabAgentToolCall` item ids (LIFO). `item/started` pushes;
   * `item/completed` for the same collab pops. Nested collabs are supported.
   * Child tool rows use `parentToolCallId` = stack peek so the narrative nests them.
   */
  private collabScopeStack: string[] = [];
  /** Collab ids for which `item/started` already emitted `ToolUse` (completion emits `ToolResult` only). */
  private collabToolUseFromStartIds = new Set<string>();
  /** Agent row ids emitted during this turn, retained across representation-specific lifecycle completion. */
  private emittedAgentToolUseIds = new Set<string>();
  /** Spawn-agent rows with a known receiver thread that have not received child completion yet. */
  private openSpawnAgentIds = new Set<string>();
  /** Spawn-agent rows already completed by child turn completion or wait state. */
  private completedSpawnAgentIds = new Set<string>();
  /** Completed spawn results retained for late metadata-only updates. */
  private completedSpawnAgentResults = new Map<string, ToolResultAgentEvent>();
  /** Late metadata for spawned Agent rows, keyed by parent collab item id. */
  private spawnAgentToolInputById = new Map<string, Record<string, unknown>>();
  /** Authoritative Codex child-thread model metadata, keyed by child thread id. */
  private childThreadMetadataById = new Map<string, Record<string, string>>();
  /** Parent Agent rows for nested native sub-agents, keyed by child Agent row id. */
  private parentAgentToolCallIdById = new Map<string, string>();
  /** Native evidence for nested spawn Agent rows, used when their receiver turn completes. */
  private readonly childSpawnEvidenceByCollabId = new Map<string, CodexChildEvidence>();
  /** Private assistant text streamed by Codex child threads, keyed by child thread id. */
  private childAssistantTextByThreadId = new Map<string, BoundedToolOutputBuffer>();
  /** Native assistant item ids used to give completed child messages structural identity. */
  private childAssistantItemIdByThreadId = new Map<string, string>();
  /** Parent follow-up prompts waiting for the next turn on an existing child thread. */
  private pendingChildPromptByThreadId = new Map<string, string>();
  /** Native child turn ids learned from exact turn-start evidence. */
  private childTurnIdByThreadId = new Map<string, string>();
  /** Suppresses duplicate native child turn-start notifications. */
  private readonly emittedChildTurnStarts = new Set<string>();
  /** Suppresses duplicate child semantic events across mapper replay paths. */
  private readonly emittedChildNativeEventIds = new Set<string>();
  /** Suppresses repeated native child notifications before semantic mapping. */
  private readonly seenChildNativeNotificationKeys = new Set<string>();
  /** Forces streamed output through artifact spooling during memory pressure. */
  private forceOutputArtifacts = false;
  /**
   * Collab ids pushed onto the stack via the legacy path (`item/completed`
   * arrived without a prior `item/started`). These need to be popped once the
   * coordinator moves on, otherwise tool calls that fire AFTER the legacy
   * collab's children still incorrectly attach to it.
   */
  private pendingLegacyCollabPops = new Set<string>();
  /**
   * Maps Codex child thread ids (`receiverThreadIds` from `spawnAgent` collabs) to the
   * parent-thread `collabAgentToolCall` item id so shell/file tools on child threads nest
   * under the correct Agent row even when multiple sub-agents run in parallel.
   */
  private collabReceiverThreadToCollabId = new Map<string, string>();
  /** Receiver ids present at item start require exact child-turn binding before routing. */
  private readonly strictChildTurnThreads = new Set<string>();
  /** Shared bounded retention order for child routing and exact turn evidence. */
  private readonly retainedChildThreadIds = new Map<string, null>();
  /** Bounded mutation/collab notifications received before spawn receiver metadata. */
  private earlyChildNotificationsByThread = new Map<string, CodexNotification[]>();
  private earlyChildNotificationCount = 0;
  /** Bounded child items held until the receiver reports an exact native turn id. */
  private readonly childNotificationsBeforeTurnByThread = new Map<string, CodexNotification[]>();
  private childNotificationsBeforeTurnCount = 0;
  /** Child events replayed while the current main-thread notification registers receivers. */
  private replayedChildEvents: CodexMappedEvent[] = [];
  /** Monotonic sequence that keeps repeated native subagent interactions distinct. */
  private subagentInteractionSequence = 0;
  /**
   * True once `turn/completed` fired but before the next turn's `turn/started`.
   * While this is set we suppress all event emission so trailing notifications
   * (late `item/reasoning/*`, late `item/agentMessage/delta`) can't keep the
   * thinking timeline scrolling after the turn footer says "done".
   */
  private turnEnded = false;

  constructor(
    threadId: string,
    mainCodexThreadId?: string,
    private readonly onPendingMutationStart?: (event: ProviderFileMutationStart) => void,
  ) {
    this.threadId = threadId;
    this.mainCodexThreadId = mainCodexThreadId;
  }

  /** Updates the app-server thread id used to classify incoming notifications. */
  setMainCodexThreadId(threadId: string): void {
    this.mainCodexThreadId = threadId;
  }

  /** Reports whether a native thread was structurally registered by a Codex collaboration item. */
  hasReceiverThread(threadId: string): boolean {
    return this.collabReceiverThreadToCollabId.has(threadId);
  }

  /** Enables or disables artifact-first buffering for future output chunks. */
  setOutputTruncationMode(enabled: boolean): void {
    this.forceOutputArtifacts = enabled;
    for (const buffer of this.commandOutputBuffers.values()) {
      buffer.setForceArtifact(enabled);
    }
    for (const buffer of this.childAssistantTextByThreadId.values()) {
      buffer.setForceArtifact(enabled);
    }
  }

  private commandOutputBuffer(toolCallId: string): BoundedToolOutputBuffer {
    let buffer = this.commandOutputBuffers.get(toolCallId);
    if (!buffer) {
      buffer = new BoundedToolOutputBuffer(this.threadId, toolCallId, {
        forceArtifact: this.forceOutputArtifacts,
      });
      this.commandOutputBuffers.set(toolCallId, buffer);
    }
    return buffer;
  }

  private childAssistantBuffer(childThreadId: string): BoundedToolOutputBuffer {
    let buffer = this.childAssistantTextByThreadId.get(childThreadId);
    if (!buffer) {
      const collabId = this.collabReceiverThreadToCollabId.get(childThreadId) ?? childThreadId;
      buffer = new BoundedToolOutputBuffer(this.threadId, collabId, {
        forceArtifact: this.forceOutputArtifacts,
      });
      this.childAssistantTextByThreadId.set(childThreadId, buffer);
    }
    return buffer;
  }

  private boundedOutput(
    toolCallId: string,
    output: string | BoundedToolOutputBuffer | undefined,
    fallback = "",
  ): BoundedToolOutputResult {
    if (output instanceof BoundedToolOutputBuffer) {
      return output.finalize(fallback);
    }
    return boundToolOutput({
      threadId: this.threadId,
      toolCallId,
      output: output ?? fallback,
      forceArtifact: this.forceOutputArtifacts,
    });
  }

  private toolResultEvent(args: {
    toolCallId: string;
    output: string | BoundedToolOutputBuffer | undefined;
    isError: boolean;
    exitCode?: number;
    toolInput?: Record<string, unknown>;
    fallback?: string;
  }): ToolResultAgentEvent {
    const bounded = this.boundedOutput(args.toolCallId, args.output, args.fallback);
    return {
      type: AgentEventType.ToolResult,
      threadId: this.threadId,
      toolCallId: args.toolCallId,
      output: bounded.output,
      isError: args.isError,
      ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
      ...(bounded.outputTruncated
        ? {
            outputTruncated: true,
            outputTotalBytes: bounded.outputTotalBytes,
            outputArtifactPath: bounded.outputArtifactPath,
          }
        : {}),
      ...(args.toolInput && Object.keys(args.toolInput).length > 0 ? { toolInput: args.toolInput } : {}),
    };
  }

  /** Reads `params.threadId` from a Codex notification when present. */
  private notificationThreadId(notification: CodexNotification): string | undefined {
    const tid = (notification.params as { threadId?: unknown }).threadId;
    return typeof tid === "string" && tid.length > 0 ? tid : undefined;
  }

  private nativeTurnId(notification: CodexNotification): string | undefined {
    const params = notification.params as Record<string, unknown>;
    const turn = params.turn;
    if (turn && typeof turn === "object") {
      const id = (turn as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) return id;
    }
    const id = params.turnId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }

  private bufferedChildTurnId(childThreadId: string | undefined): string | undefined {
    return childThreadId ? this.childTurnIdByThreadId.get(childThreadId) : undefined;
  }

  private withChildEvidence(
    events: CodexMappedEvent[],
    evidence: CodexChildEvidence,
  ): CodexMappedEvent[] {
    const attributed = events.map((event) => ({
      ...event,
      codexChild: {
        ...evidence,
        nativeEventId: this.childNativeEventId(event.type, evidence),
      },
    } as CodexMappedEvent));
    for (const event of attributed) {
      if (
        event.type === AgentEventType.ToolUse
        && event.toolName === "Agent"
        && event.toolInput?.codexCollabKind === "spawnAgent"
      ) {
        this.rememberChildSpawnEvidence(event.toolCallId, evidence);
      }
    }
    return attributed;
  }

  /** Captures nested spawn attribution before receiver registration can replay buffered child events. */
  private rememberChildSpawnEvidence(collabId: string, evidence: CodexChildEvidence | undefined): void {
    if (evidence) this.childSpawnEvidenceByCollabId.set(collabId, evidence);
  }

  /** Derives nested spawn attribution from the exact native child receiver that emitted it. */
  private childSpawnEvidenceFromNotification(
    notification: CodexNotification | undefined,
    nativeItemId: string,
    itemEventKey: string,
  ): CodexChildEvidence | undefined {
    if (!notification) return undefined;
    const nativeThreadId = this.notificationThreadId(notification);
    const parentCollaborationItemId = nativeThreadId
      ? this.collabReceiverThreadToCollabId.get(nativeThreadId)
      : undefined;
    if (!nativeThreadId || !parentCollaborationItemId) return undefined;
    const nativeTurnId = this.bufferedChildTurnId(nativeThreadId) ?? this.nativeTurnId(notification);
    return {
      nativeThreadId,
      ...(nativeTurnId ? { nativeTurnId } : {}),
      parentCollaborationItemId,
      nativeItemId,
      itemEventKey,
    };
  }

  private childNativeEventId(
    eventType: string,
    evidence: {
      nativeThreadId: string;
      nativeTurnId?: string;
      parentCollaborationItemId: string;
      nativeItemId?: string;
      itemEventKey?: string;
    },
  ): string {
    const structuralEvidence = JSON.stringify([
      eventType,
      evidence.nativeThreadId,
      evidence.nativeTurnId ?? "",
      evidence.parentCollaborationItemId,
      evidence.nativeItemId ?? "",
      evidence.itemEventKey ?? "",
    ]);
    return `codex-child:${createHash("sha256").update(structuralEvidence).digest("hex")}`;
  }

  private dedupeChildEvents(events: CodexMappedEvent[]): CodexMappedEvent[] {
    const deduped: CodexMappedEvent[] = [];
    for (const event of events) {
      if (!("codexChild" in event) || !event.codexChild?.nativeEventId) {
        deduped.push(event);
        continue;
      }
      const eventId = event.codexChild.nativeEventId;
      if (this.emittedChildNativeEventIds.has(eventId)) continue;
      this.emittedChildNativeEventIds.add(eventId);
      while (this.emittedChildNativeEventIds.size > MAX_EARLY_CHILD_NOTIFICATIONS * 2) {
        const oldest = this.emittedChildNativeEventIds.values().next().value as string | undefined;
        if (!oldest) break;
        this.emittedChildNativeEventIds.delete(oldest);
      }
      deduped.push(event);
    }
    return deduped;
  }

  private childNativeNotificationKey(notification: CodexNotification): string | undefined {
    const childThreadId = this.notificationThreadId(notification);
    if (!childThreadId) return undefined;
    const item = (notification.params as Record<string, unknown>).item as { id?: unknown } | undefined;
    const itemId = typeof item?.id === "string" ? item.id : undefined;
    const nativeTurnId = this.nativeTurnId(notification);
    if (notification.method === "turn/started" || notification.method === "turn/completed") {
      return JSON.stringify([notification.method, childThreadId, nativeTurnId ?? ""]);
    }
    if (itemId) return JSON.stringify([notification.method, childThreadId, nativeTurnId ?? "", itemId]);
    return undefined;
  }

  private markChildNativeNotification(notification: CodexNotification): boolean {
    const key = this.childNativeNotificationKey(notification);
    if (!key) return false;
    if (this.seenChildNativeNotificationKeys.has(key)) return true;
    this.seenChildNativeNotificationKeys.add(key);
    while (this.seenChildNativeNotificationKeys.size > MAX_EARLY_CHILD_NOTIFICATIONS * 2) {
      const oldest = this.seenChildNativeNotificationKeys.values().next().value as string | undefined;
      if (!oldest) break;
      this.seenChildNativeNotificationKeys.delete(oldest);
    }
    return false;
  }

  /** Classifies the notification against the app-server's main and known receiver threads. */
  private classifyNotificationThread(notification: CodexNotification): "main" | "child" | "unknown" {
    const notifThread = this.notificationThreadId(notification);
    if (!notifThread) return "main";
    if (this.collabReceiverThreadToCollabId.has(notifThread)) return "child";
    if (this.mainCodexThreadId) {
      return notifThread === this.mainCodexThreadId ? "main" : "unknown";
    }
    return "main";
  }

  /** Retains only bounded notifications that can establish or report explicit child mutations. */
  private bufferEligibleEarlyChildNotification(notification: CodexNotification): boolean {
    const childThreadId = this.notificationThreadId(notification);
    if (!childThreadId || !this.isEligibleEarlyChildNotification(notification)) return false;
    if (this.markChildNativeNotification(notification)) return true;
    if (this.earlyChildNotificationCount >= MAX_EARLY_CHILD_NOTIFICATIONS) return false;
    let pending = this.earlyChildNotificationsByThread.get(childThreadId);
    if (!pending) {
      if (this.earlyChildNotificationsByThread.size >= MAX_EARLY_CHILD_THREADS) return false;
      pending = [];
      this.earlyChildNotificationsByThread.set(childThreadId, pending);
    }
    pending.push(notification);
    this.earlyChildNotificationCount += 1;
    this.capturePendingMutationStart(notification);
    logger.debug("CodexEventMapper: buffering eligible early child notification", {
      method: notification.method,
      notificationThreadId: childThreadId,
    });
    return true;
  }

  /** Hold structurally attributed child items until exact native turn evidence arrives. */
  private bufferChildNotificationBeforeTurn(notification: CodexNotification): boolean {
    const childThreadId = this.notificationThreadId(notification);
    if (!childThreadId || this.childNotificationsBeforeTurnCount >= MAX_EARLY_CHILD_NOTIFICATIONS) {
      return false;
    }
    let pending = this.childNotificationsBeforeTurnByThread.get(childThreadId);
    if (!pending) {
      if (this.childNotificationsBeforeTurnByThread.size >= MAX_EARLY_CHILD_THREADS) return false;
      pending = [];
      this.childNotificationsBeforeTurnByThread.set(childThreadId, pending);
    }
    pending.push(notification);
    this.childNotificationsBeforeTurnCount += 1;
    return true;
  }

  private drainChildNotificationsBeforeTurn(childThreadId: string): CodexNotification[] {
    const pending = this.childNotificationsBeforeTurnByThread.get(childThreadId) ?? [];
    this.childNotificationsBeforeTurnByThread.delete(childThreadId);
    this.childNotificationsBeforeTurnCount -= pending.length;
    return pending;
  }

  /** Captures file state at an eligible unknown child start without publishing an attributed tool row. */
  private capturePendingMutationStart(notification: CodexNotification): void {
    if (notification.method !== "item/started" || !this.onPendingMutationStart) return;
    const item = notification.params.item as CompletedItem | undefined;
    const itemId = typeof item?.id === "string" ? item.id : undefined;
    if (!item || !itemId || item.type === "collabAgentToolCall") return;
    const toolUse = this.buildToolUseEvent(item, itemId, notification);
    if (!toolUse || toolUse.type !== AgentEventType.ToolUse) return;
    this.onPendingMutationStart({
      threadId: toolUse.threadId,
      toolCallId: toolUse.toolCallId,
      toolName: toolUse.toolName,
      toolInput: toolUse.toolInput,
    });
  }

  private isEligibleEarlyChildNotification(notification: CodexNotification): boolean {
    const { method } = notification;
    if (method === "turn/started" || method === "turn/completed") return true;
    if (method !== "item/started" && method !== "item/completed") return false;
    return this.isEarlyChildMutationItem(notification.params.item as CompletedItem | undefined);
  }

  private isEarlyChildMutationItem(item: CompletedItem | undefined): boolean {
    if (item?.type === "fileChange" || item?.type === "collabAgentToolCall") return true;
    if (item?.type !== "function_call" || typeof item.name !== "string") return false;
    return EARLY_CHILD_FILE_TOOL_NAMES.has(item.name.toLowerCase());
  }

  /** Child receiver threads contribute tool rows only; text and lifecycle stay private to Codex. */
  private mapChildThreadNotification(notification: CodexNotification): CodexMappedEvent[] {
    const childThreadId = this.notificationThreadId(notification);
    this.rememberChildTurnId(notification, childThreadId);
    const context = this.childNotificationContext(notification);
    const handlers: Record<string, () => CodexMappedEvent[]> = {
      "turn/started": () => this.mapChildTurnStarted(context),
      "item/commandExecution/outputDelta": () => this.mapChildCommandOutputDelta(notification),
      "item/agentMessage/delta": () => this.mapChildAssistantDelta(notification, context.childThreadId),
      "item/reasoning/textDelta": () => [],
      "item/reasoning/summaryTextDelta": () => [],
      error: () => this.mapChildError(notification, context),
      "item/started": () => this.mapChildItemStarted(notification, context),
      "item/completed": () => this.mapChildItemCompleted(notification, context),
      "turn/completed": () => this.mapChildTurnCompleted(notification, context),
    };
    const events = dispatchNativeHandler<CodexMappedEvent[]>(handlers, notification.method);
    if (events !== undefined) return events;
    logger.debug("Codex child thread notification consumed", { method: notification.method });
    return [];
  }

  private childNotificationContext(notification: CodexNotification): ChildNotificationContext {
    const childThreadId = this.notificationThreadId(notification);
    return {
      childThreadId,
      parentCollaborationItemId: childThreadId ? this.collabReceiverThreadToCollabId.get(childThreadId) : undefined,
      nativeTurnId: this.bufferedChildTurnId(childThreadId) ?? this.nativeTurnId(notification),
    };
  }

  private rememberChildTurnId(notification: CodexNotification, childThreadId: string | undefined): void {
    const nativeTurnId = this.nativeTurnId(notification);
    if (notification.method !== "turn/started" || !childThreadId || !nativeTurnId) return;
    this.retainChildThread(childThreadId);
    this.childTurnIdByThreadId.set(childThreadId, nativeTurnId);
  }

  private mapChildTurnStarted(context: ChildNotificationContext): CodexMappedEvent[] {
    const { childThreadId, parentCollaborationItemId, nativeTurnId } = context;
    if (!childThreadId || !parentCollaborationItemId || !nativeTurnId) return [];
    const startKey = `${childThreadId}:${nativeTurnId}`;
    if (this.emittedChildTurnStarts.has(startKey)) return [];
    this.emittedChildTurnStarts.add(startKey);
    this.childAssistantTextByThreadId.delete(childThreadId);
    this.childAssistantItemIdByThreadId.delete(childThreadId);
    const prompt = this.childTurnPrompt(childThreadId, parentCollaborationItemId);
    const evidence = { nativeThreadId: childThreadId, nativeTurnId, parentCollaborationItemId };
    const turnStarted: CodexMappedEvent = { type: AgentEventType.TurnStarted, threadId: this.threadId, codexChild: { ...evidence, ...(prompt ? { prompt } : {}), nativeEventId: this.childNativeEventId("turnStarted", evidence) } };
    return [turnStarted, ...this.drainChildNotificationsBeforeTurn(childThreadId).flatMap((pending) => this.mapChildThreadNotification(pending))];
  }

  private childTurnPrompt(childThreadId: string, parentCollaborationItemId: string): string | undefined {
    const prompt = this.pendingChildPromptByThreadId.get(childThreadId) ?? this.stringField(this.spawnAgentToolInputById.get(parentCollaborationItemId) ?? {}, "prompt");
    this.pendingChildPromptByThreadId.delete(childThreadId);
    return prompt;
  }

  private mapChildCommandOutputDelta(notification: CodexNotification): CodexMappedEvent[] {
    const { itemId, delta } = notification.params as { itemId?: string; delta?: string };
    if (itemId && delta) this.commandOutputBuffer(itemId).append(delta);
    return [];
  }

  private mapChildAssistantDelta(notification: CodexNotification, childThreadId: string | undefined): CodexMappedEvent[] {
    const params = notification.params as { itemId?: unknown; delta?: string };
    const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
    if (childThreadId && itemId) this.childAssistantItemIdByThreadId.set(childThreadId, itemId);
    this.appendChildAssistantText(childThreadId, params.delta ?? "");
    return [];
  }

  private mapChildError(notification: CodexNotification, context: ChildNotificationContext): CodexMappedEvent[] {
    const { childThreadId, parentCollaborationItemId, nativeTurnId } = context;
    if (!childThreadId || !parentCollaborationItemId || !nativeTurnId) return [];
    const params = notification.params as { error?: { message?: unknown } };
    const error = typeof params.error?.message === "string" ? params.error.message : "Unknown child error";
    return this.withChildEvidence([{ type: AgentEventType.Error, threadId: this.threadId, error }], { nativeThreadId: childThreadId, nativeTurnId, parentCollaborationItemId, nativeItemId: "turn-error", itemEventKey: "error", outcome: "errored" });
  }

  private mapChildItemStarted(notification: CodexNotification, context: ChildNotificationContext): CodexMappedEvent[] {
    const item = (notification.params as { item?: CompletedItem }).item;
    const itemId = typeof item?.id === "string" ? item.id : undefined;
    if (!item || !itemId) return this.consumeChildItemNotification(notification.method, item?.type);
    if (item.type === "subAgentActivity") return this.withChildNotificationEvidence(this.mapSubAgentActivityStart(item, itemId, true, notification), context, itemId, "started");
    if (item.type === "collabAgentToolCall") return this.mapChildCollabStarted(item, itemId, notification, context);
    return this.mapChildToolStarted(item, itemId, notification, context);
  }

  private mapChildCollabStarted(item: CompletedItem, itemId: string, notification: CodexNotification, context: ChildNotificationContext): CodexMappedEvent[] {
    if (this.isWaitCollab(item)) return [];
    this.rememberPendingChildPrompt(item);
    this.collabToolUseFromStartIds.add(itemId);
    this.prepareChildSpawnStart(item, itemId, notification);
    if (this.emittedAgentToolUseIds.has(itemId)) return [];
    this.emittedAgentToolUseIds.add(itemId);
    return this.withChildNotificationEvidence([this.buildCollabToolUseEvent(item, itemId, notification)], context, itemId, "started");
  }

  private prepareChildSpawnStart(item: CompletedItem, itemId: string, notification: CodexNotification): void {
    if (!this.isSpawnAgentCollab(item)) return;
    this.rememberChildSpawnEvidence(itemId, this.childSpawnEvidenceFromNotification(notification, itemId, "started"));
    this.openSpawnAgentIds.add(itemId);
    if (this.registerCollabReceiverThreads(itemId, item, true) === 0) this.openSpawnAgentIds.delete(itemId);
  }

  private mapChildToolStarted(item: CompletedItem, itemId: string, notification: CodexNotification, context: ChildNotificationContext): CodexMappedEvent[] {
    if (!TOOL_LIKE_ITEM_TYPES.has(item.type) || item.type === "webSearch") return this.consumeChildItemNotification(notification.method, item.type);
    const toolUse = this.buildToolUseEvent(item, itemId, notification);
    if (!toolUse) return this.consumeChildItemNotification(notification.method, item.type);
    this.startedToolUseSignatures.set(itemId, this.toolUseSignature(toolUse));
    return this.withChildNotificationEvidence([toolUse], context, itemId, "started");
  }

  private mapChildItemCompleted(notification: CodexNotification, context: ChildNotificationContext): CodexMappedEvent[] {
    const item = (notification.params as { item?: CompletedItem }).item;
    const itemId = typeof item?.id === "string" ? item.id : undefined;
    if (!item) return this.consumeChildItemNotification(notification.method, undefined);
    if (item.type === "subAgentActivity" && itemId) return this.withChildNotificationEvidence(this.mapSubAgentActivityStart(item, itemId, false, notification), context, itemId, "completed");
    if (this.childCompletedItemMaps(item.type)) return this.withChildNotificationEvidence(this.mapItemCompleted(item, notification, "child"), context, itemId, "completed");
    if (item.type === "agentMessage" || item.type === "message") return this.mergeChildCompletedMessage(item, itemId, context.childThreadId);
    return this.consumeChildItemNotification(notification.method, item.type);
  }

  private childCompletedItemMaps(itemType: CompletedItem["type"]): boolean {
    return new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "function_call", "reasoning", "collabAgentToolCall"]).has(itemType);
  }

  private mergeChildCompletedMessage(item: CompletedItem, itemId: string | undefined, childThreadId: string | undefined): CodexMappedEvent[] {
    if (childThreadId && itemId) this.childAssistantItemIdByThreadId.set(childThreadId, itemId);
    this.mergeChildAssistantFullText(childThreadId, this.completedMessageText(item));
    return [];
  }

  private withChildNotificationEvidence(events: CodexMappedEvent[], context: ChildNotificationContext, nativeItemId: string | undefined, itemEventKey: string): CodexMappedEvent[] {
    const { childThreadId, parentCollaborationItemId, nativeTurnId } = context;
    if (!childThreadId || !parentCollaborationItemId) return events;
    return this.withChildEvidence(events, { nativeThreadId: childThreadId, ...(nativeTurnId ? { nativeTurnId } : {}), parentCollaborationItemId, ...(nativeItemId ? { nativeItemId, itemEventKey } : {}) });
  }

  private consumeChildItemNotification(method: string, itemType: string | undefined): CodexMappedEvent[] {
    logger.debug("Codex child thread notification consumed", { method, itemType });
    return [];
  }

  private mapChildTurnCompleted(notification: CodexNotification, context: ChildNotificationContext): CodexMappedEvent[] {
    const { childThreadId } = context;
    const collabId = childThreadId ? this.collabReceiverThreadToCollabId.get(childThreadId) : undefined;
    const turn = (notification.params as { turn?: { status?: string; error?: { message?: string } } }).turn;
    const output = this.childTurnOutput(childThreadId, turn?.error?.message);
    const completion = this.completeSpawnAgent(collabId, output, turn?.status === "failed");
    if (collabId) this.childSpawnEvidenceByCollabId.delete(collabId);
    return [...this.childTurnCompletionEvents(context, output, turn?.status), ...completion];
  }

  private childTurnOutput(childThreadId: string | undefined, errorMessage: string | undefined): string | BoundedToolOutputBuffer {
    if (!childThreadId) return errorMessage ?? "";
    return this.childAssistantTextByThreadId.get(childThreadId) ?? errorMessage ?? "";
  }

  private childTurnCompletionEvents(context: ChildNotificationContext, output: string | BoundedToolOutputBuffer, status: string | undefined): CodexMappedEvent[] {
    const { childThreadId, parentCollaborationItemId, nativeTurnId } = context;
    if (!childThreadId || !parentCollaborationItemId || !nativeTurnId) return [];
    const childOutput = output instanceof BoundedToolOutputBuffer ? output.retainedText() : output;
    const evidence = { nativeThreadId: childThreadId, nativeTurnId, parentCollaborationItemId, outcome: this.childTurnOutcome(status), nativeItemId: this.childAssistantItemIdByThreadId.get(childThreadId) ?? nativeTurnId, itemEventKey: "completed" } as const;
    const events = childOutput ? this.withChildEvidence([{ type: AgentEventType.Message, threadId: this.threadId, content: childOutput, tokens: null }], evidence) : [];
    return [...events, ...this.withChildEvidence([{ type: AgentEventType.TurnComplete, threadId: this.threadId, reason: this.childTurnReason(status), costUsd: null, tokensIn: 0, tokensOut: 0 }], evidence)];
  }

  private childTurnOutcome(status: string | undefined): "completed" | "errored" | "interrupted" {
    if (status === "failed") return "errored";
    return status === "interrupted" ? "interrupted" : "completed";
  }

  private childTurnReason(status: string | undefined): "completed" | "failed" | "interrupted" {
    if (status === "failed") return "failed";
    return status === "interrupted" ? "interrupted" : "completed";
  }

  /** Convert a native Codex goal into Mcode's provider-neutral goal state. */
  private mapThreadGoal(goal: ThreadGoal, turnId?: string | null): GoalState {
    return {
      threadId: this.threadId,
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      providerId: "codex",
      source: "codex",
      turnId: turnId ?? null,
      controls: {
        canInspect: true,
        canClear: goal.status !== "complete",
      },
    };
  }

  /**
   * Registers Codex receiver child threads so later notifications on those threads
   * nest under the matching `collabAgentToolCall` Agent row.
   */
  private registerCollabReceiverThreads(
    collabId: string,
    item: CompletedItem,
    requireTurnEvidence = false,
  ): number {
    const receiverThreadIds = this.receiverThreadIds(item);
    for (const id of receiverThreadIds) {
      this.registerReceiverThread(collabId, id);
      if (requireTurnEvidence) this.strictChildTurnThreads.add(id);
    }
    return receiverThreadIds.size;
  }

  private receiverThreadIds(item: CompletedItem): Set<string> {
    const raw = item as unknown as Record<string, unknown>;
    const receiverThreadIds = new Set<string>();
    for (const id of this.nonEmptyStrings(raw.receiverThreadIds)) receiverThreadIds.add(id);
    for (const id of this.agentStateThreadIds(raw.agentsStates)) receiverThreadIds.add(id);
    return receiverThreadIds;
  }

  private nonEmptyStrings(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (typeof entry !== "string") return [];
      const trimmed = entry.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    });
  }

  private agentStateThreadIds(value: unknown): string[] {
    if (!value || typeof value !== "object") return [];
    return Object.keys(value as Record<string, unknown>).flatMap((id) => this.nonEmptyStrings([id]));
  }

  /** Registers one child thread and replays mutations that arrived before its parent activity. */
  private registerReceiverThread(agentToolCallId: string, childThreadId: string): void {
    this.retainChildThread(childThreadId);
    this.collabReceiverThreadToCollabId.set(childThreadId, agentToolCallId);
    const pending = this.earlyChildNotificationsByThread.get(childThreadId);
    if (pending) {
      this.earlyChildNotificationsByThread.delete(childThreadId);
      this.earlyChildNotificationCount -= pending.length;
      for (const notification of pending) {
        this.replayedChildEvents.push(...this.mapChildThreadNotification(notification));
      }
    }
  }

  private retainChildThread(childThreadId: string): void {
    this.retainedChildThreadIds.delete(childThreadId);
    this.retainedChildThreadIds.set(childThreadId, null);
    while (this.retainedChildThreadIds.size > MAX_RETAINED_CHILD_THREADS) {
      const oldest = this.retainedChildThreadIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.retainedChildThreadIds.delete(oldest);
      this.childTurnIdByThreadId.delete(oldest);
      this.collabReceiverThreadToCollabId.delete(oldest);
      this.strictChildTurnThreads.delete(oldest);
      this.childAssistantTextByThreadId.delete(oldest);
      this.childAssistantItemIdByThreadId.delete(oldest);
      this.pendingChildPromptByThreadId.delete(oldest);
      this.childThreadMetadataById.delete(oldest);
      const early = this.earlyChildNotificationsByThread.get(oldest);
      if (early) {
        this.earlyChildNotificationsByThread.delete(oldest);
        this.earlyChildNotificationCount -= early.length;
      }
      const beforeTurn = this.childNotificationsBeforeTurnByThread.get(oldest);
      if (beforeTurn) {
        this.childNotificationsBeforeTurnByThread.delete(oldest);
        this.childNotificationsBeforeTurnCount -= beforeTurn.length;
      }
      for (const startKey of this.emittedChildTurnStarts) {
        if (startKey.startsWith(`${oldest}:`)) this.emittedChildTurnStarts.delete(startKey);
      }
    }
  }

  private hasReceiverThreadMetadata(item: CompletedItem): boolean {
    const raw = item as unknown as Record<string, unknown>;
    return Array.isArray(raw.receiverThreadIds) || (raw.agentsStates != null && typeof raw.agentsStates === "object");
  }

  private shouldTrackCollabScope(item: CompletedItem, isSpawn: boolean, receiverCount: number): boolean {
    return !isSpawn || receiverCount > 0 || !this.hasReceiverThreadMetadata(item);
  }

  /** Returns the Codex collab tool name while tolerating older snake/camel shapes. */
  private collabToolKind(item: CompletedItem): string {
    const raw = item as unknown as Record<string, unknown>;
    return typeof item.tool === "string"
      ? item.tool
      : typeof raw.toolKind === "string"
        ? raw.toolKind
        : typeof raw.tool_kind === "string"
          ? raw.tool_kind
          : "collab";
  }

  /** True when a Codex collab item is the parent-side wait plumbing. */
  private isWaitCollab(item: CompletedItem): boolean {
    return this.collabToolKind(item) === "wait";
  }

  /** True when a Codex collab item dispatches an actual sub-agent. */
  private isSpawnAgentCollab(item: CompletedItem): boolean {
    const kind = this.collabToolKind(item);
    return kind === "spawnAgent" || kind === "spawn_agent";
  }

  /** Returns a trimmed string field from loose Codex protocol item shapes. */
  private stringField(raw: Record<string, unknown>, key: string): string | undefined {
    const value = raw[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /** Compact row label derived from the task prompt. */
  private promptDescription(prompt: string): string {
    const lines = prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const firstLine = CODEX_TASK_NAME_LINE.test(lines[0] ?? "")
      ? (lines[1] ?? lines[0] ?? prompt.trim())
      : (lines[0] ?? prompt.trim());
    return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 80)}...`;
  }

  /** Reads the task identity convention used by Codex child prompts. */
  private taskNameFromPrompt(prompt: string | undefined): string | undefined {
    if (!prompt) return undefined;
    const namedChild = prompt.trimStart().match(CODEX_NAMED_CHILD_PROMPT)?.[1];
    if (namedChild) return namedChild;
    const firstLine = prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine?.match(CODEX_TASK_NAME_LINE)?.[1];
  }

  /** Metadata shared by Codex spawn `ToolUse` and its late `ToolResult`. */
  private buildCollabToolInput(item: CompletedItem): Record<string, unknown> {
    const raw = item as unknown as Record<string, unknown>;
    const kind = this.collabToolKind(item);
    const prompt = this.stringField(raw, "prompt");
    const senderThreadId = this.stringField(raw, "senderThreadId")?.slice(0, 512);
    const receiverThreadIds = this.normalizedReceiverThreadIds(raw.receiverThreadIds);
    const childMetadata = this.singleChildMetadata(receiverThreadIds);
    return this.collabToolInputFromDetails({
      kind,
      prompt,
      senderThreadId,
      receiverThreadIds,
      isSpawn: this.isSpawnAgentCollab(item),
      taskName: this.stringField(raw, "task_name") ?? this.taskNameFromPrompt(prompt) ?? childMetadata?.agentName,
      model: this.stringField(raw, "model") ?? childMetadata?.model,
      reasoningEffort: this.stringField(raw, "reasoningEffort") ?? this.stringField(raw, "reasoning_effort") ?? childMetadata?.reasoningEffort,
    });
  }

  private singleChildMetadata(receiverThreadIds: string[]): Record<string, string> | undefined {
    return receiverThreadIds.length === 1 ? this.childThreadMetadataById.get(receiverThreadIds[0]!) : undefined;
  }

  private collabToolInputFromDetails(details: {
    kind: string;
    prompt: string | undefined;
    senderThreadId: string | undefined;
    receiverThreadIds: string[];
    isSpawn: boolean;
    taskName: string | undefined;
    model: string | undefined;
    reasoningEffort: string | undefined;
  }): Record<string, unknown> {
    const input: Record<string, unknown> = { codexCollabKind: details.kind };
    this.addInputField(input, "agentName", details.taskName);
    this.addPromptFields(input, details.prompt);
    this.addInputField(input, "model", details.model);
    this.addInputField(input, "reasoningEffort", details.reasoningEffort);
    if (!details.isSpawn) this.addInputField(input, "senderThreadId", details.senderThreadId);
    if (details.receiverThreadIds.length > 0) input.receiverThreadIds = details.receiverThreadIds;
    return input;
  }

  private addInputField(input: Record<string, unknown>, key: string, value: string | undefined): void {
    if (value) input[key] = value;
  }

  private addPromptFields(input: Record<string, unknown>, prompt: string | undefined): void {
    if (!prompt) return;
    input.description = this.promptDescription(prompt);
    input.prompt = prompt.slice(0, 32_768);
  }

  private normalizedReceiverThreadIds(value: unknown): string[] {
    return [...new Set(this.nonEmptyStrings(value).map((id) => id.slice(0, 512)))].slice(0, 32);
  }

  /** Associates a parent follow-up prompt with the next turn of its exact child receiver. */
  private rememberPendingChildPrompt(item: CompletedItem): void {
    if (this.isSpawnAgentCollab(item) || this.isWaitCollab(item)) return;
    const raw = item as unknown as Record<string, unknown>;
    const prompt = this.stringField(raw, "prompt");
    if (!prompt) return;
    for (const childThreadId of this.normalizedReceiverThreadIds(raw.receiverThreadIds)) {
      if (this.collabReceiverThreadToCollabId.has(childThreadId)) {
        this.pendingChildPromptByThreadId.set(childThreadId, prompt.slice(0, 32_768));
      }
    }
  }

  /** Merges any newly-arrived spawn metadata for later child/wait completion. */
  private mergeSpawnAgentToolInput(collabId: string, item: CompletedItem): Record<string, unknown> {
    const existing = this.spawnAgentToolInputById.get(collabId) ?? {};
    const next = { ...existing, ...this.buildCollabToolInput(item) };
    this.spawnAgentToolInputById.set(collabId, next);
    return next;
  }

  /** Applies resolved model settings carried by a completed native spawn item. */
  private applySpawnItemMetadata(item: CompletedItem): CodexMappedEvent[] {
    const raw = item as unknown as Record<string, unknown>;
    const model = this.stringField(raw, "model");
    const reasoningEffort =
      this.stringField(raw, "reasoningEffort")
      ?? this.stringField(raw, "reasoning_effort");
    if (!model || !reasoningEffort) return [];

    return [...this.receiverThreadIds(item)].flatMap((childThreadId) => (
      this.applyChildThreadMetadataInternal(childThreadId, { model, reasoningEffort })
    ));
  }

  /** Maps native Codex sub-agent activity to Agent and persisted lifecycle records. */
  private mapSubAgentActivityStart(
    item: CompletedItem,
    toolCallId: string,
    includeInteractions: boolean,
    notification?: CodexNotification,
  ): CodexMappedEvent[] {
    const activity = this.subAgentActivityDetails(item, notification);
    if (!activity) return [];
    if (item.kind === "interacted") return includeInteractions ? this.mapSubAgentInteraction(toolCallId, activity) : [];
    if (item.kind !== "started") return [];
    return this.mapSubAgentStart(toolCallId, activity, includeInteractions, notification);
  }

  private subAgentActivityDetails(item: CompletedItem, notification?: CodexNotification): {
    agentThreadId: string;
    agentPath: string;
    agentName: string;
    sourceAgentToolCallId: string | undefined;
    sourceAgentName: string | undefined;
  } | undefined {
    const agentThreadId = this.stringField(item, "agentThreadId");
    const agentPath = this.stringField(item, "agentPath");
    if (!agentThreadId || !agentPath) return undefined;
    const sourceAgentToolCallId = this.notificationSourceAgentToolCallId(notification);
    const sourceToolInput = sourceAgentToolCallId ? this.spawnAgentToolInputById.get(sourceAgentToolCallId) : undefined;
    return {
      agentThreadId,
      agentPath,
      agentName: agentPath.split("/").filter(Boolean).pop() ?? agentPath,
      sourceAgentToolCallId,
      sourceAgentName: sourceToolInput ? this.stringField(sourceToolInput, "agentName") : undefined,
    };
  }

  private notificationSourceAgentToolCallId(notification: CodexNotification | undefined): string | undefined {
    const notificationThreadId = notification ? this.notificationThreadId(notification) : undefined;
    return notificationThreadId ? this.collabReceiverThreadToCollabId.get(notificationThreadId) : undefined;
  }

  private mapSubAgentInteraction(
    toolCallId: string,
    activity: { agentName: string; agentPath: string; sourceAgentToolCallId: string | undefined; sourceAgentName: string | undefined },
  ): CodexMappedEvent[] {
    this.subagentInteractionSequence += 1;
    const lifecycleToolCallId = `subagent-activity:${toolCallId.slice(0, MAX_LIFECYCLE_PARENT_ID_LENGTH)}:${this.subagentInteractionSequence}`;
    const toolInput: Record<string, unknown> = { lifecycle: "updated", agentName: activity.agentName, agentPath: activity.agentPath };
    this.addInputField(toolInput, "sourceAgentName", activity.sourceAgentName);
    this.addInputField(toolInput, "sourceAgentToolCallId", activity.sourceAgentToolCallId);
    return [{ type: AgentEventType.ToolUse, threadId: this.threadId, toolCallId: lifecycleToolCallId, toolName: SUBAGENT_LIFECYCLE_TOOL_NAME, toolInput, parentToolCallId: toolCallId }, this.toolResultEvent({ toolCallId: lifecycleToolCallId, output: "", isError: false })];
  }

  private mapSubAgentStart(
    toolCallId: string,
    activity: { agentThreadId: string; agentPath: string; agentName: string; sourceAgentToolCallId: string | undefined },
    includeInteractions: boolean,
    notification: CodexNotification | undefined,
  ): CodexMappedEvent[] {
    const toolInput = { codexCollabKind: "spawnAgent", agentName: activity.agentName, agentPath: activity.agentPath, description: activity.agentName, receiverThreadIds: [activity.agentThreadId], ...this.childThreadMetadataById.get(activity.agentThreadId) };
    this.spawnAgentToolInputById.set(toolCallId, toolInput);
    this.rememberSubAgentStart(activity, toolCallId, includeInteractions, notification);
    if (this.emittedAgentToolUseIds.has(toolCallId)) return [];
    this.collabToolUseFromStartIds.add(toolCallId);
    this.emittedAgentToolUseIds.add(toolCallId);
    return [this.subAgentToolUseEvent(toolCallId, toolInput, activity, includeInteractions, notification)];
  }

  private rememberSubAgentStart(
    activity: { agentThreadId: string; sourceAgentToolCallId: string | undefined },
    toolCallId: string,
    includeInteractions: boolean,
    notification: CodexNotification | undefined,
  ): void {
    if (activity.sourceAgentToolCallId) this.parentAgentToolCallIdById.set(toolCallId, activity.sourceAgentToolCallId);
    this.rememberChildSpawnEvidence(toolCallId, this.childSpawnEvidenceFromNotification(notification, toolCallId, includeInteractions ? "started" : "completed"));
    this.openSpawnAgentIds.add(toolCallId);
    this.registerReceiverThread(toolCallId, activity.agentThreadId);
  }

  private subAgentToolUseEvent(
    toolCallId: string,
    toolInput: Record<string, unknown>,
    activity: { agentThreadId: string; sourceAgentToolCallId: string | undefined },
    includeInteractions: boolean,
    notification: CodexNotification | undefined,
  ): CodexMappedEvent {
    const parentToolCallId = activity.sourceAgentToolCallId;
    const nativeTurnId = notification ? this.nativeTurnId(notification) : undefined;
    return {
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName: "Agent",
      toolInput,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      ...(parentToolCallId ? { codexChild: { nativeThreadId: activity.agentThreadId, ...(nativeTurnId ? { nativeTurnId } : {}), parentCollaborationItemId: parentToolCallId, nativeItemId: toolCallId, itemEventKey: includeInteractions ? "started" : "completed" } } : {}),
    };
  }

  /** Stores authoritative child-thread settings and updates any mapped Agent row. */
  private mapThreadSettingsUpdated(params: ThreadSettingsUpdatedPayload): CodexMappedEvent[] {
    const childThreadId = params.threadId;
    const settings = params.threadSettings;
    if (!childThreadId || !settings || typeof settings !== "object" || Array.isArray(settings)) return [];

    const record = settings as Record<string, unknown>;
    const model = this.stringField(record, "model");
    const reasoningEffort = this.stringField(record, "effort");
    if (!model && !reasoningEffort) return [];
    return this.applyChildThreadMetadataInternal(childThreadId, {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  /** Applies authoritative child-thread metadata and returns runtime events. */
  applyChildThreadMetadata(
    childThreadId: string,
    metadata: { identity?: string; model?: string; reasoningEffort?: string; parentMessage?: string },
  ): ProviderRuntimeEvent[] {
    return this.applyChildThreadMetadataInternal(childThreadId, metadata)
      .map((event) => this.toRuntimeEvent(event));
  }

  /** Applies authoritative child-thread model settings to the matching Agent row. */
  private applyChildThreadMetadataInternal(
    childThreadId: string,
    metadata: { identity?: string; model?: string; reasoningEffort?: string; parentMessage?: string },
  ): CodexMappedEvent[] {
    const parentMessage = this.normalizedParentMessage(metadata.parentMessage);
    if (!childThreadId || !this.hasChildThreadMetadata(metadata, parentMessage)) return [];
    const storedMetadata = this.updatedChildMetadata(childThreadId, metadata, parentMessage);
    this.childThreadMetadataById.set(childThreadId, storedMetadata);
    const toolCallId = this.collabReceiverThreadToCollabId.get(childThreadId);
    const existingToolInput = toolCallId ? this.spawnAgentToolInputById.get(toolCallId) : undefined;
    if (!toolCallId || !existingToolInput) return [];
    const toolInput = this.updatedSpawnToolInput(existingToolInput, metadata, parentMessage);
    this.spawnAgentToolInputById.set(toolCallId, toolInput);
    const completedResult = this.completedSpawnAgentResults.get(toolCallId);
    if (completedResult) return [{ ...completedResult, toolInput }];
    const toolUse = this.childMetadataToolUseEvent(toolCallId, toolInput);
    const evidence = this.childSpawnEvidenceByCollabId.get(toolCallId);
    return evidence ? this.withChildEvidence([toolUse], evidence) : [toolUse];
  }

  private normalizedParentMessage(parentMessage: string | undefined): string | undefined {
    return typeof parentMessage === "string" ? parentMessage.trim().slice(0, 32_768) : undefined;
  }

  private hasChildThreadMetadata(
    metadata: { identity?: string; model?: string; reasoningEffort?: string },
    parentMessage: string | undefined,
  ): boolean {
    return Boolean(metadata.identity || metadata.model || metadata.reasoningEffort || parentMessage);
  }

  private updatedChildMetadata(
    childThreadId: string,
    metadata: { identity?: string; model?: string; reasoningEffort?: string },
    parentMessage: string | undefined,
  ): Record<string, string> {
    const stored = { ...this.childThreadMetadataById.get(childThreadId) };
    this.addInputField(stored, "agentName", metadata.identity);
    this.addInputField(stored, "model", metadata.model);
    this.addInputField(stored, "reasoningEffort", metadata.reasoningEffort);
    this.addPromptFields(stored, parentMessage);
    return stored as Record<string, string>;
  }

  private updatedSpawnToolInput(
    existingToolInput: Record<string, unknown>,
    metadata: { identity?: string; model?: string; reasoningEffort?: string },
    parentMessage: string | undefined,
  ): Record<string, unknown> {
    const toolInput = { ...existingToolInput };
    this.addInputField(toolInput, "agentName", metadata.identity);
    this.addInputField(toolInput, "model", metadata.model);
    this.addInputField(toolInput, "reasoningEffort", metadata.reasoningEffort);
    if (!this.stringField(existingToolInput, "prompt")) this.addPromptFields(toolInput, parentMessage);
    return toolInput;
  }

  private childMetadataToolUseEvent(toolCallId: string, toolInput: Record<string, unknown>): CodexMappedEvent {
    const parentToolCallId = this.parentAgentToolCallIdById.get(toolCallId);
    return {
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName: "Agent",
      toolInput,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    };
  }

  /** Accumulates private child-thread final text without emitting it into the parent reply. */
  private appendChildAssistantText(childThreadId: string | undefined, delta: string): void {
    if (!childThreadId || !delta) return;
    this.childAssistantBuffer(childThreadId).append(delta);
  }

  /** Stores a child-thread full-text snapshot as a delta against any streamed text. */
  private mergeChildAssistantFullText(childThreadId: string | undefined, fullText: string): void {
    if (!childThreadId || !fullText) return;
    const buffer = this.childAssistantBuffer(childThreadId);
    const prev = buffer.retainedText();
    if (buffer.isPreviewTruncated() && fullText.length >= prev.length) {
      buffer.replaceWith(fullText);
      return;
    }
    if (fullText.length > prev.length && fullText.startsWith(prev)) {
      buffer.replaceWith(fullText);
      return;
    }
    if (!prev.includes(fullText)) {
      buffer.append(fullText);
    }
  }

  /** Reads completed-message text from the OpenAI Responses-style item shape. */
  private completedMessageText(item: CompletedItem): string {
    const content = (item.content ?? []) as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === "output_text" || c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }

  /** Emits the spawn Agent ToolResult once; later child/wait completions are ignored. */
  private completeSpawnAgent(
    collabId: string | undefined,
    output: string | BoundedToolOutputBuffer | undefined,
    isError = false,
    childEvidence?: CodexChildEvidence,
  ): CodexMappedEvent[] {
    if (!collabId || this.completedSpawnAgentIds.has(collabId)) return [];
    if (!this.openSpawnAgentIds.has(collabId)) return [];
    this.completedSpawnAgentIds.add(collabId);
    this.openSpawnAgentIds.delete(collabId);
    this.popCollabFromScopeStack(collabId);
    const toolInput = this.spawnAgentToolInputById.get(collabId);
    const rawResult = this.toolResultEvent({ toolCallId: collabId, output, isError, toolInput });
    const evidence = childEvidence ?? this.childSpawnEvidenceByCollabId.get(collabId);
    const result = evidence
      ? this.withChildEvidence([rawResult], { ...evidence, itemEventKey: "completed" })[0] as ToolResultAgentEvent
      : rawResult;
    this.completedSpawnAgentResults.set(collabId, result);
    return [result];
  }

  /** Maps a `wait` collab's per-child state payload into Agent ToolResults. */
  private mapWaitStates(item: CompletedItem): CodexMappedEvent[] {
    const raw = item as unknown as Record<string, unknown>;
    const agentsStates = raw.agentsStates;
    if (!agentsStates || typeof agentsStates !== "object") return [];
    return Object.entries(agentsStates as Record<string, unknown>)
      .flatMap(([childThreadId, state]) => this.mapWaitState(childThreadId, state));
  }

  private mapWaitState(childThreadId: string, state: unknown): CodexMappedEvent[] {
    if (!state || typeof state !== "object") return [];
    const record = state as Record<string, unknown>;
    const status = typeof record.status === "string" ? record.status : "";
    if (status !== "completed" && status !== "failed") return [];
    const message = typeof record.message === "string" ? record.message : this.childAssistantTextByThreadId.get(childThreadId) ?? "";
    return this.completeSpawnAgent(this.collabReceiverThreadToCollabId.get(childThreadId), message, status === "failed");
  }

  /**
   * Parent collab id for nesting child `ToolUse` events. Codex receiver-thread notifications
   * resolve via
   * `collabReceiverThreadToCollabId`. Parent-thread tools use `collabScopeStack` only
   * when exactly one collab is open; parallel collabs on the parent thread omit stack
   * peek (same rule as Claude `getStackDerivedParentFallback`).
   */
  private nestingParentToolCallId(notification?: CodexNotification): string | undefined {
    if (notification) {
      const notifThread = this.notificationThreadId(notification);
      if (notifThread && this.classifyNotificationThread(notification) === "child") {
        return this.collabReceiverThreadToCollabId.get(notifThread);
      }
    }
    const stack = this.collabScopeStack;
    if (stack.length === 0) return undefined;
    if (stack.length > 1) return undefined;
    return stack[0];
  }

  /** Removes `id` from the collab stack (completion or defensive cleanup). */
  private popCollabFromScopeStack(collabId: string): void {
    if (this.collabScopeStack[this.collabScopeStack.length - 1] === collabId) {
      this.collabScopeStack.pop();
      return;
    }
    const idx = this.collabScopeStack.lastIndexOf(collabId);
    if (idx >= 0) this.collabScopeStack.splice(idx, 1);
  }

  /**
   * Builds the Agent `ToolUse` for a collab item (shared by `item/started` and legacy `item/completed`).
   */
  private buildCollabToolUseEvent(
    item: CompletedItem,
    toolCallId: string,
    notification?: CodexNotification,
  ): CodexMappedEvent {
    const nestParent = this.nestingParentToolCallId(notification);
    const toolInput = this.isSpawnAgentCollab(item)
      ? this.mergeSpawnAgentToolInput(toolCallId, item)
      : this.buildCollabToolInput(item);
    return {
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName: "Agent",
      toolInput,
      ...(nestParent ? { parentToolCallId: nestParent } : {}),
    };
  }

  /** Parses Codex tool arguments without dropping malformed input. */
  private parseToolArguments(args: CompletedItem["arguments"]): Record<string, unknown> {
    if (typeof args === "string") {
      try { return JSON.parse(args) as Record<string, unknown>; }
      catch { return { arguments: args }; }
    }
    if (args && typeof args === "object") return args as Record<string, unknown>;
    return {};
  }

  /** Builds the running `ToolUse` row for non-Agent Codex tool-like items. */
  private buildToolUseEvent(
    item: CompletedItem,
    toolCallId: string,
    notification?: CodexNotification,
  ): CodexMappedEvent | undefined {
    const builders: Partial<Record<CompletedItem["type"], () => CodexMappedEvent>> = {
      function_call: () => this.toolUse(toolCallId, typeof item.name === "string" ? item.name : "function", this.parseToolArguments(item.arguments), notification),
      commandExecution: () => this.toolUse(toolCallId, "command_execution", this.commandToolInput(item), notification),
      fileChange: () => this.toolUse(toolCallId, "file_change", this.fileChangeToolInput(item), notification),
      mcpToolCall: () => this.toolUse(toolCallId, this.mcpToolName(item), this.parseToolArguments(item.arguments), notification),
      dynamicToolCall: () => this.toolUse(toolCallId, item.name ?? "dynamic_tool", this.parseToolArguments(item.arguments), notification),
    };
    return dispatchNativeHandler<CodexMappedEvent>(builders, item.type);
  }

  private toolUse(toolCallId: string, toolName: string, toolInput: Record<string, unknown>, notification?: CodexNotification): CodexMappedEvent {
    const parentToolCallId = this.nestingParentToolCallId(notification);
    return { type: AgentEventType.ToolUse, threadId: this.threadId, toolCallId, toolName, toolInput, ...(parentToolCallId ? { parentToolCallId } : {}) };
  }

  private commandToolInput(item: CompletedItem): Record<string, unknown> {
    return typeof item.command === "string" && item.command.length > 0 ? { command: item.command } : {};
  }

  private fileChangeToolInput(item: CompletedItem): Record<string, unknown> {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    if (changes.length === 0) return {};
    return {
      files: changes.map((change) => change.path).filter(Boolean).join(", "),
      changes: changes.filter((change) => typeof change.path === "string" && change.path.length > 0).slice(0, 256).map((change) => ({ path: change.path, kind: change.kind })),
    };
  }

  private mcpToolName(item: CompletedItem): string {
    return `mcp:${item.server ?? ""}/${item.tool ?? item.name ?? "unknown"}`;
  }

  /** Stable enough for same-turn start/completion enrichment checks. */
  private toolUseSignature(event: CodexMappedEvent): string {
    if (event.type !== AgentEventType.ToolUse) return "";
    return JSON.stringify({
      toolName: event.toolName,
      toolInput: event.toolInput,
      parentToolCallId: event.parentToolCallId ?? null,
    });
  }

  /** Returns true when completion has new ToolUse details worth broadcasting. */
  private shouldEmitCompletionToolUse(toolCallId: string, event: CodexMappedEvent | undefined): event is CodexMappedEvent {
    if (!event) return false;
    const started = this.startedToolUseSignatures.get(toolCallId);
    this.startedToolUseSignatures.delete(toolCallId);
    return started == null || started !== this.toolUseSignature(event);
  }

  /** Returns a stable id for assistant-text notifications, including older shapes without item ids. */
  private assistantItemId(
    notification: CodexNotification,
    item?: CompletedItem,
  ): string {
    const rawItemId = item?.id;
    if (typeof rawItemId === "string" && rawItemId.length > 0) return rawItemId;
    const paramsItemId = (notification.params as { itemId?: unknown }).itemId;
    if (typeof paramsItemId === "string" && paramsItemId.length > 0) return paramsItemId;
    return this.currentAssistantItemId ?? FALLBACK_ASSISTANT_ITEM_ID;
  }

  /** Extracts assistant text from completed assistant message item shapes. */
  private assistantTextFromCompletedItem(item: CompletedItem): string {
    const content = item.content ?? [];
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === "output_text" || c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    }
    const raw = item as { text?: unknown; output?: unknown };
    if (typeof raw.text === "string") return raw.text;
    if (typeof raw.output === "string") return raw.output;
    return "";
  }

  /** True when there is assistant text whose boundary has not yet been classified. */
  private hasOpenAssistantText(): boolean {
    return (
      this.pendingAssistantBoundaryItemId !== undefined
      || this.currentAssistantItemText.length > 0
    );
  }

  /**
   * Flushes the held assistant-message boundary using Codex lookahead.
   * Non-final boundaries clear assistant text so later turn failure/cancel
   * cannot persist narration as the assistant reply.
   */
  drainPendingAssistantBoundary(isFinalResponse = false): CodexMappedEvent[] {
    if (!this.hasOpenAssistantText()) return [];
    if (isFinalResponse && this.lastCompletedAssistantText.length === 0) {
      this.lastCompletedAssistantText = this.currentAssistantItemText;
    }
    const event: CodexMappedEvent = {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: this.threadId,
      isFinalResponse,
    };
    this.pendingAssistantBoundaryItemId = undefined;
    if (!isFinalResponse) {
      this.assistantTextByItemId.clear();
      this.currentAssistantItemId = undefined;
      this.currentAssistantItemText = "";
      this.lastCompletedAssistantText = "";
    }
    return [event];
  }

  /** Flushes a pending boundary when a different item starts producing work. */
  private drainAssistantBoundaryBeforeItem(nextItemId?: string): CodexMappedEvent[] {
    if (!this.hasOpenAssistantText()) return [];
    if (nextItemId && this.currentAssistantItemId === nextItemId) return [];
    return this.drainPendingAssistantBoundary(false);
  }

  /** Records streamed assistant text and emits it as narration until a boundary promotes it. */
  private recordAssistantDelta(itemId: string, delta: string): void {
    const prev = this.assistantTextByItemId.get(itemId) ?? "";
    const next = prev + delta;
    this.assistantTextByItemId.set(itemId, next);
    this.currentAssistantItemId = itemId;
    this.currentAssistantItemText = next;
  }

  /**
   * Handles completed assistant items. It may emit a missing non-final delta for
   * completed-only message shapes, but it holds the boundary until lookahead.
   */
  private recordAssistantCompletion(
    item: CompletedItem,
    notification: CodexNotification,
  ): CodexMappedEvent[] {
    const itemId = this.assistantItemId(notification, item);
    const completedText = this.assistantTextFromCompletedItem(item);
    this.replaceFallbackAssistantItemId(itemId);
    const boundaryEvents = this.drainAssistantBoundaryBeforeItem(itemId);
    const previousText = this.assistantTextByItemId.get(itemId) ?? "";
    const events = this.completedAssistantDeltaEvents(itemId, completedText, previousText, boundaryEvents);
    this.rememberCompletedAssistantBoundary(itemId);
    return events;
  }

  private replaceFallbackAssistantItemId(itemId: string): void {
    const canReplace = itemId !== FALLBACK_ASSISTANT_ITEM_ID && this.currentAssistantItemId === FALLBACK_ASSISTANT_ITEM_ID && this.currentAssistantItemText.length > 0 && !this.assistantTextByItemId.has(itemId);
    if (!canReplace) return;
    this.assistantTextByItemId.delete(FALLBACK_ASSISTANT_ITEM_ID);
    this.assistantTextByItemId.set(itemId, this.currentAssistantItemText);
    this.currentAssistantItemId = itemId;
  }

  private completedAssistantDeltaEvents(itemId: string, completedText: string, previousText: string, boundaryEvents: CodexMappedEvent[]): CodexMappedEvent[] {
    if (completedText.length === 0) return boundaryEvents;
    const delta = completedText.length > previousText.length ? completedText.slice(previousText.length) : "";
    this.assistantTextByItemId.set(itemId, completedText);
    this.currentAssistantItemId = itemId;
    this.currentAssistantItemText = completedText;
    return delta ? [...boundaryEvents, { type: AgentEventType.TextDelta, threadId: this.threadId, delta, isFinalResponse: false }] : boundaryEvents;
  }

  private rememberCompletedAssistantBoundary(itemId: string): void {
    const text = this.assistantTextByItemId.get(itemId) ?? "";
    if (text.length === 0) return;
    this.lastCompletedAssistantText = text;
    this.pendingAssistantBoundaryItemId = itemId;
  }

  /**
   * Translates a single `CodexNotification` into zero or more `AgentEvent` objects.
   * Returns an empty array for silently consumed notification types.
   */
  mapNotification(notification: CodexNotification): ProviderRuntimeEvent[] {
    this.replayedChildEvents = [];
    const events = this.mapNotificationInternal(notification);
    return this.dedupeChildEvents(
      this.replayedChildEvents.length > 0
        ? [...events, ...this.replayedChildEvents]
        : events,
    ).map((event) => this.toRuntimeEvent(event));
  }

  private toRuntimeEvent(event: CodexMappedEvent): ProviderRuntimeEvent {
    const extension = this.runtimeExtension(event);
    return {
      event: this.rendererEvent(event),
      ...(extension ? { extension } : {}),
    };
  }

  private runtimeExtension(event: CodexMappedEvent): ProviderRuntimeEvent["extension"] {
    const collaboration = this.collaborationEvidence(event);
    if (!event.codexChild && !event.codexContinuation && !collaboration) return undefined;
    return {
      providerId: "codex",
      kind: "codex-collaboration",
      ...(event.codexChild ? { child: event.codexChild } : {}),
      ...(event.codexContinuation ? { continuation: event.codexContinuation } : {}),
      ...(collaboration ? { collaboration } : {}),
    };
  }

  private collaborationEvidence(event: CodexMappedEvent): CodexCollaborationEvidence | undefined {
    if (event.type !== AgentEventType.ToolUse && event.type !== AgentEventType.ToolResult) return undefined;
    const input = event.toolInput ?? {};
    const kind = this.stringField(input, "codexCollabKind");
    if (!kind) return undefined;
    const evidence: CodexCollaborationEvidence = { kind };
    this.addEvidenceField(evidence, "senderThreadId", this.stringField(input, "senderThreadId"));
    this.addEvidenceField(evidence, "prompt", this.stringField(input, "prompt"));
    this.addEvidenceField(evidence, "agentName", this.stringField(input, "agentName"));
    this.addEvidenceField(evidence, "agentPath", this.stringField(input, "agentPath"));
    this.addEvidenceField(evidence, "model", this.stringField(input, "model"));
    this.addEvidenceField(evidence, "reasoningEffort", this.stringField(input, "reasoningEffort"));
    const receiverThreadIds = this.nonEmptyStrings(input.receiverThreadIds);
    if (receiverThreadIds.length > 0) evidence.receiverThreadIds = receiverThreadIds;
    return evidence;
  }

  private addEvidenceField(evidence: CodexCollaborationEvidence, key: "senderThreadId" | "prompt" | "agentName" | "agentPath" | "model" | "reasoningEffort", value: string | undefined): void {
    if (value) evidence[key] = value;
  }

  private rendererEvent(event: CodexMappedEvent): AgentEvent {
    const { codexChild: _child, codexContinuation: _continuation, ...genericEvent } = event;
    if (genericEvent.type !== AgentEventType.ToolUse && genericEvent.type !== AgentEventType.ToolResult) {
      return genericEvent;
    }
    const {
      codexCollabKind: _kind,
      senderThreadId: _senderThreadId,
      receiverThreadIds: _receiverThreadIds,
      prompt: _prompt,
      agentName: _agentName,
      agentPath: _agentPath,
      model: _model,
      reasoningEffort: _reasoningEffort,
      ...toolInput
    } = genericEvent.toolInput ?? {};
    const { toolInput: _nativeToolInput, ...eventWithoutToolInput } = genericEvent;
    if (genericEvent.type === AgentEventType.ToolUse) return { ...eventWithoutToolInput, toolInput } as AgentEvent;
    if (Object.keys(toolInput).length === 0) return eventWithoutToolInput as AgentEvent;
    return { ...eventWithoutToolInput, toolInput } as AgentEvent;
  }

  private mapNotificationInternal(notification: CodexNotification): CodexMappedEvent[] {
    return this.mapDirectNotification(notification)
      ?? this.mapRoutedNotification(notification)
      ?? this.mapMainNotification(notification);
  }

  private mapDirectNotification(notification: CodexNotification): CodexMappedEvent[] | undefined {
    const handlers: Record<string, () => CodexMappedEvent[]> = {
      warning: () => { logger.warn("Codex warning notification", { method: notification.method, params: notification.params }); return []; },
      "thread/settings/updated": () => this.mapThreadSettingsUpdated(notification.params as ThreadSettingsUpdatedPayload),
    };
    return dispatchNativeHandler<CodexMappedEvent[]>(handlers, notification.method);
  }

  private mapRoutedNotification(notification: CodexNotification): CodexMappedEvent[] | undefined {
    const route = this.classifyNotificationThread(notification);
    if (route === "main") return undefined;
    if (route === "unknown") return this.mapUnknownThreadNotification(notification);
    return this.mapKnownChildNotification(notification);
  }

  private mapUnknownThreadNotification(notification: CodexNotification): CodexMappedEvent[] {
    if (this.bufferEligibleEarlyChildNotification(notification)) return [];
    logger.warn("CodexEventMapper: dropping unknown-thread notification", { method: notification.method, notificationThreadId: this.notificationThreadId(notification), mainCodexThreadId: this.mainCodexThreadId });
    return [];
  }

  private mapKnownChildNotification(notification: CodexNotification): CodexMappedEvent[] {
    const childThreadId = this.notificationThreadId(notification);
    if (this.markChildNativeNotification(notification)) return [];
    if (this.shouldBufferChildNotificationBeforeTurn(notification, childThreadId)) return [];
    return this.mapChildThreadNotification(notification);
  }

  private shouldBufferChildNotificationBeforeTurn(notification: CodexNotification, childThreadId: string | undefined): boolean {
    const hasTurnEvidence = notification.method === "item/started" || notification.method === "item/completed";
    if (!childThreadId || !hasTurnEvidence || !this.strictChildTurnThreads.has(childThreadId)) return false;
    if (this.bufferedChildTurnId(childThreadId)) return false;
    this.bufferChildNotificationBeforeTurn(notification);
    return true;
  }

  private mapMainNotification(notification: CodexNotification): CodexMappedEvent[] {
    const lifecycle = this.mapMainLifecycleNotification(notification);
    if (lifecycle) return lifecycle;
    if (this.turnEnded) return this.ignoreEndedMainNotification(notification.method);
    return this.mapActiveMainNotification(notification);
  }

  private mapMainLifecycleNotification(notification: CodexNotification): CodexMappedEvent[] | undefined {
    const handlers: Record<string, () => CodexMappedEvent[]> = {
      "thread/goal/updated": () => this.mapGoalUpdated(notification),
      "thread/goal/cleared": () => this.mapGoalCleared(notification),
      "mcpServer/startupStatus/updated": () => this.mapMcpStartupStatus(notification),
      "turn/started": () => { this.turnEnded = false; logger.debug("Codex lifecycle notification", { method: notification.method }); return []; },
    };
    return dispatchNativeHandler<CodexMappedEvent[]>(handlers, notification.method);
  }

  private mapGoalUpdated(notification: CodexNotification): CodexMappedEvent[] {
    const params = notification.params as { goal: ThreadGoal; turnId?: string | null };
    const goal = this.mapThreadGoal(params.goal, params.turnId ?? null);
    const events: CodexMappedEvent[] = [{ type: AgentEventType.GoalUpdated, threadId: this.threadId, goal }];
    if (goal.status !== "complete") return events;
    events.push({ type: AgentEventType.Message, threadId: this.threadId, content: `Goal achieved in ${goal.timeUsedSeconds}s.`, tokens: null });
    events.push({ type: AgentEventType.GoalCleared, threadId: this.threadId, providerId: "codex", reason: "completed", turnId: goal.turnId ?? null });
    return events;
  }

  private mapGoalCleared(notification: CodexNotification): CodexMappedEvent[] {
    const params = notification.params as { turnId?: string | null };
    return [{ type: AgentEventType.GoalCleared, threadId: this.threadId, providerId: "codex", reason: "cleared", turnId: params.turnId ?? null }];
  }

  private mapMcpStartupStatus(notification: CodexNotification): CodexMappedEvent[] {
    const params = notification.params as { threadId?: string; name: string; status: McpServerStartupStatus | "error"; error?: unknown; failureReason?: unknown };
    const serverThreadId = params.threadId ?? this.mainCodexThreadId;
    if (!serverThreadId) { logger.warn("CodexEventMapper: dropping MCP startup status without thread id", { name: params.name, status: params.status }); return []; }
    const status = params.status === "error" ? "failed" : params.status;
    const event: Extract<CodexMappedEvent, { type: typeof AgentEventType.McpServerStartupStatus }> = { type: AgentEventType.McpServerStartupStatus, threadId: this.threadId, providerId: "codex", serverThreadId, name: params.name, status };
    if (typeof params.error === "string") event.error = params.error;
    if (typeof params.failureReason === "string") event.failureReason = params.failureReason;
    return [event];
  }

  private ignoreEndedMainNotification(method: string): CodexMappedEvent[] {
    logger.debug("Codex notification ignored after turn/completed", { method });
    return [];
  }

  private mapActiveMainNotification(notification: CodexNotification): CodexMappedEvent[] {
    const handlers: Record<string, () => CodexMappedEvent[]> = {
      "item/started": () => this.mapMainItemStarted(notification),
      "item/reasoning/textDelta": () => this.mapReasoningDelta(notification),
      "item/reasoning/summaryTextDelta": () => this.mapReasoningDelta(notification),
      "item/reasoning/summaryPartAdded": () => [],
      "item/plan/delta": () => this.mapPlanDelta(notification),
      "turn/plan/updated": () => this.mapPlanUpdated(notification),
      "item/agentMessage/delta": () => this.mapAssistantDelta(notification),
      "item/commandExecution/outputDelta": () => this.mapCommandOutputDelta(notification),
      "item/completed": () => this.mapMainItemCompleted(notification),
      "turn/completed": () => this.mapMainTurnCompleted(notification),
      error: () => this.mapMainError(notification),
    };
    const events = dispatchNativeHandler<CodexMappedEvent[]>(handlers, notification.method);
    if (events !== undefined) return events;
    if (SILENCED_METHODS.has(notification.method)) { logger.debug("Codex notification silenced", { method: notification.method }); return []; }
    logger.warn("CodexEventMapper: unrecognized notification", { method: notification.method });
    return [];
  }

  private mapMainItemStarted(notification: CodexNotification): CodexMappedEvent[] {
    const item = (notification.params as { item?: CompletedItem }).item;
    const itemId = typeof item?.id === "string" ? item.id : undefined;
    if (item?.type === "collabAgentToolCall" && this.isWaitCollab(item)) return [];
    const boundaryEvents = this.drainAssistantBoundaryBeforeItem(itemId);
    return this.mapStartedMainItem(item, itemId, notification, boundaryEvents);
  }

  private mapStartedMainItem(item: CompletedItem | undefined, itemId: string | undefined, notification: CodexNotification, boundaryEvents: CodexMappedEvent[]): CodexMappedEvent[] {
    if (item?.type === "subAgentActivity" && itemId) return [...boundaryEvents, ...this.mapSubAgentActivityStart(item, itemId, true, notification)];
    this.clearLegacyCollabScope(item?.type);
    if (item?.type === "collabAgentToolCall" && itemId) return this.mapMainCollabStarted(item, itemId, notification, boundaryEvents);
    return this.mapMainToolStarted(item, itemId, notification, boundaryEvents);
  }

  private clearLegacyCollabScope(itemType: string | undefined): void {
    if (!itemType || !TOOL_LIKE_ITEM_TYPES.has(itemType) || itemType === "collabAgentToolCall" || this.pendingLegacyCollabPops.size === 0) return;
    for (const legacyId of this.pendingLegacyCollabPops) this.popCollabFromScopeStack(legacyId);
    this.pendingLegacyCollabPops.clear();
  }

  private mapMainCollabStarted(item: CompletedItem, itemId: string, notification: CodexNotification, boundaryEvents: CodexMappedEvent[]): CodexMappedEvent[] {
    const isSpawn = this.isSpawnAgentCollab(item);
    this.rememberPendingChildPrompt(item);
    const receiverCount = isSpawn ? this.registerCollabReceiverThreads(itemId, item, true) : 0;
    if (this.collabToolUseFromStartIds.has(itemId)) return this.refreshStartedSpawn(item, itemId, isSpawn, receiverCount, boundaryEvents);
    const alreadyEmitted = this.emittedAgentToolUseIds.has(itemId);
    const toolUse = this.buildCollabToolUseEvent(item, itemId, notification);
    if (this.shouldTrackCollabScope(item, isSpawn, receiverCount)) this.collabScopeStack.push(itemId);
    this.collabToolUseFromStartIds.add(itemId);
    this.emittedAgentToolUseIds.add(itemId);
    if (isSpawn && receiverCount > 0) this.openSpawnAgentIds.add(itemId);
    return alreadyEmitted ? boundaryEvents : [...boundaryEvents, toolUse];
  }

  private refreshStartedSpawn(item: CompletedItem, itemId: string, isSpawn: boolean, receiverCount: number, boundaryEvents: CodexMappedEvent[]): CodexMappedEvent[] {
    if (!isSpawn) return boundaryEvents;
    this.mergeSpawnAgentToolInput(itemId, item);
    if (receiverCount > 0) this.openSpawnAgentIds.add(itemId);
    return boundaryEvents;
  }

  private mapMainToolStarted(item: CompletedItem | undefined, itemId: string | undefined, notification: CodexNotification, boundaryEvents: CodexMappedEvent[]): CodexMappedEvent[] {
    if (!item || !itemId || !TOOL_LIKE_ITEM_TYPES.has(item.type) || item.type === "webSearch") return this.logMainItemStarted(notification.method, item?.type, boundaryEvents);
    const toolUse = this.buildToolUseEvent(item, itemId, notification);
    if (!toolUse) return this.logMainItemStarted(notification.method, item.type, boundaryEvents);
    this.startedToolUseSignatures.set(itemId, this.toolUseSignature(toolUse));
    return [...boundaryEvents, toolUse];
  }

  private logMainItemStarted(method: string, itemType: string | undefined, boundaryEvents: CodexMappedEvent[]): CodexMappedEvent[] {
    logger.debug("Codex lifecycle notification", { method, itemType });
    return boundaryEvents;
  }

  private mapReasoningDelta(notification: CodexNotification): CodexMappedEvent[] {
    const params = notification.params as { delta?: unknown; text?: unknown };
    const delta = typeof params.delta === "string" ? params.delta : typeof params.text === "string" ? params.text : "";
    if (!delta) return [];
    this.lastReasoningText += delta;
    return [...this.drainPendingAssistantBoundary(false), { type: AgentEventType.TextDelta, threadId: this.threadId, delta, isFinalResponse: false }];
  }

  private mapPlanDelta(notification: CodexNotification): CodexMappedEvent[] {
    const delta = (notification.params as { delta?: unknown }).delta;
    if (typeof delta !== "string" || !delta) return [];
    return [...this.drainPendingAssistantBoundary(false), { type: AgentEventType.TextDelta, threadId: this.threadId, delta, isFinalResponse: false }];
  }

  private mapPlanUpdated(notification: CodexNotification): CodexMappedEvent[] {
    const params = notification.params as { turnId?: string; explanation?: unknown; plan?: unknown };
    if (!Array.isArray(params.plan) || params.plan.length === 0) return [];
    const toolCallId = `codex-plan-${params.turnId ?? "unknown"}-${++this.planUpdateSeq}`;
    const toolInput: Record<string, unknown> = { plan: params.plan };
    if (typeof params.explanation === "string" && params.explanation.length > 0) toolInput.explanation = params.explanation;
    return [...this.drainPendingAssistantBoundary(false), { type: AgentEventType.ToolUse, threadId: this.threadId, toolCallId, toolName: "update_plan", toolInput }, { type: AgentEventType.ToolResult, threadId: this.threadId, toolCallId, output: "Plan updated", isError: false }];
  }

  private mapAssistantDelta(notification: CodexNotification): CodexMappedEvent[] {
    const delta = (notification.params as { delta?: string }).delta;
    if (!delta) return [];
    const itemId = this.assistantItemId(notification);
    const boundaryEvents = this.drainAssistantBoundaryBeforeItem(itemId);
    this.recordAssistantDelta(itemId, delta);
    return [...boundaryEvents, { type: AgentEventType.TextDelta, threadId: this.threadId, delta, isFinalResponse: false }];
  }

  private mapCommandOutputDelta(notification: CodexNotification): CodexMappedEvent[] {
    const { itemId, delta } = notification.params as { itemId?: string; delta?: string };
    if (itemId && delta) this.commandOutputBuffer(itemId).append(delta);
    return this.drainPendingAssistantBoundary(false);
  }

  private mapMainItemCompleted(notification: CodexNotification): CodexMappedEvent[] {
    const item = (notification.params as { item?: CompletedItem }).item;
    const itemId = typeof item?.id === "string" ? item.id : undefined;
    const boundaryEvents = this.shouldDrainAssistantBeforeCompletion(item, itemId) ? this.drainAssistantBoundaryBeforeItem(itemId) : [];
    logger.debug("Codex item/completed", { type: item?.type });
    return [...boundaryEvents, ...this.mapItemCompleted(item, notification)];
  }

  private shouldDrainAssistantBeforeCompletion(item: CompletedItem | undefined, itemId: string | undefined): boolean {
    if (!item) return true;
    if (item.type === "agentMessage" || item.type === "message") return false;
    if (item.type !== "collabAgentToolCall") return true;
    if (this.isWaitCollab(item)) return false;
    return !this.isSpawnAgentCollab(item) || !itemId || !this.collabToolUseFromStartIds.has(itemId);
  }

  private mapMainTurnCompleted(notification: CodexNotification): CodexMappedEvent[] {
    const turn = (notification.params as { turn?: { status?: string; error?: { message?: string; codexErrorInfo?: unknown }; usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } } }).turn;
    logger.debug("Codex turn/completed", { status: turn?.status });
    if (turn?.status === "failed") return this.mapFailedMainTurn(turn);
    if (turn?.status === "interrupted") return this.finishInterruptedMainTurn();
    return this.finishCompletedMainTurn(turn?.usage);
  }

  private mapFailedMainTurn(turn: { error?: { message?: string; codexErrorInfo?: unknown } }): CodexMappedEvent[] {
    const error = turn.error?.message ?? "Codex turn failed";
    logger.error("Codex turn failed", { error, codexErrorInfo: turn.error?.codexErrorInfo });
    const events = [...this.drainPendingAssistantBoundary(false), { type: AgentEventType.Error, threadId: this.threadId, error } as CodexMappedEvent];
    this.completeMainTurnState();
    return events;
  }

  private finishInterruptedMainTurn(): CodexMappedEvent[] {
    const events = this.drainPendingAssistantBoundary(false);
    this.completeMainTurnState();
    return events;
  }

  private finishCompletedMainTurn(usage: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined): CodexMappedEvent[] {
    const inputTokens = usage?.input_tokens ?? 0;
    const cachedInputTokens = usage?.cached_input_tokens ?? 0;
    const tokensOut = usage?.output_tokens ?? 0;
    const events = this.drainPendingAssistantBoundary(true);
    if (this.lastCompletedAssistantText) events.push({ type: AgentEventType.Message, threadId: this.threadId, content: this.lastCompletedAssistantText, tokens: null });
    events.push({ type: AgentEventType.TurnComplete, threadId: this.threadId, reason: "end_turn", costUsd: null, tokensIn: inputTokens, tokensOut, contextWindow: undefined, totalProcessedTokens: inputTokens + cachedInputTokens + tokensOut, cacheReadTokens: cachedInputTokens || undefined, providerId: "codex" });
    this.completeMainTurnState();
    return events;
  }

  private completeMainTurnState(): void {
    this.reset();
    this.turnEnded = true;
  }

  private mapMainError(notification: CodexNotification): CodexMappedEvent[] {
    const params = notification.params as { error?: { message?: string }; willRetry?: boolean };
    const error = params.error?.message ?? "Unknown error from codex app-server";
    logger.debug("Codex error notification", { error, willRetry: params.willRetry ?? false });
    const event = params.willRetry ? { type: AgentEventType.ApiRetry, threadId: this.threadId, reason: error } : { type: AgentEventType.Error, threadId: this.threadId, error };
    return [...this.drainPendingAssistantBoundary(false), event];
  }

  /** Resets per-turn accumulated state between turns. */
  reset(): void {
    this.assistantTextByItemId.clear();
    this.currentAssistantItemId = undefined;
    this.currentAssistantItemText = "";
    this.lastCompletedAssistantText = "";
    this.pendingAssistantBoundaryItemId = undefined;
    this.lastReasoningText = "";
    this.planUpdateSeq = 0;
    this.commandOutputBuffers.clear();
    this.startedToolUseSignatures.clear();
    this.collabScopeStack = [];
    this.collabToolUseFromStartIds.clear();
    this.emittedAgentToolUseIds.clear();
    this.openSpawnAgentIds.clear();
    this.completedSpawnAgentIds.clear();
    this.completedSpawnAgentResults.clear();
    this.spawnAgentToolInputById.clear();
    this.childThreadMetadataById.clear();
    this.parentAgentToolCallIdById.clear();
    this.childSpawnEvidenceByCollabId.clear();
    this.childAssistantTextByThreadId.clear();
    this.childAssistantItemIdByThreadId.clear();
    this.pendingChildPromptByThreadId.clear();
    this.emittedChildTurnStarts.clear();
    this.pendingLegacyCollabPops.clear();
    this.earlyChildNotificationsByThread.clear();
    this.earlyChildNotificationCount = 0;
    this.childNotificationsBeforeTurnByThread.clear();
    this.childNotificationsBeforeTurnCount = 0;
    this.replayedChildEvents = [];
    // Note: turnEnded is intentionally NOT cleared here. reset() is called
    // from inside turn/completed, and we want the latch to stay armed until
    // the next turn opens. Use prepareForTurn() before a new outbound turn.
  }

  /**
   * Clears per-turn buffers and re-opens event emission for the next turn.
   * Call from CodexProvider before runTurn on a reused session so streaming
   * tokens are not suppressed while waiting for turn/started.
   */
  prepareForTurn(): void {
    this.reset();
    this.turnEnded = false;
  }

  /**
   * Maps a completed `ThreadItem` to zero or more `AgentEvent` objects.
   */
  private mapItemCompleted(
    item: CompletedItem | undefined,
    notification: CodexNotification,
    route: "main" | "child" = "main",
  ): CodexMappedEvent[] {
    if (!item) return [];
    const handlers: Partial<Record<CompletedItem["type"], () => CodexMappedEvent[]>> = {
      userMessage: () => [],
      agentMessage: () => this.recordAssistantCompletion(item, notification),
      message: () => this.recordAssistantCompletion(item, notification),
      reasoning: () => this.mapCompletedReasoning(item),
      subAgentActivity: () => this.mapCompletedSubAgentActivity(item, notification),
      function_call: () => this.mapCompletedFunctionCall(item, notification),
      commandExecution: () => this.mapCompletedCommand(item, notification),
      fileChange: () => this.mapCompletedFileChange(item, notification),
      collabAgentToolCall: () => this.mapCompletedCollab(item, notification, route),
      mcpToolCall: () => this.mapCompletedMcpTool(item, notification),
      dynamicToolCall: () => this.mapCompletedMcpTool(item, notification),
    };
    const events = dispatchNativeHandler<CodexMappedEvent[]>(handlers, item.type);
    if (events !== undefined) return events;
    return this.consumeCompletedItem(item.type);
  }

  private mapCompletedReasoning(item: CompletedItem): CodexMappedEvent[] {
    const full = this.completedReasoningText(item);
    const delta = full.length > this.lastReasoningText.length ? full.slice(this.lastReasoningText.length) : "";
    this.lastReasoningText = full;
    return delta ? [{ type: AgentEventType.TextDelta, threadId: this.threadId, delta, isFinalResponse: false }] : [];
  }

  private completedReasoningText(item: CompletedItem): string {
    const summary = Array.isArray(item.summary) ? item.summary : [];
    const reasoningContent = Array.isArray(item.reasoningContent) ? item.reasoningContent : [];
    const rawContent = (item as { content?: unknown }).content;
    const content = reasoningContent.length > 0 ? reasoningContent : this.stringContentArray(rawContent);
    return [...summary, ...content].join("\n");
  }

  private stringContentArray(value: unknown): string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : [];
  }

  private mapCompletedSubAgentActivity(item: CompletedItem, notification: CodexNotification): CodexMappedEvent[] {
    return item.id ? this.mapSubAgentActivityStart(item, item.id, false, notification) : [];
  }

  private mapCompletedFunctionCall(item: CompletedItem, notification: CodexNotification): CodexMappedEvent[] {
    const toolCallId = item.id ?? `fc-${randomUUID()}`;
    return this.completedToolEvents(item, toolCallId, notification, { isError: false, output: typeof item.output === "string" ? item.output : "" });
  }

  private mapCompletedCommand(item: CompletedItem, notification: CodexNotification): CodexMappedEvent[] {
    const toolCallId = item.id ?? `cmd-${randomUUID()}`;
    const bufferedOutput = this.takeCommandOutputBuffer(item, toolCallId);
    const fallback = this.commandCompletionOutput(item);
    const exitCode = typeof item.exitCode === "number" && Number.isInteger(item.exitCode) ? item.exitCode : undefined;
    return this.completedToolEvents(item, toolCallId, notification, { isError: item.exitCode != null && item.exitCode !== 0, ...(exitCode !== undefined ? { exitCode } : {}), output: bufferedOutput, fallback });
  }

  private takeCommandOutputBuffer(item: CompletedItem, toolCallId: string): BoundedToolOutputBuffer | undefined {
    const bufferedOutput = this.commandOutputBuffers.get(toolCallId) ?? this.takeMostRecentCommandBuffer(item);
    this.commandOutputBuffers.delete(toolCallId);
    return bufferedOutput;
  }

  private takeMostRecentCommandBuffer(item: CompletedItem): BoundedToolOutputBuffer | undefined {
    if (item.id || this.commandOutputBuffers.size === 0) return undefined;
    const lastKey = [...this.commandOutputBuffers.keys()].pop();
    if (!lastKey) return undefined;
    const buffer = this.commandOutputBuffers.get(lastKey);
    this.commandOutputBuffers.delete(lastKey);
    return buffer;
  }

  private commandCompletionOutput(item: CompletedItem): string {
    if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > 0) return item.aggregatedOutput;
    return typeof item.output === "string" ? item.output : "";
  }

  private mapCompletedFileChange(item: CompletedItem, notification: CodexNotification): CodexMappedEvent[] {
    const toolCallId = item.id ?? `fchg-${randomUUID()}`;
    return this.completedToolEvents(item, toolCallId, notification, { isError: false, output: (item.changes ?? []).map((change) => change.path).join(", ") });
  }

  private mapCompletedMcpTool(item: CompletedItem, notification: CodexNotification): CodexMappedEvent[] {
    const toolCallId = item.id ?? `mcp-${randomUUID()}`;
    return this.completedToolEvents(item, toolCallId, notification, { isError: Boolean(item.error), output: String(item.error ?? item.result ?? "") });
  }

  private completedToolEvents(
    item: CompletedItem,
    toolCallId: string,
    notification: CodexNotification,
    result: { isError: boolean; output: string | BoundedToolOutputBuffer | undefined; fallback?: string; exitCode?: number },
  ): CodexMappedEvent[] {
    const toolUse = this.buildToolUseEvent(item, toolCallId, notification);
    const toolResult = this.toolResultEvent({ toolCallId, ...result });
    return this.shouldEmitCompletionToolUse(toolCallId, toolUse) ? [toolUse, toolResult] : [toolResult];
  }

  private mapCompletedCollab(item: CompletedItem, notification: CodexNotification, route: "main" | "child"): CodexMappedEvent[] {
    const toolCallId = item.id ?? `collab-${randomUUID()}`;
    if (this.isWaitCollab(item)) return this.mapWaitStates(item);
    const isSpawn = this.isSpawnAgentCollab(item);
    if (route === "main") this.rememberPendingChildPrompt(item);
    const toolResult = this.completedCollabToolResult(item, toolCallId);
    const receiverCount = this.prepareCompletedCollab(item, toolCallId, notification, route, isSpawn);
    if (this.collabToolUseFromStartIds.has(toolCallId)) return this.completeStartedCollab(item, toolCallId, route, isSpawn, toolResult);
    if (route === "child") return this.completeChildCollab(item, toolCallId, notification, isSpawn, toolResult);
    return this.completeLegacyCollab(item, toolCallId, notification, isSpawn, receiverCount, toolResult);
  }

  private completedCollabToolResult(item: CompletedItem, toolCallId: string): ToolResultAgentEvent {
    const error = typeof item.error === "string" && item.error.length > 0 ? item.error : undefined;
    const output = typeof item.result === "string" && item.result.length > 0 ? item.result : error ?? `Collaboration (${this.collabToolKind(item)})`;
    return this.toolResultEvent({ toolCallId, isError: Boolean(error), output });
  }

  private prepareCompletedCollab(item: CompletedItem, toolCallId: string, notification: CodexNotification, route: "main" | "child", isSpawn: boolean): number {
    if (!isSpawn) return 0;
    if (route === "child") { this.rememberChildSpawnEvidence(toolCallId, this.childSpawnEvidenceFromNotification(notification, toolCallId, "completed")); this.openSpawnAgentIds.add(toolCallId); }
    const receiverCount = this.registerCollabReceiverThreads(toolCallId, item);
    this.mergeSpawnAgentToolInput(toolCallId, item);
    if (receiverCount === 0) this.openSpawnAgentIds.delete(toolCallId);
    if (receiverCount > 0 && route !== "child") this.openSpawnAgentIds.add(toolCallId);
    return receiverCount;
  }

  private completeStartedCollab(item: CompletedItem, toolCallId: string, route: "main" | "child", isSpawn: boolean, toolResult: ToolResultAgentEvent): CodexMappedEvent[] {
    this.collabToolUseFromStartIds.delete(toolCallId);
    if (route === "main") this.popCollabFromScopeStack(toolCallId);
    if (!isSpawn) return [toolResult];
    const metadataEvents = this.applySpawnItemMetadata(item);
    if (metadataEvents.length > 0) return metadataEvents;
    const completedResult = this.completedSpawnAgentResults.get(toolCallId);
    const toolInput = this.spawnAgentToolInputById.get(toolCallId);
    return completedResult && toolInput ? [{ ...completedResult, toolInput }] : [];
  }

  private completeChildCollab(item: CompletedItem, toolCallId: string, notification: CodexNotification, isSpawn: boolean, toolResult: ToolResultAgentEvent): CodexMappedEvent[] {
    const toolUse = this.buildCollabToolUseEvent(item, toolCallId, notification);
    return isSpawn ? [toolUse] : [toolUse, toolResult];
  }

  private completeLegacyCollab(item: CompletedItem, toolCallId: string, notification: CodexNotification, isSpawn: boolean, receiverCount: number, toolResult: ToolResultAgentEvent): CodexMappedEvent[] {
    const toolUse = this.buildCollabToolUseEvent(item, toolCallId, notification);
    if (this.shouldTrackCollabScope(item, isSpawn, receiverCount)) { this.collabScopeStack.push(toolCallId); this.pendingLegacyCollabPops.add(toolCallId); }
    const shouldEmitToolUse = !this.emittedAgentToolUseIds.has(toolCallId);
    this.emittedAgentToolUseIds.add(toolCallId);
    if (isSpawn) return shouldEmitToolUse ? [toolUse] : [];
    return shouldEmitToolUse ? [toolUse, toolResult] : [toolResult];
  }

  private consumeCompletedItem(itemType: CompletedItem["type"]): CodexMappedEvent[] {
    if (SILENT_ITEM_TYPES.has(itemType)) { logger.debug("Codex item/completed silenced", { itemType }); return []; }
    logger.debug("CodexEventMapper: unrecognized item type in item/completed", { itemType });
    return [];
  }
}
