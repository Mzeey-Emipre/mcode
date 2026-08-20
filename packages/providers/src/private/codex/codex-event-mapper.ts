import { createHash, randomUUID } from "crypto";
import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent, GoalState, ProviderFileMutationStart } from "@mcode/contracts";
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

type ToolResultAgentEvent = Extract<AgentEvent, { type: typeof AgentEventType.ToolResult }>;

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
  private replayedChildEvents: AgentEvent[] = [];
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
    events: AgentEvent[],
    evidence: {
      nativeThreadId: string;
      nativeTurnId?: string;
      parentCollaborationItemId: string;
      prompt?: string;
      nativeItemId?: string;
      itemEventKey?: string;
      outcome?: "completed" | "errored" | "interrupted" | "cancelled";
    },
  ): AgentEvent[] {
    return events.map((event) => ({
      ...event,
      codexChild: {
        ...evidence,
        nativeEventId: this.childNativeEventId(event.type, evidence),
      },
    } as AgentEvent));
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

  private dedupeChildEvents(events: AgentEvent[]): AgentEvent[] {
    const deduped: AgentEvent[] = [];
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
    if (
      notification.method !== "item/started"
      && notification.method !== "item/completed"
      && notification.method !== "turn/started"
      && notification.method !== "turn/completed"
    ) {
      return false;
    }
    if (notification.method === "turn/started" || notification.method === "turn/completed") return true;
    const item = notification.params.item as CompletedItem | undefined;
    if (item?.type === "fileChange" || item?.type === "collabAgentToolCall") return true;
    return item?.type === "function_call"
      && typeof item.name === "string"
      && EARLY_CHILD_FILE_TOOL_NAMES.has(item.name.toLowerCase());
  }

  /** Child receiver threads contribute tool rows only; text and lifecycle stay private to Codex. */
  private mapChildThreadNotification(notification: CodexNotification): AgentEvent[] {
    const { method } = notification;
    const childThreadId = this.notificationThreadId(notification);
    const parentCollaborationItemId = childThreadId
      ? this.collabReceiverThreadToCollabId.get(childThreadId)
      : undefined;
    const explicitNativeTurnId = this.nativeTurnId(notification);
    if (method === "turn/started" && childThreadId && explicitNativeTurnId) {
      this.retainChildThread(childThreadId);
      this.childTurnIdByThreadId.set(childThreadId, explicitNativeTurnId);
    }
    const nativeTurnId = this.bufferedChildTurnId(childThreadId) ?? explicitNativeTurnId;

    if (method === "turn/started" && childThreadId && parentCollaborationItemId && nativeTurnId) {
      const startKey = `${childThreadId}:${nativeTurnId}`;
      if (this.emittedChildTurnStarts.has(startKey)) return [];
      this.emittedChildTurnStarts.add(startKey);
      this.childAssistantTextByThreadId.delete(childThreadId);
      this.childAssistantItemIdByThreadId.delete(childThreadId);
      const prompt = this.pendingChildPromptByThreadId.get(childThreadId)
        ?? this.stringField(
          this.spawnAgentToolInputById.get(parentCollaborationItemId) ?? {},
          "prompt",
        );
      this.pendingChildPromptByThreadId.delete(childThreadId);
      const turnStarted: AgentEvent = {
        type: AgentEventType.TurnStarted,
        threadId: this.threadId,
        codexChild: {
          nativeThreadId: childThreadId,
          nativeTurnId,
          parentCollaborationItemId,
          ...(prompt ? { prompt } : {}),
          nativeEventId: this.childNativeEventId("turnStarted", {
            nativeThreadId: childThreadId,
            nativeTurnId,
            parentCollaborationItemId,
          }),
        },
      };
      const pending = this.drainChildNotificationsBeforeTurn(childThreadId);
      return pending.length === 0
        ? [turnStarted]
        : [
            turnStarted,
            ...pending.flatMap((pendingNotification) => (
              this.mapChildThreadNotification(pendingNotification)
            )),
          ];
    }

    if (method === "item/commandExecution/outputDelta") {
      const { itemId, delta } = notification.params;
      if (itemId && delta) {
        this.commandOutputBuffer(itemId).append(delta);
      }
      return [];
    }

    if (method === "item/agentMessage/delta") {
      const delta = notification.params.delta;
      const itemId = typeof notification.params.itemId === "string"
        ? notification.params.itemId
        : undefined;
      if (childThreadId && itemId) this.childAssistantItemIdByThreadId.set(childThreadId, itemId);
      this.appendChildAssistantText(childThreadId, delta);
      return [];
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      // Reasoning deltas have no stable native event id. The completed reasoning
      // item carries the full text and exact native item id.
      return [];
    }

    if (method === "error") {
      const error = notification.params.error;
      const message = typeof error?.message === "string" ? error.message : "Unknown child error";
      if (!childThreadId || !parentCollaborationItemId || !nativeTurnId) return [];
      return this.withChildEvidence([{
        type: AgentEventType.Error,
        threadId: this.threadId,
        error: message,
      }], {
        nativeThreadId: childThreadId,
        nativeTurnId,
        parentCollaborationItemId,
        nativeItemId: "turn-error",
        itemEventKey: "error",
        outcome: "errored",
      });
    }

    if (method === "item/started") {
      const item = notification.params.item as CompletedItem | undefined;
      const itemType = item?.type;
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (itemType === "subAgentActivity" && itemId && item) {
        const events = this.mapSubAgentActivityStart(item, itemId, true, notification);
        return childThreadId && parentCollaborationItemId
          ? this.withChildEvidence(events, {
              nativeThreadId: childThreadId,
              ...(nativeTurnId ? { nativeTurnId } : {}),
              parentCollaborationItemId,
              nativeItemId: itemId,
              itemEventKey: "started",
            })
          : events;
      }
      if (itemType === "collabAgentToolCall" && itemId && item) {
        if (this.isWaitCollab(item)) return [];
        this.rememberPendingChildPrompt(item);
        this.collabToolUseFromStartIds.add(itemId);
        if (this.isSpawnAgentCollab(item) && this.registerCollabReceiverThreads(itemId, item, true) > 0) {
          this.openSpawnAgentIds.add(itemId);
        }
        if (this.emittedAgentToolUseIds.has(itemId)) return [];
        this.emittedAgentToolUseIds.add(itemId);
        const events = [this.buildCollabToolUseEvent(item, itemId, notification)];
        return childThreadId && parentCollaborationItemId
          ? this.withChildEvidence(events, {
              nativeThreadId: childThreadId,
              ...(nativeTurnId ? { nativeTurnId } : {}),
              parentCollaborationItemId,
              nativeItemId: itemId,
              itemEventKey: "started",
            })
          : events;
      }
      if (itemType && itemId && TOOL_LIKE_ITEM_TYPES.has(itemType) && itemType !== "webSearch") {
        const toolUse = this.buildToolUseEvent(item as CompletedItem, itemId, notification);
        if (toolUse) {
          this.startedToolUseSignatures.set(itemId, this.toolUseSignature(toolUse));
          return childThreadId && parentCollaborationItemId
            ? this.withChildEvidence([toolUse], {
                nativeThreadId: childThreadId,
                ...(nativeTurnId ? { nativeTurnId } : {}),
                parentCollaborationItemId,
                nativeItemId: itemId,
                itemEventKey: "started",
              })
            : [toolUse];
        }
      }
      logger.debug("Codex child thread notification consumed", { method, itemType });
      return [];
    }

    if (method === "item/completed") {
      const item = notification.params.item;
      const itemType = item?.type;
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (item && itemType === "subAgentActivity" && itemId) {
        const events = this.mapSubAgentActivityStart(item, itemId, false, notification);
        return childThreadId && parentCollaborationItemId
          ? this.withChildEvidence(events, {
              nativeThreadId: childThreadId,
              ...(nativeTurnId ? { nativeTurnId } : {}),
              parentCollaborationItemId,
              nativeItemId: itemId,
              itemEventKey: "completed",
            })
          : events;
      }
      if (
        itemType === "commandExecution"
        || itemType === "fileChange"
        || itemType === "mcpToolCall"
        || itemType === "dynamicToolCall"
        || itemType === "function_call"
        || itemType === "reasoning"
        || itemType === "collabAgentToolCall"
      ) {
        const events = this.mapItemCompleted(item, notification, "child");
        return childThreadId && parentCollaborationItemId
          ? this.withChildEvidence(events, {
              nativeThreadId: childThreadId,
              ...(nativeTurnId ? { nativeTurnId } : {}),
              parentCollaborationItemId,
              ...(itemId ? { nativeItemId: itemId, itemEventKey: "completed" } : {}),
            })
          : events;
      }
      if (itemType === "agentMessage" || itemType === "message") {
        if (childThreadId && itemId) this.childAssistantItemIdByThreadId.set(childThreadId, itemId);
        this.mergeChildAssistantFullText(childThreadId, this.completedMessageText(item as CompletedItem));
        return [];
      }
      logger.debug("Codex child thread notification consumed", { method, itemType });
      return [];
    }

    if (method === "turn/completed") {
      const collabId = childThreadId ? this.collabReceiverThreadToCollabId.get(childThreadId) : undefined;
      const turn = notification.params.turn;
      const status = turn?.status;
      const output =
        childThreadId != null
          ? (this.childAssistantTextByThreadId.get(childThreadId) ?? turn?.error?.message ?? "")
          : (turn?.error?.message ?? "");
      const completion = this.completeSpawnAgent(collabId, output, status === "failed");
      if (!childThreadId || !collabId || !nativeTurnId) return completion;
      const childOutput = output instanceof BoundedToolOutputBuffer
        ? output.retainedText()
        : output;
      const nativeItemId = this.childAssistantItemIdByThreadId.get(childThreadId) ?? nativeTurnId;
      const evidence = {
        nativeThreadId: childThreadId,
        nativeTurnId,
        parentCollaborationItemId: collabId,
        outcome: status === "failed"
          ? "errored"
          : status === "interrupted"
            ? "interrupted"
            : "completed",
        nativeItemId,
        itemEventKey: "completed",
      } as const;
      const childEvents: AgentEvent[] = [];
      if (childOutput) {
        childEvents.push(...this.withChildEvidence([{
          type: AgentEventType.Message,
          threadId: this.threadId,
          content: childOutput,
          tokens: null,
        }], evidence));
      }
      childEvents.push(...this.withChildEvidence([{
        type: AgentEventType.TurnComplete,
        threadId: this.threadId,
        reason: status === "failed"
          ? "failed"
          : status === "interrupted"
            ? "interrupted"
            : "completed",
        costUsd: null,
        tokensIn: 0,
        tokensOut: 0,
      }], evidence));
      return [...childEvents, ...completion];
    }

    logger.debug("Codex child thread notification consumed", { method });
    return [];
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
    const raw = item as unknown as Record<string, unknown>;
    const receiverThreadIds = new Set<string>();
    const ids = raw.receiverThreadIds;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "string" && id.length > 0) {
          receiverThreadIds.add(id);
        }
      }
    }
    const agentsStates = raw.agentsStates;
    if (agentsStates && typeof agentsStates === "object") {
      for (const childThreadId of Object.keys(agentsStates as Record<string, unknown>)) {
        if (childThreadId.length > 0) {
          receiverThreadIds.add(childThreadId);
        }
      }
    }
    for (const id of receiverThreadIds) {
      this.registerReceiverThread(collabId, id);
      if (requireTurnEvidence) this.strictChildTurnThreads.add(id);
    }
    return receiverThreadIds.size;
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
    const receiverThreadIds = Array.isArray(raw.receiverThreadIds)
      ? [...new Set(raw.receiverThreadIds.filter((value): value is string => (
          typeof value === "string" && value.trim().length > 0
        )).map((value) => value.trim().slice(0, 512)))].slice(0, 32)
      : [];
    const childMetadata = receiverThreadIds.length === 1
      ? this.childThreadMetadataById.get(receiverThreadIds[0]!)
      : undefined;
    const taskName = this.stringField(raw, "task_name")
      ?? this.taskNameFromPrompt(prompt)
      ?? childMetadata?.agentName;
    const model = this.stringField(raw, "model") ?? childMetadata?.model;
    const reasoningEffort = this.stringField(raw, "reasoningEffort")
      ?? this.stringField(raw, "reasoning_effort")
      ?? childMetadata?.reasoningEffort;
    return {
      codexCollabKind: kind,
      ...(taskName ? { agentName: taskName } : {}),
      ...(prompt ? { description: this.promptDescription(prompt), prompt: prompt.slice(0, 32_768) } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(!this.isSpawnAgentCollab(item) && senderThreadId ? { senderThreadId } : {}),
      ...(receiverThreadIds.length > 0 ? { receiverThreadIds } : {}),
    };
  }

  /** Associates a parent follow-up prompt with the next turn of its exact child receiver. */
  private rememberPendingChildPrompt(item: CompletedItem): void {
    if (this.isSpawnAgentCollab(item) || this.isWaitCollab(item)) return;
    const raw = item as unknown as Record<string, unknown>;
    const prompt = this.stringField(raw, "prompt");
    if (!prompt || !Array.isArray(raw.receiverThreadIds)) return;
    for (const value of raw.receiverThreadIds) {
      if (
        typeof value === "string"
        && this.collabReceiverThreadToCollabId.has(value)
      ) {
        this.pendingChildPromptByThreadId.set(value, prompt.slice(0, 32_768));
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
  private applySpawnItemMetadata(item: CompletedItem): AgentEvent[] {
    const raw = item as unknown as Record<string, unknown>;
    const model = this.stringField(raw, "model");
    const reasoningEffort =
      this.stringField(raw, "reasoningEffort")
      ?? this.stringField(raw, "reasoning_effort");
    if (!model || !reasoningEffort) return [];

    const receiverThreadIds = new Set<string>();
    if (Array.isArray(raw.receiverThreadIds)) {
      for (const value of raw.receiverThreadIds) {
        if (typeof value === "string" && value.length > 0) receiverThreadIds.add(value);
      }
    }
    if (raw.agentsStates && typeof raw.agentsStates === "object") {
      for (const childThreadId of Object.keys(raw.agentsStates as Record<string, unknown>)) {
        if (childThreadId.length > 0) receiverThreadIds.add(childThreadId);
      }
    }

    return [...receiverThreadIds].flatMap((childThreadId) => (
      this.applyChildThreadMetadata(childThreadId, { model, reasoningEffort })
    ));
  }

  /** Maps native Codex sub-agent activity to Agent and persisted lifecycle records. */
  private mapSubAgentActivityStart(
    item: CompletedItem,
    toolCallId: string,
    includeInteractions: boolean,
    notification?: CodexNotification,
  ): AgentEvent[] {
    const agentThreadId = this.stringField(item, "agentThreadId");
    const agentPath = this.stringField(item, "agentPath");
    if (!agentThreadId || !agentPath) return [];

    const agentName = agentPath.split("/").filter(Boolean).pop() ?? agentPath;
    const notificationThreadId = notification
      ? this.notificationThreadId(notification)
      : undefined;
    const sourceAgentToolCallId = notificationThreadId
      ? this.collabReceiverThreadToCollabId.get(notificationThreadId)
      : undefined;
    const sourceToolInput = sourceAgentToolCallId
      ? this.spawnAgentToolInputById.get(sourceAgentToolCallId)
      : undefined;
    const sourceAgentName = sourceToolInput
      ? this.stringField(sourceToolInput, "agentName")
      : undefined;
    const childThreadMetadata = this.childThreadMetadataById.get(agentThreadId);
    if (item.kind === "interacted" && includeInteractions) {
      this.subagentInteractionSequence += 1;
      const lifecycleToolCallId =
        `subagent-activity:${toolCallId.slice(0, MAX_LIFECYCLE_PARENT_ID_LENGTH)}:${this.subagentInteractionSequence}`;
      const toolInput = {
        ...(sourceAgentName ? { sourceAgentName } : {}),
        ...(sourceAgentToolCallId ? { sourceAgentToolCallId } : {}),
        lifecycle: "updated",
        agentName,
        agentPath,
      };
      return [{
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId: lifecycleToolCallId,
        toolName: SUBAGENT_LIFECYCLE_TOOL_NAME,
        toolInput,
        parentToolCallId: toolCallId,
      }, this.toolResultEvent({
        toolCallId: lifecycleToolCallId,
        output: "",
        isError: false,
      })];
    }
    if (item.kind !== "started") return [];

    const toolInput = {
      codexCollabKind: "spawnAgent",
      agentName,
      agentPath,
      description: agentName,
      receiverThreadIds: [agentThreadId],
      ...childThreadMetadata,
    };
    this.spawnAgentToolInputById.set(toolCallId, toolInput);
    if (sourceAgentToolCallId) this.parentAgentToolCallIdById.set(toolCallId, sourceAgentToolCallId);
    this.registerReceiverThread(toolCallId, agentThreadId);
    this.openSpawnAgentIds.add(toolCallId);
    if (this.emittedAgentToolUseIds.has(toolCallId)) return [];

    this.collabToolUseFromStartIds.add(toolCallId);
    this.emittedAgentToolUseIds.add(toolCallId);
    return [{
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName: "Agent",
      toolInput,
      ...(sourceAgentToolCallId ? { parentToolCallId: sourceAgentToolCallId } : {}),
      ...(sourceAgentToolCallId ? {
        codexChild: {
          nativeThreadId: agentThreadId,
          ...(notification && this.nativeTurnId(notification)
            ? { nativeTurnId: this.nativeTurnId(notification) }
            : {}),
          parentCollaborationItemId: sourceAgentToolCallId,
          nativeItemId: toolCallId,
          itemEventKey: includeInteractions ? "started" : "completed",
        },
      } : {}),
    }];
  }

  /** Stores authoritative child-thread settings and updates any mapped Agent row. */
  private mapThreadSettingsUpdated(params: ThreadSettingsUpdatedPayload): AgentEvent[] {
    const childThreadId = params.threadId;
    const settings = params.threadSettings;
    if (!childThreadId || !settings || typeof settings !== "object" || Array.isArray(settings)) return [];

    const record = settings as Record<string, unknown>;
    const model = this.stringField(record, "model");
    const reasoningEffort = this.stringField(record, "effort");
    if (!model || !reasoningEffort) return [];
    return this.applyChildThreadMetadata(childThreadId, { model, reasoningEffort });
  }

  /** Applies authoritative child-thread model settings to the matching Agent row. */
  applyChildThreadMetadata(
    childThreadId: string,
    metadata: { identity?: string; model?: string; reasoningEffort?: string },
  ): AgentEvent[] {
    if (!childThreadId || (!metadata.identity && !metadata.model && !metadata.reasoningEffort)) return [];

    const toolMetadata = {
      ...(metadata.identity ? { agentName: metadata.identity } : {}),
      ...(metadata.model ? { model: metadata.model } : {}),
      ...(metadata.reasoningEffort ? { reasoningEffort: metadata.reasoningEffort } : {}),
    };
    this.childThreadMetadataById.set(childThreadId, toolMetadata);
    const toolCallId = this.collabReceiverThreadToCollabId.get(childThreadId);
    const existingToolInput = toolCallId ? this.spawnAgentToolInputById.get(toolCallId) : undefined;
    if (!toolCallId || !existingToolInput) return [];

    const toolInput = { ...existingToolInput, ...toolMetadata };
    this.spawnAgentToolInputById.set(toolCallId, toolInput);
    const completedResult = this.completedSpawnAgentResults.get(toolCallId);
    if (completedResult) return [{ ...completedResult, toolInput }];

    return [{
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName: "Agent",
      toolInput,
      ...(this.parentAgentToolCallIdById.get(toolCallId)
        ? { parentToolCallId: this.parentAgentToolCallIdById.get(toolCallId) }
        : {}),
    }];
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
  ): AgentEvent[] {
    if (!collabId || this.completedSpawnAgentIds.has(collabId)) return [];
    if (!this.openSpawnAgentIds.has(collabId)) return [];
    this.completedSpawnAgentIds.add(collabId);
    this.openSpawnAgentIds.delete(collabId);
    this.popCollabFromScopeStack(collabId);
    const toolInput = this.spawnAgentToolInputById.get(collabId);
    const result = this.toolResultEvent({ toolCallId: collabId, output, isError, toolInput });
    this.completedSpawnAgentResults.set(collabId, result);
    return [result];
  }

  /** Maps a `wait` collab's per-child state payload into Agent ToolResults. */
  private mapWaitStates(item: CompletedItem): AgentEvent[] {
    const raw = item as unknown as Record<string, unknown>;
    const agentsStates = raw.agentsStates;
    if (!agentsStates || typeof agentsStates !== "object") return [];

    const events: AgentEvent[] = [];
    for (const [childThreadId, state] of Object.entries(agentsStates as Record<string, unknown>)) {
      if (!state || typeof state !== "object") continue;
      const record = state as Record<string, unknown>;
      const status = typeof record.status === "string" ? record.status : "";
      if (status !== "completed" && status !== "failed") continue;
      const collabId = this.collabReceiverThreadToCollabId.get(childThreadId);
      const message = typeof record.message === "string"
        ? record.message
        : (this.childAssistantTextByThreadId.get(childThreadId) ?? "");
      events.push(...this.completeSpawnAgent(collabId, message, status === "failed"));
    }
    return events;
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
  ): AgentEvent {
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
  ): AgentEvent | undefined {
    const itemType = item.type;
    const nestParent = this.nestingParentToolCallId(notification);

    if (itemType === "function_call") {
      return {
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId,
        toolName: typeof item.name === "string" ? item.name : "function",
        toolInput: this.parseToolArguments(item.arguments),
        ...(nestParent ? { parentToolCallId: nestParent } : {}),
      };
    }

    if (itemType === "commandExecution") {
      return {
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId,
        toolName: "command_execution",
        toolInput: typeof item.command === "string" && item.command.length > 0
          ? { command: item.command }
          : {},
        ...(nestParent ? { parentToolCallId: nestParent } : {}),
      };
    }

    if (itemType === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return {
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId,
        toolName: "file_change",
        toolInput: changes.length > 0
          ? {
              files: changes.map((change) => change.path).filter(Boolean).join(", "),
              changes: changes
                .filter((change) => typeof change.path === "string" && change.path.length > 0)
                .slice(0, 256)
                .map((change) => ({ path: change.path, kind: change.kind })),
            }
          : {},
        ...(nestParent ? { parentToolCallId: nestParent } : {}),
      };
    }

    if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
      const toolName = itemType === "mcpToolCall"
        ? `mcp:${item.server ?? ""}/${item.tool ?? item.name ?? "unknown"}`
        : (item.name ?? "dynamic_tool");
      return {
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId,
        toolName,
        toolInput: this.parseToolArguments(item.arguments),
        ...(nestParent ? { parentToolCallId: nestParent } : {}),
      };
    }

    return undefined;
  }

  /** Stable enough for same-turn start/completion enrichment checks. */
  private toolUseSignature(event: AgentEvent): string {
    if (event.type !== AgentEventType.ToolUse) return "";
    return JSON.stringify({
      toolName: event.toolName,
      toolInput: event.toolInput,
      parentToolCallId: event.parentToolCallId ?? null,
    });
  }

  /** Returns true when completion has new ToolUse details worth broadcasting. */
  private shouldEmitCompletionToolUse(toolCallId: string, event: AgentEvent | undefined): event is AgentEvent {
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
  drainPendingAssistantBoundary(isFinalResponse = false): AgentEvent[] {
    if (!this.hasOpenAssistantText()) return [];
    if (isFinalResponse && this.lastCompletedAssistantText.length === 0) {
      this.lastCompletedAssistantText = this.currentAssistantItemText;
    }
    const event: AgentEvent = {
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
  private drainAssistantBoundaryBeforeItem(nextItemId?: string): AgentEvent[] {
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
  ): AgentEvent[] {
    const itemId = this.assistantItemId(notification, item);
    const completedText = this.assistantTextFromCompletedItem(item);
    const hasSpecificItemId = itemId !== FALLBACK_ASSISTANT_ITEM_ID;
    if (
      hasSpecificItemId
      && this.currentAssistantItemId === FALLBACK_ASSISTANT_ITEM_ID
      && this.currentAssistantItemText.length > 0
      && !this.assistantTextByItemId.has(itemId)
    ) {
      this.assistantTextByItemId.delete(FALLBACK_ASSISTANT_ITEM_ID);
      this.assistantTextByItemId.set(itemId, this.currentAssistantItemText);
      this.currentAssistantItemId = itemId;
    }
    const boundaryEvents = this.drainAssistantBoundaryBeforeItem(itemId);
    const previousText = this.assistantTextByItemId.get(itemId) ?? "";
    const events: AgentEvent[] = [...boundaryEvents];

    if (completedText.length > 0) {
      const delta = completedText.length > previousText.length
        ? completedText.slice(previousText.length)
        : "";
      if (delta.length > 0) {
        events.push({
          type: AgentEventType.TextDelta,
          threadId: this.threadId,
          delta,
          isFinalResponse: false,
        });
      }
      this.assistantTextByItemId.set(itemId, completedText);
      this.currentAssistantItemId = itemId;
      this.currentAssistantItemText = completedText;
    }

    const text = this.assistantTextByItemId.get(itemId) ?? "";
    if (text.length > 0) {
      this.lastCompletedAssistantText = text;
      this.pendingAssistantBoundaryItemId = itemId;
    }
    return events;
  }

  /**
   * Translates a single `CodexNotification` into zero or more `AgentEvent` objects.
   * Returns an empty array for silently consumed notification types.
   */
  mapNotification(notification: CodexNotification): AgentEvent[] {
    this.replayedChildEvents = [];
    const events = this.mapNotificationInternal(notification);
    return this.dedupeChildEvents(
      this.replayedChildEvents.length > 0
        ? [...events, ...this.replayedChildEvents]
        : events,
    );
  }

  private mapNotificationInternal(notification: CodexNotification): AgentEvent[] {
    const { method } = notification;
    if (method === "warning") {
      logger.warn("Codex warning notification", { method, params: notification.params });
      return [];
    }

    if (method === "thread/settings/updated") {
      return this.mapThreadSettingsUpdated(notification.params as ThreadSettingsUpdatedPayload);
    }

    const route = this.classifyNotificationThread(notification);

    if (route === "unknown") {
      if (this.bufferEligibleEarlyChildNotification(notification)) return [];
      logger.warn("CodexEventMapper: dropping unknown-thread notification", {
        method,
        notificationThreadId: this.notificationThreadId(notification),
        mainCodexThreadId: this.mainCodexThreadId,
      });
      return [];
    }

    if (route === "child") {
      const childThreadId = this.notificationThreadId(notification);
      if (this.markChildNativeNotification(notification)) return [];
      const knownNativeTurnId = this.bufferedChildTurnId(childThreadId);
      const turnEvidenceMethod = notification.method === "item/started"
        || notification.method === "item/completed";
      if (
        childThreadId
        && this.strictChildTurnThreads.has(childThreadId)
        && !knownNativeTurnId
        && turnEvidenceMethod
      ) {
        this.bufferChildNotificationBeforeTurn(notification);
        return [];
      }
      return this.mapChildThreadNotification(notification);
    }

    if (method === "thread/goal/updated") {
      const goal = this.mapThreadGoal(notification.params.goal, notification.params.turnId ?? null);
      const events: AgentEvent[] = [{
        type: AgentEventType.GoalUpdated,
        threadId: this.threadId,
        goal,
      }];
      if (goal.status === "complete") {
        events.push({
          type: AgentEventType.Message,
          threadId: this.threadId,
          content: `Goal achieved in ${goal.timeUsedSeconds}s.`,
          tokens: null,
        });
        events.push({
          type: AgentEventType.GoalCleared,
          threadId: this.threadId,
          providerId: "codex",
          reason: "completed",
          turnId: goal.turnId ?? null,
        });
      }
      return events;
    }

    if (method === "thread/goal/cleared") {
      return [{
        type: AgentEventType.GoalCleared,
        threadId: this.threadId,
        providerId: "codex",
        reason: "cleared",
        turnId: notification.params.turnId ?? null,
      }];
    }

    if (method === "mcpServer/startupStatus/updated") {
      const serverThreadId = notification.params.threadId ?? this.mainCodexThreadId;
      if (!serverThreadId) {
        logger.warn("CodexEventMapper: dropping MCP startup status without thread id", {
          name: notification.params.name,
          status: notification.params.status,
        });
        return [];
      }
      const error = typeof notification.params.error === "string"
        ? notification.params.error
        : undefined;
      const failureReason = typeof notification.params.failureReason === "string"
        ? notification.params.failureReason
        : undefined;
      const rawStatus = notification.params.status as string;
      const status: McpServerStartupStatus = rawStatus === "error"
        ? "failed"
        : notification.params.status;
      return [{
        type: AgentEventType.McpServerStartupStatus,
        threadId: this.threadId,
        providerId: "codex",
        serverThreadId,
        name: notification.params.name,
        status,
        ...(error ? { error } : {}),
        ...(failureReason ? { failureReason } : {}),
      }];
    }

    // turn/started: starts a new turn. Clear the suppress flag so we resume
    // emitting events. (Per-turn buffer reset happens in turn/completed.)
    if (method === "turn/started") {
      this.turnEnded = false;
      logger.debug("Codex lifecycle notification", { method });
      return [];
    }

    // Suppress any trailing notifications that arrive AFTER turn/completed —
    // late `item/reasoning/textDelta` or `item/agentMessage/delta` events would
    // otherwise keep growing the thought timeline after the turn footer says
    // "done" (the visual "thoughts keep scrolling" bug).
    if (this.turnEnded) {
      logger.debug("Codex notification ignored after turn/completed", { method });
      return [];
    }

    if (method === "item/started") {
      const item = notification.params.item as CompletedItem | undefined;
      const itemType = item?.type;
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (itemType === "collabAgentToolCall" && item && this.isWaitCollab(item)) {
        return [];
      }
      const boundaryEvents = this.drainAssistantBoundaryBeforeItem(itemId);
      if (itemType === "subAgentActivity" && item && itemId) {
        return [...boundaryEvents, ...this.mapSubAgentActivityStart(item, itemId, true, notification)];
      }
      // The coordinator started a new tool-like item: any legacy collab whose
      // children have finished should be popped now so this new tool doesn't
      // accidentally inherit it as a parent.
      if (itemType && TOOL_LIKE_ITEM_TYPES.has(itemType) && itemType !== "collabAgentToolCall" && this.pendingLegacyCollabPops.size > 0) {
        for (const legacyId of this.pendingLegacyCollabPops) {
          this.popCollabFromScopeStack(legacyId);
        }
        this.pendingLegacyCollabPops.clear();
      }
      if (itemType === "collabAgentToolCall" && itemId) {
        const collabItem = item as CompletedItem;
        const isSpawn = this.isSpawnAgentCollab(collabItem);
        this.rememberPendingChildPrompt(collabItem);
        const receiverCount = isSpawn ? this.registerCollabReceiverThreads(itemId, collabItem, true) : 0;
        if (this.collabToolUseFromStartIds.has(itemId)) {
          if (isSpawn) {
            this.mergeSpawnAgentToolInput(itemId, collabItem);
            if (receiverCount > 0) this.openSpawnAgentIds.add(itemId);
          }
          return boundaryEvents;
        }
        const alreadyEmitted = this.emittedAgentToolUseIds.has(itemId);
        const toolUseEvent = this.buildCollabToolUseEvent(collabItem, itemId, notification);
        if (this.shouldTrackCollabScope(collabItem, isSpawn, receiverCount)) {
          this.collabScopeStack.push(itemId);
        }
        this.collabToolUseFromStartIds.add(itemId);
        this.emittedAgentToolUseIds.add(itemId);
        if (isSpawn && receiverCount > 0) {
          this.openSpawnAgentIds.add(itemId);
        }
        return alreadyEmitted ? boundaryEvents : [...boundaryEvents, toolUseEvent];
      }
      if (itemType && itemId && TOOL_LIKE_ITEM_TYPES.has(itemType) && itemType !== "webSearch") {
        const toolUse = this.buildToolUseEvent(item as CompletedItem, itemId, notification);
        if (toolUse) {
          this.startedToolUseSignatures.set(itemId, this.toolUseSignature(toolUse));
          return [...boundaryEvents, toolUse];
        }
      }
      logger.debug("Codex lifecycle notification", { method, itemType });
      return boundaryEvents;
    }

    // Streaming reasoning summaries from the Codex app-server (Responses API reasoning item).
    // `isFinalResponse: false` routes text into thought segments like Claude extended thinking.
    if (
      method === "item/reasoning/textDelta"
      || method === "item/reasoning/summaryTextDelta"
    ) {
      const p = notification.params;
      const delta =
        typeof p.delta === "string"
          ? p.delta
          : typeof p.text === "string"
            ? p.text
            : "";
      if (!delta) return [];
      const boundaryEvents = this.drainPendingAssistantBoundary(false);
      this.lastReasoningText += delta;
      return [...boundaryEvents, {
        type: AgentEventType.TextDelta,
        threadId: this.threadId,
        delta,
        isFinalResponse: false,
      }];
    }

    if (method === "item/reasoning/summaryPartAdded") {
      return [];
    }

    // Experimental plan stream: Codex often surfaces live "thinking" style text here rather than reasoning.
    if (method === "item/plan/delta") {
      const p = notification.params as { delta?: string };
      const delta = typeof p.delta === "string" ? p.delta : "";
      if (!delta) return [];
      const boundaryEvents = this.drainPendingAssistantBoundary(false);
      return [...boundaryEvents, {
        type: AgentEventType.TextDelta,
        threadId: this.threadId,
        delta,
        isFinalResponse: false,
      }];
    }

    if (method === "turn/plan/updated") {
      const p = notification.params as {
        turnId?: string;
        explanation?: string;
        plan?: unknown;
      };
      if (!Array.isArray(p.plan) || p.plan.length === 0) return [];
      const boundaryEvents = this.drainPendingAssistantBoundary(false);
      const toolCallId = `codex-plan-${p.turnId ?? "unknown"}-${++this.planUpdateSeq}`;
      return [...boundaryEvents, {
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId,
        toolName: "update_plan",
        toolInput: {
          ...(typeof p.explanation === "string" && p.explanation.length > 0
            ? { explanation: p.explanation }
            : {}),
          plan: p.plan,
        },
      }, {
        type: AgentEventType.ToolResult,
        threadId: this.threadId,
        toolCallId,
        output: "Plan updated",
        isError: false,
      }];
    }

    // Streaming assistant text token. Codex has no stop reason, so every
    // assistant delta streams as narration until a later boundary promotes the
    // last assistant item to the final response at turn completion.
    if (method === "item/agentMessage/delta") {
      const delta = notification.params.delta;
      if (!delta) return [];
      const itemId = this.assistantItemId(notification);
      const boundaryEvents = this.drainAssistantBoundaryBeforeItem(itemId);
      this.recordAssistantDelta(itemId, delta);
      return [...boundaryEvents, {
        type: AgentEventType.TextDelta,
        threadId: this.threadId,
        delta,
        isFinalResponse: false,
      }];
    }

    // Streaming shell command output - accumulate per item for inclusion in ToolResult
    if (method === "item/commandExecution/outputDelta") {
      const boundaryEvents = this.drainPendingAssistantBoundary(false);
      const { itemId, delta } = notification.params;
      if (itemId && delta) {
        this.commandOutputBuffer(itemId).append(delta);
      }
      return boundaryEvents;
    }

    if (method === "item/completed") {
      const completedItem = notification.params.item;
      const completedType = completedItem?.type;
      const completedId = typeof completedItem?.id === "string" ? completedItem.id : undefined;
      const isAssistantItem = completedType === "agentMessage" || completedType === "message";
      const collabCompletedItem = completedType === "collabAgentToolCall" ? completedItem : undefined;
      const isWaitCompletion = collabCompletedItem ? this.isWaitCollab(collabCompletedItem) : false;
      const isStartedSpawnCompletion =
        collabCompletedItem != null
        && completedId != null
        && this.isSpawnAgentCollab(collabCompletedItem)
        && this.collabToolUseFromStartIds.has(completedId);
      const boundaryEvents =
        isAssistantItem || isWaitCompletion || isStartedSpawnCompletion
          ? []
          : this.drainAssistantBoundaryBeforeItem(completedId);
      logger.debug("Codex item/completed", { type: completedType });
      return [...boundaryEvents, ...this.mapItemCompleted(completedItem, notification)];
    }

    if (method === "turn/completed") {
      const turn = notification.params.turn;
      logger.debug("Codex turn/completed", { status: turn?.status });

      // Failed turn: emit Error rather than TurnComplete to avoid overwriting "errored" status
      if (turn?.status === "failed") {
        const errorMsg = turn.error?.message ?? "Codex turn failed";
        logger.error("Codex turn failed", { error: errorMsg, codexErrorInfo: turn.error?.codexErrorInfo });
        const boundaryEvents = this.drainPendingAssistantBoundary(false);
        this.reset();
        this.turnEnded = true;
        return [...boundaryEvents, { type: AgentEventType.Error, threadId: this.threadId, error: errorMsg }];
      }

      if (turn?.status === "interrupted") {
        const boundaryEvents = this.drainPendingAssistantBoundary(false);
        this.reset();
        this.turnEnded = true;
        return boundaryEvents;
      }

      const boundaryEvents = this.drainPendingAssistantBoundary(true);
      const text = this.lastCompletedAssistantText;
      const usage = turn?.usage ?? {};
      const inputTokens = usage.input_tokens ?? 0;
      const cachedInputTokens = usage.cached_input_tokens ?? 0;
      const tokensIn = inputTokens;
      const tokensOut = usage.output_tokens ?? 0;
      const totalProcessedTokens = inputTokens + cachedInputTokens + tokensOut;

      const events: AgentEvent[] = [...boundaryEvents];
      if (text) {
        events.push({ type: AgentEventType.Message, threadId: this.threadId, content: text, tokens: null });
      }
      events.push({
        type: AgentEventType.TurnComplete,
        threadId: this.threadId,
        reason: "end_turn",
        costUsd: null,
        tokensIn,
        tokensOut,
        contextWindow: undefined,
        totalProcessedTokens,
        cacheReadTokens: cachedInputTokens || undefined,
        providerId: "codex",
      });
      this.reset();
      // After reset, latch the turn-ended flag so trailing notifications
      // from the codex CLI cannot leak into the timeline. `turn/started`
      // (next turn) clears the flag.
      this.turnEnded = true;
      return events;
    }

    if (method === "error") {
      // params.error.message, not params.message (canonical shape from codex-rs source)
      const errorMsg = notification.params.error?.message ?? "Unknown error from codex app-server";
      const willRetry = notification.params.willRetry ?? false;
      logger.debug("Codex error notification", { error: errorMsg, willRetry });
      const boundaryEvents = this.drainPendingAssistantBoundary(false);
      if (willRetry) {
        return [...boundaryEvents, { type: AgentEventType.ApiRetry, threadId: this.threadId, reason: errorMsg }];
      }
      return [...boundaryEvents, { type: AgentEventType.Error, threadId: this.threadId, error: errorMsg }];
    }

    if (SILENCED_METHODS.has(method)) {
      logger.debug("Codex notification silenced", { method });
      return [];
    }

    logger.warn("CodexEventMapper: unrecognized notification", { method: (notification as { method: string }).method });
    return [];
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
  ): AgentEvent[] {
    if (!item) return [];

    const { threadId } = this;
    const itemType = item.type;

    if (itemType === "userMessage") {
      // Echo of the user's own message - silently consumed
      return [];
    }

    if (itemType === "agentMessage") {
      return this.recordAssistantCompletion(item, notification);
    }

    if (itemType === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const fromReasoningField = Array.isArray(item.reasoningContent) ? item.reasoningContent : [];
      const rawContent = (item as { content?: unknown }).content;
      const fromStringArray =
        Array.isArray(rawContent) && rawContent.every((x) => typeof x === "string")
          ? (rawContent as string[])
          : [];
      const contentPieces = fromReasoningField.length > 0 ? fromReasoningField : fromStringArray;
      const full = [...summary, ...contentPieces].join("\n");
      const delta =
        full.length > this.lastReasoningText.length
          ? full.slice(this.lastReasoningText.length)
          : "";
      this.lastReasoningText = full;
      if (!delta) return [];
      return [{
        type: AgentEventType.TextDelta,
        threadId,
        delta,
        isFinalResponse: false,
      }];
    }

    if (itemType === "subAgentActivity") {
      const toolCallId = item.id;
      return toolCallId ? this.mapSubAgentActivityStart(item, toolCallId, false, notification) : [];
    }

    // OpenAI Responses API shape - some codex versions emit "message" items with a content array
    // instead of (or in addition to) streaming deltas.
    if (itemType === "message") {
      return this.recordAssistantCompletion(item, notification);
    }

    // OpenAI Responses API shape - function_call items carry tool invocations
    if (itemType === "function_call") {
      const toolCallId = item.id ?? `fc-${randomUUID()}`;
      const toolUseEvent = this.buildToolUseEvent(item, toolCallId, notification);
      const toolResultEvent = this.toolResultEvent({
        toolCallId,
        isError: false,
        output: typeof item.output === "string" ? item.output : "",
      });
      return this.shouldEmitCompletionToolUse(toolCallId, toolUseEvent)
        ? [toolUseEvent, toolResultEvent]
        : [toolResultEvent];
    }

    if (itemType === "commandExecution") {
      const toolCallId = item.id ?? `cmd-${randomUUID()}`;
      // Prefer streaming-buffered output; fall back to item.output.
      // The buffer is keyed by itemId from outputDelta notifications which should
      // match item.id, but delete by value scan as a safety net.
      let bufferedOutput = this.commandOutputBuffers.get(toolCallId);
      if (!bufferedOutput && this.commandOutputBuffers.size > 0 && !item.id) {
        // Fallback: if no item.id was provided, grab the most recent buffer entry
        const lastKey = [...this.commandOutputBuffers.keys()].pop();
        if (lastKey) {
          bufferedOutput = this.commandOutputBuffers.get(lastKey);
          this.commandOutputBuffers.delete(lastKey);
        }
      }
      const textOut =
        typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > 0
          ? item.aggregatedOutput
          : (typeof item.output === "string" ? item.output : "");
      this.commandOutputBuffers.delete(toolCallId);

      const toolUseEvent = this.buildToolUseEvent(item, toolCallId, notification);
      const toolResultEvent = this.toolResultEvent({
        toolCallId,
        isError: item.exitCode != null && item.exitCode !== 0,
        ...(typeof item.exitCode === "number" && Number.isInteger(item.exitCode)
          ? { exitCode: item.exitCode }
          : {}),
        output: bufferedOutput,
        fallback: textOut,
      });
      return this.shouldEmitCompletionToolUse(toolCallId, toolUseEvent)
        ? [toolUseEvent, toolResultEvent]
        : [toolResultEvent];
    }

    if (itemType === "fileChange") {
      const toolCallId = item.id ?? `fchg-${randomUUID()}`;
      const changes = item.changes ?? [];
      const paths = changes.map((c) => c.path).join(", ");
      const toolUseEvent = this.buildToolUseEvent(item, toolCallId, notification);
      const toolResultEvent = this.toolResultEvent({
        toolCallId,
        isError: false,
        output: paths,
      });
      return this.shouldEmitCompletionToolUse(toolCallId, toolUseEvent)
        ? [toolUseEvent, toolResultEvent]
        : [toolResultEvent];
    }

    if (itemType === "collabAgentToolCall") {
      const toolCallId = item.id ?? `collab-${randomUUID()}`;
      if (this.isWaitCollab(item)) {
        return this.mapWaitStates(item);
      }
      const isSpawn = this.isSpawnAgentCollab(item);
      if (route === "main") this.rememberPendingChildPrompt(item);
      const out =
        typeof item.result === "string" && item.result.length > 0
          ? item.result
          : typeof item.error === "string" && item.error.length > 0
            ? item.error
            : "";
      const kind = this.collabToolKind(item);
      const toolResultEvent = this.toolResultEvent({
        toolCallId,
        isError: typeof item.error === "string" && item.error.length > 0,
        output: out || `Collaboration (${kind})`,
      });
      const receiverCount = isSpawn ? this.registerCollabReceiverThreads(toolCallId, item) : 0;
      const mergedToolInput = isSpawn
        ? this.mergeSpawnAgentToolInput(toolCallId, item)
        : undefined;
      if (isSpawn) {
        if (receiverCount > 0) this.openSpawnAgentIds.add(toolCallId);
      }
      if (this.collabToolUseFromStartIds.has(toolCallId)) {
        this.collabToolUseFromStartIds.delete(toolCallId);
        if (route === "main") this.popCollabFromScopeStack(toolCallId);
        if (isSpawn) {
          const metadataEvents = this.applySpawnItemMetadata(item);
          if (metadataEvents.length > 0) return metadataEvents;
          const completedResult = this.completedSpawnAgentResults.get(toolCallId);
          return completedResult && mergedToolInput
            ? [{ ...completedResult, toolInput: mergedToolInput }]
            : [];
        }
        return [toolResultEvent];
      }
      if (route === "child") {
        const toolUseEvent = this.buildCollabToolUseEvent(item, toolCallId, notification);
        if (isSpawn) return [toolUseEvent];
        return [toolUseEvent, toolResultEvent];
      }
      // Legacy path: collab completes in one notification without a prior `item/started`.
      // Push onto the nesting stack so subsequent child `item/completed` rows
      // get `parentToolCallId`, AND register a pending pop. The next time the
      // coordinator starts a non-collab tool-like item (via `item/started`),
      // we drop this collab off the stack so coordinator work after the
      // sub-agent's children does not incorrectly attach beneath it.
      const toolUseEvent = this.buildCollabToolUseEvent(item, toolCallId, notification);
      if (this.shouldTrackCollabScope(item, isSpawn, receiverCount)) {
        this.collabScopeStack.push(toolCallId);
        this.pendingLegacyCollabPops.add(toolCallId);
      }
      const shouldEmitToolUse = !this.emittedAgentToolUseIds.has(toolCallId);
      this.emittedAgentToolUseIds.add(toolCallId);
      if (isSpawn) return shouldEmitToolUse ? [toolUseEvent] : [];
      if (!shouldEmitToolUse) return [toolResultEvent];
      return [toolUseEvent, toolResultEvent];
    }

    if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
      const toolCallId = item.id ?? `mcp-${randomUUID()}`;
      const toolUseEvent = this.buildToolUseEvent(item, toolCallId, notification);
      const toolResultEvent = this.toolResultEvent({
        toolCallId,
        isError: !!item.error,
        output: String(item.error ?? item.result ?? ""),
      });
      return this.shouldEmitCompletionToolUse(toolCallId, toolUseEvent)
        ? [toolUseEvent, toolResultEvent]
        : [toolResultEvent];
    }

    if (SILENT_ITEM_TYPES.has(itemType)) {
      logger.debug("Codex item/completed silenced", { itemType });
      return [];
    }

    logger.debug("CodexEventMapper: unrecognized item type in item/completed", { itemType });
    return [];
  }
}
