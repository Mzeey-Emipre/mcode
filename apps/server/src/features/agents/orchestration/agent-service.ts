/**
 * Agent session orchestration service.
 * Manages sending messages to AI providers, tracking active sessions,
 * and forwarding agent events to the push broadcaster.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { injectable, inject, delay } from "tsyringe";
import { logger } from "@mcode/shared";
import {
  AgentEventType,
  createSubagentPresentation,
  isSessionEvictable,
} from "@mcode/contracts";
import type {
  Thread,
  IProviderRegistry,
  IAgentProvider,
  TurnRequest,
  AgentEvent,
  ProviderId,
  TurnRuntimeSnapshot,
  AgentStopResult,
} from "@mcode/contracts";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { TURN_FINALIZER, TurnFinalizer } from "../turns/turn-finalizer.js";
import {
  ParentAssistantTextCheckpointService,
} from "../turns/parent-assistant-text-checkpoint-service.js";
import { ParentAssistantTextCoordinator } from "../turns/parent-assistant-text-coordinator.js";
import { TURN_FILE_EFFECTS, TurnFileEffects } from "../turns/turn-file-effects.js";
import { ParentNarrativeRecoveryCoordinator } from "../turns/parent-narrative-recovery-coordinator.js";
import type Database from "better-sqlite3";
import type { WorkspaceEnvironmentAutomaticSetupDispatch } from "../../projects/environment/workspace-environment-service.js";
import { MemoryPressureService, type MemoryPressureSnapshot } from "../../../runtime/memory/memory-pressure-service.js";
import { broadcast } from "../../../application/transport/push.js";
// Lazy-imported to break circular dependency: AgentService -> ThreadService -> (shared repos)
// Using delay() ensures tsyringe resolves ThreadService from the container at first access,
// not at AgentService construction time.
import {
  InternalThreadControlMcpRuntime,
  ThreadControlMutationReservationService,
} from "../../thread-control/index.js";
import { ScopedPreGrantService } from "../permissions/scoped-pre-grant.js";
import { normalizeAgentProviderError } from "./provider-agent-error-normalize.js";
import { TurnErrorPolicy } from "../turns/turn-error-policy.js";
import { TurnRuntimeRegistry } from "../turns/turn-runtime.js";
import type { TurnOutcome } from "../turns/turn-outcome.js";
import { BrowserNarrativeEventSanitizer } from "../../browser-automation/index.js";
import {
  ProviderEventIngress,
  type ProviderEventIngressEvent,
} from "../../providers/composition/provider-event-ingress.js";
import {
  TurnEventPipeline,
  type FinalizeTurnCommand,
  type TurnEventApplication,
  type TurnLifecycleControl,
} from "../turns/turn-event-pipeline.js";
import {
  TurnEventApplication as NormalizedTurnEventApplication,
  type TurnEventDiagnosticProvenance,
  type TurnEventEffects,
} from "../turns/turn-event-application.js";
import {
  PARENT_TURN_DURABILITY,
  type ParentTurnDurability,
} from "../turns/parent-turn-durability.js";
import { TURN_FEATURE_EFFECTS, TurnFeatureEffects } from "../turns/turn-feature-effects.js";
import {
  TURN_RUNTIME_PERSISTENCE,
  type TurnRuntimePersistence,
} from "../turns/turn-runtime-persistence.js";
import { TurnConversationProjectionService } from "../turns/turn-conversation-projection-service.js";
import { PostTerminalHookCompletionEffect } from "../turns/post-terminal-hook-completion-effect.js";
import { ProviderSessionCursorPersistence } from "../turns/provider-session-cursor-persistence.js";
import {
  ThreadCreationCoordinator,
  type CreateAndSendCommand,
} from "../turns/thread-creation-coordinator.js";
import {
  TurnAdmissionDispatchCoordinator,
  TURN_ADMISSION_DISPATCH_COORDINATOR,
  type CommandEffectReceipt,
  type PreparedTurnDispatch,
  type SendMessageCommand,
  type ThreadControlLeaseDirective,
  type TurnRuntimeAdmissionAuthority,
  type TurnRuntimeLease,
  type WorkspaceEnvironmentQueuedTurnSubmission,
} from "../turns/turn-admission-dispatch-coordinator.js";
import { AgentRuntimeCommandPort } from "./agent-turn-command-port.js";
import { AgentEventPublicationRegistry } from "./agent-event-publication-registry.js";
import {
  AgentEventPublicationRuntimePort,
  AgentReliabilityPort,
  AgentTurnContinuationPort,
} from "./agent-runtime-internal-ports.js";

type RetryDispatchIdentity = Readonly<{
  mutationReservationToken: string;
  generation: number;
}>;

type PreparedStop = {
  threadId: string;
  sessionId: string;
  providerId?: ProviderId;
  reservationToken?: string;
  dispatchState: AgentStopResult["dispatchState"];
  runtime: TurnRuntimeSnapshot;
};

/** Read-only runtime state available to server-owned diagnostics and recovery infrastructure. */
export interface AgentRuntimeAccess {
  /** Return the number of active agent sessions. */
  activeCount(): number;
  /** Return all active runtime thread identities. */
  activeThreadIds(): string[];
  /** Return immutable runtime snapshots. */
  runtimeSnapshots(): TurnRuntimeSnapshot[];
}

export type { SendMessageCommand } from "../turns/turn-admission-dispatch-coordinator.js";
export type { CreateAndSendCommand } from "../turns/thread-creation-coordinator.js";

