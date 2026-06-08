/**
 * Agent session orchestration service.
 * Manages sending messages to AI providers, tracking active sessions,
 * and forwarding agent events to the push broadcaster.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { injectable, inject, delay } from "tsyringe";
import { existsSync, statSync } from "fs";
import { isAbsolute } from "path";
import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type {
  Thread,
  AttachmentMeta,
  ReasoningLevel,
  ContextWindowMode,
  IProviderRegistry,
  TurnRequest,
  AgentEvent,
  ProviderId,
  InteractionMode,
  PermissionDecision,
  PermissionRequest,
  PlanOutput,
  PlanAction,
} from "@mcode/contracts";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { MessageRepo } from "../repositories/message-repo";
import { HookExecutionRepo, type CreateHookExecutionInput } from "../repositories/hook-execution-repo";
import { NarrativeStore } from "./narrative-store.js";
import { TurnFinalizer } from "./turn-finalizer.js";
import { PlanQuestionService } from "./plan-question-service.js";
import { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo";
import type Database from "better-sqlite3";
import { TaskRepo } from "../repositories/task-repo";
import { PlanQuestionAnswersRepo } from "../repositories/plan-question-answers-repo";
import { GitService } from "./git-service";
import { AttachmentService } from "./attachment-service";
import { SnapshotService } from "./snapshot-service";
import { MemoryPressureService } from "./memory-pressure-service";
import { broadcast } from "../transport/push";
import { GoalCommand } from "../commands/goal-command";
// Lazy-imported to break circular dependency: AgentService -> ThreadService -> (shared repos)
// Using delay() ensures tsyringe resolves ThreadService from the container at first access,
// not at AgentService construction time.
import { ThreadService } from "./thread-service";
import { SettingsService } from "./settings-service.js";
import { ProviderAvailabilityService } from "./provider-availability-service.js";
import {
  ProviderDisabledError,
  ProviderCliMissingError,
} from "./provider-availability-errors.js";
import { PlanQuestionParser } from "./plan-question-parser.js";
import { PlanOutputParser } from "./plan-output-parser.js";
import { PlanRepo } from "../repositories/plan-repo";
import { HandoffCoordinator } from "./handoff/handoff-coordinator.js";
import { ScopedPreGrantService } from "./scoped-pre-grant.js";
import { normalizeAgentProviderError } from "./provider-agent-error-normalize.js";

/**
 * Escape special XML characters in a string to prevent injection into
 * provider XML tags (e.g. the reply-to context block).
 */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

