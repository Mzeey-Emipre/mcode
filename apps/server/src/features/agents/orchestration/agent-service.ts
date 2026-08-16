/**
 * Agent session orchestration service.
 * Manages sending messages to AI providers, tracking active sessions,
 * and forwarding agent events to the push broadcaster.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { injectable, inject, delay } from "tsyringe";
import { existsSync, statSync } from "fs";
import { isAbsolute } from "path";
import { createHash, randomUUID } from "node:crypto";
import { logger, validateBranchName } from "@mcode/shared";
import {
  AgentEventType,
  CanonicalSubagentRosterSchema,
  isChildTurnCancellable,
  isGoalCapable,
  isGoalOpen,
  isSessionEvictable,
  previewAnnotationSnapshotAttachments,
} from "@mcode/contracts";
import type {
  Thread,
  AttachmentMeta,
  ReasoningLevel,
  ContextWindowMode,
  IProviderRegistry,
  IAgentProvider,
  TurnRequest,
  AgentEvent,
  ProviderId,
  InteractionMode,
  OrchestrationMode,
  PermissionDecision,
  PermissionRequest,
  PlanOutput,
  Message,
  MessageMention,
  PreviewAnnotationBundle,
  GoalState,
  GoalLookupResult,
  SendMessageInput,
  CreateAndSendInput,
  PermissionMode,
  ProviderFileMutationStart,
  TurnRuntimeSnapshot,
  AgentStopResult,
  CollaborationActionKind,
  CanonicalSubagentRoster,
  CanonicalSubagentRosterRequest,
  CanonicalSubagentStopRequest,
  CanonicalSubagentStopResult,
} from "@mcode/contracts";
import { ThreadRepo } from "../../../repositories/thread-repo";
import { WorkspaceRepo } from "../../../repositories/workspace-repo";
import { MessageRepo } from "../../../repositories/message-repo";
import { HookExecutionRepo, type CreateHookExecutionInput } from "../../../repositories/hook-execution-repo";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { TurnFinalizer } from "../turns/turn-finalizer.js";
import { TurnFileTracker } from "../turns/turn-file-tracker.js";
import { PlanQuestionService } from "../planning/plan-question-service.js";
import { TurnSnapshotRepo } from "../../../repositories/turn-snapshot-repo";
import type Database from "better-sqlite3";
import { TaskRepo, type StoredTask } from "../../../repositories/task-repo";
import { PlanQuestionAnswersRepo } from "../../../repositories/plan-question-answers-repo";
import { GitService } from "../../projects/index.js";
import { AttachmentService } from "../../attachments/storage/attachment-service";
import { FileService } from "../../projects/files/file-service";
import { SnapshotService } from "../../projects/diffs/snapshots/snapshot-service";
import { MemoryPressureService, type MemoryPressureSnapshot } from "../../../runtime/memory/memory-pressure-service";
import { broadcast } from "../../../transport/push";
import { GoalCommand } from "../commands/goal-command";
import { CommandRouter } from "../commands/command-router";
// Lazy-imported to break circular dependency: AgentService -> ThreadService -> (shared repos)
// Using delay() ensures tsyringe resolves ThreadService from the container at first access,
// not at AgentService construction time.
import {
  InternalThreadControlMcpRuntime,
  ThreadControlMutationReservationService,
  ThreadService,
} from "../../thread-control/index.js";
import { SettingsService } from "../../../shared/settings/settings-service.js";
import { ProviderAvailabilityService } from "../../providers/availability/provider-availability-service.js";
import {
  ProviderDisabledError,
  ProviderCliMissingError,
} from "../../providers/availability/provider-availability-errors.js";
import { PlanQuestionParser } from "../planning/plan-question-parser.js";
import { PlanOutputParser } from "../planning/plan-output-parser.js";
import { PlanRepo } from "../../../repositories/plan-repo";
import { HandoffCoordinator } from "../../handoff/index.js";
import { ScopedPreGrantService } from "../permissions/scoped-pre-grant.js";
import { normalizeAgentProviderError } from "./provider-agent-error-normalize.js";
import { TurnErrorPolicy } from "../turns/turn-error-policy.js";
import { TurnRuntimeRegistry } from "../turns/turn-runtime.js";
import type { TurnOutcome } from "../turns/turn-outcome.js";
import { BrowserNarrativeEventSanitizer } from "../../browser-automation/index.js";
import { CanonicalAgentEventSink } from "../canonical/canonical-agent-event-sink.js";

/**
 * Escape special XML characters in a string to prevent injection into
 * provider XML tags (e.g. the reply-to context block).
 */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Reports whether a provider receives the internal thread-control MCP lease. */
export function usesInternalThreadControlMcp(provider: string): provider is ProviderId {
  return ["claude", "codex", "cursor", "copilot"].includes(provider);
}

const FILE_INJECTION_SEPARATOR = "\n\n---\n";

type RetryDispatchIdentity = Readonly<{
  mutationReservationToken: string;
  generation: number;
}>;

/** Command accepted by {@link AgentService.sendMessage}, including cross-thread provenance and mutation-reservation metadata. */
export type SendMessageCommand = Omit<SendMessageInput, "permissionMode" | "provider"> & {
  permissionMode?: PermissionMode | "default";
  provider?: ProviderId;
  /** Assistant message whose plan-question batch is settled by this send. */
  markPlanAnswerForMessageId?: string;
  /** Provider payload used instead of the persisted user-facing content. */
  providerWireOverride?: string;
  /** Server-assigned turn identity used by thread-control creation results. */
  sourceTurnId?: string;
  /** Source thread identity for a cross-thread user message origin. */
  sourceThreadId?: string;
  /** Source provider identity for a cross-thread user message origin. */
  sourceProviderId?: string;
  /** Source turn identity for a cross-thread user message origin. */
  originSourceTurnId?: string;
  /** Existing shared mutation reservation supplied by thread-control approval dispatch. */
  mutationReservationToken?: string;
  /** Resolves the authoritative first-turn handshake before provider I/O continues. */
  onTurnStarted?: (snapshot: TurnRuntimeSnapshot) => void;
  /** Starts a new provider execution instead of continuing the thread's prior native session. */
  forceFreshSession?: boolean;
  /** Interrupted execution consumed atomically when the replacement turn starts. */
  retryOfExecutionId?: string;
};

/** Command accepted by {@link AgentService.createAndSend}, including service defaults for model and permission mode. */
export type CreateAndSendCommand = Omit<
  CreateAndSendInput,
  "model" | "permissionMode" | "provider"
> & {
  model?: string;
  permissionMode?: PermissionMode | "default";
  provider?: ProviderId;
};

function buildInjectedFileMessage(
  text: string,
  files: Array<{ path: string; content: string }>,
): string {
  if (files.length === 0) return text;
  const fileBlocks = files
    .map((file) => {
      const escapedContent = file.content.replace(/<\/file>/gi, "<\\/file>");
      const escapedPath = file.path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      return `<file path="${escapedPath}">\n${escapedContent}\n</file>`;
    })
    .join("\n");
  return `${text}${FILE_INJECTION_SEPARATOR}${fileBlocks}`;
}

/**
 * Generate a thread title from message content: first line, truncated
 * to 50 characters at a word boundary with "..." appended.
 */
function truncateTitle(content: string): string {
  const firstLine = content.split("\n")[0].trim();
  if (firstLine.length <= 50) {
    return firstLine || "New Thread";
  }

  const truncated = firstLine.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  const cutPoint = lastSpace > 0 ? lastSpace : 50;
  return truncated.slice(0, cutPoint) + "...";
}

const FORK_HISTORY_BUDGET_BYTES = 1_000_000;
const FORK_HISTORY_PAGE_SIZE = 100;
const FORK_HISTORY_MAX_MESSAGES = 500;
const GOAL_ACHIEVED_RECEIPT_RE = /^Goal achieved in \d+s\.$/;
const DIRECT_RESPONSE_GOAL_RE = /^\s*(?:say|reply|respond|answer)(?:\s+with)?\s+(.+?)\s*$/i;
type AgentMessageEvent = Extract<AgentEvent, { type: "message" }>;

interface ClaudeNativeGoalProvider {
  hasNativeGoalCommand(sessionId: string): boolean;
  runNativeGoalCommand(
    sessionId: string,
    command: "/goal" | "/goal off",
  ): Promise<{ kind: "active"; objective: string } | { kind: "cleared"; objective: string } | { kind: "empty" } | { kind: "unavailable" } | null>;
}

function asClaudeNativeGoalProvider(provider: IAgentProvider): ClaudeNativeGoalProvider | null {
  const candidate = provider as Partial<ClaudeNativeGoalProvider>;
  return typeof candidate.hasNativeGoalCommand === "function" &&
    typeof candidate.runNativeGoalCommand === "function"
    ? (candidate as ClaudeNativeGoalProvider)
    : null;
}

function stripSurroundingGoalQuotes(value: string): string {
  const text = value.trim();
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
    ["‘", "’"],
  ];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

function normalizeDirectResponseGoalText(value: string): string {
  return stripSurroundingGoalQuotes(value)
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase();
}

function directResponseGoalTarget(objective: string): string | null {
  const match = DIRECT_RESPONSE_GOAL_RE.exec(objective);
  if (!match) return null;
  const target = normalizeDirectResponseGoalText(match[1]);
  return target.length > 0 ? target : null;
}

function satisfiesDirectResponseGoal(goal: GoalState, content: string): boolean {
  const target = directResponseGoalTarget(goal.objective);
  if (!target) return false;
  return normalizeDirectResponseGoalText(content) === target;
}

function goalTimestampMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function elapsedGoalSeconds(goal: GoalState, nowMs: number): number {
  const elapsed = Math.floor((nowMs - goalTimestampMs(goal.createdAt)) / 1000);
  return Math.max(goal.timeUsedSeconds, elapsed, 0);
}

/**
 * Extract the harness-assigned task id from a `TaskCreate` result line such as
 * "Task #1 created successfully: ...". Returns null when no id is present.
 */
function parseHarnessTaskId(output: string): string | null {
  const match = /#(\d+)/.exec(output);
  return match ? match[1] : null;
}