function toolResultMetadata(event: Extract<AgentEvent, { type: "toolResult" }>): {
  outputTruncated?: true;
  outputTotalBytes?: number;
  outputArtifactPath?: string;
  exitCode?: number;
} {
  return {
    ...(event.outputTruncated === true ? { outputTruncated: true as const } : {}),
    ...(event.outputTotalBytes != null ? { outputTotalBytes: event.outputTotalBytes } : {}),
    ...(event.outputArtifactPath ? { outputArtifactPath: event.outputArtifactPath } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
  };
}

function endedOutcome(outcome: Exclude<Extract<AgentEvent, { type: "ended" }>['outcome'], undefined>): TurnOutcome {
  if (outcome === "completed") return "completed";
  if (outcome === "errored") return "errored";
  return "interrupted";
}

/** Orchestrates agent sessions, message sending, and event forwarding. */
@injectable()
export class AgentService {
  /** Canonical per-thread execution identity and lifecycle authority. */
  private readonly turnRuntime = new TurnRuntimeRegistry();
  private readonly browserNarrativeEventSanitizer: BrowserNarrativeEventSanitizer;
  private readonly preparedProviderEvents = new WeakMap<object, AgentEvent | undefined>();
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
  /** Feature-owned coordinator for file-effect setup, ordering, and terminal prerequisites. */
  /** Exposes the file-effect baseline wait seam without retaining file-effect state in AgentService. */
  private get fileTrackingRefCaptureByThread(): TurnFileEffects {
    return this.turnFileEffects;
  }
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
  /** Resolves queued automatic dispatches only after their authoritative runtime releases its active slot. */
  private readonly automaticQueuedTurnCompletionResolvers = new Map<string, () => void>();
  /**
   * Per-thread dispatch state for transient retries. Fire-and-forget providers
   * A provider can return from `sendTurn` before the stream ends, so the retry
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
      /** Provider-neutral thread-control activation selected during admission. */
      threadControl: ThreadControlLeaseDirective | null;
      turnRequest: TurnRequest;
      /** Shared mutation token required for every provider dispatch and release. */
      mutationReservationToken: string;
      /** Monotonic turn generation used to reject stale retry callbacks. */
      generation: number;
      /** Opaque command-effect receipt retained until terminal success or retry exhaustion. */
      commandEffect: CommandEffectReceipt | null;
    }
  >();
  /**
   * Threads whose `TurnComplete` event has already been processed but whose
   * finalize may still be in-flight or have already finished.
   * Set when `TurnComplete` is handled; cleared on `TurnStarted` so the
   * per-thread flag resets between turns.
   * Hooks that arrive while this flag is set are treated as post-turn (Stop /
   * SessionEnd / PreCompact) and persist only after the terminal projection verifies.
   */
  private turnCompleteSeenByThread = new Set<string>();
  /** Execution identity that produced the last assistant Message for each thread. */
  private finalResponseExecutionByThread = new Map<string, string>();
  /** Reservation token attached to each active provider turn. */
  private readonly activeMutationReservations = new Map<string, string>();
  /** Single-flight user stop operation per thread. */
  private readonly stopOperationsByThread = new Map<string, Promise<AgentStopResult>>();
  /** Monotonic turn generation per thread, including turns that failed setup. */
  private readonly turnGenerations = new Map<string, number>();
  private readonly mutationReservations: ThreadControlMutationReservationService;
  private readonly parentDurability: ParentTurnDurability;
  private readonly parentAssistantText: ParentAssistantTextCoordinator;
  private readonly parentNarrativeRecovery: ParentNarrativeRecoveryCoordinator;
  private readonly providerEventIngress: ProviderEventIngress;
  /** First sidecar sequence for text awaiting an authoritative message boundary. */
  private readonly unclassifiedAssistantTextStartByExecution = new Map<string, number>();
  /** Feature-owned pipeline for validated provider envelopes and terminal materialization. */
  private turnEventPipeline: TurnEventPipeline | undefined;
  /** Owns provider-neutral normalized event sequencing and durable renderer publication. */
  private readonly normalizedTurnEventApplication: NormalizedTurnEventApplication;
  /** Hook completions that publish only after their parent turn is durable. */
  private readonly ownedLateHookCompletions = new WeakSet<object>();
  constructor(
    @inject(TURN_RUNTIME_PERSISTENCE)
    private readonly runtimePersistence: TurnRuntimePersistence,
    @inject(TURN_FINALIZER)
    private readonly turnFinalizer: TurnFinalizer,
    @inject(TURN_FILE_EFFECTS)
    private readonly turnFileEffects: TurnFileEffects,
    @inject(TURN_ADMISSION_DISPATCH_COORDINATOR)
    private readonly turnAdmissions: TurnAdmissionDispatchCoordinator,
    @inject(TurnConversationProjectionService)
    private readonly conversationProjection: TurnConversationProjectionService,
    @inject(PostTerminalHookCompletionEffect)
    private readonly lateHookCompletions: PostTerminalHookCompletionEffect,
    @inject(ProviderSessionCursorPersistence)
    private readonly sessionCursors: ProviderSessionCursorPersistence,
    @inject(ThreadCreationCoordinator)
    private readonly threadCreation: ThreadCreationCoordinator,
    @inject("IProviderRegistry")
    private readonly providerRegistry: IProviderRegistry,
    @inject(MemoryPressureService)
    private readonly memoryPressureService: MemoryPressureService,
    @inject("Database") private readonly db: Database.Database,
    @inject(ScopedPreGrantService)
    private readonly scopedPreGrant: ScopedPreGrantService,
    @inject(NarrativeStore)
    private readonly narrativeStore: NarrativeStore,
    @inject(ParentAssistantTextCheckpointService)
    parentAssistantTextCheckpoints: ParentAssistantTextCheckpointService,
    @inject(delay(() => InternalThreadControlMcpRuntime))
    private readonly threadControlMcp?: InternalThreadControlMcpRuntime,
    @inject(delay(() => ThreadControlMutationReservationService))
    mutationReservations?: ThreadControlMutationReservationService,
    @inject(PARENT_TURN_DURABILITY)
    parentDurability?: ParentTurnDurability,
    @inject(ProviderEventIngress)
    providerEventIngress?: ProviderEventIngress,
    @inject(TURN_FEATURE_EFFECTS)
    private readonly featureEffects?: TurnFeatureEffects,
    @inject(AgentRuntimeCommandPort)
    runtimeCommands?: AgentRuntimeCommandPort,
    @inject(AgentEventPublicationRuntimePort)
    publicationRuntime?: AgentEventPublicationRuntimePort,
    @inject(AgentTurnContinuationPort)
    continuation?: AgentTurnContinuationPort,
    @inject(AgentReliabilityPort)
    reliability?: AgentReliabilityPort,
    @inject(AgentEventPublicationRegistry)
    private readonly eventPublication: AgentEventPublicationRegistry = new AgentEventPublicationRegistry(),
  ) {
    this.browserNarrativeEventSanitizer = new BrowserNarrativeEventSanitizer(
      (threadId, toolCallId) => this.narrativeStore.getBufferedToolCalls(threadId)
        .find((toolCall) => toolCall.toolCallId === toolCallId)
        ?.toolName,
    );
    this.mutationReservations = mutationReservations ?? new ThreadControlMutationReservationService();
    if (!parentDurability) throw new Error("Parent turn durability is not configured");
    this.parentDurability = parentDurability;
    this.parentAssistantText = new ParentAssistantTextCoordinator(
      this.parentDurability,
      parentAssistantTextCheckpoints,
      (update) => {
        broadcast("turn.savingStatus", update);
        queueMicrotask(() => this.turnEventPipeline?.resume(update.threadId));
      },
    );
    this.parentNarrativeRecovery = new ParentNarrativeRecoveryCoordinator(
      this.parentDurability,
      this.narrativeStore,
    );
    if (!providerEventIngress) throw new Error("Provider event ingress is not configured");
    this.providerEventIngress = providerEventIngress;
    this.normalizedTurnEventApplication = new NormalizedTurnEventApplication(this.createTurnEventEffects());
    runtimeCommands?.bind({
      sendMessage: (command) => this.sendMessage(command),
      runtimeSnapshots: () => this.runtimeSnapshots(),
    });
    publicationRuntime?.bind({
      getCurrentFileEffectTurnId: (threadId) => this.getCurrentFileEffectTurnId(threadId),
      shouldSuppressTurnEnded: (threadId) => this.shouldSuppressTurnEnded(threadId),
      shouldSuppressTurnComplete: (threadId) => this.shouldSuppressTurnComplete(threadId),
      shouldSuppressTransientTurnError: (threadId, errorMessage) => (
        this.shouldSuppressTransientTurnError(threadId, errorMessage)
      ),
    });
    continuation?.bind((executionId) => this.continueWithoutSaving(executionId));
    reliability?.bind((threadId) => this.streamReliabilityAssistantText(threadId));
    this.eventPublication.registerPipelineStart(() => this.initializeProviderEvents());
  }

  /** Initialize file tracking once for the active turn, including provider-originated resumes. */
  private ensureTurnFileTracking(threadId: string, cwdOverride?: string): Promise<void> {
    const setup = this.turnFileEffects.ensure(threadId, cwdOverride);
    return setup;
  }

  /** Return the server tracker generation that owns live file effects for a thread. */
  private getCurrentFileEffectTurnId(threadId: string): string | undefined {
    return this.turnFileEffects.currentTurnId(threadId);
  }

  /** Connect focused event families to the provider-neutral normalized event application. */
  private createTurnEventEffects(): TurnEventEffects {
    return {
      recordDiagnostic: (input, event) => this.recordProviderDiagnostic(input, event),
      applyTextDelta: (event) => this.applyTextDelta(event),
      applyGeneratedAttachment: (event) => this.applyGeneratedAttachment(event),
      applyMessage: (providerId, event) => this.applyProviderMessage(providerId, event),
      applyAssistantMessageBoundary: (event) => this.applyAssistantMessageBoundary(event),
      applyToolUse: (event) => this.applyToolUse(event),
      applyHookStarted: (event) => this.applyHookStarted(event),
      applyHookCompleted: (event) => this.applyHookCompleted(event),
      applyToolResult: (event) => this.applyToolResult(event),
      applyTurnStarted: (event) => this.applyTurnStarted(event),
      applyTurnComplete: (event) => this.applyTurnComplete(event),
      applyError: (event) => this.applyProviderError(event),
      applyCompacting: (event) => this.applyCompacting(event),
      applyCompactSummary: (event) => this.applyCompactSummary(event),
      applySystem: (providerId, event) => this.applyProviderSystem(providerId, event),
      applyEnded: (event) => this.applyEnded(event),
      finishAssistantText: (executionId) => this.parentAssistantText.finish(executionId),
      isAssistantTextUnsaved: (executionId) => (
        this.parentAssistantText.durabilityMode(executionId) === "unsaved"
      ),
      interruptForAssistantTextFailure: (event, reason) => (
        this.stopForParentAssistantTextCheckpointFailure(event, reason)
      ),
      checkpointNarrative: (event) => this.parentNarrativeRecovery.checkpoint(event),
      interruptForNarrativeFailure: (event, error) => (
        this.stopForNarrativeRecoveryCheckpointFailure(event, error)
      ),
      isLateHook: (event) => this.isLateHook(event),
      ownsLateHookPublication: (event) => this.ownedLateHookCompletions.delete(event as object),
      publish: (event) => this.publishProviderEvent(event),
      fileFinalization: (threadId) => this.turnFileEffects.previousFinalization(threadId),
    };
  }

  /** Record provider diagnostics when a canonical receipt did not already record the event. */
  private recordProviderDiagnostic(provenance: TurnEventDiagnosticProvenance, event: AgentEvent): void {
    if (provenance.sourceKind === "canonical-commit" && provenance.canonicalReceipt) return;
    if (!event.turnExecutionId) return;
    this.parentDurability.recordProviderDiagnostic({
      executionId: event.turnExecutionId,
      event,
      terminal: event.type === AgentEventType.TurnComplete
        || event.type === AgentEventType.Error
        || (event.type === AgentEventType.Ended && event.outcome !== undefined),
    });
  }

  /** Buffer or narrate one text delta without mutating the subagent parent stack. */
  private applyTextDelta(event: Extract<AgentEvent, { type: "textDelta" }>): boolean {
    if (event.isFinalResponse === true) {
      this.turnFinalizer.appendStreamingText(event.threadId, event.delta);
    } else if (event.isFinalResponse === false) {
      this.narrativeStore.openOrExtendThought(event.threadId, event.delta);
    } else {
      this.recordUnclassifiedAssistantText(event);
      this.turnFinalizer.appendStreamingText(event.threadId, event.delta);
    }
    this.featureEffects?.onTextDelta(event.threadId, event.delta);
    return true;
  }

  /** Track the first durable sidecar sequence for text that awaits a message boundary. */
  private recordUnclassifiedAssistantText(event: Extract<AgentEvent, { type: "textDelta" }>): void {
    const executionId = event.turnExecutionId;
    const sequence = executionId ? this.parentAssistantText.sequence(executionId) : undefined;
    if (executionId && sequence && !this.unclassifiedAssistantTextStartByExecution.has(executionId)) {
      this.unclassifiedAssistantTextStartByExecution.set(executionId, sequence);
    }
  }

  /** Buffer one generated attachment until the terminal materialization seam. */
  private applyGeneratedAttachment(event: Extract<AgentEvent, { type: "generatedAttachment" }>): boolean {
    this.turnFinalizer.bufferAssistantAttachments(event.threadId, [event.attachment]);
    return true;
  }

  /** Buffer an assistant message and materialize any plan record that requires its message id. */
  private applyProviderMessage(
    providerId: ProviderId,
    event: Extract<AgentEvent, { type: "message" }>,
  ): boolean {
    if (event.turnExecutionId) this.finalResponseExecutionByThread.set(event.threadId, event.turnExecutionId);
    this.bufferAssistantMessage(event);
    this.featureEffects?.onAssistantMessage(providerId, event);
    this.narrativeStore.clearAgentStackOnMessage(event.threadId);
    if (this.featureEffects?.needsAssistantMaterialization(event)) {
      this.turnFinalizer.materializeAssistantRow(event.threadId);
    }
    this.featureEffects?.persistAssistantMessage(event);
    return true;
  }

  /** Assign renderer-stable message identity while retaining non-substantive bodies for the finalizer. */
  private bufferAssistantMessage(event: Extract<AgentEvent, { type: "message" }>): void {
    try {
      this.conversationProjection.bufferAssistantMessage(event, this.isPostTurnGoalReceipt(event));
    } catch (error) {
      logger.error("Failed to persist assistant message", {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Return whether a provider message is the goal-completion receipt that follows terminal output. */
  private isPostTurnGoalReceipt(event: Extract<AgentEvent, { type: "message" }>): boolean {
    return this.turnCompleteSeenByThread.has(event.threadId)
      && /^Goal achieved in \d+s\.$/.test(event.content.trim());
  }

  /** Apply the authoritative assistant-message boundary without touching the parent stack. */
  private applyAssistantMessageBoundary(
    event: Extract<AgentEvent, { type: "assistantMessageBoundary" }>,
  ): boolean {
    if (event.isFinalResponse === true) {
      const finalText = this.narrativeStore.takeOpenThought(event.threadId);
      if (finalText) this.turnFinalizer.appendStreamingText(event.threadId, finalText);
      if (event.turnExecutionId) this.unclassifiedAssistantTextStartByExecution.delete(event.turnExecutionId);
      return true;
    }
    return event.isFinalResponse === false ? this.classifyUnclassifiedAssistantTextAsNarration(event) : true;
  }

  /** Append a tool start to narration and attribute its file effects exactly once. */
  private applyToolUse(event: Extract<AgentEvent, { type: "toolUse" }>): boolean {
    this.narrativeStore.closeOpenThought(event.threadId);
    this.bufferToolCall(event.threadId, event);
    if (!this.turnEventPipeline?.consumeEarlyFileEffect(event)) this.turnFileEffects.observeToolUse(event);
    return true;
  }

  /** Open a hook with a deterministic narrative position. */
  private applyHookStarted(event: Extract<AgentEvent, { type: "hookStarted" }>): boolean {
    const late = this.turnCompleteSeenByThread.has(event.threadId);
    if (!late) this.narrativeStore.closeOpenThought(event.threadId);
    this.narrativeStore.openHook(event.threadId, {
      hookName: event.hookName,
      toolName: event.toolName ?? null,
      phase: late ? "stop" : event.hookType,
      payload: JSON.stringify({ hookType: late ? "stop" : event.hookType, toolName: late ? null : event.toolName ?? null }),
      sortOrder: this.narrativeStore.nextSortOrder(event.threadId),
    });
    return true;
  }

  /** Close a hook and defer its renderer publication when its parent turn has already completed. */
  private applyHookCompleted(event: Extract<AgentEvent, { type: "hookCompleted" }>): boolean {
    const open = this.narrativeStore.peekOpenHook(event.threadId, event.hookName);
    if (!open) return true;
    const completed = {
      id: open.id,
      hookName: open.hookName,
      toolName: open.toolName,
      phase: open.phase,
      payload: open.payload,
      durationMs: event.durationMs,
      didBlock: event.didBlock,
      startedAt: open.startedAt,
      endedAt: new Date().toISOString(),
      sortOrder: open.sortOrder,
    };
    this.narrativeStore.pushClosedHook(event.threadId, { ...completed, messageId: "" });
    this.narrativeStore.removeOpenHook(event.threadId, event.hookName);
    if (this.turnCompleteSeenByThread.has(event.threadId)) {
      this.ownedLateHookCompletions.add(event);
      this.persistVerifiedLateHook(event.threadId, completed);
    }
    return true;
  }

  /** Append a tool completion to narration and its current file-effect generation. */
  private applyToolResult(event: Extract<AgentEvent, { type: "toolResult" }>): boolean {
    if (!this.turnEventPipeline?.consumeEarlyFileEffect(event)) this.turnFileEffects.observeToolResult(event);
    this.narrativeStore.updateBufferedToolCallOutput(
      event.threadId,
      event.toolCallId,
      event.output,
      event.isError,
      event.toolInput,
      toolResultMetadata(event),
    );
    this.featureEffects?.onToolResult(event.threadId, event.toolCallId, event.output, event.isError);
    return true;
  }

  /** Return renderer-facing metadata recorded with one tool result. */
  private isLateHook(event: AgentEvent): boolean {
    return this.turnCompleteSeenByThread.has(event.threadId)
      && (event.type === AgentEventType.HookStarted || event.type === AgentEventType.HookCompleted);
  }

  /** Admit a provider-resumed turn before it can replace the active runtime generation. */
  private applyTurnStarted(event: Extract<AgentEvent, { type: "turnStarted" }>): boolean {
    if (!this.admitTurnStarted(event.threadId)) return false;
    if (!this.turnEventPipeline?.consumeEarlyFileEffect(event)) this.turnFileEffects.beginResumed(event.threadId);
    if (!this.activeSessionIds.has(event.threadId)) {
      this.activeSessionIds.add(event.threadId);
      this.memoryPressureService.markActive(event.threadId);
    }
    this.narrativeStore.resetTurnCounters(event.threadId);
    this.turnCompleteSeenByThread.delete(event.threadId);
    this.finalResponseExecutionByThread.delete(event.threadId);
    this.terminalFinalizedThreads.delete(event.threadId);
    return true;
  }

  /** Reserve runtime authority for an auto-resumed turn or stop it before it can stream. */
  private admitTurnStarted(threadId: string): boolean {
    const reservation = this.mutationReservations.get(threadId);
    const thread = this.runtimePersistence.load(threadId);
    if (reservation?.state === "stopping" || this.isStoppedThread(thread?.status)) {
      this.stopUnadmittedTurn(threadId, thread?.provider as ProviderId | undefined, "late TurnStarted");
      return false;
    }
    if (this.activeMutationReservations.has(threadId)) return true;
    const token = this.mutationReservations.reserve(threadId, "activeTurn");
    if (!token) {
      this.stopUnadmittedTurn(threadId, thread?.provider as ProviderId | undefined, "blocked auto-resumed turn");
      return false;
    }
    this.activeMutationReservations.set(threadId, token);
    return true;
  }

  /** Return whether a persisted thread status prohibits a new provider turn. */
  private isStoppedThread(status: Thread["status"] | undefined): boolean {
    return status === undefined || ["paused", "stopped", "completed", "errored", "failed", "interrupted"].includes(status);
  }

  /** Ask the owning provider to stop an event stream that the runtime did not admit. */
  private stopUnadmittedTurn(threadId: string, providerId: ProviderId | undefined, reason: string): void {
    logger.warn("Ignoring TurnStarted that the runtime did not admit", { threadId, providerId, reason });
    if (!providerId) return;
    try {
      const provider = this.providerRegistry.resolve(providerId);
      void Promise.resolve(provider.stopSession(`mcode-${threadId}`)).catch((error) => {
        logger.warn("Failed to stop unadmitted provider turn", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger.warn("Failed to resolve provider for unadmitted turn", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Apply a provider completion while preserving retry and compaction suppression rules. */
  private applyTurnComplete(event: Extract<AgentEvent, { type: "turnComplete" }>): boolean {
    if (this.shouldSuppressStoppingTerminal(event.threadId, event.turnExecutionId)) return false;
    if (this.shouldSuppressTurnComplete(event.threadId)) return false;
    const compacting = this.compactionInProgressByThread.has(event.threadId);
    const terminalized = !compacting && this.turnRuntime.terminalize(event.threadId, event.turnExecutionId!, "completed");
    if (!compacting && !terminalized) return false;
    this.turnCompleteSeenByThread.add(event.threadId);
    if (terminalized) void this.finalizeTerminalTurn(event.threadId, "completed", "turnComplete");
    if (!compacting) this.completeProviderRuntime(event);
    this.recordContextUsage(event, compacting);
    return terminalized;
  }

  /** Release runtime-only completion authority after a terminal provider completion. */
  private completeProviderRuntime(event: Extract<AgentEvent, { type: "turnComplete" }>): void {
    this.threadControlMcp?.revoke(`mcode-${event.threadId}`);
    this.trackSessionEnded(event.threadId, event.turnExecutionId);
    this.disarmTurnRetryWindow(event.threadId);
    this.featureEffects?.refreshAfterTurn(event.threadId);
  }

  /** Persist provider context usage only for a completed non-compaction turn. */
  private recordContextUsage(event: Extract<AgentEvent, { type: "turnComplete" }>, compacting: boolean): void {
    if (event.tokensIn > 0 && !compacting) {
      try {
        this.runtimePersistence.recordContextUsage(event.threadId, event.tokensIn, event.contextWindow);
      } catch (error) {
        logger.warn("Context usage not persisted", {
          threadId: event.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.lastContextByThread.set(event.threadId, event.tokensIn);
    if (event.contextWindow) this.lastContextWindowByThread.set(event.threadId, event.contextWindow);
  }

  /** Apply a provider error, suppressing only a retryable failed attempt. */
  private applyProviderError(event: Extract<AgentEvent, { type: "error" }>): boolean {
    if (this.shouldSuppressStoppingTerminal(event.threadId, event.turnExecutionId)) return false;
    if (this.suppressTransientError(event)) return false;
    const terminalized = this.turnRuntime.terminalize(event.threadId, event.turnExecutionId!, "errored");
    if (!terminalized) return false;
    void this.finalizeTerminalTurn(event.threadId, "errored", "error");
    this.trackSessionEnded(event.threadId, event.turnExecutionId);
    this.disarmTurnRetryWindow(event.threadId);
    this.releaseMutationReservation(event.threadId);
    this.clearTurnEndedState(event.threadId);
    return true;
  }

  /** Schedule a stream retry and swallow its trailing terminal event. */
  private suppressTransientError(event: Extract<AgentEvent, { type: "error" }>): boolean {
    if (!this.shouldSuppressTransientTurnError(event.threadId, event.error ?? "")) return false;
    this.endedSuppressionThreads.add(event.threadId);
    const dispatch = this.turnRetryDispatchByThread.get(event.threadId);
    if (dispatch && !dispatch.sendTurnInFlight) this.scheduleTransientStreamRetry(event.threadId, event.error ?? "");
    return true;
  }

  /** Track compaction state without terminalizing its synthetic completion. */
  private applyCompacting(event: Extract<AgentEvent, { type: "compacting" }>): boolean {
    if (event.active) {
      this.lastContextByThread.set(event.threadId, 0);
      this.compactionInProgressByThread.add(event.threadId);
      return true;
    }
    this.compactionInProgressByThread.delete(event.threadId);
    this.persistCompactionDivider(event.threadId);
    return true;
  }

  /** Persist a durable divider once compaction has completed. */
  private persistCompactionDivider(threadId: string): void {
    try {
      this.conversationProjection.persistCompactionDivider(threadId);
    } catch (error) {
      logger.error("Failed to persist compaction system message", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Persist a provider-reported compaction summary. */
  private applyCompactSummary(event: Extract<AgentEvent, { type: "compactSummary" }>): boolean {
    try {
      this.runtimePersistence.recordCompactionSummary(event.threadId, event.summary);
      logger.info("Persisted compaction summary", { threadId: event.threadId, summaryLength: event.summary.length });
    } catch (error) {
      logger.error("Failed to persist compaction summary", {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  /** Persist provider session cursor updates without coupling the pipeline to a provider implementation. */
  private applyProviderSystem(providerId: ProviderId, event: Extract<AgentEvent, { type: "system" }>): boolean {
    this.sessionCursors.apply(providerId, event, this.turnRuntime.snapshot(event.threadId)?.turnExecutionId ?? undefined);
    return true;
  }

  /** Apply a provider stream end only when it still owns the active execution. */
  private applyEnded(event: Extract<AgentEvent, { type: "ended" }>): boolean {
    if (event.outcome === undefined) return false;
    if (this.shouldSuppressStoppingTerminal(event.threadId, event.turnExecutionId)) return false;
    if (this.shouldSuppressTurnEnded(event.threadId)) return false;
    const runtime = this.turnRuntime.snapshot(event.threadId);
    const executionId = runtime?.turnExecutionId;
    if (!executionId || !this.isActiveRuntimeExecution(runtime, event.turnExecutionId)) return false;
    const outcome = endedOutcome(event.outcome);
    if (!this.turnRuntime.terminalize(event.threadId, executionId, outcome)) return false;
    void this.finalizeTerminalTurn(event.threadId, outcome, "ended");
    this.trackSessionEnded(event.threadId, executionId);
    this.disarmTurnRetryWindow(event.threadId);
    this.clearTurnEndedState(event.threadId);
    return true;
  }

  /** Return whether an ended event belongs to a still-active runtime execution. */
  private isActiveRuntimeExecution(runtime: TurnRuntimeSnapshot | null, executionId: string | undefined): boolean {
    const phase = runtime?.phase;
    return runtime?.turnExecutionId === executionId
      && (phase === "running" || phase === "finalizing");
  }

  /** Publish a renderer-facing event after converting legacy cancelled end state to interrupted. */
  private publishProviderEvent(event: AgentEvent): void {
    const published = event.type === AgentEventType.Ended && event.outcome === "cancelled"
      ? { ...event, outcome: "interrupted" as const }
      : event;
    this.eventPublication.publish(published);
  }

  /**
   * Admit a complete turn command, then retain only runtime-owned provider dispatch.
   */
  async sendMessage(command: SendMessageCommand): Promise<void> {
    const admitted = await this.turnAdmissions.admit(command, this.runtimeAdmissionAuthority());
    if (admitted.kind !== "dispatch") return;
    await this.dispatchPreparedTurn(admitted);
  }

  /** Expose AgentService's runtime state without giving admission independent lifecycle authority. */
  private runtimeAdmissionAuthority(): TurnRuntimeAdmissionAuthority {
    return {
      reserve: (command) => this.reserveTurnAdmission(command),
      activate: (lease) => this.activateTurnAdmission(lease),
      abort: (lease) => this.abortTurnAdmission(lease),
      release: (lease) => this.releaseTurnAdmission(lease),
      owns: (lease) => this.ownsTurnAdmission(lease),
    };
  }

  /** Reserve one runtime generation and its mutation lease for a new admitted turn. */
  private reserveTurnAdmission(command: SendMessageCommand): TurnRuntimeLease {
    if (!this.reserveTurn(command.threadId)) {
      throw new Error(`Thread ${command.threadId} already has an active agent session`);
    }
    const token = this.reserveMutationToken(command);
    if (!token) {
      this.activeSessionIds.delete(command.threadId);
      throw new Error(`Thread ${command.threadId} already has a pending mutation`);
    }
    const generation = (this.turnGenerations.get(command.threadId) ?? 0) + 1;
    this.turnGenerations.set(command.threadId, generation);
    const turnExecutionId = this.turnRuntime.start(command.threadId).turnExecutionId!;
    this.activeMutationReservations.set(command.threadId, token);
    command.onTurnStarted?.({ threadId: command.threadId, turnExecutionId, phase: "running" });
    return { threadId: command.threadId, turnExecutionId, mutationReservationToken: token, generation };
  }

  /** Reuse an approved mutation lease or reserve one for a normal composer turn. */
  private reserveMutationToken(command: SendMessageCommand): string | null {
    if (!command.mutationReservationToken) {
      return this.mutationReservations.reserve(command.threadId, "activeTurn");
    }
    return this.mutationReservations.owns(command.threadId, command.mutationReservationToken, "activeTurn")
      ? command.mutationReservationToken
      : null;
  }

  /** Mark a leased runtime active only after admission has validated its durable setup. */
  private activateTurnAdmission(lease: TurnRuntimeLease): void {
    if (!this.ownsTurnAdmission(lease)) {
      throw new Error(`Turn admission lost runtime ownership: ${lease.threadId}`);
    }
    this.memoryPressureService.assertCanStartTurn();
    this.memoryPressureService.markActive(lease.threadId);
  }

  /** Release a failed admission without disturbing a replacement turn that won the lease. */
  private releaseTurnAdmission(lease: TurnRuntimeLease): void {
    const ownsRuntime = this.turnRuntime.snapshot(lease.threadId)?.turnExecutionId === lease.turnExecutionId;
    const ownsMutation = this.activeMutationReservations.get(lease.threadId) === lease.mutationReservationToken;
    if ((ownsRuntime || ownsMutation) && this.activeSessionIds.delete(lease.threadId)) {
      this.memoryPressureService.markIdle(lease.threadId);
    }
    if (ownsMutation) this.activeMutationReservations.delete(lease.threadId);
    this.mutationReservations.release(lease.threadId, lease.mutationReservationToken);
  }

  /** Terminalize an admitted turn when durable admission cannot complete. */
  private async abortTurnAdmission(lease: TurnRuntimeLease): Promise<void> {
    if (!this.turnRuntime.terminalize(lease.threadId, lease.turnExecutionId, "errored")) return;
    await (this.finalizeTerminalTurn(lease.threadId, "errored", "turn admission failure") ?? Promise.resolve());
    this.disarmTurnRetryWindow(lease.threadId);
    this.trackSessionEnded(lease.threadId, lease.turnExecutionId);
  }

  /** Check exact runtime generation and reservation ownership before provider work. */
  private ownsTurnAdmission(lease: TurnRuntimeLease): boolean {
    return this.ownsActiveTurnExecution(
      lease.threadId,
      lease.turnExecutionId,
      lease.mutationReservationToken,
    );
  }

  /** Set up generic turn tracking, apply a stable command receipt, then send through the provider. */
  private async dispatchPreparedTurn(prepared: PreparedTurnDispatch): Promise<void> {
    if (!this.ownsTurnAdmission(prepared.lease)) {
      this.releaseTurnAdmission(prepared.lease);
      return;
    }
    try {
      await this.prepareRuntimeDispatch(prepared);
      await this.activatePreparedCommandEffect(prepared);
      await this.startPreparedProviderDispatch(prepared);
    } catch (error) {
      await this.failPreparedTurnDispatch(prepared, error);
    }
  }

  /** Initialize pipeline state after the parent-turn transaction has committed. */
  private async prepareRuntimeDispatch(prepared: PreparedTurnDispatch): Promise<void> {
    const { lease, request } = prepared;
    this.turnFinalizer.resetStreamingText(lease.threadId);
    this.parentAssistantText.start(lease.turnExecutionId, request.turnId);
    this.turnAdmissions.markDispatchActive(lease.threadId);
    this.emitProviderEvent(prepared.provider, {
      type: AgentEventType.TurnStarted,
      threadId: lease.threadId,
      turnExecutionId: lease.turnExecutionId,
    } satisfies AgentEvent);
    await this.ensureTurnFileTracking(lease.threadId, prepared.cwd);
    await this.fileTrackingRefCaptureByThread.get(lease.threadId);
    this.narrativeStore.beginTurn(lease.threadId);
    this.narrativeStore.resetTurnCounters(lease.threadId);
    this.lastContextByThread.set(lease.threadId, prepared.contextSeed);
    if (prepared.contextWindow) this.lastContextWindowByThread.set(lease.threadId, prepared.contextWindow);
  }

  /** Activate command-specific state only after the runtime can still dispatch. */
  private async activatePreparedCommandEffect(prepared: PreparedTurnDispatch): Promise<void> {
    if (!this.ownsTurnAdmission(prepared.lease)) {
      this.releaseTurnAdmission(prepared.lease);
      return;
    }
    await this.turnAdmissions.activateCommandEffect(prepared.commandEffect);
    if (!this.ownsTurnAdmission(prepared.lease)) {
      await this.turnAdmissions.rollbackCommandEffect(prepared.commandEffect);
      this.releaseTurnAdmission(prepared.lease);
    }
  }

  /** Register retry state and issue the initial provider send. */
  private async startPreparedProviderDispatch(prepared: PreparedTurnDispatch): Promise<void> {
    if (!this.ownsTurnAdmission(prepared.lease)) return;
    this.applyThreadControlLease(prepared.threadControl);
    const dispatch = this.createRetryDispatch(prepared);
    this.turnRetryDispatchByThread.set(prepared.lease.threadId, dispatch);
    this.retryingThreads.add(prepared.lease.threadId);
    await this.sendPreparedDispatch(prepared.lease.threadId, dispatch);
  }

  /** Construct runtime-owned retry state from an immutable dispatch package. */
  private createRetryDispatch(prepared: PreparedTurnDispatch) {
    return {
      attempt: 1,
      retryInFlight: false,
      sendTurnInFlight: false,
      dispatchStarted: false,
      sessionName: prepared.request.sessionId,
      sourceTurnId: prepared.request.turnId,
      resolvedProvider: prepared.provider,
      effectiveProvider: prepared.providerId,
      threadControl: prepared.threadControl,
      turnRequest: prepared.request,
      commandEffect: prepared.commandEffect,
      mutationReservationToken: prepared.lease.mutationReservationToken,
      generation: prepared.lease.generation,
    };
  }

  /** Apply the provider-neutral thread-control directive selected during admission. */
  private applyThreadControlLease(directive: ThreadControlLeaseDirective | null): void {
    if (!directive) return;
    if (directive.kind === "revoke") {
      this.threadControlMcp?.revoke(directive.sessionId);
      return;
    }
    this.threadControlMcp?.activate({ ...directive, eligible: true });
  }

  /** Send one attempt and hand only retryable failures to the existing retry owner. */
  private async sendPreparedDispatch(
    threadId: string,
    dispatch: ReturnType<AgentService["createRetryDispatch"]>,
  ): Promise<void> {
    dispatch.sendTurnInFlight = true;
    try {
      await this.sendProviderTurn(threadId, dispatch);
      dispatch.sendTurnInFlight = false;
      logger.info("Message sent via provider", {
        threadId,
        session: dispatch.sessionName,
        model: dispatch.turnRequest.model,
      });
    } catch (error) {
      dispatch.sendTurnInFlight = false;
      await this.handleInitialDispatchFailure(threadId, dispatch, error);
    }
  }

  /** Invoke a provider only while its AgentService mutation lease remains current. */
  private async sendProviderTurn(
    threadId: string,
    dispatch: ReturnType<AgentService["createRetryDispatch"]>,
  ): Promise<void> {
    if (typeof dispatch.turnRequest.turnExecutionId !== "string") {
      throw new Error("Turn execution identity required at provider dispatch boundary");
    }
    const send = this.mutationReservations.runIfOwned(
      threadId,
      dispatch.mutationReservationToken,
      "activeTurn",
      () => {
        dispatch.dispatchStarted = true;
        return dispatch.resolvedProvider.sendTurn(dispatch.turnRequest);
      },
    );
    if (send === undefined) return;
    await send;
  }

  /** Deliver service-generated lifecycle events through the provider runtime boundary. */
  private emitProviderEvent(provider: IAgentProvider, event: AgentEvent): void {
    const runtimeEvent = { event };
    const emitter = provider as unknown as { emit?: (eventName: "event", value: typeof runtimeEvent) => boolean };
    if (typeof emitter.emit === "function") {
      emitter.emit.call(provider, "event", runtimeEvent);
      return;
    }
    this.providerEventIngress.acceptProviderRuntime(provider.id, runtimeEvent);
  }

  /** Retry a failed initial dispatch once when the error policy permits it. */
  private async handleInitialDispatchFailure(
    threadId: string,
    dispatch: ReturnType<AgentService["createRetryDispatch"]>,
    error: unknown,
  ): Promise<void> {
    if (!this.mutationReservations.owns(threadId, dispatch.mutationReservationToken, "activeTurn")) return;
    if (await this.runTransientTurnRetry(threadId, error)) return;
    await this.giveUpTransientTurnRetry(threadId, error);
  }

  /** Terminalize setup failures while preserving an explicit user-stop winner. */
  private async failPreparedTurnDispatch(prepared: PreparedTurnDispatch, error: unknown): Promise<void> {
    const runtime = this.turnRuntime.snapshot(prepared.lease.threadId);
    const cancelled = runtime?.turnExecutionId === prepared.lease.turnExecutionId
      && runtime.phase === "cancelled"
      && !this.mutationReservations.owns(prepared.lease.threadId, prepared.lease.mutationReservationToken, "activeTurn");
    if (cancelled) {
      await this.turnAdmissions.rollbackCommandEffect(prepared.commandEffect);
      this.releaseTurnAdmission(prepared.lease);
      return;
    }
    if (this.turnRuntime.terminalize(prepared.lease.threadId, prepared.lease.turnExecutionId, "errored")) {
      await (this.finalizeTerminalTurn(prepared.lease.threadId, "errored", "send setup failure") ?? Promise.resolve());
      this.disarmTurnRetryWindow(prepared.lease.threadId);
      this.trackSessionEnded(prepared.lease.threadId, prepared.lease.turnExecutionId);
    }
    this.releaseTurnAdmission(prepared.lease);
    await this.turnAdmissions.rollbackCommandEffect(prepared.commandEffect);
    throw error;
  }

  /** Start a prepared first-turn command and return the authoritative runtime snapshot. */
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

  /** Dispatch a queued Turn that the automatic Setup lifecycle claimed after commit. */
  async dispatchQueuedAutomaticTurn(
    submission: WorkspaceEnvironmentQueuedTurnSubmission,
  ): Promise<WorkspaceEnvironmentAutomaticSetupDispatch> {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const send = this.sendMessage({
      ...this.turnAdmissions.queuedCommand(submission),
      onTurnStarted: (runtime) => {
        this.automaticQueuedTurnCompletionResolvers.set(runtime.turnExecutionId!, resolveCompletion);
        resolveStarted();
      },
    });
    await Promise.race([
      started,
      send.then(() => {
        throw new Error(`Queued Turn finished without runtime dispatch: ${submission.threadId}`);
      }),
    ]);
    return { completion };
  }

  /** Provision a thread through its coordinator, then start its generic first-turn command. */
  async createAndSend(command: CreateAndSendCommand): Promise<Thread & { runtimeSnapshot: TurnRuntimeSnapshot; warnings?: string[] }> {
    const created = await this.threadCreation.createInitialTurn(command);
    if (created.kind === "queued") {
      return {
        ...created.thread,
        runtimeSnapshot: { threadId: created.thread.id, turnExecutionId: null, phase: "idle" },
        ...(created.thread.warnings?.length ? { warnings: created.thread.warnings } : {}),
      };
    }
    const runtimeSnapshot = await this.sendInitialMessageAndSnapshot(created.command, (err) => {
      logger.error("createAndSend initial send failed", {
        threadId: created.thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return {
      ...created.thread,
      runtimeSnapshot,
      ...(created.thread.warnings?.length ? { warnings: created.thread.warnings } : {}),
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

  /** Stop exact active turn, preserving provider failure as retryable RPC error. */
  private async stopSessionInternal(threadId: string): Promise<AgentStopResult> {
    const prepared = this.prepareStop(threadId);
    if (!this.isRunning(prepared.runtime)) return this.alreadyTerminal(prepared);
    const checkpointResult = this.finishStopCheckpoint(prepared);
    if (checkpointResult) return checkpointResult;
    await this.stopProviderForTurn(prepared);
    return this.finalizeStoppedTurn(prepared);
  }

  private prepareStop(threadId: string): PreparedStop {
    const reservationToken = this.activeMutationReservations.get(threadId);
    const runtime = this.turnRuntime.snapshot(threadId) ?? this.idleRuntime(threadId);
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    const reservation = reservationToken ? this.mutationReservations.get(threadId) : undefined;
    const dispatchState = this.stopDispatchState(runtime, dispatch?.dispatchStarted, reservation?.state);
    if (reservationToken) this.mutationReservations.transition(threadId, reservationToken, "activeTurn", "stopping");
    return {
      threadId,
      sessionId: `mcode-${threadId}`,
      providerId: this.runtimePersistence.load(threadId)?.provider as ProviderId | undefined,
      reservationToken,
      dispatchState,
      runtime,
    };
  }

  private stopDispatchState(
    runtime: TurnRuntimeSnapshot,
    dispatched: boolean | undefined,
    reservationState: string | undefined,
  ): AgentStopResult["dispatchState"] {
    if (!this.isRunning(runtime)) return "unknown";
    if (dispatched) return "dispatched";
    return reservationState === "activeTurn" || reservationState === "stopping" || reservationState === undefined
      ? "not-dispatched"
      : "unknown";
  }

  private finishStopCheckpoint(prepared: PreparedStop): AgentStopResult | null {
    const executionId = prepared.runtime.turnExecutionId!;
    if (this.parentAssistantText.finish(executionId)) return null;
    if (!this.parentAssistantText.hasStoppedForStorageFailure(executionId)) {
      this.stopForParentAssistantTextCheckpointFailure({
        type: AgentEventType.TextDelta,
        threadId: prepared.threadId,
        turnExecutionId: executionId,
        delta: "",
        isFinalResponse: true,
      }, "Assistant text recovery remained unavailable during a user stop");
    }
    return this.alreadyTerminal({ ...prepared, runtime: this.turnRuntime.snapshot(prepared.threadId) ?? prepared.runtime });
  }

  private async stopProviderForTurn(prepared: PreparedStop): Promise<void> {
    const descendantStop = this.featureEffects?.stopDescendants(prepared.threadId);
    if (descendantStop) await descendantStop;
    if (prepared.dispatchState !== "not-dispatched") await this.stopProvider(prepared);
    this.disarmTurnRetryWindow(prepared.threadId);
  }

  private async stopProvider(prepared: PreparedStop): Promise<void> {
    if (!prepared.providerId) return;
    try {
      await this.providerRegistry.resolve(prepared.providerId).stopSession(prepared.sessionId);
    } catch (error) {
      if (!this.isRunning(this.turnRuntime.snapshot(prepared.threadId) ?? this.idleRuntime(prepared.threadId))) return;
      if (prepared.reservationToken) {
        this.mutationReservations.transition(prepared.threadId, prepared.reservationToken, "stopping", "activeTurn");
      }
      this.retryingThreads.delete(prepared.threadId);
      this.endedSuppressionThreads.delete(prepared.threadId);
      logger.warn("Provider stopSession failed", { threadId: prepared.threadId, providerId: prepared.providerId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async finalizeStoppedTurn(prepared: PreparedStop): Promise<AgentStopResult> {
    const current = this.turnRuntime.snapshot(prepared.threadId) ?? prepared.runtime;
    if (!this.ownsStoppedExecution(current, prepared.runtime.turnExecutionId)) return this.alreadyTerminal({ ...prepared, runtime: current });
    if (!this.turnRuntime.terminalize(prepared.threadId, prepared.runtime.turnExecutionId!, "cancelled")) {
      return this.alreadyTerminal({ ...prepared, runtime: this.turnRuntime.snapshot(prepared.threadId) ?? this.idleRuntime(prepared.threadId) });
    }
    await (this.finalizeTerminalTurn(prepared.threadId, "cancelled", "user stop") ?? Promise.resolve());
    this.disarmTurnRetryWindow(prepared.threadId);
    this.clearTurnEndedState(prepared.threadId);
    this.runtimePersistence.setRuntimeStatus(prepared.threadId, "paused");
    broadcast("thread.status", { threadId: prepared.threadId, status: "paused" });
    this.trackSessionEnded(prepared.threadId, prepared.runtime.turnExecutionId);
    return {
      threadId: prepared.threadId,
      turnExecutionId: prepared.runtime.turnExecutionId,
      snapshot: this.turnRuntime.snapshot(prepared.threadId) ?? this.idleRuntime(prepared.threadId),
      status: "cancelled",
      dispatchState: prepared.dispatchState,
    };
  }

  private alreadyTerminal(prepared: PreparedStop): AgentStopResult {
    this.disarmTurnRetryWindow(prepared.threadId);
    return {
      threadId: prepared.threadId,
      turnExecutionId: prepared.runtime.turnExecutionId,
      snapshot: prepared.runtime,
      status: "already-terminal",
      dispatchState: prepared.dispatchState,
    };
  }

  private idleRuntime(threadId: string): TurnRuntimeSnapshot {
    return { threadId, turnExecutionId: null, phase: "idle" };
  }

  private isRunning(runtime: TurnRuntimeSnapshot): boolean {
    return runtime.turnExecutionId !== null && (runtime.phase === "running" || runtime.phase === "finalizing");
  }

  private ownsStoppedExecution(runtime: TurnRuntimeSnapshot, executionId: string | null): boolean {
    return this.isRunning(runtime) && runtime.turnExecutionId === executionId;
  }

  /** Stop the active turn and discard any pooled provider session for a deleted thread. */
  async teardownSession(threadId: string): Promise<void> {
    const sessionId = `mcode-${threadId}`;
    const thread = this.runtimePersistence.load(threadId);
    const providerId = thread?.provider as ProviderId | undefined;
    const wasActive = this.activeSessionIds.has(threadId);

    if (wasActive) {
      await this.stopSession(threadId);
    }

    if (!providerId) return;
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

  /** Number of currently active sessions. */
  private activeCount(): number {
    return this.activeSessionIds.size;
  }

  /** Atomically reserve the first accepted send for one thread. */
  private reserveTurn(threadId: string): boolean {
    if (this.activeSessionIds.has(threadId)) return false;
    this.activeSessionIds.add(threadId);
    return true;
  }

  /** Get all currently active thread IDs. */
  private activeThreadIds(): string[] {
    return this.turnRuntime.runningThreadIds();
  }

  /** Return authoritative per-thread runtime snapshots for reconnect hydration. */
  private runtimeSnapshots(): TurnRuntimeSnapshot[] {
    return this.turnRuntime.snapshots().map((snapshot) => ({
      ...snapshot,
      savingStatus: snapshot.turnExecutionId
        ? this.parentAssistantText.durabilityMode(snapshot.turnExecutionId)
        : null,
    }));
  }

  /** Continue one active response after the user accepts that subsequent text is not recoverable. */
  private continueWithoutSaving(executionId: string): void {
    if (!this.parentAssistantText.continueWithoutSaving(executionId)) {
      throw new Error("Unsaved continuation is unavailable for this execution");
    }
  }

  /** Normalize one provider event once at the production provider boundary. */
  private prepareProviderEvent(event: AgentEvent): AgentEvent | undefined {
    if (this.preparedProviderEvents.has(event as object)) {
      return this.preparedProviderEvents.get(event as object);
    }
    const normalized = this.prepareNormalizedProviderEvent(
      this.turnRuntime.normalizeEvent(event),
    );
    this.preparedProviderEvents.set(event as object, normalized);
    return normalized;
  }

  private prepareNormalizedProviderEvent(event: AgentEvent | undefined): AgentEvent | undefined {
    if (!event) return undefined;
    const sanitized = this.browserNarrativeEventSanitizer.sanitize(event);
    if (sanitized.type === AgentEventType.ToolUse && sanitized.toolName === "Agent") {
      return {
        ...sanitized,
        subagentPresentation: createSubagentPresentation(sanitized.toolInput, sanitized.toolCallId),
      };
    }
    if (sanitized.type !== AgentEventType.ToolResult || !sanitized.toolInput) return sanitized;
    return this.prepareAgentToolResult(sanitized);
  }

  private prepareAgentToolResult(event: Extract<AgentEvent, { type: typeof AgentEventType.ToolResult }>): AgentEvent {
    const bufferedAgent = this.narrativeStore.getBufferedToolCalls(event.threadId)
      .find((toolCall) => toolCall.toolCallId === event.toolCallId && toolCall.toolName === "Agent");
    if (!bufferedAgent) return event;
    return {
      ...event,
      subagentPresentation: createSubagentPresentation({
        ...bufferedAgent._rawToolInput,
        ...event.toolInput,
      }, event.toolCallId),
    };
  }

  /**
   * Track that a session has ended. No-ops if the session was not active.
   * If this was the last active session, signals idle to MemoryPressureService.
   */
  private trackSessionEnded(threadId: string, executionId?: string | null): void {
    if (this.activeSessionIds.delete(threadId)) {
      this.memoryPressureService.markIdle(threadId);
    }
    if (executionId) {
      const resolve = this.automaticQueuedTurnCompletionResolvers.get(executionId);
      if (resolve) {
        this.automaticQueuedTurnCompletionResolvers.delete(executionId);
        resolve();
      }
    }
    const reservationToken = this.turnRetryDispatchByThread.get(threadId)?.mutationReservationToken;
    this.releaseMutationReservation(threadId, reservationToken);
  }

  /** Clear resources that belong to a turn after terminal handling owns the outcome. */
  private clearTurnEndedState(threadId: string): void {
    this.threadControlMcp?.revoke(`mcode-${threadId}`);
    this.scopedPreGrant.clear(threadId);
    this.featureEffects?.clearTurn(threadId);
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
  private shouldSuppressTransientTurnError(threadId: string, errorMessage: string): boolean {
    return this.retryingThreads.has(threadId) && this.turnErrorPolicy.classify(errorMessage) === "transient";
  }

  /**
   * Whether a provider-emitted `Ended` for `threadId` should be swallowed because
   * it trails a just-suppressed transient `Error` or an explicit user stop. Keeps
   * a failed attempt's teardown from flashing before retry, and keeps a provider
   * stop's synchronous teardown event from terminalizing the turn as interrupted
   * before stopSession can durably record cancelled. Consulted by the composition
   * root before broadcasting and by the `Ended` cleanup path.
   */
  private shouldSuppressTurnEnded(threadId: string): boolean {
    if (this.endedSuppressionThreads.has(threadId)) return true;
    if (this.mutationReservations.get(threadId)?.state === "stopping") return true;
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
  private shouldSuppressTurnComplete(threadId: string): boolean {
    return this.endedSuppressionThreads.has(threadId);
  }

  /** Suppress a matching provider terminal event while an explicit stop owns the turn. */
  private shouldSuppressStoppingTerminal(threadId: string, turnExecutionId?: string | null): boolean {
    if (this.mutationReservations.get(threadId)?.state !== "stopping") return false;
    return this.turnRuntime.snapshot(threadId)?.turnExecutionId === turnExecutionId;
  }

  /**
   * Clears the transient-retry window once the turn has finished or given up.
   */
  private disarmTurnRetryWindow(
    threadId: string,
    identity?: RetryDispatchIdentity,
    preserveCommandEffect = false,
  ): boolean {
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    if (identity && (!dispatch
      || dispatch.mutationReservationToken !== identity.mutationReservationToken
      || dispatch.generation !== identity.generation)) {
      return false;
    }
    this.retryingThreads.delete(threadId);
    this.endedSuppressionThreads.delete(threadId);
    this.turnRetryDispatchByThread.delete(threadId);
    if (!preserveCommandEffect) this.turnAdmissions.completeCommandEffect(dispatch?.commandEffect ?? null);
    return true;
  }

  /**
   * Starts finalization once for a terminal turn path. Provider streams can emit
   * both Error/TurnComplete and a trailing Ended for the same turn.
   */
  private finalizeMaterializedTurn(
    threadId: string,
    outcome: TurnOutcome,
    source: string,
  ): Promise<boolean> | null {
    if (this.terminalFinalizedThreads.has(threadId)) return null;
    this.terminalFinalizedThreads.add(threadId);
    const finalizedExecutionId = this.turnRuntime.snapshot(threadId)?.turnExecutionId;
    const finalize = this.turnFileEffects.finalize(
      threadId,
      outcome,
      finalizedExecutionId ?? undefined,
      source,
    );
    void finalize.finally(() => {
      if (finalizedExecutionId) {
        this.parentAssistantText.discard(finalizedExecutionId);
        this.unclassifiedAssistantTextStartByExecution.delete(finalizedExecutionId);
        this.turnEventPipeline?.discard(threadId, finalizedExecutionId ?? undefined);
        this.parentNarrativeRecovery.clear(finalizedExecutionId);
      }
      if (this.finalResponseExecutionByThread.get(threadId) === finalizedExecutionId) {
        this.finalResponseExecutionByThread.delete(threadId);
      }
    });
    return finalize;
  }

  /** Route every terminal source through the pipeline fence once it is available. */
  private finalizeTerminalTurn(
    threadId: string,
    outcome: TurnOutcome,
    source: string,
  ): Promise<boolean> | null {
    const executionId = this.turnRuntime.snapshot(threadId)?.turnExecutionId ?? undefined;
    if (!this.turnEventPipeline) return this.finalizeMaterializedTurn(threadId, outcome, source);
    return this.turnEventPipeline.finalizeTurn({
      threadId,
      executionId,
      outcome,
      source: this.pipelineTerminalSource(source),
    });
  }

  /** Materialize a fenced terminal command without allowing the pipeline to reach AgentService internals. */
  private finalizePipelineTurn(command: FinalizeTurnCommand): Promise<boolean> | null {
    return this.finalizeMaterializedTurn(command.threadId, command.outcome, command.source);
  }

  /** Collapse legacy terminal labels into the pipeline's explicit source vocabulary. */
  private pipelineTerminalSource(source: string): FinalizeTurnCommand["source"] {
    if (source === "user stop") return "user-stop";
    if (source === "shutdown") return "shutdown";
    if (source.includes("checkpoint failure")) return "checkpoint-failure";
    return "provider";
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
    if (!this.shouldRetryDispatch(dispatch, triggerErr)) return false;
    const identity = this.retryDispatchIdentity(dispatch);
    dispatch.retryInFlight = true;
    this.endedSuppressionThreads.add(threadId);
    try {
      if (!await this.prepareTransientRetry(threadId, dispatch, identity, triggerErr)) return false;
      return this.dispatchTransientRetry(threadId, dispatch, identity);
    } finally {
      this.clearTransientRetryInFlight(threadId, identity, dispatch);
    }
  }

  /** Return whether this dispatch can enter a new transient retry attempt. */
  private shouldRetryDispatch(
    dispatch: ReturnType<AgentService["getCurrentRetryDispatch"]>,
    error: unknown,
  ): dispatch is NonNullable<ReturnType<AgentService["getCurrentRetryDispatch"]>> {
    return dispatch !== null
      && !dispatch.retryInFlight
      && this.turnErrorPolicy.shouldRetry(error, dispatch.attempt);
  }

  /** Restore the provider and runtime state needed for a fresh retry attempt. */
  private async prepareTransientRetry(
    threadId: string,
    dispatch: NonNullable<ReturnType<AgentService["getCurrentRetryDispatch"]>>,
    identity: RetryDispatchIdentity,
    triggerErr: unknown,
  ): Promise<boolean> {
    await this.evictRetrySession(threadId, dispatch);
    if (!this.getCurrentRetryDispatch(threadId, identity)) return false;
    this.applyThreadControlLease(dispatch.threadControl);
    this.clearRetrySessionCursor(threadId);
    if (!this.getCurrentRetryDispatch(threadId, identity)) return false;
    this.logTransientRetry(threadId, dispatch, triggerErr);
    dispatch.attempt += 1;
    dispatch.turnRequest = { ...dispatch.turnRequest, deliveryAttempt: dispatch.attempt, resumeFrom: undefined };
    if (!this.resetParentAssistantTextForRetry(threadId, dispatch.turnRequest.turnExecutionId)) return false;
    this.endedSuppressionThreads.delete(threadId);
    return true;
  }

  /** Evict one pooled session without turning an eviction failure into a fatal send failure. */
  private async evictRetrySession(
    threadId: string,
    dispatch: NonNullable<ReturnType<AgentService["getCurrentRetryDispatch"]>>,
  ): Promise<void> {
    try {
      await this.evictPooledSession(dispatch.resolvedProvider, dispatch.sessionName);
    } catch (error) {
      logger.warn("Failed to discard pooled session before retry", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Clear a stale native cursor before retrying against a fresh provider session. */
  private clearRetrySessionCursor(threadId: string): void {
    this.sessionCursors.clearForRetry(threadId);
  }

  /** Record a bounded retry with the original error available for diagnosis. */
  private logTransientRetry(
    threadId: string,
    dispatch: NonNullable<ReturnType<AgentService["getCurrentRetryDispatch"]>>,
    error: unknown,
  ): void {
    logger.warn("Transient send failed; retried against a fresh session", {
      threadId,
      attempt: dispatch.attempt,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** Send a fresh retry and recurse only while the retry policy still allows it. */
  private async dispatchTransientRetry(
    threadId: string,
    dispatch: NonNullable<ReturnType<AgentService["getCurrentRetryDispatch"]>>,
    identity: RetryDispatchIdentity,
  ): Promise<boolean> {
    dispatch.sendTurnInFlight = true;
    try {
      const sent = this.mutationReservations.runIfOwned(
        threadId,
        identity.mutationReservationToken,
        "activeTurn",
        () => {
          dispatch.dispatchStarted = true;
          return dispatch.resolvedProvider.sendTurn(dispatch.turnRequest);
        },
      );
      if (sent === undefined) return false;
      await sent;
      return true;
    } catch (error) {
      return this.retryAfterRetryFailure(threadId, dispatch, identity, error);
    } finally {
      dispatch.sendTurnInFlight = false;
    }
  }

  /** Recurse through the bounded retry policy after a retry attempt fails. */
  private retryAfterRetryFailure(
    threadId: string,
    dispatch: NonNullable<ReturnType<AgentService["getCurrentRetryDispatch"]>>,
    identity: RetryDispatchIdentity,
    error: unknown,
  ): Promise<boolean> {
    if (!this.getCurrentRetryDispatch(threadId, identity)) return Promise.resolve(false);
    return this.turnErrorPolicy.shouldRetry(error, dispatch.attempt)
      ? this.runTransientTurnRetry(threadId, error, identity)
      : Promise.resolve(false);
  }

  /** Clear an in-flight retry flag only when the same generation still owns it. */
  private clearTransientRetryInFlight(
    threadId: string,
    identity: RetryDispatchIdentity,
    dispatch: NonNullable<ReturnType<AgentService["getCurrentRetryDispatch"]>>,
  ): void {
    if (this.getCurrentRetryDispatch(threadId, identity)) dispatch.retryInFlight = false;
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
    const commandEffect = dispatch.commandEffect;

    this.disarmTurnRetryWindow(threadId, this.retryDispatchIdentity(dispatch), true);
    const wasActive = this.activeSessionIds.delete(threadId);
    if (wasActive) {
      this.memoryPressureService.markIdle(threadId);
    }
    this.releaseMutationReservation(threadId, dispatch.mutationReservationToken);
    // Roll the just-installed command side effect back so a failed send doesn't
    // leave a hidden gate (e.g. a Stop-hook goal) active on the next turn. Runs
    // only here, after the retry budget is spent; transient retries keep it.
    await this.turnAdmissions.rollbackCommandEffect(commandEffect);
    const rawMessage = err instanceof Error ? err.message : String(err);
    const errorMessage = this.normalizeProviderError(rawMessage, effectiveProvider);
    const turnExecutionId = dispatch.turnRequest.turnExecutionId;
    logger.error("Provider send failed", { threadId, error: rawMessage });

    try {
      const resolvedProvider = this.providerRegistry.resolve(effectiveProvider);
      this.emitProviderEvent(resolvedProvider, {
        type: "error",
        threadId,
        turnExecutionId,
        error: errorMessage,
      } satisfies AgentEvent);
      this.emitProviderEvent(resolvedProvider, {
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

    this.turnAdmissions.markDispatchErrored(threadId);
  }

  /** Subscribe to provider ingress after the service has assembled its event pipeline. */
  private initializeProviderEvents(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.memoryPressureService.onPressureChange((snapshot) => {
      this.handleMemoryPressure(snapshot);
    });

    this.providerEventIngress.start(this.providerRegistry, this.pipeline());
  }

  /** Build the feature-owned ingress queue after provider handlers are registered. */
  private pipeline(): TurnEventPipeline {
    if (this.turnEventPipeline) return this.turnEventPipeline;
    const lifecycle: TurnLifecycleControl = {
      normalize: (event) => this.prepareProviderEvent(event),
      finalize: (command) => this.finalizePipelineTurn(command),
    };
    const application: TurnEventApplication = {
      apply: (input, event, publish) => this.applyQueuedTurnEvent(input, event, publish),
      observeFileMutation: (event) => {
        this.turnFileEffects.observeProviderMutation(event);
      },
      rejectForQueueCapacity: (event) => this.stopForParentAssistantTextCheckpointFailure(
        event,
        "Assistant text event retention capacity reached",
      ),
      previousFileFinalization: (threadId) => this.turnFileEffects.previousFinalization(threadId),
      beginResumedFileTracking: (threadId) => this.turnFileEffects.beginResumed(threadId),
      observeToolUse: (event) => this.turnFileEffects.observeToolUse(event),
      observeToolResult: (event) => this.turnFileEffects.observeToolResult(event),
    };
    this.turnEventPipeline = new TurnEventPipeline(lifecycle, application);
    return this.turnEventPipeline;
  }

  /** Apply one queue-admitted event after parent assistant text reaches its durable checkpoint. */
  private applyQueuedTurnEvent(input: ProviderEventIngressEvent, event: AgentEvent, publish: boolean): boolean {
    const queued = this.queueVisibleAssistantText(input, event, publish);
    if (queued !== undefined) return queued;
    if (publish && !this.parentAssistantText.prepareSemanticBoundary(event.threadId)) {
      return this.parentAssistantText.hasThreadStoppedForStorageFailure(event.threadId);
    }
    return this.normalizedTurnEventApplication.apply(input, event, publish);
  }

  /** Keep renderer-visible assistant text behind its canonical checkpoint before applying it. */
  private queueVisibleAssistantText(
    input: ProviderEventIngressEvent,
    event: AgentEvent,
    publish: boolean,
  ): boolean | undefined {
    if (!publish || !this.eventPublication.isBound() || event.type !== AgentEventType.TextDelta) return undefined;
    if (event.isFinalResponse === false || !event.turnExecutionId) return undefined;
    const queued = this.queueParentAssistantText(event, () => {
      void this.normalizedTurnEventApplication.apply(input, event, true);
    });
    if (queued === "blocked") return false;
    return queued;
  }

  /** Return narrow runtime capabilities for server-owned diagnostics and recovery infrastructure. */
  runtimeAccess(): AgentRuntimeAccess {
    return {
      activeCount: () => this.activeCount(),
      activeThreadIds: () => this.activeThreadIds(),
      runtimeSnapshots: () => this.runtimeSnapshots(),
    };
  }

  /** Publish one unfinished deterministic assistant prefix for the private reliability harness. */
  private streamReliabilityAssistantText(threadId: string): { threadId: string; executionId: string; text: string } {
    if (!this.eventPublication.isBound()) {
      throw new Error("Agent event publication is unavailable for reliability streaming");
    }
    if (!this.reserveTurn(threadId)) throw new Error(`Thread ${threadId} already has an active agent session`);

    const text = "Durable assistant prefix for restart recovery.";
    const executionId = this.turnRuntime.start(threadId).turnExecutionId!;
    try {
      this.conversationProjection.startReliabilityTurn(threadId, executionId);
      const event: AgentEvent = {
        type: AgentEventType.TextDelta,
        threadId,
        turnExecutionId: executionId,
        delta: text,
        isFinalResponse: true,
      };
      if (!this.queueParentAssistantText(event, () => {
        this.turnFinalizer.appendStreamingText(threadId, text);
        this.eventPublication.publish(event);
      })) {
        throw new Error("Reliability assistant text could not be queued");
      }
      if (!this.parentAssistantText.flush(executionId)) {
        throw new Error("Reliability assistant text could not be checkpointed");
      }
      return { threadId, executionId, text };
    } catch (error) {
      if (this.activeSessionIds.delete(threadId)) this.memoryPressureService.markIdle(threadId);
      throw error;
    }
  }

  /** Queue visible candidate response text until its durable chunk commits. */
  private queueParentAssistantText(
    event: Extract<AgentEvent, { type: typeof AgentEventType.TextDelta }>,
    publish: () => void,
  ): boolean | "blocked" | undefined {
    return this.parentAssistantText.queueText(
      event,
      publish,
      (reason) => this.stopForParentAssistantTextCheckpointFailure(event, reason),
    );
  }

  private resetParentAssistantTextForRetry(threadId: string, executionId: string): boolean {
    if (this.parentDurability.loadCheckpoint(executionId)) {
      try {
        if (!this.parentAssistantText.resetForRetry(executionId)) return false;
      } catch (error) {
        logger.warn("Assistant text checkpoint could not reset before retry", {
          threadId,
          turnExecutionId: executionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }
    this.unclassifiedAssistantTextStartByExecution.delete(executionId);
    this.turnFinalizer.resetStreamingText(threadId);
    return true;
  }

  /** Move provisional assistant text to narration without leaving two durable recovery owners. */
  private classifyUnclassifiedAssistantTextAsNarration(
    event: Extract<AgentEvent, { type: typeof AgentEventType.AssistantMessageBoundary }>,
  ): boolean {
    const executionId = event.turnExecutionId;
    if (!executionId) {
      this.narrativeStore.closeOpenThought(event.threadId);
      this.turnFinalizer.resetStreamingText(event.threadId);
      return true;
    }
    const firstSequence = this.unclassifiedAssistantTextStartByExecution.get(executionId);
    if (!firstSequence) {
      this.narrativeStore.closeOpenThought(event.threadId);
      this.turnFinalizer.resetStreamingText(event.threadId);
      return true;
    }
    if (this.parentAssistantText.durabilityMode(executionId) === "unsaved") {
      const stagedNarration = this.narrativeStore.stageNarrationSegment(
        event.threadId,
        this.turnFinalizer.getStreamingText(event.threadId),
      );
      if (stagedNarration) this.narrativeStore.applyStagedNarrationSegment(event.threadId, stagedNarration);
      this.parentAssistantText.resetSequence(executionId);
      this.unclassifiedAssistantTextStartByExecution.delete(executionId);
      this.turnFinalizer.resetStreamingText(event.threadId);
      return true;
    }
    const text = this.parentAssistantText.checkpoints.restoreChunks(executionId)
      .filter((chunk) => chunk.lastSequence >= firstSequence)
      .map((chunk) => chunk.text)
      .join("");
    const stagedNarration = this.narrativeStore.stageNarrationSegment(event.threadId, text);
    let confirmRecoveryCheckpoint: (() => void) | undefined;
    try {
      this.db.transaction(() => {
        const recoveryCheckpoint = this.parentNarrativeRecovery.prepareCheckpoint(
          event,
          stagedNarration
            ? this.narrativeStore.recoverySnapshotWithStagedNarration(event.threadId, stagedNarration)
            : undefined,
        );
        recoveryCheckpoint?.persist();
        if (!this.parentAssistantText.checkpoints.resetInTransaction(executionId)) {
          throw new Error(`Unclassified assistant text checkpoint was not reset: ${executionId}`);
        }
        confirmRecoveryCheckpoint = recoveryCheckpoint?.confirm;
      })();
    } catch (error) {
      this.stopForNarrativeRecoveryCheckpointFailure(event, error);
      return false;
    }
    this.parentAssistantText.checkpoints.discardRecoveryJournal(executionId);
    this.parentAssistantText.discard(executionId);
    confirmRecoveryCheckpoint?.();
    if (stagedNarration) this.narrativeStore.applyStagedNarrationSegment(event.threadId, stagedNarration);
    this.unclassifiedAssistantTextStartByExecution.delete(executionId);
    this.turnFinalizer.resetStreamingText(event.threadId);
    return true;
  }

  /** Persist one post-terminal hook only after its parent turn's finalizer verified durability. */
  private persistVerifiedLateHook(
    threadId: string,
    hook: Parameters<PostTerminalHookCompletionEffect["schedule"]>[1],
  ): void {
    this.lateHookCompletions.schedule(threadId, hook, this.turnFileEffects.previousFinalization(threadId));
  }

  /** Stop the provider when visible assistant text cannot be made durable. */
  private stopForParentAssistantTextCheckpointFailure(event: AgentEvent, reason: string): void {
    const executionId = event.turnExecutionId;
    if (!executionId || !this.isActiveRuntimeExecution(this.turnRuntime.snapshot(event.threadId) ?? null, executionId)) return;
    logger.error("Parent assistant text checkpoint failed", {
      threadId: event.threadId,
      turnExecutionId: executionId,
      reason,
    });
    this.requestProviderStopAfterCheckpointFailure(event.threadId, executionId);
    this.disarmTurnRetryWindow(event.threadId);
  }

  /** Stop the provider when a visible structured narrative record cannot commit. */
  private stopForNarrativeRecoveryCheckpointFailure(event: AgentEvent, error: unknown): void {
    const executionId = event.turnExecutionId;
    if (!executionId || !this.isActiveRuntimeExecution(this.turnRuntime.snapshot(event.threadId) ?? null, executionId)) return;
    logger.error("Parent narrative recovery checkpoint failed", {
      threadId: event.threadId,
      turnExecutionId: executionId,
      error: error instanceof Error ? error.message : String(error),
    });
    this.requestProviderStopAfterCheckpointFailure(event.threadId, executionId);
    this.disarmTurnRetryWindow(event.threadId);
  }

  /** Request a provider stop, then wait for its terminal event to state the outcome. */
  private requestProviderStopAfterCheckpointFailure(threadId: string, executionId: string): void {
    const providerId = this.runtimePersistence.load(threadId)?.provider as ProviderId | undefined;
    if (!providerId) return;
    const provider = this.providerRegistry.resolve(providerId);
    void Promise.resolve(provider.stopSession(`mcode-${threadId}`)).catch((error) => {
      logger.warn("Provider stop failed after checkpoint failure", {
        threadId,
        turnExecutionId: executionId,
        error: error instanceof Error ? error.message : String(error),
      });
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
   * opaque upstream 5xx payloads, etc.).
   */
  private normalizeProviderError(message: string, provider: string): string {
    return normalizeAgentProviderError(provider, message);
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
      subagentPresentation?: import("@mcode/contracts").SubagentPresentation;
    },
  ): void {
    const parentToolCallId = this.narrativeStore.bufferToolCall(threadId, event);
    this.featureEffects?.onToolUse(threadId, { ...event, parentToolCallId });
  }

  /** Stop all active agent sessions (for graceful shutdown). */
  async stopAll(): Promise<void> {
    const ids = [...this.activeSessionIds];
    await Promise.all(
      ids.map(async (threadId) => {
        await this.featureEffects?.stopDescendants(threadId);
        const runtime = this.turnRuntime.snapshot(threadId);
        const terminalized = runtime?.turnExecutionId
          ? this.turnRuntime.terminalize(threadId, runtime.turnExecutionId, "interrupted")
          : false;
        if (!terminalized && runtime?.phase !== "interrupted") return;
        await (this.finalizeTerminalTurn(threadId, "interrupted", "shutdown") ?? Promise.resolve());
        this.trackSessionEnded(threadId, runtime?.turnExecutionId);
        this.runtimePersistence.setRuntimeStatus(threadId, "interrupted");
        broadcast("thread.status", { threadId, status: "interrupted" });
      }),
    );
    for (const threadId of ids) {
      const sessionId = `mcode-${threadId}`;
      const thread = this.runtimePersistence.load(threadId);
      const providerId = thread?.provider as ProviderId | undefined;
      if (!providerId) continue;
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