/** Orchestrates agent sessions, message sending, and event forwarding. */
@injectable()
export class AgentService {
  private readonly activeSessionIds = new Set<string>();
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
  /**
   * Threads whose `TurnComplete` event has already been processed but whose
   * finalize may still be in-flight or have already finished.
   * Set when `TurnComplete` is handled; cleared on `TurnStarted` so the
   * per-thread flag resets between turns.
   * Hooks that arrive while this flag is set are treated as post-turn (Stop /
   * SessionEnd / PreCompact) and flushed directly via `flushLateHook`.
   */
  private turnCompleteSeenByThread = new Set<string>();
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

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(GitService) private readonly gitService: GitService,
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
  ) {
    this.turnFinalizer = new TurnFinalizer(
      this.messageRepo,
      this.threadRepo,
      this.narrativeStore,
      this.snapshotService,
      this.turnSnapshotRepo,
      this.db,
    );
  }

  /**
   * Send a user message to the Claude agent for a given thread.
   * Loads the thread, persists the user message, resolves the working
   * directory, and dispatches to the provider.
   */
  async sendMessage(
    threadId: string,
    content: string,
    permissionMode: string,
    model = "claude-sonnet-4-6",
    attachments: AttachmentMeta[] = [],
    reasoningLevel?: ReasoningLevel,
    provider?: ProviderId,
    interactionMode?: InteractionMode,
    maxBudgetUsd?: number,
    maxTurns?: number,
    copilotAgent?: string,
    contextWindowMode?: ContextWindowMode,
    thinking?: boolean,
    codexFastMode?: boolean,
    /**
     * If set, persist a plan-questions "answered" marker for the given
     * assistant message id in the same SQLite transaction as the user
     * message create. Used by `answerQuestions` to record that the wizard
     * has been satisfied so it does not re-pop on reload.
     */
    markPlanAnswerForMessageId?: string,
    /**
     * Provider-only payload for this send (fork continuation, stitched replay).
     * The persisted user row uses {@link messageDisplayContent} when supplied,
     * otherwise the original `content` argument; this string is forwarded to
     * the agent without writing the override text to SQLite when set.
     */
    providerWireOverride?: string,
    /** ID of the message being replied to. Stored on the user message row. */
    replyToMessageId?: string,
    /** Highlighted text excerpt from the replied-to message. Stored on the user message row. */
    quotedText?: string,
    /**
     * Transcript stored in SQLite for the user bubble. When omitted, the
     * original `content` argument is persisted. The `content` argument is
     * still the base for plan/reply wrapping sent to the provider.
     */
    messageDisplayContent?: string,
    planAction?: PlanAction,
  ): Promise<void> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    // Use the thread's stored provider as authoritative fallback; only override
    // when the caller explicitly supplies a provider (new thread or explicit switch).
    const effectiveProvider: ProviderId = provider ?? (thread.provider as ProviderId) ?? "claude";
    // Fall back to the thread's persisted Copilot agent when the caller doesn't supply one.
    // Converts null (DB "cleared") to undefined (provider ignores it) so the SDK defaults.
    const effectiveCopilotAgent = copilotAgent ?? (thread.copilot_agent ?? undefined);

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

    // `/goal` app-native command. The capability is probed through
    // {@link GoalCapableProvider}: any provider that implements it gets `/goal`
    // for free, and a provider without it passes the command through as plain
    // text so the model still sees what the user typed.
    //
    //   `/goal <condition>` — rewrite (SET): the wire payload becomes a
    //                         directive and the goal is installed just before
    //                         dispatch (see deferred install below).
    //   `/goal clear`       — handled: remove the active goal, no dispatch.
    //   `/goal` / `/goal show` — handled: show the active goal, no dispatch.
    //
    // Deferred goal install for the SET form: populated here and consumed
    // immediately before `sendTurn` runs, so a send failure can't leave a
    // stale goal in the provider map. The catch block on the send also clears
    // it as a belt-and-suspenders guard for failures between install and
    // successful dispatch.
    let pendingGoalInstall: string | null = null;
    const goalCommand = new GoalCommand(
      this.providerRegistry.resolve(effectiveProvider),
      { messageRepo: this.messageRepo, db: this.db },
      broadcast,
    );
    const goalOutcome = goalCommand.handle(threadId, content);
    if (goalOutcome.kind === "handled") {
      logger.info("Handled /goal control command", { threadId });
      return;
    }
    if (goalOutcome.kind === "rewrite") {
      pendingGoalInstall = goalOutcome.pendingGoal;
      messageDisplayContent = content;
      content = goalOutcome.content;
    }

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

    // Compute next sequence number and persist user message
    const { messages: existingMessages } = this.messageRepo.listByThread(threadId, 1);
    const nextSeq =
      existingMessages.length > 0
        ? existingMessages[existingMessages.length - 1].sequence + 1
        : 1;

    const persistedUserText = messageDisplayContent ?? content;

    const { stored, persisted } = await this.attachmentService.persist(
      threadId,
      attachments,
    );
    // Persist the user message and (when answering plan questions) the
    // answered marker in a single transaction. If the marker insert fails
    // (e.g. FK rejects an unknown messageId) the user message is rolled
    // back too, keeping marker durability == answer durability.
    this.turnFinalizer.resetStreamingText(threadId);

    this.db.transaction(() => {
      this.messageRepo.create(
        threadId,
        "user",
        persistedUserText,
        nextSeq,
        stored.length > 0 ? stored : undefined,
        replyToMessageId,
        quotedText,
      );
      if (markPlanAnswerForMessageId) {
        // INSERT OR IGNORE inside the repo skips PK collisions (idempotent
        // re-marking) but FK violations still abort the tx, which is exactly
        // what we want — durable iff the answer is durable.
        this.planQuestionAnswersRepo.markAnswered(
          markPlanAnswerForMessageId,
          threadId,
        );
      }
    })();

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

    this.threadRepo.updateStatus(threadId, "active");

    // Capture git snapshot ref_before for this turn
    try {
      const refBefore = await this.snapshotService.captureRef(cwd);
      this.turnFinalizer.recordTurnRef(threadId, refBefore, cwd);
    } catch (err) {
      logger.warn("Failed to capture ref_before", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    const isResume = nextSeq > 1 && !!thread.sdk_session_id;

    // Resume signal: defined ⇒ resume that SDK session, undefined ⇒ fresh.
    // Replaces the former setSdkSessionId(...) + resume:true two-step dance.
    const resumeFrom: string | undefined =
      isResume && thread.sdk_session_id ? thread.sdk_session_id : undefined;

    const resolvedProvider = this.providerRegistry.resolve(effectiveProvider);

    this.activeSessionIds.add(threadId);
    this.memoryPressureService.markActive();

    // Emit the live-session "turn started" signal before any other events so
    // clients can populate runningThreadIds (drives sidebar + composer indicators).
    // Cast to EventEmitter since IAgentProvider only exposes on(); all providers
    // extend EventEmitter, matching the same pattern used for synthetic error/ended
    // emission in the catch block below.
    (resolvedProvider as unknown as import("events").EventEmitter).emit("event", {
      type: AgentEventType.TurnStarted,
      threadId,
    } satisfies AgentEvent);

    const providerMessage = providerWireOverride ?? wirePayload;

    // Install the deferred /goal hook gate now, as late as possible before
    // dispatch. If sendTurn throws synchronously or rejects, the catch block
    // below tears the goal back out so failures don't leave a hidden gate
    // active. Only runs for the SET form (pendingGoalInstall is only populated
    // when the goal command returned a rewrite).
    if (pendingGoalInstall !== null) {
      goalCommand.installGoal(threadId, pendingGoalInstall);
      logger.info("Goal installed; dispatching directive to provider", {
        threadId,
        goal: pendingGoalInstall,
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

    try {
      await resolvedProvider.sendTurn({
        sessionId: sessionName,
        threadId,
        message: providerMessage,
        cwd,
        model: resolvedModel,
        fallbackModel,
        permissionMode,
        interactionMode: effectiveInteractionMode ?? "build",
        attachments: persisted.length > 0 ? persisted : undefined,
        reasoningLevel,
        ...(effectiveBudget > 0 && { maxBudgetUsd: effectiveBudget }),
        ...(effectiveTurns > 0 && { maxTurns: effectiveTurns }),
        resumeFrom,
        providerOptions,
      } as TurnRequest);
      logger.info("Message sent via provider", {
        threadId,
        session: sessionName,
        model: resolvedModel,
      });
    } catch (err) {
      this.activeSessionIds.delete(threadId);
      if (this.activeSessionIds.size === 0) {
        this.memoryPressureService.markIdle();
      }
      // Roll the just-installed goal back so a failed send doesn't leave a
      // hidden Stop-hook gate active on the next (possibly unrelated) turn.
      // Only runs when we got past the deferred install above.
      if (pendingGoalInstall !== null) {
        try {
          goalCommand.rollbackGoal(threadId);
        } catch (clearErr) {
          logger.warn("Failed to clear goal after failed send", {
            threadId,
            error: clearErr instanceof Error ? clearErr.message : String(clearErr),
          });
        }
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      // Normalize spawn ENOENT into a user-friendly CLI-not-found message that
      // the frontend CliErrorBanner can detect and display with setup instructions.
      const errorMessage = this.normalizeProviderError(rawMessage, effectiveProvider);
      logger.error("Provider send failed", { threadId, error: rawMessage });

      // Emit an error event through the provider so the frontend receives it
      // via the normal agent.event push pipeline and can display the CLI error banner.
      // Cast to EventEmitter since all providers extend it, but IAgentProvider only exposes on().
      try {
        const resolvedProvider = this.providerRegistry.resolve(effectiveProvider) as unknown as import("events").EventEmitter;
        resolvedProvider.emit("event", {
          type: "error",
          threadId,
          error: errorMessage,
        } satisfies AgentEvent);
        resolvedProvider.emit("event", {
          type: "ended",
          threadId,
        } satisfies AgentEvent);
      } catch (emitErr) {
        logger.warn("Failed to emit error event to provider", {
          threadId,
          error: emitErr instanceof Error ? emitErr.message : String(emitErr),
        });
      }

      this.threadRepo.updateStatus(threadId, "errored");
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
    permissionMode = "default",
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
    await this.sendMessage(
      threadId,
      content,
      permissionMode,
      thread.model ?? "claude-sonnet-4-6",
      [],
      reasoningLevel,
      (thread.provider as ProviderId) ?? "claude",
      undefined, // interactionMode
      undefined, // maxBudgetUsd
      undefined, // maxTurns
      undefined, // copilotAgent
      contextWindowMode,
      thinking,
      undefined,
      markPlanAnswerForMessageId,
    );
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

  /**
   * Create a new thread and immediately send the first message.
   * Generates a title from the content, creates the thread, sends,
   * and returns the fully-populated Thread object.
   */
  async createAndSend(
    workspaceId: string,
    content: string,
    model = "claude-sonnet-4-6",
    permissionMode = "default",
    mode: "direct" | "worktree" = "direct",
    branch = "main",
    existingWorktreePath?: string,
    attachments: AttachmentMeta[] = [],
    reasoningLevel?: ReasoningLevel,
    provider: ProviderId = "claude",
    interactionMode?: InteractionMode,
    parentThreadId?: string,
    forkedFromMessageId?: string,
    maxBudgetUsd?: number,
    maxTurns?: number,
    copilotAgent?: string,
    contextWindowMode?: ContextWindowMode,
    thinking?: boolean,
    codexFastMode?: boolean,
    displayContent?: string,
  ): Promise<Thread & { warnings?: string[] }> {
    const title = truncateTitle(displayContent ?? content);

    if (parentThreadId) {
      return this.createBranchedThread({
        workspaceId, content, model, permissionMode, mode, branch,
        existingWorktreePath, attachments, reasoningLevel, provider,
        interactionMode, parentThreadId, forkedFromMessageId, title,
        maxBudgetUsd, maxTurns,
        copilotAgent,
        contextWindowMode,
        thinking,
        codexFastMode,
        displayContent,
      });
    }

    let thread: Thread;
    let threadWarnings: string[] | undefined;
    if (existingWorktreePath) {
      // Attach to existing worktree
      const workspace = this.workspaceRepo.findById(workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      const knownWorktrees = this.gitService.listWorktrees(workspaceId);
      const normalize = (p: string) =>
        p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      const normalizedInput = normalize(existingWorktreePath);
      const matched = knownWorktrees.find(
        (wt) => normalize(wt.path) === normalizedInput,
      );
      if (!matched) {
        throw new Error("Path is not a recognized worktree");
      }

      const canonicalBranch = matched.branch;
      thread = this.threadRepo.create(
        workspaceId,
        title,
        "worktree",
        canonicalBranch,
        false,
        provider,
      );
      this.threadRepo.updateWorktreePath(thread.id, existingWorktreePath);
      thread = {
        ...thread,
        worktree_path: existingWorktreePath,
        branch: canonicalBranch,
      };
    } else if (mode === "worktree") {
      const createResult = await this.threadService.create(workspaceId, title, "worktree", branch);
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
      permission_mode: persistedPermissionMode,
      context_window_mode: contextWindowMode ?? thread.context_window_mode,
      thinking: thinking ?? thread.thinking,
      copilot_agent: copilotAgent ?? thread.copilot_agent,
      codex_fast_mode: provider === "codex" && codexFastMode !== undefined
        ? codexFastMode
        : thread.codex_fast_mode,
    };

    void this.sendMessage(
      thread.id,
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
      contextWindowMode,
      thinking,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      displayContent,
    ).catch((err) => {
      logger.error("createAndSend initial send failed", {
        threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const updated = this.threadRepo.findById(thread.id);
    return { ...(updated ?? thread), ...(threadWarnings?.length ? { warnings: threadWarnings } : {}) };
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
    permissionMode: string;
    mode: "direct" | "worktree";
    branch: string;
    existingWorktreePath?: string;
    attachments: AttachmentMeta[];
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
  }): Promise<Thread & { warnings?: string[] }> {
    const {
      workspaceId, content, model, permissionMode, mode, branch,
      existingWorktreePath, attachments, reasoningLevel, provider,
      interactionMode, parentThreadId, forkedFromMessageId, title,
      maxBudgetUsd, maxTurns,
      copilotAgent,
      contextWindowMode,
      thinking,
      codexFastMode,
      displayContent,
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

    /** Guards fork handoff against loading unbounded history into memory. */
    const FORK_HISTORY_MAX_SEQUENCE = 10_000;
    if (forkMessage.sequence > FORK_HISTORY_MAX_SEQUENCE) {
      throw new Error(
        `Fork point includes too much prior history (sequence ${forkMessage.sequence}; max ${FORK_HISTORY_MAX_SEQUENCE}). Choose an earlier message (lower sequence) to branch from.`,
      );
    }

    // Load all messages up to and including the fork point — no row cap.
    const forkedMessages = this.messageRepo.listByThreadUpToSequence(
      parentThreadId,
      forkMessage.sequence,
    );

    // Create child thread with lineage
    const lineage = { parentThreadId, forkedFromMessageId: resolvedForkMessageId };
    let thread: Thread;
    let threadWarnings: string[] | undefined;

    if (existingWorktreePath) {
      const workspace = this.workspaceRepo.findById(workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      const knownWorktrees = this.gitService.listWorktrees(workspaceId);
      const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      const normalizedInput = normalize(existingWorktreePath);
      const matched = knownWorktrees.find((wt) => normalize(wt.path) === normalizedInput);
      if (!matched) throw new Error("Path is not a recognized worktree");

      thread = this.threadRepo.create(workspaceId, title, "worktree", matched.branch, false, provider, lineage);
      this.threadRepo.updateWorktreePath(thread.id, existingWorktreePath);
      thread = { ...thread, worktree_path: existingWorktreePath, branch: matched.branch };
    } else if (mode === "worktree") {
      const createResult = await this.threadService.create(workspaceId, title, "worktree", branch);
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

    void this.sendMessage(
      thread.id,
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
      effectiveContextWindowMode,
      effectiveThinking,
      resolvedCodexFast ?? undefined,
      undefined,
      providerInput,
      undefined,
      undefined,
      displayContent,
    ).catch((err) => {
      logger.error("createBranchedThread initial send failed", {
        threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { ...thread, ...(threadWarnings?.length ? { warnings: threadWarnings } : {}) };
  }

  /** Stop the agent for a given thread, persisting any buffered tool calls first. */
  async stopSession(threadId: string): Promise<void> {
    const sessionId = `mcode-${threadId}`;
    const thread = this.threadRepo.findById(threadId);
    const providerId = (thread?.provider ?? "claude") as ProviderId;
    try {
      const provider = this.providerRegistry.resolve(providerId);
      provider.stopSession(sessionId);
    } catch {
      // Provider may not be available
    }
    // A user stop ends the turn. The finalizer flushes partial assistant text,
    // persists buffered tool calls (running ones inherit "cancelled"), captures
    // the snapshot, broadcasts turn.persisted, and clears per-turn state.
    await this.turnFinalizer.finalize(threadId, "cancelled");
    this.threadRepo.updateStatus(threadId, "paused");
    broadcast("thread.status", { threadId, status: "paused" });
    if (this.activeSessionIds.has(threadId)) {
      this.activeSessionIds.delete(threadId);
      if (this.activeSessionIds.size === 0) {
        this.memoryPressureService.markIdle();
      }
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

  /** Number of currently active sessions. */
  activeCount(): number {
    return this.activeSessionIds.size;
  }

  /** Get all currently active thread IDs. */
  activeThreadIds(): string[] {
    return [...this.activeSessionIds];
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
    if (!this.activeSessionIds.has(threadId)) return;
    this.activeSessionIds.delete(threadId);
    if (this.activeSessionIds.size === 0) {
      this.memoryPressureService.markIdle();
    }
  }

  /**
   * Subscribe to all provider events and handle persistence internally.
   * Must be called once at startup after the DI container is fully resolved.
   * Keeps assistant message persistence inside the service rather than
   * leaking it into the composition root.
   * Idempotent: subsequent calls are no-ops.
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    for (const provider of this.providerRegistry.resolveAll()) {
      provider.on("event", (event: AgentEvent) => {
        // Plan mode: feed streaming text to the question parser.
        // Buffer questions until the session closes (`ended`) so the client
        // cannot submit answers against a still-active session, which would
        // risk overlapping sends on the same thread.
        if (event.type === AgentEventType.TextDelta) {
          this.turnFinalizer.appendStreamingText(event.threadId, event.delta);
          // Final-response deltas are the assistant's user-facing reply — they will
          // be stored as the message body when the Message event arrives. Do not
          // open a ThoughtSegment for them: that would cause the text to appear
          // twice (once as a dimmed thought block, once as the assistant message).
          if (!event.isFinalResponse) {
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

        if (event.type === AgentEventType.Message) {
          try {
            const { messages: existing } = this.messageRepo.listByThread(event.threadId, 1);
            const nextSeq =
              existing.length > 0
                ? existing[existing.length - 1].sequence + 1
                : 1;
            // Record the thread's active model on the message so the UI can
            // display which provider/model produced the response, even if the
            // user later switches model mid-conversation.
            const thread = this.threadRepo.findById(event.threadId);
            const modelForMessage = thread?.model ?? null;
            const msg = this.messageRepo.create(
              event.threadId,
              "assistant",
              event.content,
              nextSeq,
              undefined,
              undefined,
              undefined,
              modelForMessage,
            );
            // Carry the persisted message ID so the broadcast schema passes it
            // through to the client. The client uses it for stable message identity
            // (branching, dedup across Electron's dual MessagePort+WebSocket channels).
            event.messageId = msg.id;
            // Carry the model too so the client's locally-built Message can
            // show the model name in the footer immediately — without it the
            // footer renders without the model until a thread refresh re-fetches
            // the persisted row from the DB.
            event.model = modelForMessage;
            this.turnFinalizer.resetStreamingText(event.threadId);
          } catch (err) {
            logger.error("Failed to persist assistant message", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          // A Message event marks the end of the turn. Any Agent calls still
          // on the stack are implicitly done - clear the stack so the next turn
          // starts clean (narrative-pipeline.md Trap 2 end-of-turn clear).
          this.narrativeStore.clearAgentStackOnMessage(event.threadId);

          // Persist any pending plan-output extracted from streamed text deltas.
          // Guarded on event.messageId so it only runs when the assistant message
          // was successfully persisted above.
          const pendingPlan = this.pendingPlanOutputs.get(event.threadId);
          const pendingExitPlan = this.pendingExitPlanMarkdown.get(event.threadId);
          const hadOutputParser = this.planOutputParsers.has(event.threadId);
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
        }

        if (event.type === AgentEventType.AssistantMessageBoundary) {
          // Authoritative classification of the just-streamed text deltas based
          // on the Anthropic message-level `stop_reason`. When `isFinalResponse`
          // is true the open thought segment was really the final user-facing
          // response (the legacy heuristic could not detect this for tool-free
          // turns) — drop it so it never gets persisted as a thought row, which
          // would otherwise render alongside the assistant message bubble.
          // Otherwise the message ended with a non-finalizing stop_reason such
          // as `tool_use`; close the thought so it persists as preamble.
          if (event.isFinalResponse) {
            this.narrativeStore.dropOpenThought(event.threadId);
          } else {
            this.narrativeStore.closeOpenThought(event.threadId);
          }
        }

        if (event.type === AgentEventType.ToolUse) {
          this.narrativeStore.closeOpenThought(event.threadId);
          this.bufferToolCall(event.threadId, event);
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
          this.narrativeStore.updateBufferedToolCallOutput(event.threadId, event.toolCallId, event.output, event.isError);
        }

        if (event.type === AgentEventType.TurnStarted) {
          // Re-add to activeSessionIds for auto-resumed turns (ScheduleWakeup/loop).
          // For sendMessage()-originated turns this is a no-op since sendMessage()
          // already added the thread before emitting TurnStarted.
          if (!this.activeSessionIds.has(event.threadId)) {
            this.activeSessionIds.add(event.threadId);
            this.memoryPressureService.markActive();
          }
          // Reset per-turn state that must survive past turn finalize so late
          // hooks can attach to the previous turn. Re-seeding them here rather
          // than in the finalizer's clear ensures a fresh counter for each new turn
          // while late hooks from the prior turn can still increment the old one.
          this.narrativeStore.resetTurnCounters(event.threadId);
          this.turnCompleteSeenByThread.delete(event.threadId);
        }

        if (event.type === AgentEventType.TurnComplete) {
          // Mark that the turn result has been seen so any hooks that arrive
          // after this point (Stop / SessionEnd / PreCompact) are routed through
          // flushLateHook instead of the normal mid-turn buffer.
          this.turnCompleteSeenByThread.add(event.threadId);

          this.turnFinalizer.finalize(event.threadId, "completed").catch((err) => {
            logger.error("finalize failed on turnComplete", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          // Clear the "running" flag so agent.listRunning no longer reports
          // this thread and shutdown won't downgrade it to "interrupted."
          // Skip during compaction: the SDK fires a synthetic TurnComplete
          // before the compaction API call, but the session continues
          // automatically.
          if (!this.compactionInProgressByThread.has(event.threadId)) {
            this.trackSessionEnded(event.threadId);
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
          // The finalizer discards the buffered turn when no assistant row
          // exists (e.g. a pre-turn CLI-not-found failure) rather than
          // broadcasting turn.persisted against the wrong (user) message id.
          this.turnFinalizer.finalize(event.threadId, "errored").catch((err) => {
            logger.error("finalize failed on error event", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
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
            const { messages: existing } = this.messageRepo.listByThread(event.threadId, 1);
            const nextSeq =
              existing.length > 0
                ? existing[existing.length - 1].sequence + 1
                : 1;
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
          this.trackSessionEnded(event.threadId);
          // Turn-scoped cleanup of any one-shot handoff Read grant. No-op on
          // later turns since the grant is already gone (consumed or cleared).
          this.scopedPreGrant.clear(event.threadId);
          this.planParsers.delete(event.threadId);
          this.planOutputParsers.delete(event.threadId);
          this.pendingPlanOutputs.delete(event.threadId);
          this.pendingExitPlanMarkdown.delete(event.threadId);
          this.planCapturedThisTurn.delete(event.threadId);
        }
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
   * non-narrative side effect AgentService still owns: persisting TodoWrite
   * task state for reconnect hydration. The narrative buffer + agentCallStack
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
  stopAll(): void {
    const ids = [...this.activeSessionIds];
    for (const threadId of ids) {
      const sessionId = `mcode-${threadId}`;
      const thread = this.threadRepo.findById(threadId);
      const providerId = (thread?.provider ?? "claude") as ProviderId;
      try {
        const provider = this.providerRegistry.resolve(providerId);
        provider.stopSession(sessionId);
      } catch {
        // best-effort
      }
    }
    this.activeSessionIds.clear();
  }
}