/** Orchestrates agent sessions, message sending, and event forwarding. */
@injectable()
export class AgentService {
  /** Canonical per-thread execution identity and lifecycle authority. */
  private readonly turnRuntime = new TurnRuntimeRegistry();
  private readonly browserNarrativeEventSanitizer: BrowserNarrativeEventSanitizer;
  private readonly preparedProviderEvents = new WeakMap<object, AgentEvent | undefined>();
  private readonly activeSessionIds = new Set<string>();
  private readonly nativeGoalRefreshInFlight = new Set<string>();
  private initialized = false;
  /** Running context token estimate, per thread. Reset on compaction start; overwritten on turnComplete. */
  private lastContextByThread = new Map<string, number>();
  /** Most recent SDK-reported context window size, per thread. */
  private lastContextWindowByThread = new Map<string, number>();
  /** Tracks threads where compaction is currently in progress to guard DB persistence in turnComplete. */
  private compactionInProgressByThread = new Set<string>();
  /**
   * Per-thread narrative buffers (tool calls, agentCallStack, thoughts, hooks,
   * sort counter) and their enrichment + classification + persistence logic
   * live in {@link NarrativeStore}. AgentService delegates the write seam to it.
   */
  /**
   * Owns the end-of-turn seam: re-entrancy guard, interrupted-text flush,
   * precondition check, narrative persistence, git snapshot, `turn.persisted`
   * broadcast, and per-turn clear. AgentService feeds it the pre-turn git ref
   * and streaming assistant text during the turn, then calls
   * {@link TurnFinalizer.finalize} from each turn-end path.
   */
  private readonly turnFinalizer: TurnFinalizer;
  /** Explicit provider mutation tracker used for authored file effects. */
  private readonly turnFileTracker: TurnFileTracker;
  /** Tracker initialization for the active generation of each thread. */
  private readonly fileTrackingSetupByThread = new Map<string, Promise<void>>();
  /** Serializes provider file events behind tracker initialization. */
  private readonly fileTrackingActivityByThread = new Map<string, Promise<void>>();
  /** Pre-turn Git capture that may continue after an auto-resumed tracker becomes ready. */
  private readonly fileTrackingRefCaptureByThread = new Map<string, Promise<void>>();
  /** Prevents a resumed turn from replacing the prior generation before persistence. */
  private readonly fileTrackingFinalizationByThread = new Map<string, Promise<void>>();
  /** Holds a resumed provider event stream until the preceding turn is persisted. */
  private readonly providerEventBarrierByThread = new Map<string, Promise<void>>();
  /** Provider events whose file-tracking portion ran before deferred narrative handling. */
  private readonly earlyFileTrackingEvents = new WeakSet<object>();
  /**
   * Classifies a failed send as transient or fatal and caps the automatic
   * retry, so a brief flake doesn't cost the user a manual re-send while a
   * misclassified fatal error can't loop.
   */
  private readonly turnErrorPolicy = new TurnErrorPolicy();
  /**
   * Threads with a transient-failure retry in flight. While a thread is armed,
   * a transient `Error` event from the failed attempt is hidden from the UI (the
   * broadcast in the composition root and the errored-finalize here both consult
   * {@link shouldSuppressTransientTurnError}). The retry's fresh attempt then
   * surfaces normally, so the user never sees the swallowed flake. Disarmed on
   * success or just before the final-failure emit, so a give-up still shows.
   */
  private readonly retryingThreads = new Set<string>();
  /**
   * Threads whose failed-attempt teardown events (`Ended`, `TurnComplete`) must
   * be swallowed during a transient retry. Without this the failed attempt would
   * tear down the UI's running state (spinner off, partial stream committed)
   * before the retry streams, producing a visible gap. Armed when a transient
   * `Error` is suppressed and again at the start of each retry catch (before
   * `discardSession`, which can emit a trailing `Ended` without a preceding
   * `Error`). Consulted by {@link shouldSuppressTurnEnded} and
   * {@link shouldSuppressTurnComplete}; cleared only after pooled-session
   * eviction drains (or immediately when no session existed), on success, or on
   * give-up so the retry's own terminal events still reach the UI.
   */
  private readonly endedSuppressionThreads = new Set<string>();
  /** Threads that have already entered the finalizer for the current turn. */
  private readonly terminalFinalizedThreads = new Set<string>();
  /**
   * Per-thread dispatch state for transient retries. Fire-and-forget providers
   * (Claude) can return from `sendTurn` before the stream ends, so the retry
   * window must stay armed until `TurnComplete` and stream failures must be
   * able to re-dispatch from the `Error` handler rather than only from the
   * `sendTurn` catch.
   */
  private readonly turnRetryDispatchByThread = new Map<
    string,
    {
      attempt: number;
      retryInFlight: boolean;
      /** False once the in-flight `sendTurn` promise has settled (success or throw). */
      sendTurnInFlight: boolean;
      /** True once the provider's sendTurn invocation has begun. */
      dispatchStarted: boolean;
      sessionName: string;
      sourceTurnId: string;
      resolvedProvider: import("@mcode/contracts").IAgentProvider;
      effectiveProvider: ProviderId;
      turnRequest: TurnRequest;
      /** Shared mutation token required for every provider dispatch and release. */
      mutationReservationToken: string;
      /** Monotonic turn generation used to reject stale retry callbacks. */
      generation: number;
      /**
       * The command side-effect rollback closure (`commandOutcome.onRollback`)
       * captured for this turn. Run only when the retry budget is exhausted so
       * a failed send doesn't leave a hidden gate (e.g. a Stop-hook goal) active
       * on the next turn; a transient retry keeps the side effect installed.
       */
      pendingRollback: (() => void | Promise<void>) | null;
    }
  >();
  /**
   * Owns the mcode-native command namespace (`/goal`, ...). Dispatches each
   * send through registered `McodeCommand`s before the message reaches the
   * provider, so the app-interpreted / provider-passed boundary is named in
   * one place rather than branched inline.
   */
  private readonly commandRouter: CommandRouter;
  /** Goal command shared by slash-command and typed composer goal dispatch. */
  private readonly goalCommand: GoalCommand;
  /**
   * Threads whose `TurnComplete` event has already been processed but whose
   * finalize may still be in-flight or have already finished.
   * Set when `TurnComplete` is handled; cleared on `TurnStarted` so the
   * per-thread flag resets between turns.
   * Hooks that arrive while this flag is set are treated as post-turn (Stop /
   * SessionEnd / PreCompact) and flushed directly via `flushLateHook`.
   */
  private turnCompleteSeenByThread = new Set<string>();
  /** Execution identity that produced the last assistant Message for each thread. */
  private finalResponseExecutionByThread = new Map<string, string>();
  /** Per-thread streaming parsers active while the model is generating questions in plan mode. */
  private planParsers = new Map<string, PlanQuestionParser>();
  /** Per-thread streaming parsers for extracting structured plan-output blocks. */
  private planOutputParsers = new Map<string, PlanOutputParser>();
  /** Holds parsed plan output until the Message event provides a messageId for persistence. */
  private pendingPlanOutputs = new Map<string, PlanOutput>();
  /** ExitPlanMode / create_plan markdown waiting for the assistant Message row. */
  private pendingExitPlanMarkdown = new Map<string, string>();
  /** Prevents duplicate plan records when ExitPlanMode and plan-output both fire. */
  private planCapturedThisTurn = new Set<string>();
  /** Reservation token attached to each active provider turn. */
  private readonly activeMutationReservations = new Map<string, string>();
  /** Single-flight user stop operation per thread. */
  private readonly stopOperationsByThread = new Map<string, Promise<AgentStopResult>>();
  /** Single-flight child stop operation per canonical child thread. */
  private readonly childStopOperationsByThread = new Map<string, Promise<CanonicalSubagentStopResult>>();
  /** Monotonic turn generation per thread, including turns that failed setup. */
  private readonly turnGenerations = new Map<string, number>();
  private readonly mutationReservations: ThreadControlMutationReservationService;
  private readonly canonicalSink: CanonicalAgentEventSink;

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(delay(() => GitService)) private readonly gitService: GitService,
    @inject(AttachmentService)
    private readonly attachmentService: AttachmentService,
    @inject("IProviderRegistry")
    private readonly providerRegistry: IProviderRegistry,
    @inject(delay(() => ThreadService))
    private readonly threadService: ThreadService,
    @inject(HookExecutionRepo) private readonly hookExecutionRepo: HookExecutionRepo,
    @inject(TurnSnapshotRepo) private readonly turnSnapshotRepo: TurnSnapshotRepo,
    @inject(SnapshotService) private readonly snapshotService: SnapshotService,
    @inject("Database") private readonly db: Database.Database,
    @inject(MemoryPressureService)
    private readonly memoryPressureService: MemoryPressureService,
    @inject(TaskRepo) private readonly taskRepo: TaskRepo,
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject(ProviderAvailabilityService)
    private readonly availability: ProviderAvailabilityService,
    @inject(PlanQuestionAnswersRepo)
    private readonly planQuestionAnswersRepo: PlanQuestionAnswersRepo,
    @inject(PlanRepo) private readonly planRepo: PlanRepo,
    @inject(HandoffCoordinator)
    private readonly handoffCoordinator: HandoffCoordinator,
    @inject(ScopedPreGrantService)
    private readonly scopedPreGrant: ScopedPreGrantService,
    @inject(NarrativeStore)
    private readonly narrativeStore: NarrativeStore,
    @inject(PlanQuestionService)
    private readonly planQuestionService: PlanQuestionService,
    @inject(FileService) private readonly fileService?: FileService,
    @inject(delay(() => InternalThreadControlMcpRuntime))
    private readonly threadControlMcp?: InternalThreadControlMcpRuntime,
    @inject(delay(() => ThreadControlMutationReservationService))
    mutationReservations?: ThreadControlMutationReservationService,
    @inject(CanonicalAgentEventSink)
    canonicalSink?: CanonicalAgentEventSink,
  ) {
    this.browserNarrativeEventSanitizer = new BrowserNarrativeEventSanitizer(
      (threadId, toolCallId) => this.narrativeStore.getBufferedToolCalls(threadId)
        .find((toolCall) => toolCall.toolCallId === toolCallId)
        ?.toolName,
    );
    this.mutationReservations = mutationReservations ?? new ThreadControlMutationReservationService();
    this.canonicalSink = canonicalSink ?? new CanonicalAgentEventSink(this.db);
    this.turnFileTracker = new TurnFileTracker(
      (cwd, ref, path) => this.snapshotService.getFileAtRef(cwd, ref, path),
      (threadId, turnId, summary) => {
        broadcast("turn.fileEffectsUpdated", { threadId, turnId, summary });
      },
    );
    this.turnFinalizer = new TurnFinalizer(
      this.messageRepo,
      this.threadRepo,
      this.narrativeStore,
      this.snapshotService,
      this.turnSnapshotRepo,
      this.db,
      this.turnFileTracker,
      this.canonicalSink,
    );
    this.goalCommand = new GoalCommand(
      { messageRepo: this.messageRepo, db: this.db },
      broadcast,
    );
    this.commandRouter = new CommandRouter([this.goalCommand]);
  }

  /** Initialize file tracking once for the active turn, including provider-originated resumes. */
  private ensureTurnFileTracking(threadId: string, cwdOverride?: string): Promise<void> {
    const existing = this.fileTrackingSetupByThread.get(threadId);
    if (existing) return existing;
    const thread = this.threadRepo.findById(threadId);
    if (!thread) return Promise.resolve();
    const workspace = this.workspaceRepo.findById(thread.workspace_id);
    if (!workspace) return Promise.resolve();
    const cwd = cwdOverride ?? this.gitService.resolveWorkingDir(
      workspace.path,
      thread.mode,
      thread.worktree_path,
    );
    let generation: number;
    try {
      generation = this.turnFileTracker.beginTurn(threadId, cwd, null);
      this.turnFinalizer.recordTurnRef(threadId, null, cwd, generation);
    } catch (err) {
      logger.warn("Failed to initialize file tracker", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return Promise.resolve();
    }
    const setup = Promise.resolve();
    this.fileTrackingSetupByThread.set(threadId, setup);
    this.fileTrackingActivityByThread.set(threadId, setup);
    const refCapture = (async () => {
      try {
        const refBefore = await this.snapshotService.captureRef(cwd);
        this.turnFinalizer.recordTurnRef(threadId, refBefore, cwd, generation);
        await this.turnFileTracker.setBaselineRef(threadId, generation, refBefore);
      } catch (err) {
        logger.warn("Failed to capture ref_before", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    this.fileTrackingRefCaptureByThread.set(threadId, refCapture);
    return setup;
  }

  /** Return the server tracker generation that owns live file effects for a thread. */
  getCurrentFileEffectTurnId(threadId: string): string | undefined {
    return this.turnFileTracker.getCurrentTurnId(threadId);
  }

  /** Start one provider file observation immediately and retain its completion for finalization. */
  private queueTurnFileTracking(threadId: string, action: () => Promise<void>): void {
    const setup = this.fileTrackingSetupByThread.get(threadId);
    if (!setup) return;
    const previous = this.fileTrackingActivityByThread.get(threadId) ?? setup;
    let observation: Promise<void>;
    try {
      observation = action();
    } catch (err) {
      observation = Promise.reject(err);
    }
    const guardedObservation = observation.catch((err) => {
      logger.warn("Failed to observe provider file event", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const next = Promise.all([previous, guardedObservation]).then(() => undefined);
    this.fileTrackingActivityByThread.set(threadId, next);
  }

  /**
   * Send a user message to the Claude agent for a given thread.
   * Loads the thread, persists the user message, resolves the working
   * directory, and dispatches to the provider.
   */
  async sendMessage({
    threadId,
    content,
    messageId,
    permissionMode = "default",
    model = "claude-sonnet-4-6",
    attachments = [],
    reasoningLevel,
    provider,
    interactionMode,
    maxBudgetUsd,
    maxTurns,
    copilotAgent,
    contextWindow: contextWindowMode,
    thinking,
    codexFastMode,
    markPlanAnswerForMessageId,
    providerWireOverride,
    replyToMessageId,
    quotedText,
    displayContent: messageDisplayContent,
    planAction,
    mentions = [],
    previewAnnotations,
    goalObjective,
    orchestrationMode,
    sourceTurnId: requestedSourceTurnId,
    sourceThreadId: originSourceThreadId,
    sourceProviderId: originSourceProviderId,
    originSourceTurnId,
    mutationReservationToken,
    onTurnStarted,
    forceFreshSession = false,
    retryOfExecutionId,
  }: SendMessageCommand): Promise<void> {
    const provenance = [originSourceThreadId, originSourceTurnId, originSourceProviderId];
    const hasAnyProvenance = provenance.some((value) => value !== undefined);
    const hasCompleteProvenance = provenance.every((value) => typeof value === "string" && value.length > 0);
    if (hasAnyProvenance && !hasCompleteProvenance) {
      throw new Error("Cross-thread messages require a complete thread provenance tuple");
    }

    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const wasUserCompleted = thread.user_completed_at !== null;
    if (["failed", "stopped", "archived", "deleted"].includes(thread.status)) {
      throw new Error(`Cannot send message to terminal thread: ${threadId}`);
    }
    // Use the thread's stored provider as authoritative fallback; only override
    // when the caller explicitly supplies a provider (new thread or explicit switch).
    const effectiveProvider: ProviderId = provider ?? (thread.provider as ProviderId) ?? "claude";
    // Fall back to the thread's persisted Copilot agent when the caller doesn't supply one.
    // Converts null (DB "cleared") to undefined (provider ignores it) so the SDK defaults.
    const effectiveCopilotAgent = copilotAgent ?? (thread.copilot_agent ?? undefined);
    const effectiveOrchestrationMode =
      orchestrationMode ?? thread.orchestration_mode ?? "standard";

    // Gate: reject disabled or CLI-missing providers before any side effects
    // (message persistence, status changes) so the thread stays in a clean state.
    try {
      this.availability.assertUsable(effectiveProvider);
    } catch (err) {
      if (err instanceof ProviderDisabledError || err instanceof ProviderCliMissingError) {
        broadcast("agent.event", {
          type: "providerUnavailable",
          threadId,
          providerId: effectiveProvider,
          reason: err instanceof ProviderDisabledError ? "disabled" : "cli_missing",
          configuredPath: err instanceof ProviderCliMissingError ? err.configuredPath : undefined,
        });
        // RPC must reject so callers (e.g. batch resume, composer send) roll back optimistic
        // running state instead of succeeding while nothing was persisted.
      }
      throw err;
    }

    if (thread.status === "deleted" || thread.deleted_at != null) {
      throw new Error(`Cannot send message to deleted thread: ${threadId}`);
    }

    const workspace = this.workspaceRepo.findById(thread.workspace_id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${thread.workspace_id}`);
    }

    const validatedMentions = this.validateMessageMentions({
      workspaceId: workspace.id,
      threadId,
      content,
      mentions,
      provider: effectiveProvider,
    });

    // Route the message through the mcode-native command namespace before it
    // reaches the provider. The router probes each command's required
    // capability and passes through when the resolved provider lacks it, so the
    // model still sees the raw text on providers without the capability.
    //
    //   handled     — a control form was fully serviced; short-circuit the send.
    //   rewrite     — the wire payload was rewritten (e.g. `/goal <condition>`);
    //                 fall through and run the lifecycle closures around the
    //                 send (onDispatch just before, onRollback on failure).
    //   passthrough — forward the original content to the model unchanged.
    //
    // onDispatch is deferred to immediately before `sendTurn` so a send failure
    // can't leave a stale side effect (e.g. a goal gate) on the provider; the
    // catch block runs onRollback as a belt-and-suspenders guard.
    let pendingDispatch: (() => void | Promise<void>) | null = null;
    let pendingRollback: (() => void | Promise<void>) | null = null;
    let commandContext: {
      threadId: string;
      content: string;
      provider: IAgentProvider;
    };
    commandContext = {
      threadId,
      content,
      provider: this.providerRegistry.resolve(effectiveProvider),
    };
    const commandOutcome = goalObjective !== undefined
      ? await this.goalCommand.prepareSet(commandContext, goalObjective)
      : await this.commandRouter.route(commandContext);
    if (commandOutcome.kind === "handled") {
      logger.info("Handled mcode-native command", { threadId });
      return;
    }
    if (commandOutcome.kind === "rewrite") {
      pendingDispatch = commandOutcome.onDispatch ?? null;
      pendingRollback = commandOutcome.onRollback ?? null;
      messageDisplayContent ??= content;
      content = commandOutcome.content;
    }

    let activeSlotReserved = this.reserveTurn(threadId);
    if (!activeSlotReserved) {
      throw new Error(`Thread ${threadId} already has an active agent session`);
    }
    let reservationToken: string | null = null;
    let reservedExecutionId: string | null = null;
    const releaseReservedSlot = () => {
      if (!activeSlotReserved) return;
      activeSlotReserved = false;
      const currentRuntime = this.turnRuntime.snapshot(threadId);
      const ownsRuntime = reservedExecutionId !== null
        && currentRuntime?.turnExecutionId === reservedExecutionId;
      const ownsMutation = reservationToken !== null
        && this.activeMutationReservations.get(threadId) === reservationToken;
      const ownsUnstartedSlot = reservedExecutionId === null && reservationToken === null;
      if ((ownsRuntime || ownsMutation || ownsUnstartedSlot) && this.activeSessionIds.delete(threadId)) {
        this.memoryPressureService.markIdle(threadId);
      }
      if (reservationToken && this.activeMutationReservations.get(threadId) === reservationToken) {
        this.activeMutationReservations.delete(threadId);
      }
      if (reservationToken) this.mutationReservations.release(threadId, reservationToken);
    };
    reservationToken = mutationReservationToken
      ? this.mutationReservations.owns(threadId, mutationReservationToken, "activeTurn")
        ? mutationReservationToken
        : null
      : this.mutationReservations.reserve(threadId, "activeTurn");
    if (!reservationToken) {
      releaseReservedSlot();
      throw new Error(`Thread ${threadId} already has a pending mutation`);
    }
    this.activeMutationReservations.set(threadId, reservationToken);
    const generation = (this.turnGenerations.get(threadId) ?? 0) + 1;
    this.turnGenerations.set(threadId, generation);
    const turnExecutionId = this.turnRuntime.start(threadId).turnExecutionId!;
    reservedExecutionId = turnExecutionId;
    onTurnStarted?.({
      threadId,
      turnExecutionId,
      phase: "running",
    });

    let commandDispatched = false;
    const rollbackCommand = async (): Promise<void> => {
      if (!commandDispatched || pendingRollback === null) return;
      try {
        await pendingRollback();
      } catch (rollbackErr) {
        logger.warn("Failed to roll back command side effect after send setup failure", {
          threadId,
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      }
    };

    try {
      const cwd = this.gitService.resolveWorkingDir(
        workspace.path,
        thread.mode,
        thread.worktree_path,
      );

      // Validate cwd before persisting anything
      if (
        !isAbsolute(cwd) ||
        !existsSync(cwd) ||
        !statSync(cwd).isDirectory()
      ) {
        throw new Error(`cwd is not a valid absolute directory: ${cwd}`);
      }

      this.memoryPressureService.assertCanStartTurn();
      this.memoryPressureService.markActive(threadId);

      // Compute next sequence number and persist user message
      const nextSeq = this.messageRepo.getLatestSequenceIncludingInternal(threadId) + 1;

      const persistedUserText = messageDisplayContent ?? content;

      const previewAnnotationAttachments =
        previewAnnotationSnapshotAttachments(previewAnnotations);
      const attachmentsForPersistence =
        previewAnnotationAttachments.length > 0
          ? [...attachments, ...previewAnnotationAttachments]
          : attachments;

      const { stored, persisted } = await this.attachmentService.persist(
        threadId,
        attachmentsForPersistence,
      );
    // Persist the user message and (when answering plan questions) the
    // answered marker in a single transaction. If the marker insert fails
    // (e.g. FK rejects an unknown messageId) the user message is rolled
    // back too, keeping marker durability == answer durability.
    this.turnFinalizer.resetStreamingText(threadId);

    const sourceTurnId = requestedSourceTurnId ?? randomUUID();

    const origin = originSourceThreadId && originSourceTurnId && originSourceProviderId
      ? {
          type: "thread" as const,
          sourceThreadId: originSourceThreadId,
          sourceTurnId: originSourceTurnId,
          sourceProviderId: originSourceProviderId,
        }
      : undefined;
    const canonicalProviderIdentities = !forceFreshSession && thread.sdk_session_id
      && effectiveProvider === thread.provider
      ? [{
          providerId: effectiveProvider,
          scope: effectiveProvider === "codex" ? "thread" as const : "session" as const,
          value: thread.sdk_session_id,
          provenance: "native" as const,
        }]
      : [];
    let reopenedThread: Thread | null = null;
    this.canonicalSink.startParentTurn({
      thread: {
        id: threadId,
        workspaceId: workspace.id,
        providerId: effectiveProvider,
        createdAt: thread.created_at,
      },
      turnId: sourceTurnId,
      executionId: turnExecutionId,
      permissionMode: permissionMode === "full"
        || (permissionMode === "default" && thread.permission_mode === "full")
        ? "full"
        : "supervised",
      providerIdentities: canonicalProviderIdentities,
      retryOfExecutionId,
      projectUserMessage: () => {
        if (wasUserCompleted) {
          reopenedThread = this.threadRepo.reopen(threadId);
          if (!reopenedThread) throw new Error(`Thread not found: ${threadId}`);
        }
        const args = [
          threadId,
          "user" as const,
          persistedUserText,
          nextSeq,
          stored.length > 0 ? stored : undefined,
          replyToMessageId,
          quotedText,
          undefined,
          undefined,
          validatedMentions.length > 0 ? validatedMentions : undefined,
          previewAnnotations,
        ] as const;
        let message: Message;
        if (messageId === undefined && origin === undefined) {
          message = this.messageRepo.create(...args);
        } else if (messageId === undefined && origin !== undefined) {
          message = this.messageRepo.create(...args, origin);
        } else if (origin === undefined) {
          message = this.messageRepo.create(...args, undefined, messageId);
        } else {
          message = this.messageRepo.create(...args, origin, messageId);
        }
        if (markPlanAnswerForMessageId) {
          // INSERT OR IGNORE inside the repo skips PK collisions (idempotent
          // re-marking) but FK violations still abort the transaction, which
          // keeps the answer and its durable marker atomic.
          this.planQuestionAnswersRepo.markAnswered(
            markPlanAnswerForMessageId,
            threadId,
          );
        }
        return message;
      },
    });

    if (reopenedThread) {
      broadcast("thread.lifecycleChanged", { thread: reopenedThread });
    }

    // Notify other tabs/clients on the same thread that the wizard can be
    // hidden. Fired only after the tx commits so listeners never see a
    // marker that was rolled back.
    if (markPlanAnswerForMessageId) {
      broadcast("plan.answered", {
        threadId,
        assistantMessageId: markPlanAnswerForMessageId,
      });
    }

    // In plan mode, register the parser so the wizard flow works regardless of
    // whether a provider content override exists. When branching (override present),
    // the override already carries the plan-wrapped stitched content; only wrap the
    // plain content when there is no override.
    // Plan-tab implement/revise actions force build mode so the prompt is not
    // re-wrapped with the question-generation template.
    let wirePayload = content;

    if (planAction === "revise") {
      this.armPlanGenerationTurn(threadId);
      wirePayload = `${wirePayload}\n\n${this.planQuestionService.buildPlanOutputInstructions()}`;
    }
    // The retired setPlanQuestionMode toggle is gone: Cursor derives plan-question
    // suppression from each Turn's interactionMode at sendTurn. An "implement"
    // turn dispatches as "build", which clears the flag.

    const effectiveInteractionMode =
      planAction === "revise" || planAction === "implement"
        ? undefined
        : interactionMode;

    if (effectiveInteractionMode === "plan") {
      this.planParsers.set(threadId, new PlanQuestionParser());
      if (providerWireOverride === undefined) {
        wirePayload = this.buildPlanPrompt(wirePayload);
      }
    }

    // When the user is replying to a previous message, wrap the quoted context
    // in XML tags so the AI provider understands the reference.
    if (replyToMessageId && providerWireOverride === undefined) {
      const replyTarget = this.messageRepo.findByIdInThread(threadId, replyToMessageId);
      if (replyTarget) {
        const quoteBody = quotedText
          ? quotedText.slice(0, 2000)
          : replyTarget.content.slice(0, 2000);
        const truncated = quoteBody.length < (quotedText ?? replyTarget.content).length ? "..." : "";
        wirePayload = `<reply-to role="${replyTarget.role}" sequence="${replyTarget.sequence}">\n${escapeXml(quoteBody)}${truncated}\n</reply-to>\n\n${wirePayload}`;
      }
    }

    const resolvedProvider = this.providerRegistry.resolve(effectiveProvider);
    if (!this.ownsActiveTurnExecution(threadId, turnExecutionId, reservationToken)) {
      return;
    }
    this.threadRepo.updateStatus(threadId, "active");
    // Emit before baseline I/O so the UI enters running state immediately. AgentService's
    // provider listener initializes the tracker synchronously before the broadcaster reads its id.
    (resolvedProvider as unknown as import("events").EventEmitter).emit("event", {
      type: AgentEventType.TurnStarted,
      threadId,
      turnExecutionId,
    } satisfies AgentEvent);

    await this.ensureTurnFileTracking(threadId, cwd);
    await this.fileTrackingRefCaptureByThread.get(threadId);
    this.narrativeStore.beginTurn(threadId);
    this.narrativeStore.resetTurnCounters(threadId);

    // Initialize context tracking from the previous turn's final count.
    // For resume turns, last_context_tokens is the authoritative count from
    // the previous turnComplete; for the very first turn it is null (treated as 0).
    const contextSeed = thread.last_context_tokens ?? 0;
    this.lastContextByThread.set(threadId, contextSeed);
    if (thread.context_window) {
      this.lastContextWindowByThread.set(threadId, thread.context_window);
    }

    const resolvedModel = model;
    const settings = await this.settingsService.get();
    const { fallbackId } = settings.model.defaults;
    const fallbackModel =
      fallbackId && fallbackId !== resolvedModel ? fallbackId : undefined;

    // Resolve guardrails: per-request values override settings defaults.
    // A value of 0 means "disabled" — do not pass to provider.
    const effectiveBudget = maxBudgetUsd ?? settings.agent.guardrails.maxBudgetUsd;
    const effectiveTurns = maxTurns ?? settings.agent.guardrails.maxTurns;

    // Resolve context window mode + thinking via the standard precedence chain:
    // per-call (composer/RPC override) > thread (persisted from earlier turns)
    // > settings default. The result is what actually flows to the SDK.
    const effectiveContextWindowMode: ContextWindowMode =
      contextWindowMode ??
      (thread.context_window_mode as ContextWindowMode | null) ??
      settings.model.defaults.contextWindow;
    const effectiveThinking: boolean =
      thinking ?? (thread.thinking ?? settings.model.defaults.thinking);
    const effectiveCodexFastMode: boolean =
      effectiveProvider === "codex"
        ? (codexFastMode !== undefined
            ? codexFastMode
            : thread.codex_fast_mode != null
              ? thread.codex_fast_mode
              : (settings.provider.codex?.fastMode ?? false))
        : false;
    this.threadRepo.updateModel(threadId, resolvedModel);
    // Only persist provider when the caller explicitly supplied one (new thread or deliberate switch).
    if (provider !== undefined) {
      this.threadRepo.updateProvider(threadId, effectiveProvider);
    }
    // Persist per-thread composer settings alongside the model
    this.threadRepo.updateSettings(threadId, {
      ...(reasoningLevel !== undefined && { reasoning_level: reasoningLevel }),
      ...(interactionMode !== undefined && { interaction_mode: interactionMode }),
      ...(orchestrationMode !== undefined && { orchestration_mode: orchestrationMode }),
      ...(permissionMode !== undefined && permissionMode !== "default" && { permission_mode: permissionMode }),
      ...(contextWindowMode !== undefined && { context_window_mode: contextWindowMode }),
      ...(thinking !== undefined && { thinking }),
      ...(copilotAgent !== undefined && { copilot_agent: copilotAgent }),
      ...(codexFastMode !== undefined && effectiveProvider === "codex" && { codex_fast_mode: codexFastMode }),
    });

    const persistedProvider: ProviderId =
      provider !== undefined ? effectiveProvider : (thread.provider as ProviderId) ?? "claude";
    broadcast("thread.modelUpdated", {
      threadId,
      model: resolvedModel,
      provider: persistedProvider,
    });

    const sessionName = `mcode-${threadId}`;
    // A branched child has a system handoff at seq 1 but no sdk_session_id.
    // Only treat as resume if there is actually a session to resume.
    const isResume = !forceFreshSession && nextSeq > 1 && !!thread.sdk_session_id;

    // Resume signal: defined ⇒ resume that SDK session, undefined ⇒ fresh.
    // Replaces the former setSdkSessionId(...) + resume:true two-step dance.
    const resumeFrom: string | undefined =
      isResume && thread.sdk_session_id ? thread.sdk_session_id : undefined;

    let providerMessage = providerWireOverride ?? wirePayload;
    if (effectiveProvider !== "codex") {
      providerMessage = this.injectMentionFileContents({
        workspaceId: workspace.id,
        threadId,
        text: providerMessage,
        mentions: validatedMentions,
      });
    }

    // Run the command's deferred dispatch side effect now, as late as possible
    // before dispatch. If sendTurn throws synchronously or rejects, the catch
    // block below runs the rollback so failures don't leave a hidden side
    // effect active. Only set for a rewrite outcome that supplied onDispatch.
    if (pendingDispatch !== null) {
      if (!this.mutationReservations.owns(threadId, reservationToken, "activeTurn")) {
        return;
      }
      // Flag the attempt before running it so the catch-block rollback fires
      // even if the (possibly async) side effect itself throws. Awaited because
      // a command's onDispatch may be async (e.g. installing a goal), and the
      // install must complete before the provider turn is dispatched.
      commandDispatched = true;
      await pendingDispatch();
      if (!this.ownsActiveTurnExecution(threadId, turnExecutionId, reservationToken)) {
        await rollbackCommand();
        return;
      }
      logger.info("Command side effect installed; dispatching to provider", {
        threadId,
      });
    }

    // Provider-specific knobs are walled into providerOptions, keyed by the
    // resolved Provider. The orchestrator picks both the Provider and its
    // matching options together; the cast at the sendTurn boundary is the one
    // controlled point where the runtime selection meets the union type.
    const providerOptions =
      effectiveProvider === "claude"
        ? { contextWindowMode: effectiveContextWindowMode, thinking: effectiveThinking }
        : effectiveProvider === "codex"
          ? { fastMode: effectiveCodexFastMode }
          : effectiveProvider === "copilot"
            ? { agent: effectiveCopilotAgent }
            : {};

    // Auto-retry loop for transient send failures. A known-transient signature
    // (stale pooled session, spawn race, brief network blip) retries once
    // against a fresh session so a flake doesn't cost the user a manual re-send;
    // the policy's attempt cap stops a misclassified fatal error from looping.
    let attemptResumeFrom = resumeFrom;
    // Arm the retry-suppression window for the whole loop so a transient `Error`
    // the provider emits mid-attempt (before its rejection reaches the catch
    // below) is hidden from the UI. The classification gate in
    // `shouldSuppressTransientTurnError` keeps fatal errors visible; both exits
    // (success and give-up) disarm before returning.
    this.retryingThreads.add(threadId);
    const baseTurnRequest = {
      sessionId: sessionName,
      turnExecutionId,
      workspaceId: workspace.id,
      threadId,
      message: providerMessage,
      mentions: validatedMentions.length > 0 ? validatedMentions : undefined,
      cwd,
      model: resolvedModel,
      fallbackModel,
      permissionMode,
      interactionMode: effectiveInteractionMode ?? "build",
      orchestrationMode: effectiveOrchestrationMode,
      attachments: persisted.length > 0 ? persisted : undefined,
      reasoningLevel,
      ...(effectiveBudget > 0 && { maxBudgetUsd: effectiveBudget }),
      ...(effectiveTurns > 0 && { maxTurns: effectiveTurns }),
      resumeFrom: attemptResumeFrom,
      providerOptions,
    } as TurnRequest;
    if (usesInternalThreadControlMcp(effectiveProvider)) {
      this.threadControlMcp?.activate({
        sessionId: sessionName,
        sourceThreadId: threadId,
        sourceTurnId,
        sourceProviderId: effectiveProvider,
        permissionMode: permissionMode === "full" ? "full" : "supervised",
      });
    }
    if (!this.mutationReservations.owns(threadId, reservationToken, "activeTurn")) {
      return;
    }
    this.turnRetryDispatchByThread.set(threadId, {
      attempt: 1,
      retryInFlight: false,
      sendTurnInFlight: false,
      dispatchStarted: false,
      sessionName,
      sourceTurnId,
      resolvedProvider,
      effectiveProvider,
      turnRequest: baseTurnRequest,
      pendingRollback,
      mutationReservationToken: reservationToken,
      generation,
    });
    for (;;) {
      const dispatch = this.turnRetryDispatchByThread.get(threadId);
      if (!dispatch) return;
      dispatch.turnRequest = {
        ...dispatch.turnRequest,
        resumeFrom: attemptResumeFrom,
      };
      dispatch.sendTurnInFlight = true;
      try {
        if (typeof dispatch.turnRequest.turnExecutionId !== "string") {
          throw new Error("Turn execution identity required at provider dispatch boundary");
        }
        const sendTurn = this.mutationReservations.runIfOwned(
          threadId,
          reservationToken,
          "activeTurn",
          () => {
            dispatch.dispatchStarted = true;
            return resolvedProvider.sendTurn(dispatch.turnRequest);
          },
        );
        if (sendTurn === undefined) return;
        await sendTurn;
        dispatch.sendTurnInFlight = false;
        logger.info("Message sent via provider", {
          threadId,
          session: sessionName,
          model: resolvedModel,
        });
        // Fire-and-forget providers return before the stream ends. Keep the retry
        // window armed until TurnComplete so mid-stream transient errors stay
        // suppressed and can re-dispatch via the Error handler.
        return;
      } catch (err) {
        dispatch.sendTurnInFlight = false;
        if (!this.mutationReservations.owns(threadId, reservationToken, "activeTurn")) {
          return;
        }
        const retried = await this.runTransientTurnRetry(threadId, err);
        if (retried) return;
        await this.giveUpTransientTurnRetry(threadId, err);
        return;
      }
    }
    } catch (err) {
      const runtime = this.turnRuntime.snapshot(threadId);
      const cancelledByStop = runtime?.turnExecutionId === turnExecutionId
        && runtime.phase === "cancelled"
        && !this.mutationReservations.owns(threadId, reservationToken, "activeTurn");
      if (cancelledByStop) {
        await rollbackCommand();
        releaseReservedSlot();
        return;
      }
      if (this.turnRuntime.terminalize(threadId, turnExecutionId, "errored")) {
        await (this.finalizeTerminalTurn(threadId, "errored", "send setup failure") ?? Promise.resolve());
        this.disarmTurnRetryWindow(threadId);
      }
      releaseReservedSlot();
      await rollbackCommand();
      throw err;
    }
  }

  /**
   * Submit answers to the model's plan questions and resume the session.
   * Formats answers as a human-readable follow-up message and sends it
   * without the plan-mode question wrapper so the model generates the plan.
   */
  async answerQuestions(
    threadId: string,
    answers: Array<{ questionId: string; selectedOptionId: string | null; freeText: string | null }>,
    permissionMode: PermissionMode | "default" = "default",
    reasoningLevel?: ReasoningLevel,
    contextWindowMode?: ContextWindowMode,
    thinking?: boolean,
  ): Promise<void> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    // The service builds the human-readable answer payload and keys the marker
    // on the assistant message carrying the fence (see
    // docs/plans/2026-04-30-plan-question-answers-marker.md). The facade still
    // arms plan-generation and performs the send.
    const { content, markPlanAnswerForMessageId } =
      this.planQuestionService.buildAnswerPayload(threadId, answers);

    this.armPlanGenerationTurn(threadId);

    // interactionMode intentionally omitted — no question wrapping for the answer turn
    await this.sendMessage({
      threadId,
      content,
      permissionMode,
      model: thread.model ?? "claude-sonnet-4-6",
      attachments: [],
      reasoningLevel,
      provider: (thread.provider as ProviderId) ?? "claude",
      contextWindow: contextWindowMode,
      thinking,
      markPlanAnswerForMessageId,
    });
  }

  /**
   * Durably mark the latest plan-questions batch for the thread as
   * settled without sending any answers to the model. Used by the
   * wizard's `cancel` action so the batch does NOT re-surface on
   * subsequent reloads or thread switches. Idempotent — `INSERT OR
   * IGNORE` inside the repo absorbs repeat calls. No-ops silently
   * when there is no fenced message to settle (e.g. dev / test
   * harnesses that inject the wizard without a real fence in the
   * message history).
   */
  dismissPlanQuestions(threadId: string): void {
    const assistantMessageId = this.planQuestionService.dismiss(threadId);
    if (!assistantMessageId) return;
    // Use `plan.dismissed` rather than `plan.answered` so other tabs settle
    // the batch (hide the wizard, add to the answered set) without firing
    // the "submission echo" animation reserved for actual answers.
    broadcast("plan.dismissed", { threadId, assistantMessageId });
  }

  private validateMessageMentions(input: {
    workspaceId: string;
    threadId: string;
    content: string;
    mentions: readonly MessageMention[];
    provider: ProviderId;
  }): MessageMention[] {
    const sorted = [...input.mentions].sort((a, b) => a.range.start - b.range.start);
    let previousEnd = 0;

    for (const mention of sorted) {
      const displayText = mention.kind === "command" ? `/${mention.label}` : `@${mention.label}`;
      if (
        mention.range.end > input.content.length ||
        input.content.slice(mention.range.start, mention.range.end) !== displayText
      ) {
        throw new Error(`Invalid mention range for ${displayText}`);
      }
      if (mention.range.start < previousEnd) {
        throw new Error("Mention ranges must not overlap");
      }
      previousEnd = mention.range.end;

      if (mention.kind === "file") {
        if (!this.fileService) {
          throw new Error("File mention validation is unavailable");
        }
        this.fileService.validateMentionPath(input.workspaceId, mention.path, input.threadId);
        continue;
      }

      if (mention.kind === "command") continue;

      if (input.provider !== "codex") {
        throw new Error("Provider mentions are only supported by Codex");
      }
    }

    return sorted;
  }

  private injectMentionFileContents(input: {
    workspaceId: string;
    threadId: string;
    text: string;
    mentions: readonly MessageMention[];
  }): string {
    const uniquePaths = new Set<string>();
    const files: Array<{ path: string; content: string }> = [];

    for (const mention of input.mentions) {
      if (mention.kind !== "file" || uniquePaths.has(mention.path)) continue;
      if (!this.fileService) {
        throw new Error("File mention injection is unavailable");
      }
      uniquePaths.add(mention.path);
      files.push({
        path: mention.path,
        content: this.fileService.read(input.workspaceId, mention.path, input.threadId),
      });
    }

    return buildInjectedFileMessage(input.text, files);
  }

  private async createAttachedExistingWorktreeThread(params: {
    workspaceId: string;
    title: string;
    existingWorktreePath: string;
    provider: ProviderId;
    baseBranch?: string;
    lineage?: {
      parentThreadId: string;
      forkedFromMessageId: string;
    };
  }): Promise<Thread> {
    const workspace = this.workspaceRepo.findById(params.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${params.workspaceId}`);

    const knownWorktrees = await this.gitService.listWorktrees(params.workspaceId);
    const normalize = (p: string) =>
      p.replace(/\\/g, "/").replace(/\/$/, "");
    const normalizedInput = normalize(params.existingWorktreePath);
    const matched = knownWorktrees.find(
      (wt) => {
        const normalizedKnown = normalize(wt.path);
        return process.platform === "win32"
          ? normalizedKnown.toLowerCase() === normalizedInput.toLowerCase()
          : normalizedKnown === normalizedInput;
      },
    );
    if (!matched) {
      throw new Error("Path is not a recognized worktree");
    }

    const isDetached = matched.branch === "(detached)";
    const branch = isDetached ? params.baseBranch : matched.branch;
    if (!branch) {
      throw new Error("Base branch is required when attaching a detached worktree");
    }
    if (isDetached && branch === "HEAD") {
      throw new Error("Base branch cannot be HEAD when attaching a detached worktree");
    }
    validateBranchName(branch);

    const thread = this.threadRepo.create(
      params.workspaceId,
      params.title,
      "worktree",
      branch,
      false,
      params.provider,
      params.lineage,
      isDetached ? "branchless" : "named",
      isDetached ? branch : null,
    );
    this.threadRepo.updateWorktreePath(thread.id, matched.path);
    return {
      ...thread,
      worktree_path: matched.path,
    };
  }

  /**
   * Create a new thread and immediately send the first message.
   * Generates a title from the content, creates the thread, sends,
   * and returns the fully-populated Thread object.
   */
  private async sendInitialMessageAndSnapshot(
    command: SendMessageCommand,
    onError: (error: unknown) => void,
  ): Promise<TurnRuntimeSnapshot> {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const send = this.sendMessage({
      ...command,
      onTurnStarted: resolveStarted,
    });
    void send.catch(onError);
    await Promise.race([
      started,
      send.then(() => undefined, () => undefined),
    ]);
    return this.turnRuntime.snapshot(command.threadId) ?? {
      threadId: command.threadId,
      turnExecutionId: null,
      phase: "idle",
    };
  }

  async createAndSend({
    workspaceId,
    content,
    model = "claude-sonnet-4-6",
    permissionMode = "default",
    mode = "direct",
    branch = "main",
    worktreeBranchMode = "branchless",
    existingWorktreePath,
    existingWorktreeBaseBranch,
    attachments = [],
    reasoningLevel,
    provider = "claude",
    interactionMode,
    parentThreadId,
    forkedFromMessageId,
    maxBudgetUsd,
    maxTurns,
    copilotAgent,
    contextWindow: contextWindowMode,
    thinking,
    codexFastMode,
    displayContent,
    mentions = [],
    previewAnnotations,
    goalObjective,
    orchestrationMode,
  }: CreateAndSendCommand): Promise<Thread & { runtimeSnapshot: TurnRuntimeSnapshot; warnings?: string[] }> {
    const title = truncateTitle(displayContent ?? content);

    if (parentThreadId) {
      return this.createBranchedThread({
        workspaceId, content, model, permissionMode, mode, branch,
        existingWorktreePath, existingWorktreeBaseBranch, worktreeBranchMode, attachments, mentions, reasoningLevel, provider,
        interactionMode, parentThreadId, forkedFromMessageId, title,
        maxBudgetUsd, maxTurns,
        copilotAgent,
        contextWindowMode,
        thinking,
        codexFastMode,
        displayContent,
        previewAnnotations,
        goalObjective,
        orchestrationMode,
      });
    }

    let thread: Thread;
    let threadWarnings: string[] | undefined;
    if (existingWorktreePath) {
      thread = await this.createAttachedExistingWorktreeThread({
        workspaceId,
        title,
        existingWorktreePath,
        provider,
        baseBranch: existingWorktreeBaseBranch,
      });
    } else if (mode === "worktree") {
      const createResult = await this.threadService.create(
        workspaceId,
        title,
        "worktree",
        branch,
        { branchless: worktreeBranchMode !== "named" },
      );
      threadWarnings = createResult.warnings;
      thread = createResult;
      this.threadRepo.updateProvider(thread.id, provider);
      thread = { ...thread, provider };
    } else {
      thread = this.threadRepo.create(
        workspaceId,
        title,
        "direct",
        branch,
        true,
        provider,
      );
    }

    this.threadRepo.updateModel(thread.id, model);
    this.threadRepo.updateSettings(thread.id, {
      ...(reasoningLevel !== undefined && { reasoning_level: reasoningLevel }),
      ...(interactionMode !== undefined && { interaction_mode: interactionMode }),
      ...(orchestrationMode !== undefined && { orchestration_mode: orchestrationMode }),
      ...(permissionMode !== undefined && permissionMode !== "default" && { permission_mode: permissionMode }),
      ...(contextWindowMode !== undefined && { context_window_mode: contextWindowMode }),
      ...(thinking !== undefined && { thinking }),
      ...(copilotAgent !== undefined && { copilot_agent: copilotAgent }),
      ...(provider === "codex" && codexFastMode !== undefined && { codex_fast_mode: codexFastMode }),
    });
    const persistedPermissionMode =
      permissionMode === "full" || permissionMode === "supervised"
        ? permissionMode
        : thread.permission_mode;
    thread = {
      ...thread,
      model,
      provider,
      reasoning_level: reasoningLevel ?? thread.reasoning_level,
      interaction_mode: interactionMode ?? thread.interaction_mode,
      orchestration_mode: orchestrationMode ?? thread.orchestration_mode,
      permission_mode: persistedPermissionMode,
      context_window_mode: contextWindowMode ?? thread.context_window_mode,
      thinking: thinking ?? thread.thinking,
      copilot_agent: copilotAgent ?? thread.copilot_agent,
      codex_fast_mode: provider === "codex" && codexFastMode !== undefined
        ? codexFastMode
        : thread.codex_fast_mode,
    };

    const runtimeSnapshot = await this.sendInitialMessageAndSnapshot({
      threadId: thread.id,
      content,
      permissionMode,
      model,
      attachments,
      reasoningLevel,
      provider,
      interactionMode,
      maxBudgetUsd,
      maxTurns,
      copilotAgent,
      contextWindow: contextWindowMode,
      thinking,
      displayContent,
      mentions,
      previewAnnotations,
      goalObjective,
      orchestrationMode,
    }, (err) => {
      logger.error("createAndSend initial send failed", {
        threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const updated = this.threadRepo.findById(thread.id);
    return {
      ...(updated ?? thread),
      runtimeSnapshot,
      ...(threadWarnings?.length ? { warnings: threadWarnings } : {}),
    };
  }

  /**
   * Create a child thread branched from a parent at a specific message.
   * Injects a conversation replay into the provider's first turn for continuity.
   * The handoff system message (seq 1) is stored in the DB for the UI; the replay
   * is sent only to the provider via `providerWireOverride` on `sendMessage`.
   */
  private async createBranchedThread(params: {
    workspaceId: string;
    content: string;
    model: string;
    permissionMode: PermissionMode | "default";
    mode: "direct" | "worktree";
    branch: string;
    worktreeBranchMode?: "branchless" | "named";
    existingWorktreePath?: string;
    existingWorktreeBaseBranch?: string;
    attachments: AttachmentMeta[];
    mentions: MessageMention[];
    reasoningLevel?: ReasoningLevel;
    provider: ProviderId;
    interactionMode?: InteractionMode;
    parentThreadId: string;
    forkedFromMessageId?: string;
    title: string;
    maxBudgetUsd?: number;
    maxTurns?: number;
    copilotAgent?: string;
    contextWindowMode?: ContextWindowMode;
    thinking?: boolean;
    codexFastMode?: boolean;
    displayContent?: string;
    previewAnnotations?: PreviewAnnotationBundle;
    goalObjective?: string;
    orchestrationMode?: OrchestrationMode;
  }): Promise<Thread & { runtimeSnapshot: TurnRuntimeSnapshot; warnings?: string[] }> {
    const {
      workspaceId, content, model, permissionMode, mode, branch,
      existingWorktreePath, existingWorktreeBaseBranch, worktreeBranchMode, attachments, mentions, reasoningLevel, provider,
      interactionMode, parentThreadId, forkedFromMessageId, title,
      maxBudgetUsd, maxTurns,
      copilotAgent,
      contextWindowMode,
      thinking,
      codexFastMode,
      displayContent,
      previewAnnotations,
      goalObjective,
      orchestrationMode,
    } = params;

    // Validate parent
    const parentThread = this.threadRepo.findById(parentThreadId);
    if (!parentThread) throw new Error(`Parent thread not found: ${parentThreadId}`);

    // Inherit context window mode and thinking from the parent thread when not
    // explicitly overridden by the caller — branched threads continue in the same
    // context tier / thinking mode as the thread they forked from.
    const effectiveContextWindowMode =
      contextWindowMode ?? (parentThread.context_window_mode as ContextWindowMode | null | undefined) ?? undefined;
    const effectiveThinking =
      thinking !== undefined ? thinking : (parentThread.thinking != null ? Boolean(parentThread.thinking) : undefined);
    if (parentThread.workspace_id !== workspaceId) {
      throw new Error("Cannot branch across workspaces");
    }
    if (parentThread.deleted_at != null) {
      throw new Error("Cannot branch from a deleted thread");
    }

    // Resolve the fork message ID. When not specified, use the last message.
    let resolvedForkMessageId = forkedFromMessageId;
    if (!resolvedForkMessageId) {
      const { messages: tail } = this.messageRepo.listByThread(parentThreadId, 1);
      if (tail.length === 0) {
        throw new Error("No messages in parent thread to branch from");
      }
      resolvedForkMessageId = tail[tail.length - 1].id;
    }

    // Look up the fork message to get its sequence number.
    const forkMessage = this.messageRepo.findByIdInThread(parentThreadId, resolvedForkMessageId);
    if (!forkMessage) {
      throw new Error(`Fork message not found in parent thread: ${resolvedForkMessageId}`);
    }

    const { messages: forkedMessages, budget: forkHistoryBudget } = this.messageRepo.listByThreadUpToSequenceBudgeted(
      parentThreadId,
      forkMessage.sequence,
      {
        maxBytes: FORK_HISTORY_BUDGET_BYTES,
        pageSize: FORK_HISTORY_PAGE_SIZE,
        maxRows: FORK_HISTORY_MAX_MESSAGES,
      },
    );

    // Create child thread with lineage
    const lineage = { parentThreadId, forkedFromMessageId: resolvedForkMessageId };
    let thread: Thread;
    let threadWarnings: string[] | undefined;

    if (existingWorktreePath) {
      thread = await this.createAttachedExistingWorktreeThread({
        workspaceId,
        title,
        existingWorktreePath,
        provider,
        lineage,
        baseBranch: existingWorktreeBaseBranch,
      });
    } else if (mode === "worktree") {
      const createResult = await this.threadService.create(
        workspaceId,
        title,
        "worktree",
        branch,
        { branchless: worktreeBranchMode !== "named" },
      );
      threadWarnings = createResult.warnings;
      thread = createResult;
      // Patch lineage + provider atomically. If either fails, delete the orphan thread.
      try {
        this.threadRepo.updateLineage(thread.id, parentThreadId, resolvedForkMessageId);
        this.threadRepo.updateProvider(thread.id, provider);
      } catch (patchErr) {
        this.threadRepo.softDelete(thread.id);
        throw patchErr;
      }
      thread = { ...thread, provider, parent_thread_id: parentThreadId, forked_from_message_id: resolvedForkMessageId };
    } else {
      thread = this.threadRepo.create(workspaceId, title, "direct", branch, true, provider, lineage);
    }

    const resolvedCodexFast =
      codexFastMode !== undefined
        ? codexFastMode
        : parentThread.codex_fast_mode;
    this.threadRepo.updateModel(thread.id, model);
    this.threadRepo.updateSettings(thread.id, {
      ...(reasoningLevel !== undefined && { reasoning_level: reasoningLevel }),
      ...(interactionMode !== undefined && { interaction_mode: interactionMode }),
      ...(orchestrationMode !== undefined && { orchestration_mode: orchestrationMode }),
      ...(permissionMode !== undefined && permissionMode !== "default" && { permission_mode: permissionMode }),
      ...(effectiveContextWindowMode !== undefined && { context_window_mode: effectiveContextWindowMode }),
      ...(effectiveThinking !== undefined && { thinking: effectiveThinking }),
      ...(copilotAgent !== undefined && { copilot_agent: copilotAgent }),
      ...(provider === "codex" && resolvedCodexFast !== null && { codex_fast_mode: resolvedCodexFast }),
    });
    const persistedPermissionMode =
      permissionMode === "full" || permissionMode === "supervised"
        ? permissionMode
        : thread.permission_mode;
    thread = {
      ...thread,
      model,
      provider,
      reasoning_level: reasoningLevel ?? thread.reasoning_level,
      interaction_mode: interactionMode ?? thread.interaction_mode,
      orchestration_mode: orchestrationMode ?? thread.orchestration_mode,
      permission_mode: persistedPermissionMode,
      context_window_mode: effectiveContextWindowMode ?? thread.context_window_mode,
      thinking: effectiveThinking ?? thread.thinking,
      copilot_agent: copilotAgent ?? thread.copilot_agent,
      codex_fast_mode: provider === "codex" && resolvedCodexFast !== null
        ? resolvedCodexFast
        : thread.codex_fast_mode,
    };

    // Delegate handoff path selection (B/A/D) and the legacy-replay fallback to
    // the coordinator. It owns artifact persistence, the seq-1 anchor, off-band
    // delivery, and returns the provider-only first-turn payload.
    const { providerWireOverride } = await this.handoffCoordinator.deliverHandoff({
      parentThread,
      childThreadId: thread.id,
      childProvider: provider,
      forkMessage,
      forkedMessages,
      historyBudget: forkHistoryBudget,
      userMessage: content,
      model,
    });

    // In plan mode, wrap so the provider receives buildPlanPrompt(handoff + userPrompt).
    // The DB still stores the clean user prompt at seq 2 (written by sendMessage).
    const providerInput =
      interactionMode === "plan" ? this.buildPlanPrompt(providerWireOverride) : providerWireOverride;

    if (provider === "codex" && resolvedCodexFast !== null) {
      this.threadRepo.updateSettings(thread.id, {
        codex_fast_mode: resolvedCodexFast,
      });
    }

    const runtimeSnapshot = await this.sendInitialMessageAndSnapshot({
      threadId: thread.id,
      content,
      permissionMode,
      model,
      attachments,
      reasoningLevel,
      provider,
      interactionMode,
      maxBudgetUsd,
      maxTurns,
      copilotAgent,
      contextWindow: effectiveContextWindowMode,
      thinking: effectiveThinking,
      codexFastMode: resolvedCodexFast ?? undefined,
      providerWireOverride: providerInput,
      displayContent,
      mentions,
      previewAnnotations,
      goalObjective,
      orchestrationMode,
    }, (err) => {
      logger.error("createBranchedThread initial send failed", {
        threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      ...thread,
      runtimeSnapshot,
      ...(threadWarnings?.length ? { warnings: threadWarnings } : {}),
    };
  }

  /** Stop exact active turn, sharing one in-flight operation per thread. */
  async stopSession(threadId: string): Promise<AgentStopResult> {
    const existing = this.stopOperationsByThread.get(threadId);
    if (existing) return existing;
    const operation = this.stopSessionInternal(threadId);
    this.stopOperationsByThread.set(threadId, operation);
    try {
      return await operation;
    } finally {
      if (this.stopOperationsByThread.get(threadId) === operation) {
        this.stopOperationsByThread.delete(threadId);
      }
    }
  }

  /** Load the canonical child roster with server-authoritative stop eligibility. */
  loadCanonicalSubagentRoster(request: CanonicalSubagentRosterRequest): CanonicalSubagentRoster {
    const roster = this.canonicalSink.loadSubagentRoster(request);
    const addStopEligibility = (row: CanonicalSubagentRoster["active"][number]) => {
      const target = this.canonicalSink.loadCanonicalChildStopTarget({
        owningParentThreadId: request.owningParentThreadId,
        childThreadId: row.id,
      });
      if (!target
        || target.latestTurn?.status !== "Running"
        || !target.nativeThreadId
        || !target.nativeTurnId) return row;
      try {
        const provider = this.providerRegistry.resolve(target.childThread.providerId as ProviderId);
        return { ...row, canStop: isChildTurnCancellable(provider) };
      } catch {
        return row;
      }
    };
    return CanonicalSubagentRosterSchema().parse({
      ...roster,
      active: roster.active.map(addStopEligibility),
      done: roster.done,
    });
  }

  /** Stop one exact canonical child turn without stopping its provider session. */
  async stopChildTurn(
    owningParentThreadId: string,
    childThreadId: string,
  ): Promise<CanonicalSubagentStopResult> {
    return this.stopCanonicalChild({ owningParentThreadId, childThreadId });
  }

  /** Stop one exact canonical child turn without stopping its provider session. */
  async stopCanonicalChild(request: CanonicalSubagentStopRequest): Promise<CanonicalSubagentStopResult> {
    const operationKey = JSON.stringify([
      request.owningParentThreadId,
      request.childThreadId,
    ]);
    const existing = this.childStopOperationsByThread.get(operationKey);
    if (existing) return existing;
    const operation = this.stopCanonicalChildInternal(request);
    this.childStopOperationsByThread.set(operationKey, operation);
    try {
      return await operation;
    } finally {
      if (this.childStopOperationsByThread.get(operationKey) === operation) {
        this.childStopOperationsByThread.delete(operationKey);
      }
    }
  }

  private async stopCanonicalChildInternal(
    request: CanonicalSubagentStopRequest,
  ): Promise<CanonicalSubagentStopResult> {
    const target = this.canonicalSink.loadCanonicalChildStopTarget(request);
    if (!target) {
      return {
        childThreadId: request.childThreadId,
        status: "failed",
        message: "The selected child does not belong to this parent thread.",
      };
    }
    if (target.latestTurn?.status !== "Running") {
      return { childThreadId: request.childThreadId, status: "already-terminal" };
    }
    if (!target.nativeThreadId || !target.nativeTurnId) {
      return {
        childThreadId: request.childThreadId,
        status: "unsupported",
        message: "The active child turn does not have an exact provider identity.",
      };
    }

    let provider: IAgentProvider;
    try {
      provider = this.providerRegistry.resolve(target.childThread.providerId as ProviderId);
    } catch {
      return {
        childThreadId: request.childThreadId,
        status: "unsupported",
        message: "The child provider is unavailable.",
      };
    }
    if (!isChildTurnCancellable(provider)) {
      return {
        childThreadId: request.childThreadId,
        status: "unsupported",
        message: "The child provider does not support independent cancellation.",
      };
    }

    try {
      await provider.interruptChildTurn(
        `mcode-${request.owningParentThreadId}`,
        target.nativeThreadId,
        target.nativeTurnId,
      );
    } catch {
      logger.warn("Canonical child interruption failed", {
        category: "provider-interrupt-failed",
        owningParentThreadId: request.owningParentThreadId,
        childThreadId: request.childThreadId,
        providerId: target.childThread.providerId,
      });
      return {
        childThreadId: request.childThreadId,
        status: "failed",
        message: "Child interruption failed.",
      };
    }

    const finished = this.canonicalSink.finishCodexChildTurn({
      childThreadId: request.childThreadId,
      nativeTurnId: target.nativeTurnId,
      outcome: "cancelled",
      error: "Interrupted by user",
    });
    return {
      childThreadId: request.childThreadId,
      status: finished.status === "Interrupted" ? "interrupted" : "already-terminal",
    };
  }

  /** Stop exact active turn, preserving provider failure as retryable RPC error. */
  private async stopSessionInternal(threadId: string): Promise<AgentStopResult> {
    const sessionId = `mcode-${threadId}`;
    const thread = this.threadRepo.findById(threadId);
    const providerId = (thread?.provider ?? "claude") as ProviderId;
    const reservationToken = this.activeMutationReservations.get(threadId);
    const reservation = reservationToken ? this.mutationReservations.get(threadId) : undefined;
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    const runtimeBefore = this.turnRuntime.snapshot(threadId);
    const activeExecution = runtimeBefore
      && (runtimeBefore.phase === "running" || runtimeBefore.phase === "finalizing")
      && runtimeBefore.turnExecutionId !== null;
    const dispatchState: AgentStopResult["dispatchState"] = !activeExecution
      ? "unknown"
      : dispatch?.dispatchStarted === true
        ? "dispatched"
        : dispatch
          || reservation?.state === "activeTurn"
          || reservation?.state === "stopping"
          ? "not-dispatched"
          : "unknown";
    if (reservationToken) {
      this.mutationReservations.transition(threadId, reservationToken, "activeTurn", "stopping");
    }
    const idleSnapshot: TurnRuntimeSnapshot = {
      threadId,
      turnExecutionId: null,
      phase: "idle",
    };
    if (!activeExecution) {
      this.disarmTurnRetryWindow(threadId);
      return {
        threadId,
        turnExecutionId: runtimeBefore?.turnExecutionId ?? null,
        snapshot: runtimeBefore ?? idleSnapshot,
        status: "already-terminal",
        dispatchState,
      };
    }

    if (dispatchState !== "not-dispatched") {
      try {
        const provider = this.providerRegistry.resolve(providerId);
        await provider.stopSession(sessionId);
      } catch (err) {
        const runtimeAfterFailure = this.turnRuntime.snapshot(threadId);
        if (runtimeAfterFailure?.phase === "running" || runtimeAfterFailure?.phase === "finalizing") {
          if (reservationToken) {
            this.mutationReservations.transition(threadId, reservationToken, "stopping", "activeTurn");
          }
          this.retryingThreads.delete(threadId);
          this.endedSuppressionThreads.delete(threadId);
          logger.warn("Provider stopSession failed", {
            threadId,
            providerId,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
    }

    this.disarmTurnRetryWindow(threadId);
    const runtimeAfterProvider = this.turnRuntime.snapshot(threadId);
    if (!runtimeAfterProvider
      || runtimeAfterProvider.phase !== "running" && runtimeAfterProvider.phase !== "finalizing"
      || runtimeAfterProvider.turnExecutionId !== runtimeBefore.turnExecutionId) {
      return {
        threadId,
        turnExecutionId: runtimeAfterProvider?.turnExecutionId ?? runtimeBefore.turnExecutionId,
        snapshot: runtimeAfterProvider ?? runtimeBefore,
        status: "already-terminal",
        dispatchState,
      };
    }

    // A user stop ends the turn. The finalizer flushes partial assistant text,
    // persists buffered tool calls (running ones inherit "cancelled"), captures
    // the snapshot, broadcasts turn.persisted, and clears per-turn state.
    const terminalized = this.turnRuntime.terminalize(
      threadId,
      runtimeBefore.turnExecutionId!,
      "cancelled",
    );
    if (!terminalized) {
      const terminalSnapshot = this.turnRuntime.snapshot(threadId) ?? idleSnapshot;
      return {
        threadId,
        turnExecutionId: terminalSnapshot.turnExecutionId,
        snapshot: terminalSnapshot,
        status: "already-terminal",
        dispatchState,
      };
    }
    const finalize = this.finalizeTerminalTurn(threadId, "cancelled", "user stop");
    this.disarmTurnRetryWindow(threadId);
    await (finalize ?? Promise.resolve());
    this.threadRepo.updateStatus(threadId, "paused");
    broadcast("thread.status", { threadId, status: "paused" });
    if (this.activeSessionIds.has(threadId)) {
      this.activeSessionIds.delete(threadId);
      this.memoryPressureService.markIdle(threadId);
    }
    this.releaseMutationReservation(threadId, reservationToken);
    const snapshot = this.turnRuntime.snapshot(threadId) ?? idleSnapshot;
    return {
      threadId,
      turnExecutionId: runtimeBefore.turnExecutionId,
      snapshot,
      status: "cancelled",
      dispatchState,
    };
  }

  /** Return a thread's active open goal without starting provider work. */
  async getThreadGoal(threadId: string): Promise<GoalLookupResult> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    const providerId = (thread.provider ?? "claude") as ProviderId;
    const provider = this.providerRegistry.resolve(providerId);
    if (!isGoalCapable(provider)) {
      return {
        goal: null,
        authoritative: true,
        source: "unsupported",
        reason: "unsupported-provider",
      };
    }

    const sessionId = `mcode-${threadId}`;
    const result = provider.getGoalLookup
      ? await provider.getGoalLookup(sessionId)
      : {
          goal: await provider.getGoal(sessionId),
          authoritative: false,
          source: providerId === "codex" ? "codex-cache" as const : "claude-wrapper" as const,
          reason: "missing" as const,
        };
    return {
      ...result,
      goal: isGoalOpen(result.goal) ? result.goal : null,
    };
  }

  /** Clear a thread's active goal without writing transcript rows or starting a turn. */
  async clearThreadGoal(threadId: string): Promise<GoalLookupResult> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    const providerId = (thread.provider ?? "claude") as ProviderId;
    const provider = this.providerRegistry.resolve(providerId);
    if (!isGoalCapable(provider)) {
      return {
        goal: null,
        authoritative: true,
        source: "unsupported",
        reason: "unsupported-provider",
      };
    }

    const sessionId = `mcode-${threadId}`;
    const nativeClaude = asClaudeNativeGoalProvider(provider);
    if (nativeClaude?.hasNativeGoalCommand(sessionId) === true) {
      const lookup = provider.getGoalLookup
        ? await provider.getGoalLookup(sessionId)
        : { goal: await provider.getGoal(sessionId), authoritative: false, source: "claude-cache" as const };
      const currentGoal = isGoalOpen(lookup.goal) ? lookup.goal : null;
      if (currentGoal && this.activeSessionIds.has(threadId)) {
        return {
          goal: currentGoal,
          authoritative: false,
          source: "claude-cache",
          reason: "busy",
        };
      }

      const result = await nativeClaude.runNativeGoalCommand(sessionId, "/goal off");
      if (result?.kind === "cleared" || result?.kind === "empty") {
        return {
          goal: null,
          authoritative: true,
          source: "claude-native-command",
        };
      }
      if (result?.kind === "unavailable") {
        return {
          goal: currentGoal,
          authoritative: false,
          source: "claude-cache",
          reason: currentGoal ? "missing" : "not-materialized",
        };
      }
      const goalAfterNativeClear = provider.getGoalLookup
        ? (await provider.getGoalLookup(sessionId)).goal
        : await provider.getGoal(sessionId);
      return {
        goal: isGoalOpen(goalAfterNativeClear) ? goalAfterNativeClear : currentGoal,
        authoritative: false,
        source: "claude-cache",
        reason: "missing",
      };
    }

    const source = providerId === "codex" ? "codex-native" as const : "claude-wrapper" as const;
    const cleared = await provider.clearGoal(sessionId);
    if (cleared) {
      if (providerId === "codex" && provider.getGoalLookup) {
        const lookup = await provider.getGoalLookup(sessionId);
        if (lookup.source !== "codex-native" || lookup.authoritative !== true) {
          return {
            ...lookup,
            goal: isGoalOpen(lookup.goal) ? lookup.goal : null,
          };
        }
      }
      return { goal: null, authoritative: true, source };
    }

    const lookup = provider.getGoalLookup
      ? await provider.getGoalLookup(sessionId)
      : {
          goal: await provider.getGoal(sessionId),
          authoritative: false,
          source: providerId === "codex" ? "codex-cache" as const : "claude-wrapper" as const,
          reason: "missing" as const,
        };
    return {
      ...lookup,
      goal: isGoalOpen(lookup.goal) ? lookup.goal : null,
    };
  }

  /** Stop the active turn and discard any pooled provider session for a deleted thread. */
  async teardownSession(threadId: string): Promise<void> {
    const sessionId = `mcode-${threadId}`;
    const thread = this.threadRepo.findById(threadId);
    const providerId = (thread?.provider ?? "claude") as ProviderId;
    const wasActive = this.activeSessionIds.has(threadId);

    if (wasActive) {
      await this.stopSession(threadId);
    }

    let provider: import("@mcode/contracts").IAgentProvider;
    try {
      provider = this.providerRegistry.resolve(providerId);
    } catch (err) {
      logger.warn("Provider unavailable during thread teardown", {
        threadId,
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (isSessionEvictable(provider)) {
      await this.evictPooledSession(provider, sessionId);
    } else if (!wasActive) {
      await provider.stopSession(sessionId);
    }
  }

  /**
   * Get the current parent tool call ID for a thread's active Agent nesting.
   * Delegates to {@link NarrativeStore} which owns the agentCallStack and the
   * "exactly one running Agent" fallback rule (narrative-pipeline.md Trap 1).
   */
  getCurrentParentToolCallId(threadId: string): string | undefined {
    return this.narrativeStore.getCurrentParentToolCallId(threadId);
  }

  /**
   * Walk up the parentToolCallId chain to find the nearest Agent tool call
   * and return its description as the group label for TodoWrite tasks.
   */
  private resolveAgentGroupLabel(
    threadId: string,
    parentToolCallId: string,
  ): string {
    const buffer = this.narrativeStore.getBufferedToolCalls(threadId);
    let current: string | undefined = parentToolCallId;

    while (current) {
      const tc = buffer.find((b) => b.toolCallId === current);
      if (!tc) break;
      if (tc.toolName === "Agent") {
        const desc = tc._rawToolInput?.description ?? tc._rawToolInput?.prompt;
        if (typeof desc === "string" && desc.length > 0) {
          return desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
        }
        return "Sub-agent";
      }
      current = tc.parentToolCallId;
    }

    return "Sub-agent";
  }

  private coerceStoredTaskStatus(raw: unknown): StoredTask["status"] {
    const status = String(raw ?? "pending");
    if (
      status === "pending" ||
      status === "in_progress" ||
      status === "completed" ||
      status === "cancelled"
    ) {
      return status;
    }
    if (status === "inProgress" || status === "in-progress") return "in_progress";
    if (status === "canceled") return "cancelled";
    return "pending";
  }

  private taskCreateContent(toolInput: Record<string, unknown>): string | null {
    const subject =
      typeof toolInput.subject === "string" && toolInput.subject.trim().length > 0
        ? toolInput.subject.trim()
        : typeof toolInput.title === "string" && toolInput.title.trim().length > 0
          ? toolInput.title.trim()
          : typeof toolInput.content === "string" && toolInput.content.trim().length > 0
            ? toolInput.content.trim()
            : "";
    const description =
      typeof toolInput.description === "string" && toolInput.description.trim().length > 0
        ? toolInput.description.trim()
        : "";

    if (!subject && !description) return null;
    if (!subject) return description;
    if (!description) return subject;
    return `${subject} - ${description}`;
  }

  private updatePlanTasks(toolInput: Record<string, unknown>, group: string): StoredTask[] {
    const entries =
      Array.isArray(toolInput.plan)
        ? toolInput.plan
        : Array.isArray(toolInput.tasks)
          ? toolInput.tasks
          : Array.isArray(toolInput.todos)
            ? toolInput.todos
            : [];

    return entries.flatMap((entry): StoredTask[] => {
      const item: Record<string, unknown> = typeof entry === "object" && entry !== null
        ? entry as Record<string, unknown>
        : { step: entry };
      const content =
        typeof item.step === "string" && item.step.trim().length > 0
          ? item.step.trim()
          : typeof item.content === "string" && item.content.trim().length > 0
            ? item.content.trim()
            : typeof item.title === "string" && item.title.trim().length > 0
              ? item.title.trim()
              : typeof item.description === "string" && item.description.trim().length > 0
                ? item.description.trim()
                : "";
      if (!content) return [];
      return [{
        content,
        status: this.coerceStoredTaskStatus(item.status),
        group,
      }];
    });
  }

  /**
   * Persist a `TaskCreate` once its result arrives. The harness assigns the task
   * id (returned only in the result, e.g. "Task #1 created successfully: ...")
   * and that id is what later `TaskUpdate` calls reference, so the task can only
   * be stored with a stable identity here, not at tool-use time. Input fields
   * (subject/description/activeForm) are read back from the buffered tool call.
   */
  private handleTaskCreateResult(
    threadId: string,
    toolCallId: string,
    output: string,
    isError: boolean,
  ): void {
    if (isError) return;
    const buffered = this.narrativeStore
      .getBufferedToolCalls(threadId)
      .find((tc) => tc.toolCallId === toolCallId);
    if (!buffered || buffered.toolName !== "TaskCreate") return;
    const harnessId = parseHarnessTaskId(output);
    if (!harnessId) return;
    const input = buffered._rawToolInput ?? {};
    const content = this.taskCreateContent(input);
    if (!content) return;
    const group = buffered.parentToolCallId
      ? this.resolveAgentGroupLabel(threadId, buffered.parentToolCallId)
      : "Tasks";
    const activeForm =
      typeof input.activeForm === "string" && input.activeForm.trim().length > 0
        ? input.activeForm.trim()
        : undefined;
    try {
      this.taskRepo.appendTask(threadId, {
        id: harnessId,
        content,
        status: "pending",
        ...(activeForm ? { activeForm } : {}),
        group,
      });
    } catch (err) {
      logger.warn("TaskCreate task not persisted", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Apply a `TaskUpdate` to the persisted task list so the Scope view reflects
   * status transitions, deletions, and subject/activeForm edits after reload.
   * Matches the task by its harness id scoped to `group` (ids collide across
   * sub-agents); `deleted` removes it.
   */
  private applyTaskUpdate(
    threadId: string,
    toolInput: Record<string, unknown>,
    group: string,
  ): void {
    const taskId =
      toolInput.taskId != null && String(toolInput.taskId).length > 0
        ? String(toolInput.taskId)
        : "";
    if (!taskId) return;
    try {
      if (toolInput.status === "deleted") {
        this.taskRepo.removeTask(threadId, taskId, group);
        return;
      }
      const patch: Partial<Pick<StoredTask, "status" | "content" | "activeForm">> = {};
      if (toolInput.status !== undefined) {
        patch.status = this.coerceStoredTaskStatus(toolInput.status);
      }
      if (typeof toolInput.subject === "string" && toolInput.subject.trim().length > 0) {
        patch.content = toolInput.subject.trim();
      }
      if (typeof toolInput.activeForm === "string" && toolInput.activeForm.trim().length > 0) {
        patch.activeForm = toolInput.activeForm.trim();
      }
      if (Object.keys(patch).length > 0) {
        this.taskRepo.updateTask(threadId, taskId, patch, group);
      }
    } catch (err) {
      logger.warn("TaskUpdate not persisted", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Number of currently active sessions. */
  activeCount(): number {
    return this.activeSessionIds.size;
  }

  /** Atomically reserve the first accepted send for one thread. */
  reserveTurn(threadId: string): boolean {
    if (this.activeSessionIds.has(threadId)) return false;
    this.activeSessionIds.add(threadId);
    return true;
  }

  /** Get all currently active thread IDs. */
  activeThreadIds(): string[] {
    return this.turnRuntime.runningThreadIds();
  }

  /** Return authoritative per-thread runtime snapshots for reconnect hydration. */
  runtimeSnapshots(): TurnRuntimeSnapshot[] {
    return this.turnRuntime.snapshots();
  }

  /** Normalize one provider event once at the production provider boundary. */
  prepareProviderEvent(event: AgentEvent): AgentEvent | undefined {
    if (this.preparedProviderEvents.has(event as object)) {
      return this.preparedProviderEvents.get(event as object);
    }
    const normalizedEvent = this.turnRuntime.normalizeEvent(event);
    const normalized = normalizedEvent
      ? this.browserNarrativeEventSanitizer.sanitize(normalizedEvent)
      : undefined;
    this.preparedProviderEvents.set(event as object, normalized);
    return normalized;
  }

  /**
   * Forward a user's permission decision to the provider holding the request.
   * Tries all registered providers; the first one that holds the requestId resolves it.
   */
  respondToPermission(requestId: string, decision: PermissionDecision): void {
    for (const provider of this.providerRegistry.resolveAll()) {
      if (provider.resolvePermission?.(requestId, decision)) {
        return;
      }
    }
    logger.warn("permission.respond: no provider holds requestId %s", requestId);
  }

  /** Collect all pending permission requests for a thread across all providers. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    const results: PermissionRequest[] = [];
    for (const provider of this.providerRegistry.resolveAll()) {
      if (provider.listPendingPermissions) {
        results.push(...provider.listPendingPermissions(threadId));
      }
    }
    return results;
  }

  /**
   * Track that a session has ended. No-ops if the session was not active.
   * If this was the last active session, signals idle to MemoryPressureService.
   */
  private trackSessionEnded(threadId: string): void {
    if (this.activeSessionIds.delete(threadId)) {
      this.memoryPressureService.markIdle(threadId);
    }
    const reservationToken = this.turnRetryDispatchByThread.get(threadId)?.mutationReservationToken;
    this.releaseMutationReservation(threadId, reservationToken);
  }

  /** Release the shared mutation token without forcing provider-session teardown. */
  private releaseMutationReservation(threadId: string, reservationToken?: string): void {
    const currentToken = this.activeMutationReservations.get(threadId);
    const token = reservationToken ?? currentToken;
    if (token && currentToken === token) {
      this.activeMutationReservations.delete(threadId);
      this.mutationReservations.release(threadId, token);
    }
  }

  /** Check exact runtime and reservation ownership before setup crosses an async boundary. */
  private ownsActiveTurnExecution(
    threadId: string,
    turnExecutionId: string,
    reservationToken: string,
  ): boolean {
    const runtime = this.turnRuntime.snapshot(threadId);
    return runtime?.turnExecutionId === turnExecutionId
      && (runtime.phase === "running" || runtime.phase === "finalizing")
      && this.mutationReservations.owns(threadId, reservationToken, "activeTurn");
  }

  /** Return a retry dispatch only while its token and generation still own the thread. */
  private getCurrentRetryDispatch(
    threadId: string,
    identity?: RetryDispatchIdentity,
  ): (typeof this.turnRetryDispatchByThread extends Map<string, infer T> ? T : never) | null {
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    if (!dispatch) return null;
    if (identity
      && (dispatch.mutationReservationToken !== identity.mutationReservationToken
        || dispatch.generation !== identity.generation)) {
      return null;
    }
    if (!this.mutationReservations.owns(threadId, dispatch.mutationReservationToken, "activeTurn")) {
      return null;
    }
    return dispatch;
  }

  /** Snapshot the identity used to fence delayed retry work from a replacement turn. */
  private retryDispatchIdentity(dispatch: {
    mutationReservationToken: string;
    generation: number;
  }): RetryDispatchIdentity {
    return {
      mutationReservationToken: dispatch.mutationReservationToken,
      generation: dispatch.generation,
    };
  }

  /**
   * Whether a provider-emitted `Error` for `threadId` should be hidden from the
   * UI because a transient-failure retry is in flight. True only when the thread
   * is armed (mid retry loop) AND the error itself classifies as transient, so a
   * fatal error always reaches the user even during the retry window. Consulted
   * by the composition root before broadcasting and by the errored-finalize path.
   */
  shouldSuppressTransientTurnError(threadId: string, errorMessage: string): boolean {
    return this.retryingThreads.has(threadId) && this.turnErrorPolicy.classify(errorMessage) === "transient";
  }

  /**
   * Whether a provider-emitted `Ended` for `threadId` should be swallowed because
   * it trails a just-suppressed transient `Error` from a failed attempt. Keeps
   * the failed attempt's teardown (spinner off, partial-stream commit) from
   * flashing before the retry re-arms the running state. The flag is one retry
   * window wide: cleared before each re-dispatch and on the loop's final exit, so
   * the retry's own (or the give-up's) `Ended` still reaches the UI. Consulted by
   * the composition root before broadcasting and by the `Ended` cleanup path.
   *
   * Only the transient-retry flags gate this. A bare `Ended` with no in-flight
   * retry means the stream genuinely ended and must reach the cleanup path, or
   * the thread leaks in the running state. Internal session recreation
   * (context-window / permission-mode handoff) suppresses the superseded
   * session's `Ended` at the provider layer (`suppressEndedQueries`), so it never
   * needs a broad gate here.
   */
  shouldSuppressTurnEnded(threadId: string): boolean {
    if (this.endedSuppressionThreads.has(threadId)) return true;
    // Swallow `Ended` emitted while a re-dispatch is mid-flight (e.g. the pooled
    // session's eviction `Ended` during a transient retry).
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    return dispatch?.retryInFlight === true;
  }

  /**
   * Whether a provider-emitted `TurnComplete` for `threadId` should be swallowed
   * because it belongs to a failed attempt that is being retried. Mirrors
   * {@link shouldSuppressTurnEnded}: both gate the same retry-window teardown.
   */
  shouldSuppressTurnComplete(threadId: string): boolean {
    return this.endedSuppressionThreads.has(threadId);
  }

  /**
   * Clears the transient-retry window once the turn has finished or given up.
   */
  private disarmTurnRetryWindow(threadId: string, identity?: RetryDispatchIdentity): boolean {
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    if (identity && (!dispatch
      || dispatch.mutationReservationToken !== identity.mutationReservationToken
      || dispatch.generation !== identity.generation)) {
      return false;
    }
    this.retryingThreads.delete(threadId);
    this.endedSuppressionThreads.delete(threadId);
    this.turnRetryDispatchByThread.delete(threadId);
    return true;
  }

  /**
   * Starts finalization once for a terminal turn path. Provider streams can emit
   * both Error/TurnComplete and a trailing Ended for the same turn.
   */
  private finalizeTerminalTurn(
    threadId: string,
    outcome: TurnOutcome,
    source: string,
  ): Promise<void> | null {
    if (this.terminalFinalizedThreads.has(threadId)) return null;
    this.terminalFinalizedThreads.add(threadId);
    const finalizedExecutionId = this.turnRuntime.snapshot(threadId)?.turnExecutionId;
    const setup = this.fileTrackingSetupByThread.get(threadId);
    const activity = this.fileTrackingActivityByThread.get(threadId) ?? setup;
    const refCapture = this.fileTrackingRefCaptureByThread.get(threadId);
    const prerequisite = Promise.all([
      activity ?? Promise.resolve(),
      refCapture ?? Promise.resolve(),
    ]);
    const finalize = this.turnFinalizer.finalize(
      threadId,
      outcome,
      prerequisite,
      finalizedExecutionId ?? undefined,
    )
      .catch((err) => {
      logger.error("finalize failed on terminal event", {
        threadId,
        outcome,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      });
    this.fileTrackingFinalizationByThread.set(threadId, finalize);
    void finalize.finally(() => {
      if (this.finalResponseExecutionByThread.get(threadId) === finalizedExecutionId) {
        this.finalResponseExecutionByThread.delete(threadId);
      }
      if (this.fileTrackingSetupByThread.get(threadId) === setup) {
        this.fileTrackingSetupByThread.delete(threadId);
      }
      if (this.fileTrackingActivityByThread.get(threadId) === activity) {
        this.fileTrackingActivityByThread.delete(threadId);
      }
      if (this.fileTrackingRefCaptureByThread.get(threadId) === refCapture) {
        this.fileTrackingRefCaptureByThread.delete(threadId);
      }
      if (this.fileTrackingFinalizationByThread.get(threadId) === finalize) {
        this.fileTrackingFinalizationByThread.delete(threadId);
      }
    });
    return finalize;
  }

  /**
   * Evicts a pooled provider session and waits for its subprocess to unwind so
   * any trailing `Ended` from teardown is emitted while suppression is still armed.
   */
  private async evictPooledSession(
    provider: import("@mcode/contracts").IAgentProvider,
    sessionName: string,
  ): Promise<void> {
    if (!isSessionEvictable(provider)) return;
    await provider.discardSession(sessionName);
    const withWait = provider as import("@mcode/contracts").IAgentProvider & {
      waitForSessionExit?: (sessionId: string, timeoutMs?: number) => Promise<void>;
    };
    if (typeof withWait.waitForSessionExit === "function") {
      await withWait.waitForSessionExit(sessionName, 5000);
    }
  }

  /**
   * Re-dispatches a turn against a fresh session after a transient failure.
   * Returns true when a retry `sendTurn` was issued and the outer loop should continue.
   */
  private async runTransientTurnRetry(
    threadId: string,
    triggerErr: unknown,
    expectedIdentity?: RetryDispatchIdentity,
  ): Promise<boolean> {
    const dispatch = this.getCurrentRetryDispatch(threadId, expectedIdentity);
    if (!dispatch || dispatch.retryInFlight) return false;
    if (!this.turnErrorPolicy.shouldRetry(triggerErr, dispatch.attempt)) return false;
    const identity = this.retryDispatchIdentity(dispatch);

    dispatch.retryInFlight = true;
    this.endedSuppressionThreads.add(threadId);
    try {
      try {
        await this.evictPooledSession(dispatch.resolvedProvider, dispatch.sessionName);
      } catch (evictErr) {
        logger.warn("Failed to discard pooled session before retry", {
          threadId,
          error: evictErr instanceof Error ? evictErr.message : String(evictErr),
        });
      }
      if (!this.getCurrentRetryDispatch(threadId, identity)) return false;
      if (usesInternalThreadControlMcp(dispatch.effectiveProvider)) {
        this.threadControlMcp?.activate({
          sessionId: dispatch.sessionName,
          sourceThreadId: threadId,
          sourceTurnId: dispatch.sourceTurnId,
          sourceProviderId: dispatch.effectiveProvider,
          permissionMode: dispatch.turnRequest.permissionMode === "full" ? "full" : "supervised",
        });
      }
      try {
        this.threadRepo.clearSdkSessionId(threadId);
      } catch (clearErr) {
        logger.warn("Failed to clear sdk_session_id before retry", {
          threadId,
          error: clearErr instanceof Error ? clearErr.message : String(clearErr),
        });
      }
      if (!this.getCurrentRetryDispatch(threadId, identity)) return false;
      logger.warn("Transient send failed; retried against a fresh session", {
        threadId,
        attempt: dispatch.attempt,
        error: triggerErr instanceof Error ? triggerErr.message : String(triggerErr),
      });
      dispatch.attempt += 1;
      dispatch.turnRequest = { ...dispatch.turnRequest, resumeFrom: undefined };
      this.endedSuppressionThreads.delete(threadId);
      dispatch.sendTurnInFlight = true;
      try {
        const sendTurn = this.mutationReservations.runIfOwned(
          threadId,
          identity.mutationReservationToken,
          "activeTurn",
          () => {
            dispatch.dispatchStarted = true;
            return dispatch.resolvedProvider.sendTurn(dispatch.turnRequest);
          },
        );
        if (sendTurn === undefined) return false;
        await sendTurn;
        dispatch.sendTurnInFlight = false;
        return true;
      } catch (sendErr) {
        dispatch.sendTurnInFlight = false;
        if (!this.getCurrentRetryDispatch(threadId, identity)) return false;
        if (this.turnErrorPolicy.shouldRetry(sendErr, dispatch.attempt)) {
          return this.runTransientTurnRetry(threadId, sendErr, identity);
        }
        return false;
      }
    } finally {
      if (this.getCurrentRetryDispatch(threadId, identity)) {
        dispatch.retryInFlight = false;
      }
    }
  }

  /**
   * Schedules a stream-time transient retry from the `Error` event handler.
   * Fire-and-forget providers can emit `Error` after `sendTurn` already resolved.
   */
  private scheduleTransientStreamRetry(threadId: string, errorMessage: string): void {
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    if (!dispatch || dispatch.retryInFlight) return;
    const identity = this.retryDispatchIdentity(dispatch);
    void (async () => {
      if (!this.getCurrentRetryDispatch(threadId, identity)) return;
      if (this.turnErrorPolicy.shouldRetry(errorMessage, dispatch.attempt)) {
        const retried = await this.runTransientTurnRetry(threadId, errorMessage, identity);
        if (retried) return;
      }
      await this.giveUpTransientTurnRetry(threadId, errorMessage, identity);
    })().catch((err) => {
      logger.error("Transient stream retry failed", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Surfaces a terminal failure after the retry cap is exhausted.
   */
  private async giveUpTransientTurnRetry(
    threadId: string,
    err: unknown,
    identity?: RetryDispatchIdentity,
  ): Promise<void> {
    const dispatch = this.getCurrentRetryDispatch(threadId, identity);
    if (!dispatch) return;
    const effectiveProvider = dispatch.effectiveProvider;
    const pendingRollback = dispatch.pendingRollback;

    this.disarmTurnRetryWindow(threadId, this.retryDispatchIdentity(dispatch));
    const wasActive = this.activeSessionIds.delete(threadId);
    if (wasActive) {
      this.memoryPressureService.markIdle(threadId);
    }
    this.releaseMutationReservation(threadId, dispatch.mutationReservationToken);
    // Roll the just-installed command side effect back so a failed send doesn't
    // leave a hidden gate (e.g. a Stop-hook goal) active on the next turn. Runs
    // only here, after the retry budget is spent; transient retries keep it.
    if (pendingRollback !== null) {
      try {
        await pendingRollback();
      } catch (clearErr) {
        logger.warn("Failed to roll back command side effect after failed send", {
          threadId,
          error: clearErr instanceof Error ? clearErr.message : String(clearErr),
        });
      }
    }
    const rawMessage = err instanceof Error ? err.message : String(err);
    const errorMessage = this.normalizeProviderError(rawMessage, effectiveProvider);
    const turnExecutionId = dispatch.turnRequest.turnExecutionId;
    logger.error("Provider send failed", { threadId, error: rawMessage });

    try {
      const resolvedProvider = this.providerRegistry.resolve(effectiveProvider) as unknown as import("events").EventEmitter;
      resolvedProvider.emit("event", {
        type: "error",
        threadId,
        turnExecutionId,
        error: errorMessage,
      } satisfies AgentEvent);
      resolvedProvider.emit("event", {
        type: "ended",
        threadId,
        turnExecutionId,
      } satisfies AgentEvent);
    } catch (emitErr) {
      logger.warn("Failed to emit error event to provider", {
        threadId,
        error: emitErr instanceof Error ? emitErr.message : String(emitErr),
      });
    }

    this.threadRepo.updateStatus(threadId, "errored");
  }

  /**
   * Subscribe to all provider events and handle persistence internally.
   * Must be called once at startup after the DI container is fully resolved.
   * Keeps assistant message persistence inside the service rather than
   * leaking it into the composition root.
   * The optional publication callback runs after the synchronous internal pass
   * for every normalized event, including events that take an internal
   * early-return path. A deferred file-tracking replay handles the event
   * internally but does not publish it again.
   * Idempotent: subsequent calls are no-ops.
   */
  init(onProviderEvent?: (event: AgentEvent) => void): void {
    if (this.initialized) return;
    this.initialized = true;

    this.memoryPressureService.onPressureChange((snapshot) => {
      this.handleMemoryPressure(snapshot);
    });

    for (const provider of this.providerRegistry.resolveAll()) {
      provider.on("file_mutation_start", (event: ProviderFileMutationStart) => {
        void this.ensureTurnFileTracking(event.threadId);
        this.queueTurnFileTracking(event.threadId, () => (
          this.turnFileTracker.observeToolUse(
            event.threadId,
            event.toolCallId,
            event.toolName,
            event.toolInput,
          )
        ));
      });
      const handleNormalizedEvent = (event: AgentEvent): void => {
        if (
          event.type === AgentEventType.ToolUse
          && event.toolName === "Agent"
          && event.toolInput.codexCollabKind === "spawnAgent"
          && !event.codexChild
          && event.turnExecutionId
        ) {
          this.startCodexChildFromProviderEvent(event);
          // The child turn owns delegated input; the parent narrative keeps only its compact Agent reference.
          event = {
            ...event,
            toolInput: Object.fromEntries(
              Object.entries(event.toolInput).filter(([key]) => key !== "prompt"),
            ),
          };
        }
        if (event.type === AgentEventType.ToolUse || event.type === AgentEventType.ToolResult) {
          if (!("codexChild" in event && event.codexChild)) {
            this.recordCodexCollaborationAction(event, `toolCall:${event.toolCallId}`);
          }
        }
        if (
          event.type === AgentEventType.TurnStarted
          && "codexContinuation" in event
          && event.codexContinuation
          && !this.startCodexProviderContinuationFromEvent(event)
        ) {
          logger.warn("Ignoring provider continuation without canonical collaboration action", {
            threadId: event.threadId,
            turnExecutionId: event.turnExecutionId,
          });
          return;
        }
        if ("codexChild" in event && event.codexChild && this.handleCodexChildProviderEvent(event)) return;
        const priorFinalization = this.fileTrackingFinalizationByThread.get(event.threadId);
        const existingBarrier = this.providerEventBarrierByThread.get(event.threadId);
        if (!existingBarrier && priorFinalization && event.type === AgentEventType.TurnStarted) {
          this.fileTrackingSetupByThread.delete(event.threadId);
          this.fileTrackingActivityByThread.delete(event.threadId);
          this.fileTrackingRefCaptureByThread.delete(event.threadId);
          void this.ensureTurnFileTracking(event.threadId);
          this.earlyFileTrackingEvents.add(event);
        }
        if (existingBarrier && event.type === AgentEventType.ToolUse) {
          const toolUseEvent = event;
          this.queueTurnFileTracking(event.threadId, () => (
            this.turnFileTracker.observeToolUse(
              toolUseEvent.threadId,
              toolUseEvent.toolCallId,
              toolUseEvent.toolName,
              toolUseEvent.toolInput,
            )
          ));
          this.earlyFileTrackingEvents.add(event);
        }
        if (existingBarrier && event.type === AgentEventType.ToolResult) {
          const toolResultEvent = event;
          this.queueTurnFileTracking(event.threadId, () => (
            this.turnFileTracker.observeToolResult(
              toolResultEvent.threadId,
              toolResultEvent.toolCallId,
              toolResultEvent.toolInput,
            )
          ));
          this.earlyFileTrackingEvents.add(event);
        }
        const barrier = existingBarrier
          ?? (event.type === AgentEventType.TurnStarted ? priorFinalization : undefined);
        if (barrier) {
          if (!existingBarrier) this.providerEventBarrierByThread.set(event.threadId, barrier);
          void barrier.then(() => {
            if (event.type === AgentEventType.TurnStarted
              && this.providerEventBarrierByThread.get(event.threadId) === barrier) {
              this.providerEventBarrierByThread.delete(event.threadId);
            }
            const deferredEvent = this.turnRuntime.normalizeEvent(event);
            if (deferredEvent) {
              handleEvent(deferredEvent, false);
            }
          });
          return;
        }
        if (event.turnExecutionId) {
          this.canonicalSink.recordProviderDiagnostic({
            executionId: event.turnExecutionId,
            event,
            terminal: event.type === AgentEventType.TurnComplete
              || event.type === AgentEventType.Error
              || event.type === AgentEventType.Ended,
          });
        }
        // Plan mode: feed streaming text to the question parser.
        // Buffer questions until the session closes (`ended`) so the client
        // cannot submit answers against a still-active session, which would
        // risk overlapping sends on the same thread.
        if (event.type === AgentEventType.TextDelta) {
          // Final-response deltas belong to TurnFinalizer, which owns the
          // assistant body fallback when a provider Message never arrives.
          // Unknown/non-final deltas belong to NarrativeStore until the
          // authoritative boundary either closes them as thoughts or transfers
          // them into TurnFinalizer.
          if (event.isFinalResponse) {
            this.turnFinalizer.appendStreamingText(event.threadId, event.delta);
          } else {
            // Open or extend the current thought segment. NarrativeStore allocates
            // the sort order lazily on the first delta so consecutive deltas keep
            // the same slot, taken BEFORE any following tool call's sort order.
            this.narrativeStore.openOrExtendThought(event.threadId, event.delta);
          }
          const parser = this.planParsers.get(event.threadId);
          if (parser) {
            const questions = parser.feed(event.delta);
            if (questions) {
              // Broadcast immediately so the wizard renders as soon as the model
              // finishes emitting the fenced block, even while the session keeps
              // streaming. Submission is gated client-side on thread-running state.
              broadcast("plan.questions", { threadId: event.threadId, questions });
              this.planParsers.delete(event.threadId);
            }
          }
          const outputParser = this.planOutputParsers.get(event.threadId);
          if (outputParser) {
            const planOutput = outputParser.feed(event.delta);
            if (planOutput) {
              this.planOutputParsers.delete(event.threadId);
              this.pendingPlanOutputs.set(event.threadId, planOutput);
            }
          }
          // NOTE: Do NOT clear agentCallStack on textDelta. The Claude SDK
          // emits textDelta from subagents while they are still running child
          // tool calls. Clearing the stack here would cause subsequent child
          // toolUse events to lose their parentToolCallId enrichment. The stack
          // is cleaned up on turnComplete/ended and when toolResult arrives for
          // Agent calls via updateBufferedToolCallOutput.
        }

        if (event.type === AgentEventType.GeneratedAttachment) {
          this.turnFinalizer.bufferAssistantAttachments(event.threadId, [event.attachment]);
        }

        if (event.type === AgentEventType.Message) {
          if (event.turnExecutionId) {
            this.finalResponseExecutionByThread.set(event.threadId, event.turnExecutionId);
          }
          let isPostTurnGoalReceipt = false;
          let messagePersisted = false;
          try {
            // Record the thread's active model on the message so the UI can
            // display which provider/model produced the response, even if the
            // user later switches model mid-conversation.
            const thread = this.threadRepo.findById(event.threadId);
            const modelForMessage = thread?.model ?? null;
            isPostTurnGoalReceipt =
              this.turnCompleteSeenByThread.has(event.threadId) &&
              GOAL_ACHIEVED_RECEIPT_RE.test(event.content.trim());

            if (isPostTurnGoalReceipt) {
              const { messages } = this.messageRepo.listByThread(event.threadId, 1);
              const last = messages[messages.length - 1] ?? null;
              const nextSequence = this.messageRepo.getLatestSequenceIncludingInternal(event.threadId) + 1;
              const receipt = last?.role === "assistant" && last.content === event.content
                ? last
                : this.messageRepo.create(
                  event.threadId,
                  "assistant",
                  event.content,
                  nextSequence,
                  undefined,
                  undefined,
                  undefined,
                  modelForMessage,
                );
              event.messageId = receipt.id;
              event.model = modelForMessage;
            } else {
              // Buffer the body behind the finalize seam instead of writing it
              // eagerly. TurnFinalizer.finalize materializes the row only when the
              // TurnSubstance predicate holds, so a turn that produced no tool call,
              // body, narration, or hook leaves no assistant row (#578).
              const attachments = this.turnFinalizer.getBufferedAssistantAttachments(event.threadId);
              const messageId = this.turnFinalizer.bufferAssistantBody(
                event.threadId,
                event.content,
                modelForMessage,
                attachments,
              );
              // Carry the deterministic message ID so the broadcast schema passes it
              // through to the client. The client uses it for stable message identity
              // (branching, dedup across Electron's dual MessagePort+WebSocket channels).
              event.messageId = messageId;
              // Carry the model too so the client's locally-built Message can
              // show the model name in the footer immediately — without it the
              // footer renders without the model until a thread refresh re-fetches
              // the persisted row from the DB.
              event.model = modelForMessage;
              if (attachments.length > 0) {
                event.attachments = attachments;
              }
              this.turnFinalizer.resetStreamingText(event.threadId);
            }
            messagePersisted = true;
          } catch (err) {
            logger.error("Failed to persist assistant message", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          this.maybeCompleteDirectResponseGoal(provider, event);
          // A Message event marks the end of the turn. Any Agent calls still
          // on the stack are implicitly done - clear the stack so the next turn
          // starts clean (narrative-pipeline.md Trap 2 end-of-turn clear).
          this.narrativeStore.clearAgentStackOnMessage(event.threadId);

          // Persist any pending plan-output extracted from streamed text deltas.
          // Guarded on event.messageId so it only runs when the assistant message
          // was successfully buffered above.
          const pendingPlan = this.pendingPlanOutputs.get(event.threadId);
          const pendingExitPlan = this.pendingExitPlanMarkdown.get(event.threadId);
          const hadOutputParser = this.planOutputParsers.has(event.threadId);
          // plans.message_id is a NOT NULL FK to messages.id, so the assistant
          // row must exist before persistPlanRecord runs. The body is otherwise
          // buffered until TurnFinalizer.finalize; materialize it eagerly here so
          // the FK target is present (materializeAssistantRow is idempotent).
          if ((pendingPlan || pendingExitPlan || hadOutputParser) && event.messageId) {
            this.turnFinalizer.materializeAssistantRow(event.threadId);
          }
          if (pendingPlan && event.messageId) {
            this.pendingPlanOutputs.delete(event.threadId);
            this.planOutputParsers.delete(event.threadId);
            this.pendingExitPlanMarkdown.delete(event.threadId);
            const contentMd = pendingPlan.sections
              .map((s) => `${"#".repeat(s.level + 1)} ${s.title}\n\n${s.content}`)
              .join("\n\n");

            const sectionsJson = JSON.stringify(
              pendingPlan.sections.map((s) => ({ id: s.id, title: s.title, level: s.level })),
            );

            this.persistPlanRecord(
              event.threadId,
              event.messageId,
              pendingPlan.title,
              contentMd,
              sectionsJson,
              pendingPlan.changeSummary ?? null,
            );
          } else if (pendingExitPlan && event.messageId) {
            this.pendingExitPlanMarkdown.delete(event.threadId);
            this.planOutputParsers.delete(event.threadId);
            const extracted = this.extractPlanFromMarkdown(pendingExitPlan);
            if (extracted) {
              this.persistPlanRecord(
                event.threadId,
                event.messageId,
                extracted.title,
                extracted.contentMd,
                extracted.sectionsJson,
                null,
              );
            }
          } else if (hadOutputParser && !pendingPlan && event.messageId && event.content) {
            // Fallback: the model didn't emit a ```plan-output block but this
            // was a plan-answer turn. Extract a plan from the raw markdown.
            this.planOutputParsers.delete(event.threadId);
            try {
              const extracted = this.extractPlanFromMarkdown(event.content);
              if (extracted) {
                this.persistPlanRecord(
                  event.threadId,
                  event.messageId,
                  extracted.title,
                  extracted.contentMd,
                  extracted.sectionsJson,
                  null,
                );
                logger.info("plan-output: extracted plan from markdown fallback", {
                  threadId: event.threadId,
                  title: extracted.title,
                });
              }
            } catch (err) {
              logger.warn("plan-output: markdown fallback extraction failed", {
                threadId: event.threadId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          const runtime = this.turnRuntime.snapshot(event.threadId);
          if (messagePersisted
            && !isPostTurnGoalReceipt
            && !this.compactionInProgressByThread.has(event.threadId)
            && event.turnExecutionId
            && runtime?.turnExecutionId === event.turnExecutionId
            && (runtime.phase === "running" || runtime.phase === "finalizing")
            && !this.turnCompleteSeenByThread.has(event.threadId)) {
            const completionEvent: AgentEvent = {
              type: AgentEventType.TurnComplete,
              threadId: event.threadId,
              turnExecutionId: event.turnExecutionId,
              reason: "message_received",
              costUsd: null,
              tokensIn: 0,
              tokensOut: 0,
              providerId: this.threadRepo.findById(event.threadId)?.provider,
            };
            queueMicrotask(() => {
              const current = this.turnRuntime.snapshot(event.threadId);
              if (!current || current.turnExecutionId !== event.turnExecutionId) {
                return;
              }
              if ((current.phase === "running" || current.phase === "finalizing")
                && !this.compactionInProgressByThread.has(event.threadId)
                && !this.turnCompleteSeenByThread.has(event.threadId)) {
                this.emitProviderEvent(provider, completionEvent);
              }
            });
          }
        }

        if (event.type === AgentEventType.AssistantMessageBoundary) {
          // Authoritative classification of the just-streamed text deltas based
          // on the Anthropic message-level `stop_reason`. When `isFinalResponse`
          // is true, move that text to the assistant body owner so it never
          // persists as a thought row or lives in two server-side buffers.
          // Otherwise the message ended with a non-finalizing stop_reason such
          // as `tool_use`; close the thought so it persists as preamble.
          if (event.isFinalResponse) {
            const finalText = this.narrativeStore.takeOpenThought(event.threadId);
            if (finalText) {
              this.turnFinalizer.appendStreamingText(event.threadId, finalText);
            }
          } else {
            this.narrativeStore.closeOpenThought(event.threadId);
            this.turnFinalizer.resetStreamingText(event.threadId);
          }
        }

        if (event.type === AgentEventType.ToolUse) {
          const toolUseEvent = event;
          this.narrativeStore.closeOpenThought(event.threadId);
          this.bufferToolCall(event.threadId, toolUseEvent);
          if (!this.earlyFileTrackingEvents.delete(toolUseEvent)) {
            this.queueTurnFileTracking(event.threadId, () => (
              this.turnFileTracker.observeToolUse(
                toolUseEvent.threadId,
                toolUseEvent.toolCallId,
                toolUseEvent.toolName,
                toolUseEvent.toolInput,
              )
            ));
          }
        }

        if (event.type === AgentEventType.HookStarted) {
          // Late hooks (TurnComplete already seen) bypass the in-turn buffer.
          // They will be persisted directly in the paired HookCompleted handler.
          if (this.turnCompleteSeenByThread.has(event.threadId)) {
            const sortOrder = this.narrativeStore.nextSortOrder(event.threadId);
            // Use the open-hook map as a scratch pad so HookCompleted can still
            // pair with the HookStarted record even for late hooks.
            this.narrativeStore.openHook(event.threadId, {
              hookName: event.hookName,
              toolName: event.toolName ?? null,
              // Post-turn hooks are always tagged "stop" regardless of hookType
              // because they fire after the SDK result message.
              phase: "stop",
              payload: JSON.stringify({ hookType: "stop", toolName: null }),
              sortOrder,
            });
          } else {
            const sortOrder = this.narrativeStore.nextSortOrder(event.threadId);
            // Close any open thought so the hook sorts after the text that preceded it,
            // mirroring the tool-call branch.
            this.narrativeStore.closeOpenThought(event.threadId);
            this.narrativeStore.openHook(event.threadId, {
              hookName: event.hookName,
              toolName: event.toolName ?? null,
              phase: event.hookType,
              payload: JSON.stringify({ hookType: event.hookType, toolName: event.toolName ?? null }),
              sortOrder,
            });
          }
        }

        if (event.type === AgentEventType.HookCompleted) {
          const open = this.narrativeStore.peekOpenHook(event.threadId, event.hookName);
          if (open) {
            const endedAt = new Date().toISOString();
            // Late hook: persist immediately to the last message row and
            // broadcast a HookCompleted event with persistedMessageId.
            if (this.turnCompleteSeenByThread.has(event.threadId)) {
              this.flushLateHook(event.threadId, {
                id: open.id,
                hookName: open.hookName,
                toolName: open.toolName,
                phase: open.phase,
                payload: open.payload,
                durationMs: event.durationMs,
                didBlock: event.didBlock,
                startedAt: open.startedAt,
                endedAt,
                sortOrder: open.sortOrder,
              });
            } else {
              this.narrativeStore.pushClosedHook(event.threadId, {
                id: open.id,
                messageId: "",
                hookName: open.hookName,
                toolName: open.toolName,
                phase: open.phase,
                payload: open.payload,
                durationMs: event.durationMs,
                didBlock: event.didBlock,
                startedAt: open.startedAt,
                endedAt,
                sortOrder: open.sortOrder,
              });
            }
            this.narrativeStore.removeOpenHook(event.threadId, event.hookName);
          }
        }

        if (event.type === AgentEventType.ToolResult) {
          const toolResultEvent = event;
          if (!this.earlyFileTrackingEvents.delete(toolResultEvent)) {
            this.queueTurnFileTracking(event.threadId, () => (
              this.turnFileTracker.observeToolResult(
                toolResultEvent.threadId,
                toolResultEvent.toolCallId,
                toolResultEvent.toolInput,
              )
            ));
          }
          this.narrativeStore.updateBufferedToolCallOutput(
            event.threadId,
            event.toolCallId,
            event.output,
            event.isError,
            event.toolInput,
            {
              ...(event.outputTruncated === true ? { outputTruncated: true } : {}),
              ...(event.outputTotalBytes != null ? { outputTotalBytes: event.outputTotalBytes } : {}),
              ...(event.outputArtifactPath ? { outputArtifactPath: event.outputArtifactPath } : {}),
              ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
            },
          );
          // Persist a just-created task now that the harness has assigned its id.
          this.handleTaskCreateResult(
            event.threadId,
            event.toolCallId,
            event.output,
            event.isError,
          );
        }

        if (event.type === AgentEventType.TurnStarted) {
          const currentReservation = this.mutationReservations.get(event.threadId);
          const thread = this.threadRepo.findById(event.threadId);
          const stoppedThread = !thread
            || ["paused", "stopped", "completed", "errored", "failed", "interrupted"].includes(thread.status);
          if (currentReservation?.state === "stopping" || stoppedThread) {
            logger.warn("Ignoring late TurnStarted for stopped thread", {
              threadId: event.threadId,
              reservationState: currentReservation?.state,
              threadStatus: thread?.status,
            });
            if (currentReservation?.state !== "stopping") {
              try {
                const providerId = (thread?.provider ?? "claude") as ProviderId;
                const provider = this.providerRegistry.resolve(providerId);
                void Promise.resolve(provider.stopSession(`mcode-${event.threadId}`)).catch((error) => {
                  logger.warn("Failed to stop late auto-resumed turn", {
                    threadId: event.threadId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                });
              } catch (error) {
                logger.warn("Failed to resolve provider for late auto-resumed turn", {
                  threadId: event.threadId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            return;
          }
          if (!this.activeMutationReservations.has(event.threadId)) {
            const reservationToken = this.mutationReservations.reserve(event.threadId, "activeTurn");
            if (!reservationToken) {
              logger.warn("Aborting auto-resumed turn because a mutation reservation is owned", {
                threadId: event.threadId,
                reservationState: this.mutationReservations.get(event.threadId)?.state,
              });
              try {
                const thread = this.threadRepo.findById(event.threadId);
                const providerId = (thread?.provider ?? "claude") as ProviderId;
                const provider = this.providerRegistry.resolve(providerId);
                void Promise.resolve(provider.stopSession(`mcode-${event.threadId}`)).catch((error) => {
                  logger.warn("Failed to stop blocked auto-resumed turn", {
                    threadId: event.threadId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                });
              } catch (error) {
                logger.warn("Failed to resolve provider for blocked auto-resumed turn", {
                  threadId: event.threadId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              return;
            }
            this.activeMutationReservations.set(event.threadId, reservationToken);
          }
          if (!this.earlyFileTrackingEvents.delete(event)) {
            this.fileTrackingSetupByThread.delete(event.threadId);
            this.fileTrackingActivityByThread.delete(event.threadId);
            this.fileTrackingRefCaptureByThread.delete(event.threadId);
            void this.ensureTurnFileTracking(event.threadId);
          }
          // Re-add to activeSessionIds for auto-resumed turns (ScheduleWakeup/loop).
          // For sendMessage()-originated turns this is a no-op since sendMessage()
          // already added the thread before emitting TurnStarted.
          if (!this.activeSessionIds.has(event.threadId)) {
            this.activeSessionIds.add(event.threadId);
            this.memoryPressureService.markActive(event.threadId);
          }
          // Reset per-turn state that must survive past turn finalize so late
          // hooks can attach to the previous turn. Re-seeding them here rather
          // than in the finalizer's clear ensures a fresh counter for each new turn
          // while late hooks from the prior turn can still increment the old one.
          this.narrativeStore.resetTurnCounters(event.threadId);
          this.turnCompleteSeenByThread.delete(event.threadId);
          this.finalResponseExecutionByThread.delete(event.threadId);
          this.terminalFinalizedThreads.delete(event.threadId);
        }

        if (event.type === AgentEventType.TurnComplete) {
          // Swallow a failed attempt's `TurnComplete` during a retry so the UI
          // running state survives until the fresh attempt streams.
          if (this.shouldSuppressTurnComplete(event.threadId)) {
            return;
          }
          // Mark that the turn result has been seen so any hooks that arrive
          // after this point (Stop / SessionEnd / PreCompact) are routed through
          // flushLateHook instead of the normal mid-turn buffer.
          this.turnCompleteSeenByThread.add(event.threadId);

          if (!this.compactionInProgressByThread.has(event.threadId)
            && this.turnRuntime.terminalize(event.threadId, event.turnExecutionId!, "completed")) {
            void this.finalizeTerminalTurn(event.threadId, "completed", "turnComplete");
          }

          // Clear the "running" flag so agent.listRunning no longer reports
          // this thread and shutdown won't downgrade it to "interrupted."
          // Skip during compaction: the SDK fires a synthetic TurnComplete
          // before the compaction API call, but the session continues
          // automatically.
          if (!this.compactionInProgressByThread.has(event.threadId)) {
            this.threadControlMcp?.revoke(`mcode-${event.threadId}`);
            this.trackSessionEnded(event.threadId);
            this.disarmTurnRetryWindow(event.threadId);
            void this.refreshNativeClaudeGoalAfterTurn(event.threadId);
          }

          // Persist context usage so the tracker shows immediately on thread reload.
          // Skip during compaction: the compaction API call emits a turnComplete
          // with the pre-compaction token count. Persisting it would cause cold
          // reloads to resurrect the wrong (near-100%) context fill.
          if (event.tokensIn > 0 && !this.compactionInProgressByThread.has(event.threadId)) {
            try {
              // Always persist tokensIn. contextWindow is only written when the
              // SDK reports it — providers that don't expose a context window
              // (e.g. Codex) leave that column unchanged.
              this.threadRepo.updateContextUsage(event.threadId, event.tokensIn, event.contextWindow);
            } catch (err) {
              logger.warn("Context usage not persisted", {
                threadId: event.threadId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // Update running baseline so tool-result estimates start from the
          // correct post-turn value.
          this.lastContextByThread.set(event.threadId, event.tokensIn);
          if (event.contextWindow) {
            this.lastContextWindowByThread.set(event.threadId, event.contextWindow);
          }
        }

        if (event.type === AgentEventType.Error) {
          // Hide a transient failure that is about to be retried: skip the
          // errored finalize so the failed attempt does not persist a partial
          // turn or clear per-turn state mid-retry. The fresh attempt owns the
          // turn's real outcome. Fatal errors are not suppressed (see the gate).
          if (this.shouldSuppressTransientTurnError(event.threadId, event.error ?? "")) {
            // Also swallow the `Ended` that trails this error so the failed
            // attempt's teardown never reaches the UI mid-retry. The retry loop
            // clears the flag before re-dispatch and on its final exit.
            this.endedSuppressionThreads.add(event.threadId);
            const streamDispatch = this.turnRetryDispatchByThread.get(event.threadId);
            // Only re-dispatch from the stream when sendTurn already settled.
            // Rejections are retried from the sendTurn catch to avoid double retry.
            if (streamDispatch && !streamDispatch.sendTurnInFlight) {
              this.scheduleTransientStreamRetry(event.threadId, event.error ?? "");
            }
            return;
          }
          // The finalizer discards the buffered turn when no assistant row
          // exists (e.g. a pre-turn CLI-not-found failure) rather than
          // broadcasting turn.persisted against the wrong (user) message id.
          this.disarmTurnRetryWindow(event.threadId);
          if (this.turnRuntime.terminalize(event.threadId, event.turnExecutionId!, "errored")) {
            void this.finalizeTerminalTurn(event.threadId, "errored", "error");
          }
          this.trackSessionEnded(event.threadId);
          this.releaseMutationReservation(event.threadId);
          // Turn-scoped cleanup of any one-shot handoff Read grant when the
          // first Turn errors out before completing normally.
          this.scopedPreGrant.clear(event.threadId);
          this.planParsers.delete(event.threadId);
          this.planOutputParsers.delete(event.threadId);
          this.pendingPlanOutputs.delete(event.threadId);
          this.pendingExitPlanMarkdown.delete(event.threadId);
          this.planCapturedThisTurn.delete(event.threadId);
        }

        if (event.type === AgentEventType.Compacting && event.active) {
          // Compaction is consuming the entire conversation as input.
          // Zero the baseline so no tool-result estimate fires during compaction,
          // and mark in-progress so turnComplete does not persist the compaction
          // call's pre-compaction token count to the DB.
          this.lastContextByThread.set(event.threadId, 0);
          this.compactionInProgressByThread.add(event.threadId);
        }

        if (event.type === AgentEventType.Compacting && !event.active) {
          this.compactionInProgressByThread.delete(event.threadId);
          // Compaction finished — persist a system divider message
          try {
            const nextSeq = this.messageRepo.getLatestSequenceIncludingInternal(event.threadId) + 1;
            this.messageRepo.create(
              event.threadId,
              "system",
              "Context compacted",
              nextSeq,
            );
          } catch (err) {
            logger.error("Failed to persist compaction system message", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (event.type === AgentEventType.CompactSummary) {
          try {
            this.threadRepo.updateCompactSummary(event.threadId, event.summary);
            logger.info("Persisted compaction summary", { threadId: event.threadId, summaryLength: event.summary.length });
          } catch (err) {
            logger.error("Failed to persist compaction summary", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Persist SDK session ID so the thread can be resumed after a
        // server restart. The Codex provider emits this on thread.started.
        if (event.type === AgentEventType.System) {
          const SDK_PREFIX = "sdk_session_id:";
          if (event.subtype.startsWith(SDK_PREFIX)) {
            const sdkId = event.subtype.slice(SDK_PREFIX.length);
            if (!sdkId) return;
            try {
              this.threadRepo.updateSdkSessionId(event.threadId, sdkId);
              const executionId = this.turnRuntime.snapshot(event.threadId)?.turnExecutionId;
              if (executionId) {
                this.canonicalSink.recordNativeCursor(executionId, {
                  providerId: provider.id,
                  scope: provider.id === "codex" ? "thread" : "session",
                  value: sdkId,
                  provenance: "native",
                });
              }
            } catch (err) {
              logger.warn("Failed to persist sdk_session_id", {
                threadId: event.threadId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          } else if (event.subtype === "sdk_session_invalidated") {
            // The provider abandoned an unresumable session (poison-pill 400).
            // Clear the persisted id so the next turn spawns fresh rather than
            // resuming the broken transcript.
            try {
              this.threadRepo.clearSdkSessionId(event.threadId);
            } catch (err) {
              logger.warn("Failed to clear sdk_session_id", {
                threadId: event.threadId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        if (event.type === AgentEventType.Ended) {
          // Swallow the failed attempt's trailing `Ended` during a retry so the
          // UI's running state survives until the fresh attempt streams. Skip the
          // teardown/cleanup below; the retry (or give-up) owns the real `Ended`.
          if (this.shouldSuppressTurnEnded(event.threadId)) {
            return;
          }
          const thread = this.threadRepo.findById(event.threadId);
          const runtime = this.turnRuntime.snapshot(event.threadId);
          const activeExecution = runtime != null
            && runtime.turnExecutionId === event.turnExecutionId
            && (runtime.phase === "running" || runtime.phase === "finalizing");
          const activeExecutionId = runtime?.turnExecutionId;
          if (event.outcome == null && activeExecution && activeExecutionId
            && !this.turnCompleteSeenByThread.has(event.threadId)) {
            const hasFinalResponse = this.finalResponseExecutionByThread.get(event.threadId)
              === activeExecutionId;
            this.emitProviderEvent(provider, hasFinalResponse
              ? {
                  type: AgentEventType.TurnComplete,
                  threadId: event.threadId,
                  turnExecutionId: activeExecutionId,
                  reason: "provider_stream_exhausted",
                  costUsd: null,
                  tokensIn: 0,
                  tokensOut: 0,
                  providerId: thread?.provider,
                }
              : {
                  type: AgentEventType.Error,
                  threadId: event.threadId,
                  turnExecutionId: activeExecutionId,
                  error: "Provider stream ended before terminal event",
                });
          }
          const shouldInferCodexCancellation = event.outcome == null
            && !activeExecution
            && thread?.provider === "codex"
            && this.activeSessionIds.has(event.threadId);
          const outcome = event.outcome
            ?? (shouldInferCodexCancellation ? "cancelled" : undefined);
          if (outcome) {
            if (shouldInferCodexCancellation) {
              const finalText = this.narrativeStore.takeOpenThought(event.threadId);
              if (finalText) {
                this.turnFinalizer.appendStreamingText(event.threadId, finalText);
              }
            }
            const phase = outcome === "cancelled" ? "cancelled" : outcome === "errored" ? "errored" : "completed";
            if (this.turnRuntime.terminalize(event.threadId, event.turnExecutionId!, phase)) {
              void this.finalizeTerminalTurn(event.threadId, outcome, "ended");
            }
          }
          this.trackSessionEnded(event.threadId);
          this.threadControlMcp?.revoke(`mcode-${event.threadId}`);
          // Turn-scoped cleanup of any one-shot handoff Read grant. No-op on
          // later turns since the grant is already gone (consumed or cleared).
          this.scopedPreGrant.clear(event.threadId);
          this.planParsers.delete(event.threadId);
          this.planOutputParsers.delete(event.threadId);
          this.pendingPlanOutputs.delete(event.threadId);
          this.pendingExitPlanMarkdown.delete(event.threadId);
          this.planCapturedThisTurn.delete(event.threadId);
        }
      };
      const handleEvent = (event: AgentEvent, publish = true): void => {
        const normalizedEvent = this.prepareProviderEvent(event);
        if (!normalizedEvent) return;
        handleNormalizedEvent(normalizedEvent);
        if (publish) onProviderEvent?.(normalizedEvent);
      };
      provider.on("event", handleEvent);
    }
  }

  private startCodexChildFromProviderEvent(
    event: Extract<AgentEvent, { type: typeof AgentEventType.ToolUse }>,
  ): void {
    const executionId = event.turnExecutionId;
    if (!executionId) return;
    const parentTurn = this.canonicalSink.loadTurnByExecution(executionId);
    const parentThread = this.canonicalSink.loadThread(event.threadId);
    if (!parentTurn || !parentThread) return;
    const description = typeof event.toolInput.description === "string"
      ? event.toolInput.description
      : undefined;
    const prompt = typeof event.toolInput.prompt === "string" ? event.toolInput.prompt : undefined;
    const identity = typeof event.toolInput.agentName === "string"
      ? event.toolInput.agentName
      : undefined;
    const model = typeof event.toolInput.model === "string" ? event.toolInput.model : undefined;
    const reasoningEffort = typeof event.toolInput.reasoningEffort === "string"
      ? event.toolInput.reasoningEffort
      : undefined;
    try {
      this.canonicalSink.startCodexChildDelegation({
        parentThreadId: parentThread.id,
        parentTurnId: parentTurn.id,
        parentExecutionId: executionId,
        parentItemId: `toolCall:${event.toolCallId}`,
        receiverThreadIds: Array.isArray(event.toolInput.receiverThreadIds)
          ? event.toolInput.receiverThreadIds.filter((value): value is string => (
              typeof value === "string" && value.trim().length > 0
            )).map((value) => value.trim().slice(0, 512)).slice(0, 32)
          : [],
        description,
        prompt,
        identity,
        model,
        reasoningEffort,
        providerIdentities: parentThread.providerIdentities,
      });
    } catch (error) {
      logger.warn("Codex child provisional persistence failed", {
        threadId: event.threadId,
        toolCallId: event.toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Map one explicit Codex collaboration tool name to the canonical action kind. */
  private codexCollaborationKind(event: AgentEvent): CollaborationActionKind | undefined {
    if (event.type !== AgentEventType.ToolUse && event.type !== AgentEventType.ToolResult) return undefined;
    const value = event.toolInput?.codexCollabKind;
    if (typeof value !== "string") return undefined;
    const normalized = value.toLowerCase().replace(/[_-]/g, "");
    if (normalized === "spawnagent") return undefined;
    if (normalized === "sendinput" || normalized === "sendmessage") return "message";
    if (normalized === "followup") return "follow-up";
    if (normalized === "resume" || normalized === "resumeagent") return "resume";
    if (normalized === "returnresult") return "return-result";
    if (normalized === "permission" || normalized === "requestpermission") return "permission";
    if (normalized === "clarification" || normalized === "requestclarification") return "clarification";
    return undefined;
  }

  /** Persist one Codex collaboration action only when exact source and target IDs resolve. */
  private recordCodexCollaborationAction(
    event: Extract<AgentEvent, { type: typeof AgentEventType.ToolUse | typeof AgentEventType.ToolResult }>,
    sourceItemId?: string,
  ): void {
    const isResult = event.type === AgentEventType.ToolResult;
    const kind = this.codexCollaborationKind(event);
    if (!kind) return;
    const evidence = "codexChild" in event ? event.codexChild : undefined;
    const senderThreadId = typeof event.toolInput?.senderThreadId === "string"
      ? event.toolInput.senderThreadId.trim().slice(0, 512)
      : evidence?.nativeThreadId;
    const receiverThreadIds = Array.isArray(event.toolInput?.receiverThreadIds)
      ? [...new Set(event.toolInput.receiverThreadIds.filter((value): value is string => (
          typeof value === "string" && value.trim().length > 0
        )).map((value) => value.trim().slice(0, 512)))]
      : [];
    const sourceThread = evidence?.nativeThreadId
      ? this.canonicalSink.loadThreadByProviderIdentity({
          providerId: "codex",
          scope: "thread",
          value: evidence.nativeThreadId,
          provenance: "native",
        })
      : this.canonicalSink.loadThread(event.threadId);
    if (!sourceThread) return;
    const sourceTurn = evidence?.nativeTurnId
      ? this.canonicalSink.loadTurnByProviderIdentity(sourceThread.id, {
          providerId: "codex",
          scope: "turn",
          value: evidence.nativeTurnId,
          provenance: "native",
        })
      : event.turnExecutionId
        ? this.canonicalSink.loadTurnByExecution(event.turnExecutionId)
        : null;
    if (!sourceTurn || sourceTurn.threadId !== sourceThread.id) return;
    if (senderThreadId) {
      const senderThread = this.canonicalSink.loadThreadByProviderIdentity({
        providerId: "codex",
        scope: "thread",
        value: senderThreadId,
        provenance: "native",
      });
      if (!senderThread || senderThread.id !== sourceThread.id) return;
    }
    const nativeItemId = event.toolCallId;
    if (isResult) {
      const action = this.canonicalSink.loadCollaborationActionBySourceProviderIdentity(
        sourceThread.id,
        sourceTurn.id,
        {
          providerId: "codex",
          scope: "item",
          value: nativeItemId,
          provenance: "native",
        },
      );
      if (!action) return;
      const targetThreadId = action.target.threadId;
      try {
        this.canonicalSink.recordCollaborationAction({
          actionId: action.id,
          kind: action.kind,
          sourceThreadId: action.source.threadId,
          sourceTurnId: action.source.turnId,
          sourceExecutionId: this.canonicalSink.loadExecutionIdForTurn(action.source.turnId),
          sourceItemId: action.source.itemId,
          targetThreadId,
          ...(action.target.turnId ? { targetTurnId: action.target.turnId } : {}),
          status: event.isError ? "Failed" : "Acknowledged",
          providerIdentities: action.providerIdentities,
          payload: this.codexActionPayload(event, action.kind),
        });
      } catch (error) {
        logger.warn("Codex collaboration result persistence failed", {
          toolCallId: event.toolCallId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (!sourceItemId || receiverThreadIds.length !== 1) return;
    const targetThread = this.canonicalSink.loadThreadByProviderIdentity({
      providerId: "codex",
      scope: "thread",
      value: receiverThreadIds[0]!,
      provenance: "native",
    });
    if (!targetThread || targetThread.id === sourceThread.id) return;
    const actionId = `collaboration:codex:${createHash("sha256")
      .update(`${sourceThread.id}:${sourceTurn.id}:${sourceItemId}:${kind}`)
      .digest("hex")}`;
    try {
      this.canonicalSink.recordCollaborationAction({
        actionId,
        kind,
        sourceThreadId: sourceThread.id,
        sourceTurnId: sourceTurn.id,
        sourceExecutionId: this.canonicalSink.loadExecutionIdForTurn(sourceTurn.id),
        sourceItemId,
        targetThreadId: targetThread.id,
        status: "Dispatched",
        providerIdentities: [
          ...(senderThreadId ? [{
            providerId: "codex" as const,
            scope: "thread" as const,
            value: senderThreadId,
            provenance: "native" as const,
          }] : []),
          ...receiverThreadIds.map((value) => ({
            providerId: "codex" as const,
            scope: "thread" as const,
            value,
            provenance: "native" as const,
          })),
          {
            providerId: "codex" as const,
            scope: "item" as const,
            value: nativeItemId,
            provenance: "native" as const,
          },
          ...(evidence?.nativeItemId ? [{
            providerId: "codex" as const,
            scope: "item" as const,
            value: evidence.nativeItemId,
            provenance: "native" as const,
          }] : []),
        ],
        payload: this.codexActionPayload(event, kind),
      });
    } catch (error) {
      logger.warn("Codex collaboration action persistence failed", {
        toolCallId: event.toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Keep collaboration payloads small while retaining exact provider routing evidence. */
  private codexActionPayload(
    event: Extract<AgentEvent, { type: typeof AgentEventType.ToolUse | typeof AgentEventType.ToolResult }>,
    kind: CollaborationActionKind,
  ): Record<string, unknown> {
    const input = event.toolInput ?? {};
    const prompt = typeof input.prompt === "string" ? input.prompt.slice(0, 32_768) : undefined;
    return {
      projection: "codexCollaboration",
      kind,
      ...(event.type === AgentEventType.ToolUse ? { toolName: event.toolName } : {}),
      toolCallId: event.toolCallId.slice(0, 512),
      ...(typeof input.senderThreadId === "string" ? { senderThreadId: input.senderThreadId.slice(0, 512) } : {}),
      ...(Array.isArray(input.receiverThreadIds)
        ? {
            receiverThreadIds: input.receiverThreadIds
              .filter((value): value is string => typeof value === "string")
              .slice(0, 32)
              .map((value) => value.slice(0, 512)),
          }
        : {}),
      ...(prompt ? { prompt } : {}),
      ...(event.type === AgentEventType.ToolResult ? { isError: event.isError } : {}),
    };
  }

  /** Start a parent turn only when Codex proves the exact child action that triggered it. */
  private startCodexProviderContinuationFromEvent(
    event: Extract<AgentEvent, { type: typeof AgentEventType.TurnStarted }>,
  ): boolean {
    const evidence = event.codexContinuation;
    if (!evidence || !event.turnExecutionId) return false;
    const sourceThread = this.canonicalSink.loadThreadByProviderIdentity({
      providerId: "codex",
      scope: "thread",
      value: evidence.sourceNativeThreadId,
      provenance: "native",
    });
    if (!sourceThread) return false;
    const sourceTurn = this.canonicalSink.loadTurnByProviderIdentity(sourceThread.id, {
      providerId: "codex",
      scope: "turn",
      value: evidence.sourceNativeTurnId,
      provenance: "native",
    });
    if (!sourceTurn) return false;
    const targetThread = this.canonicalSink.loadThreadByProviderIdentity({
      providerId: "codex",
      scope: "thread",
      value: evidence.targetNativeThreadId,
      provenance: "native",
    });
    if (!targetThread || targetThread.id !== event.threadId) return false;
    const triggerAction = this.canonicalSink.loadCollaborationActionBySourceProviderIdentity(
      sourceThread.id,
      sourceTurn.id,
      {
        providerId: "codex",
        scope: "item",
        value: evidence.sourceNativeItemId,
        provenance: "native",
      },
    );
    if (!triggerAction) return false;
    const parentThread = this.canonicalSink.loadThread(event.threadId);
    if (!parentThread || parentThread.id !== targetThread.id) return false;
    try {
      this.canonicalSink.startProviderContinuation({
        parentThreadId: parentThread.id,
        turnId: randomUUID(),
        executionId: event.turnExecutionId,
        permissionMode: this.threadRepo.findById(parentThread.id)?.permission_mode === "full"
          ? "full"
          : "supervised",
        providerIdentities: parentThread.providerIdentities,
        triggerActionId: triggerAction.id,
      });
      this.threadRepo.updateStatus(parentThread.id, "active");
      return true;
    } catch (error) {
      logger.warn("Codex provider continuation persistence failed", {
        threadId: event.threadId,
        sourceNativeThreadId: evidence.sourceNativeThreadId,
        sourceNativeTurnId: evidence.sourceNativeTurnId,
        sourceNativeItemId: evidence.sourceNativeItemId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private handleCodexChildProviderEvent(event: AgentEvent): boolean {
    if (!("codexChild" in event)) return false;
    const evidence = event.codexChild;
    const parentExecutionId = event.turnExecutionId;
    const parentTurn = parentExecutionId
      ? this.canonicalSink.loadTurnByExecution(parentExecutionId)
      : null;
    const parentItemId = evidence ? `toolCall:${evidence.parentCollaborationItemId}` : "";
    const provisionalDelegation = parentTurn && parentItemId
      ? this.canonicalSink.loadCodexChildDelegation(event.threadId, parentItemId)
      : null;
    if (event.type === AgentEventType.ToolResult
      && event.isError
      && evidence
      && parentExecutionId
      && parentTurn
      && provisionalDelegation
      && !provisionalDelegation.collaborationAction.target.turnId) {
      try {
        this.canonicalSink.markCodexChildDeliveryRejected({
          parentThreadId: event.threadId,
          parentTurnId: parentTurn.id,
          parentExecutionId,
          parentItemId,
          nativeThreadId: evidence.nativeThreadId,
        });
        return true;
      } catch (error) {
        this.recordCodexChildRoutingFailure(
          event,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (!evidence || !evidence.nativeTurnId) {
      this.recordCodexChildRoutingFailure(event, "missing-native-turn");
      return true;
    }
    if (!parentExecutionId) {
      this.recordCodexChildRoutingFailure(event, "missing-parent-execution");
      return true;
    }
    if (!parentTurn) {
      this.recordCodexChildRoutingFailure(event, "parent-turn-not-found");
      return true;
    }
    const delegation = this.canonicalSink.loadCodexChildDelegation(event.threadId, parentItemId);
    if (!delegation) {
      this.recordCodexChildRoutingFailure(event, "delegation-not-found");
      return true;
    }
    try {
      this.canonicalSink.registerCodexReceiverThreadIds({
        parentThreadId: event.threadId,
        parentTurnId: parentTurn.id,
        parentExecutionId,
        parentItemId,
        nativeThreadId: evidence.nativeThreadId,
        receiverThreadIds: [evidence.nativeThreadId],
      });
      if (event.type === AgentEventType.TurnStarted) {
        this.canonicalSink.startCodexChildTurn({
          parentThreadId: event.threadId,
          parentTurnId: parentTurn.id,
          parentExecutionId,
          parentItemId,
          nativeThreadId: evidence.nativeThreadId,
          nativeTurnId: evidence.nativeTurnId,
          ...(evidence.prompt ? { prompt: evidence.prompt } : {}),
        });
        return true;
      }
      const childThread = this.canonicalSink.bindCodexChildIdentity({
        parentThreadId: event.threadId,
        parentTurnId: parentTurn.id,
        parentExecutionId,
        parentItemId,
        nativeThreadId: evidence.nativeThreadId,
      }).childThread;
      if (event.type === AgentEventType.TextDelta) {
        if (!evidence.nativeItemId) return true;
        this.canonicalSink.recordCodexChildItem({
          childThreadId: childThread.id,
          nativeTurnId: evidence.nativeTurnId,
          nativeItemId: evidence.nativeItemId,
          eventKey: evidence.itemEventKey ?? "completed",
          kind: "reasoning",
          payload: {
            projection: "codexChildReasoning",
            content: event.delta,
          },
        });
        return true;
      }
      if (event.type === AgentEventType.ToolUse) {
        const childItem = this.canonicalSink.recordCodexChildItem({
          childThreadId: childThread.id,
          nativeTurnId: evidence.nativeTurnId,
          nativeItemId: evidence.nativeItemId ?? event.toolCallId,
          eventKey: evidence.itemEventKey ?? "started",
          kind: "tool-call",
          payload: {
            projection: "codexChildToolCall",
            toolName: event.toolName,
            toolInput: event.toolInput,
          },
        });
        this.recordCodexCollaborationAction(event, childItem.id);
        return true;
      }
      if (event.type === AgentEventType.ToolResult) {
        this.canonicalSink.recordCodexChildItem({
          childThreadId: childThread.id,
          nativeTurnId: evidence.nativeTurnId,
          nativeItemId: evidence.nativeItemId ?? evidence.parentCollaborationItemId,
          eventKey: evidence.itemEventKey ?? "assistant-result",
          kind: evidence.nativeItemId ? "tool-result" : "message",
          payload: evidence.nativeItemId
            ? {
                projection: "codexChildToolResult",
                output: event.output,
                isError: event.isError,
              }
            : {
                projection: "message",
                message: {
                  id: `codex-child-message:${evidence.nativeTurnId}`,
                  role: "assistant",
                  content: event.output,
                  timestamp: new Date().toISOString(),
                },
              },
        });
        this.recordCodexCollaborationAction(event);
        return true;
      }
      if (event.type === AgentEventType.Message) {
        const nativeItemId = evidence.nativeItemId ?? evidence.nativeTurnId;
        this.canonicalSink.recordCodexChildItem({
          childThreadId: childThread.id,
          nativeTurnId: evidence.nativeTurnId,
          nativeItemId,
          eventKey: evidence.itemEventKey ?? "completed",
          kind: "message",
          payload: {
            projection: "message",
            message: {
              id: `codex-child-message:${nativeItemId}`,
              thread_id: childThread.id,
              role: "assistant",
              content: event.content,
              tool_calls: null,
              files_changed: null,
              cost_usd: null,
              tokens_used: event.tokens,
              timestamp: new Date().toISOString(),
              sequence: 0,
              attachments: null,
            },
          },
        });
        return true;
      }
      if (event.type === AgentEventType.TurnComplete || event.type === AgentEventType.Ended) {
        this.canonicalSink.finishCodexChildTurn({
          childThreadId: childThread.id,
          nativeTurnId: evidence.nativeTurnId,
          outcome: evidence.outcome ?? "completed",
        });
        return true;
      }
      if (event.type === AgentEventType.Error) {
        this.canonicalSink.finishCodexChildTurn({
          childThreadId: childThread.id,
          nativeTurnId: evidence.nativeTurnId,
          outcome: "errored",
          error: event.error,
        });
        return true;
      }
    } catch (error) {
      this.recordCodexChildRoutingFailure(
        event,
        error instanceof Error ? error.message : String(error),
      );
      logger.warn("Codex child canonical event rejected", {
        threadId: event.threadId,
        nativeThreadId: evidence.nativeThreadId,
        nativeTurnId: evidence.nativeTurnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  private recordCodexChildRoutingFailure(event: AgentEvent, reason: string): void {
    const evidence = "codexChild" in event ? event.codexChild : undefined;
    const persisted = this.canonicalSink.recordCodexChildRoutingDiagnostic({
      threadId: event.threadId,
      parentItemId: evidence ? `toolCall:${evidence.parentCollaborationItemId}` : undefined,
      executionId: event.turnExecutionId,
      event,
      reason,
    });
    if (!persisted) {
      throw new Error(`Codex child routing invariant failed: ${reason}`);
    }
    logger.warn("Codex child routing diagnostic", {
      threadId: event.threadId,
      parentCollaborationItemId: evidence?.parentCollaborationItemId,
      reason,
    });
  }

  private handleMemoryPressure(snapshot: MemoryPressureSnapshot): void {
    const truncateOutput = snapshot.level !== "normal";
    for (const provider of this.providerRegistry.resolveAll()) {
      const memoryAware = provider as IAgentProvider & {
        setOutputTruncationMode?: (enabled: boolean) => void;
        shedMemoryPressure?: (level: MemoryPressureSnapshot["level"]) => Promise<void> | void;
      };

      memoryAware.setOutputTruncationMode?.(truncateOutput);
      if (snapshot.level === "normal" || typeof memoryAware.shedMemoryPressure !== "function") {
        continue;
      }
      Promise.resolve(memoryAware.shedMemoryPressure(snapshot.level)).catch((err: unknown) => {
        logger.warn("Provider memory-pressure shedding failed", {
          level: snapshot.level,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Normalize a raw provider error into clearer user-facing strings (CLI ENOENT,
   * opaque Cursor upstream 5xx payloads, etc.).
   */
  private normalizeProviderError(message: string, provider: string): string {
    return normalizeAgentProviderError(provider, message);
  }

  private emitProviderEvent(provider: IAgentProvider, event: AgentEvent): void {
    const emitter = provider as unknown as {
      emit?: (eventName: "event", event: AgentEvent) => boolean;
    };
    if (typeof emitter.emit !== "function") return;
    emitter.emit.call(provider, "event", event);
  }

  private refreshNativeClaudeGoalAfterTurn(threadId: string): void {
    if (this.activeSessionIds.has(threadId)) return;
    if (this.nativeGoalRefreshInFlight.has(threadId)) return;
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.provider !== "claude") return;
    const provider = this.providerRegistry.resolve("claude");
    const nativeClaude = asClaudeNativeGoalProvider(provider);
    const sessionId = `mcode-${threadId}`;
    if (nativeClaude?.hasNativeGoalCommand(sessionId) !== true || !isGoalCapable(provider)) {
      return;
    }

    void (async () => {
      this.nativeGoalRefreshInFlight.add(threadId);
      try {
        const before = await provider.getGoal(sessionId);
        if (!isGoalOpen(before)) return;
        if (this.activeSessionIds.has(threadId)) return;
        const result = await nativeClaude.runNativeGoalCommand(sessionId, "/goal");
        if (result?.kind === "empty") {
          const nowMs = Date.now();
          this.emitProviderEvent(provider, {
            type: AgentEventType.GoalUpdated,
            threadId,
            goal: {
              ...before,
              status: "complete",
              timeUsedSeconds: elapsedGoalSeconds(before, nowMs),
              updatedAt: nowMs,
              controls: { ...before.controls, canClear: false },
            },
          } satisfies AgentEvent);
          this.emitProviderEvent(provider, {
            type: AgentEventType.GoalCleared,
            threadId,
            providerId: before.providerId ?? "claude",
            reason: "completed",
            turnId: before.turnId ?? null,
          } satisfies AgentEvent);
        }
      } finally {
        this.nativeGoalRefreshInFlight.delete(threadId);
      }
    })().catch((err: unknown) => {
      logger.warn("Native Claude goal refresh failed", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private maybeCompleteDirectResponseGoal(provider: IAgentProvider, event: AgentMessageEvent): void {
    if (!isGoalCapable(provider)) return;
    if (GOAL_ACHIEVED_RECEIPT_RE.test(event.content.trim())) return;

    const sessionId = `mcode-${event.threadId}`;
    void (async () => {
      const goal = await provider.getGoal(sessionId);
      if (!isGoalOpen(goal) || !satisfiesDirectResponseGoal(goal, event.content)) {
        return;
      }

      const cleared = await provider.clearGoal(sessionId);
      if (!cleared) {
        logger.warn("Direct-response goal matched but provider did not clear it", {
          threadId: event.threadId,
          providerId: goal.providerId,
          objective: goal.objective,
        });
        return;
      }

      const nowMs = Date.now();
      this.emitProviderEvent(provider, {
        type: AgentEventType.GoalUpdated,
        threadId: event.threadId,
        goal: {
          ...goal,
          status: "complete",
          timeUsedSeconds: elapsedGoalSeconds(goal, nowMs),
          updatedAt: nowMs,
          controls: { ...goal.controls, canClear: false },
        },
      } satisfies AgentEvent);
      this.emitProviderEvent(provider, {
        type: AgentEventType.GoalCleared,
        threadId: event.threadId,
        providerId: goal.providerId ?? "unknown",
        reason: "completed",
        turnId: goal.turnId ?? null,
      } satisfies AgentEvent);
    })().catch((err: unknown) => {
      logger.warn("Direct-response goal completion check failed", {
        threadId: event.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Fallback plan extraction from raw markdown when the model doesn't emit
   * a ```plan-output fenced block. Parses headings to build sections.
   */
  private extractPlanFromMarkdown(
    content: string,
  ): { title: string; contentMd: string; sectionsJson: string } | null {
    const lines = content.split("\n");

    // Find the first H1 or H2 as the plan title
    let title: string | null = null;
    const sections: { id: string; title: string; level: number }[] = [];
    let sectionCounter = 0;

    for (const line of lines) {
      const h1Match = line.match(/^#\s+(.+)/);
      const h2Match = line.match(/^##\s+(.+)/);
      const h3Match = line.match(/^###\s+(.+)/);

      if (h1Match && !title) {
        title = h1Match[1].trim();
      } else if (h1Match) {
        sectionCounter++;
        sections.push({ id: `s${sectionCounter}`, title: h1Match[1].trim(), level: 1 });
      }

      if (h2Match) {
        if (!title) {
          title = h2Match[1].trim();
        } else {
          sectionCounter++;
          sections.push({ id: `s${sectionCounter}`, title: h2Match[1].trim(), level: 2 });
        }
      }

      if (h3Match) {
        sectionCounter++;
        sections.push({ id: `s${sectionCounter}`, title: h3Match[1].trim(), level: 3 });
      }
    }

    // Need at least a title and one section to consider this a plan
    if (!title || sections.length === 0) return null;

    return {
      title,
      contentMd: content,
      sectionsJson: JSON.stringify(sections),
    };
  }

  /**
   * Handle the ExitPlanMode tool call from the Claude SDK (or Cursor
   * `create_plan`). Defer persistence until the assistant Message event
   * supplies a stable messageId.
   */
  handleExitPlanMode(threadId: string, planMarkdown: string): void {
    if (this.planCapturedThisTurn.has(threadId)) {
      logger.debug("ExitPlanMode: plan already captured this turn", { threadId });
      return;
    }

    this.planOutputParsers.delete(threadId);
    this.pendingPlanOutputs.delete(threadId);
    this.pendingExitPlanMarkdown.set(threadId, planMarkdown);
  }

  /** Arm plan-output parsing and Claude ExitPlanMode capture for one generation turn. */
  private armPlanGenerationTurn(threadId: string): void {
    this.planOutputParsers.set(threadId, new PlanOutputParser());
    this.planCapturedThisTurn.delete(threadId);

    // Claude ExitPlanMode capture is a Claude-only concern that the binary
    // TurnRequest.interactionMode cannot carry (it would conflate the
    // question-generation turn with the answer/revise turn). It stays an
    // off-interface arming on the concrete ClaudeProvider, invoked via a cast
    // like setGoal/clearGoal. The revise/answer turn dispatches with
    // interactionMode "build", so Cursor's per-Turn question mode clears itself.
    const thread = this.threadRepo.findById(threadId);
    const effectiveProvider = (thread?.provider as ProviderId) ?? "claude";
    if (effectiveProvider === "claude") {
      const claudeProvider = this.providerRegistry.resolve("claude") as unknown as {
        setPlanAnswerMode: (threadId: string, enabled: boolean) => void;
      };
      claudeProvider.setPlanAnswerMode(threadId, true);
    }
  }

  /** Persist one plan version and broadcast, skipping duplicate captures per turn. */
  private persistPlanRecord(
    threadId: string,
    messageId: string,
    title: string,
    contentMd: string,
    sectionsJson: string,
    changeSummary: string | null,
  ): void {
    if (this.planCapturedThisTurn.has(threadId)) {
      logger.debug("plan persist skipped: already captured this turn", { threadId });
      return;
    }

    try {
      const plan = this.planRepo.create(
        threadId,
        messageId,
        title,
        contentMd,
        sectionsJson,
        changeSummary,
      );
      this.planCapturedThisTurn.add(threadId);
      broadcast("plan.generated", { threadId, plan });
    } catch (err) {
      logger.error("Failed to persist plan output", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Wrap a user message with the plan-mode question-generation prompt. */
  private buildPlanPrompt(userMessage: string): string {
    return `[PLAN MODE] You are in planning mode. Your only job right now is to identify 2-5 key architectural decisions that need user input, based solely on the user's message below.

Constraints:
- Do NOT call any tools. Do NOT read files, run commands, or explore the codebase.
- Do NOT use native ask-question or create-plan tools; Mcode renders questions from a fenced block.
- Do NOT write any prose, preamble, or commentary.
- Your entire response MUST be the single fenced plan-questions block shown below, then stop.
- After the user answers, you will receive their selections in a follow-up turn and may then plan freely.

Output format (must be valid JSON inside the fence):

\`\`\`plan-questions
[
  {
    "id": "q1",
    "category": "CATEGORY_NAME",
    "question": "Your question here?",
    "options": [
      { "id": "o1", "title": "Option Title", "description": "Brief description.", "recommended": true },
      { "id": "o2", "title": "Another Option", "description": "Brief description." }
    ]
  }
]
\`\`\`

---

${userMessage}`;
  }

  /**
   * Buffer a tool call event into the narrative write seam, then perform the
   * non-narrative side effect AgentService still owns: persisting task state
   * for reconnect hydration. The narrative buffer + agentCallStack
   * push + parent attribution (narrative-pipeline.md Trap 1) live in
   * {@link NarrativeStore.bufferToolCall}, which returns the attributed parent.
   */
  private bufferToolCall(
    threadId: string,
    event: {
      toolCallId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      parentToolCallId?: string;
    },
  ): void {
    const parentToolCallId = this.narrativeStore.bufferToolCall(threadId, event);

    // Persist TodoWrite state for hydration on reconnect
    if (event.toolName === "TodoWrite") {
      const todos = event.toolInput?.todos;
      if (Array.isArray(todos)) {
        const validStatuses = new Set([
          "pending",
          "in_progress",
          "completed",
          "cancelled",
        ]);

        // Resolve group label: sub-agent calls use the parent Agent's description
        const group = parentToolCallId
          ? this.resolveAgentGroupLabel(threadId, parentToolCallId)
          : "Tasks";

        const cleanedTodos = todos
          .filter(
            (t): t is Record<string, unknown> =>
              t != null && typeof t === "object" && "content" in t,
          )
          .map((t) => {
            const rawStatus = String(t.status ?? "");
            return {
              content: String(t.content ?? ""),
              status: (validStatuses.has(rawStatus) ? rawStatus : "pending") as
                | "pending"
                | "in_progress"
                | "completed"
                | "cancelled",
              group,
            };
          });
        if (cleanedTodos.length > 0) {
          try {
            // Always merge by group so top-level and sub-agent tasks coexist
            this.taskRepo.upsertGroup(threadId, group, cleanedTodos);
          } catch (err) {
            logger.warn("TodoWrite tasks not persisted", {
              threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // TaskCreate is persisted at result time (see handleTaskCreateResult): the
    // harness-assigned task id needed to correlate later TaskUpdate calls only
    // appears in the TaskCreate result, never in its input.

    if (event.toolName === "TaskUpdate") {
      const group = parentToolCallId
        ? this.resolveAgentGroupLabel(threadId, parentToolCallId)
        : "Tasks";
      this.applyTaskUpdate(threadId, event.toolInput, group);
    }

    if (event.toolName === "update_plan") {
      const group = parentToolCallId
        ? this.resolveAgentGroupLabel(threadId, parentToolCallId)
        : "Tasks";
      const tasks = this.updatePlanTasks(event.toolInput, group);
      if (tasks.length === 0) return;
      try {
        this.taskRepo.upsertGroup(threadId, group, tasks);
      } catch (err) {
        logger.warn("update_plan tasks not persisted", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Persist a single late hook (Stop / SessionEnd / PreCompact) that arrived
   * after the turn was finalized and the in-turn buffers were cleared.
   * Writes the row directly to SQLite and broadcasts a `HookCompleted` event
   * with `persistedMessageId` set so the client can route it into the correct
   * persisted narrative cache entry rather than the volatile hook list.
   *
   * If the finalizer recorded no persisted message id (e.g. the turn never
   * produced an assistant message), the hook is silently discarded — there is
   * no row to attach it to.
   */
  private flushLateHook(
    threadId: string,
    hook: Omit<CreateHookExecutionInput, "messageId">,
  ): void {
    const messageId = this.turnFinalizer.getLastPersistedMessageId(threadId);
    if (!messageId) {
      logger.warn("flushLateHook: no persisted message id for thread; discarding late hook", {
        threadId,
        hookName: hook.hookName,
      });
      return;
    }
    try {
      this.hookExecutionRepo.bulkCreate([{ ...hook, messageId }]);
    } catch (err) {
      logger.error("flushLateHook: failed to persist late hook", {
        threadId,
        hookName: hook.hookName,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Broadcast with persistedMessageId so the client can attach this hook
    // to the already-persisted narrative cache entry instead of appending it
    // to the volatile hooksByThread list (which is cleared on turn end).
    broadcast("agent.event", {
      type: AgentEventType.HookCompleted,
      threadId,
      hookName: hook.hookName,
      exitCode: 0,
      durationMs: hook.durationMs ?? 0,
      didBlock: hook.didBlock,
      persistedMessageId: messageId,
      // Stable DB row id so the client can dedupe redelivered broadcasts.
      persistedHookId: hook.id,
    } satisfies AgentEvent);
  }

  /** Stop all active agent sessions (for graceful shutdown). */
  async stopAll(): Promise<void> {
    const ids = [...this.activeSessionIds];
    await Promise.all(
      ids.map((threadId) => {
        const runtime = this.turnRuntime.snapshot(threadId);
        const terminalized = runtime?.turnExecutionId
          ? this.turnRuntime.terminalize(threadId, runtime.turnExecutionId, "cancelled")
          : false;
        return (terminalized || runtime?.phase === "cancelled")
          ? this.finalizeTerminalTurn(threadId, "cancelled", "shutdown") ?? Promise.resolve()
          : Promise.resolve();
      }),
    );
    for (const threadId of ids) {
      const sessionId = `mcode-${threadId}`;
      const thread = this.threadRepo.findById(threadId);
      const providerId = (thread?.provider ?? "claude") as ProviderId;
      try {
        const provider = this.providerRegistry.resolve(providerId);
        void Promise.resolve(provider.stopSession(sessionId)).catch(() => {});
      } catch {
        // best-effort
      }
    }
    this.activeSessionIds.clear();
    for (const [threadId, token] of this.activeMutationReservations) {
      this.mutationReservations.release(threadId, token);
    }
    this.activeMutationReservations.clear();
  }
}
