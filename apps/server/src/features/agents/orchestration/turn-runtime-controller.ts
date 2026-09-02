/**
 * Agent session orchestration service.
 * Manages sending messages to AI providers, tracking active sessions,
 * and forwarding agent events to the push broadcaster.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { injectable, inject, delay } from "tsyringe";
import { logger } from "@mcode/shared";
import { isSessionEvictable } from "@mcode/contracts";
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
import { TURN_FILE_EFFECTS, TurnFileEffects } from "../turns/turn-file-effects.js";
import type { WorkspaceEnvironmentAutomaticSetupDispatch } from "../../projects/environment/workspace-environment-service.js";
import { MemoryPressureService, type MemoryPressureSnapshot } from "../../../runtime/memory/memory-pressure-service.js";
import { broadcast } from "../../../application/transport/push.js";
import {
  InternalThreadControlMcpRuntime,
  ThreadControlMutationReservationService,
} from "../../thread-control/index.js";
import { ScopedPreGrantService } from "../permissions/scoped-pre-grant.js";
import { TurnErrorPolicy } from "../turns/turn-error-policy.js";
import { TurnRuntimeRegistry } from "../turns/turn-runtime.js";
import type { TurnOutcome } from "../turns/turn-outcome.js";
import { ProviderEventIngress } from "../../providers/composition/provider-event-ingress.js";
import {
  TurnEventPipeline,
  type FinalizeTurnCommand,
  type TurnLifecycleControl,
} from "../turns/turn-event-pipeline.js";
import { ProviderTurnEventApplication } from "../turns/provider-turn-event-application.js";
import { TURN_FEATURE_EFFECTS, TurnFeatureEffects } from "../turns/turn-feature-effects.js";
import { TURN_RUNTIME_PERSISTENCE, type TurnRuntimePersistence } from "../turns/turn-runtime-persistence.js";
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
import {
  idleRuntime,
  isActiveRuntimeExecution,
  isRunningRuntime,
  isStoppedThread,
  ownsStoppedExecution,
  pipelineTerminalSource,
  stopDispatchState,
} from "./agent-service-helpers.js";
import type { TurnRuntimeEventControl } from "./turn-runtime-event-control.js";

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

/** Orchestrates agent sessions, message sending, and event forwarding. */
@injectable()
export class TurnRuntimeController implements TurnLifecycleControl, TurnRuntimeEventControl {
  /** Canonical per-thread execution identity and lifecycle authority. */
  private readonly turnRuntime = new TurnRuntimeRegistry();
  private readonly activeSessionIds = new Set<string>();
  private initialized = false;
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
  /** Reservation token attached to each active provider turn. */
  private readonly activeMutationReservations = new Map<string, string>();
  /** Single-flight user stop operation per thread. */
  private readonly stopOperationsByThread = new Map<string, Promise<AgentStopResult>>();
  /** Monotonic turn generation per thread, including turns that failed setup. */
  private readonly turnGenerations = new Map<string, number>();
  /** Single ordered pipeline for validated provider envelopes and terminal materialization. */
  private readonly turnEventPipeline: TurnEventPipeline;
  constructor(
    @inject(TURN_RUNTIME_PERSISTENCE)
    private readonly runtimePersistence: TurnRuntimePersistence,
    @inject(TURN_FILE_EFFECTS)
    private readonly turnFileEffects: TurnFileEffects,
    @inject(TURN_ADMISSION_DISPATCH_COORDINATOR)
    private readonly turnAdmissions: TurnAdmissionDispatchCoordinator,
    @inject(ThreadCreationCoordinator)
    private readonly threadCreation: ThreadCreationCoordinator,
    @inject("IProviderRegistry")
    private readonly providerRegistry: IProviderRegistry,
    @inject(MemoryPressureService)
    private readonly memoryPressureService: MemoryPressureService,
    @inject(ScopedPreGrantService)
    private readonly scopedPreGrant: ScopedPreGrantService,
    @inject(delay(() => InternalThreadControlMcpRuntime))
    private readonly threadControlMcp: InternalThreadControlMcpRuntime | undefined,
    @inject(delay(() => ThreadControlMutationReservationService))
    private readonly mutationReservations: ThreadControlMutationReservationService,
    @inject(ProviderEventIngress)
    private readonly providerEventIngress: ProviderEventIngress,
    @inject(TURN_FEATURE_EFFECTS)
    private readonly featureEffects: TurnFeatureEffects,
    @inject(AgentRuntimeCommandPort)
    runtimeCommands: AgentRuntimeCommandPort,
    @inject(AgentEventPublicationRuntimePort)
    publicationRuntime: AgentEventPublicationRuntimePort,
    @inject(AgentTurnContinuationPort)
    continuation: AgentTurnContinuationPort,
    @inject(AgentReliabilityPort)
    reliability: AgentReliabilityPort,
    @inject(AgentEventPublicationRegistry)
    private readonly eventPublication: AgentEventPublicationRegistry,
    @inject(delay(() => ProviderTurnEventApplication))
    private readonly eventApplication: ProviderTurnEventApplication,
  ) {
    this.turnEventPipeline = new TurnEventPipeline(this, eventApplication);
    runtimeCommands.bind({
      sendMessage: (command) => this.sendMessage(command),
      runtimeSnapshots: () => this.runtimeSnapshots(),
    });
    publicationRuntime.bind({
      getCurrentFileEffectTurnId: (threadId) => this.getCurrentFileEffectTurnId(threadId),
      shouldSuppressTurnEnded: (threadId) => this.shouldSuppressTurnEnded(threadId),
      shouldSuppressTurnComplete: (threadId) => this.shouldSuppressTurnComplete(threadId),
      shouldSuppressTransientTurnError: (threadId, errorMessage) => (
        this.shouldSuppressTransientTurnError(threadId, errorMessage)
      ),
    });
    continuation.bind((executionId) => eventApplication.continueWithoutSaving(executionId));
    reliability.bind((threadId) => eventApplication.streamReliabilityAssistantText(threadId));
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

  /** Admit provider-originated runtime state before it can replace the active turn. */
  admitProviderTurn(threadId: string): boolean {
    const reservation = this.mutationReservations.get(threadId);
    const thread = this.runtimePersistence.load(threadId);
    if (reservation?.state === "stopping" || isStoppedThread(thread?.status)) {
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

  /** Mark an admitted provider turn active for memory-pressure accounting. */
  markProviderTurnActive(threadId: string): void {
    if (this.activeSessionIds.has(threadId)) return;
    this.activeSessionIds.add(threadId);
    this.memoryPressureService.markActive(threadId);
  }

  /** Return the authoritative runtime state for one thread. */
  snapshot(threadId: string): TurnRuntimeSnapshot | undefined {
    return this.turnRuntime.snapshot(threadId);
  }

  /** Start runtime identity for a provider-originated turn before its events enter ingress. */
  beginProviderTurn(threadId: string): string {
    return this.turnRuntime.start(threadId).turnExecutionId!;
  }

  /** Release runtime ownership after a provider completion. */
  completeProviderTurn(event: Extract<AgentEvent, { type: "turnComplete" }>): boolean {
    if (!this.turnRuntime.terminalize(event.threadId, event.turnExecutionId!, "completed")) return false;
    this.threadControlMcp?.revoke(`mcode-${event.threadId}`);
    this.trackSessionEnded(event.threadId, event.turnExecutionId);
    this.disarmTurnRetryWindow(event.threadId);
    return true;
  }

  /** Terminalize a provider failure before its event application finalizes it. */
  failProviderTurn(event: Extract<AgentEvent, { type: "error" }>): boolean {
    return this.turnRuntime.terminalize(event.threadId, event.turnExecutionId!, "errored");
  }

  /** Release a lost provider stream or terminalize its reported outcome. */
  endProviderTurn(event: Extract<AgentEvent, { type: "ended" }>): boolean {
    if (event.outcome === undefined) {
      if (event.reason !== "provider_lost" || !event.turnExecutionId) return false;
      if (!this.turnRuntime.release(event.threadId, event.turnExecutionId)) return false;
      this.trackSessionEnded(event.threadId, event.turnExecutionId);
      this.disarmTurnRetryWindow(event.threadId);
      this.clearTurnEndedState(event.threadId);
      return true;
    }
    const runtime = this.turnRuntime.snapshot(event.threadId);
    if (!runtime?.turnExecutionId || !isActiveRuntimeExecution(runtime, event.turnExecutionId)) return false;
    const outcome = event.outcome === "cancelled" ? "interrupted" : event.outcome;
    return this.turnRuntime.terminalize(event.threadId, runtime.turnExecutionId, outcome);
  }

  /** Clear runtime-only resources after terminal event ownership is settled. */
  clearTerminalState(threadId: string): void {
    const executionId = this.turnRuntime.snapshot(threadId)?.turnExecutionId;
    this.trackSessionEnded(threadId, executionId);
    this.disarmTurnRetryWindow(threadId);
    this.clearTurnEndedState(threadId);
  }

  /** Materialize one terminal outcome through the pipeline's ordering fence. */
  finalizeTerminalTurn(threadId: string, outcome: TurnOutcome, source: string): Promise<boolean> | null {
    return this.turnEventPipeline.finalizeTurn({
      threadId,
      executionId: this.turnRuntime.snapshot(threadId)?.turnExecutionId ?? undefined,
      outcome,
      source: pipelineTerminalSource(source),
    });
  }

  /** Return whether the pipeline already applied deferred file work for this event. */
  consumeEarlyFileEffect(event: AgentEvent): boolean {
    return this.turnEventPipeline.consumeEarlyFileEffect(event);
  }

  /** Resume blocked event application after a durable checkpoint commits. */
  resumeEventPipeline(threadId: string): void {
    this.turnEventPipeline.resume(threadId);
  }

  /** Drop event work that belongs to a terminalized execution. */
  discardEventPipeline(threadId: string, executionId?: string): void {
    this.turnEventPipeline.discard(threadId, executionId);
  }

  /** Stop the active provider when its event state cannot become durable. */
  stopForEventApplicationFailure(event: AgentEvent, reason: string): void {
    const executionId = event.turnExecutionId;
    if (!executionId || !isActiveRuntimeExecution(this.turnRuntime.snapshot(event.threadId) ?? null, executionId)) return;
    logger.error(reason, { threadId: event.threadId, turnExecutionId: executionId, eventType: event.type });
    let providerId: ProviderId | undefined;
    try {
      providerId = this.runtimePersistence.load(event.threadId)?.provider as ProviderId | undefined;
    } catch (error) {
      logger.warn("Provider lookup failed after event application failure", {
        threadId: event.threadId,
        turnExecutionId: executionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (providerId) {
      try {
        void Promise.resolve(this.providerRegistry.resolve(providerId).stopSession(`mcode-${event.threadId}`)).catch((error) => {
          logger.warn("Provider stop failed after event application failure", {
            threadId: event.threadId,
            turnExecutionId: executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        logger.warn("Provider resolution failed after event application failure", {
          threadId: event.threadId,
          turnExecutionId: executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.disarmTurnRetryWindow(event.threadId);
  }

  /** Reserve a runtime identity for the restart-reliability harness. */
  beginReliabilityTurn(threadId: string): string {
    if (!this.reserveTurn(threadId)) throw new Error(`Thread ${threadId} already has an active agent session`);
    return this.turnRuntime.start(threadId).turnExecutionId!;
  }

  /** Release a restart-reliability reservation after its durable prefix fails. */
  releaseReliabilityTurn(threadId: string): void {
    if (this.activeSessionIds.delete(threadId)) this.memoryPressureService.markIdle(threadId);
  }

  /** Materialize a queued terminal turn without bypassing its event owner. */
  finalize(command: FinalizeTurnCommand): Promise<boolean> | null {
    return this.eventApplication.finalize(command);
  }

  /** Stop a provider stream that the runtime cannot admit. */
  private stopUnadmittedTurn(threadId: string, providerId: ProviderId | undefined, reason: string): void {
    logger.warn("Ignoring TurnStarted that the runtime did not admit", { threadId, providerId, reason });
    if (!providerId) return;
    try {
      void Promise.resolve(this.providerRegistry.resolve(providerId).stopSession(`mcode-${threadId}`)).catch((error) => {
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
    this.eventApplication.beginPreparedTurn(lease.threadId, lease.turnExecutionId, request.turnId);
    this.turnAdmissions.markDispatchActive(lease.threadId);
    this.emitProviderEvent(prepared.provider, {
      type: "turnStarted",
      threadId: lease.threadId,
      turnExecutionId: lease.turnExecutionId,
    } satisfies AgentEvent);
    await this.ensureTurnFileTracking(lease.threadId, prepared.cwd);
    await this.turnFileEffects.get(lease.threadId);
    this.eventApplication.recordContextSeed(lease.threadId, prepared.contextSeed, prepared.contextWindow ?? undefined);
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
    dispatch: ReturnType<TurnRuntimeController["createRetryDispatch"]>,
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
    dispatch: ReturnType<TurnRuntimeController["createRetryDispatch"]>,
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
    dispatch: ReturnType<TurnRuntimeController["createRetryDispatch"]>,
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

  /** Stop exact active turn, preserving provider failure as retryable RPC error. */
  private async stopSessionInternal(threadId: string): Promise<AgentStopResult> {
    const prepared = this.prepareStop(threadId);
    if (!isRunningRuntime(prepared.runtime)) return this.alreadyTerminal(prepared);
    this.finishStopCheckpoint(prepared);
    await this.stopProviderForTurn(prepared);
    return this.finalizeStoppedTurn(prepared);
  }

  private prepareStop(threadId: string): PreparedStop {
    const reservationToken = this.activeMutationReservations.get(threadId);
    const runtime = this.turnRuntime.snapshot(threadId) ?? idleRuntime(threadId);
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    const reservation = reservationToken ? this.mutationReservations.get(threadId) : undefined;
    const dispatchState = stopDispatchState(runtime, dispatch?.dispatchStarted, reservation?.state);
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

  /** Flush text checkpoints before the user-requested cancellation finalizes the turn. */
  private finishStopCheckpoint(prepared: PreparedStop): void {
    const executionId = prepared.runtime.turnExecutionId!;
    this.eventApplication.finishAssistantText(executionId);
  }

  private async stopProviderForTurn(prepared: PreparedStop): Promise<void> {
    await this.featureEffects.stopDescendants(prepared.threadId);
    if (prepared.dispatchState !== "not-dispatched") await this.stopProvider(prepared);
    this.disarmTurnRetryWindow(prepared.threadId);
  }

  private async stopProvider(prepared: PreparedStop): Promise<void> {
    if (!prepared.providerId) return;
    try {
      await this.providerRegistry.resolve(prepared.providerId).stopSession(prepared.sessionId);
    } catch (error) {
      if (!isRunningRuntime(this.turnRuntime.snapshot(prepared.threadId) ?? idleRuntime(prepared.threadId))) return;
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
    if (!ownsStoppedExecution(current, prepared.runtime.turnExecutionId)) return this.alreadyTerminal({ ...prepared, runtime: current });
    if (!this.turnRuntime.terminalize(prepared.threadId, prepared.runtime.turnExecutionId!, "cancelled")) {
      return this.alreadyTerminal({ ...prepared, runtime: this.turnRuntime.snapshot(prepared.threadId) ?? idleRuntime(prepared.threadId) });
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
      snapshot: this.turnRuntime.snapshot(prepared.threadId) ?? idleRuntime(prepared.threadId),
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
      savingStatus: this.eventApplication.savingStatus(snapshot.turnExecutionId),
    }));
  }

  /** Normalize one provider event once at the production provider boundary. */
  normalize(event: AgentEvent): AgentEvent | undefined {
    return this.eventApplication.prepare(this.turnRuntime.normalizeEvent(event));
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
    this.featureEffects.clearTurn(threadId);
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

  /** Schedule a retry and hide only the transient error from the failed attempt. */
  suppressTransientError(event: Extract<AgentEvent, { type: "error" }>): boolean {
    if (!this.shouldSuppressTransientTurnError(event.threadId, event.error ?? "")) return false;
    this.endedSuppressionThreads.add(event.threadId);
    const dispatch = this.turnRetryDispatchByThread.get(event.threadId);
    if (dispatch && !dispatch.sendTurnInFlight) this.scheduleTransientStreamRetry(event.threadId, event.error ?? "");
    return true;
  }

  /**
   * Whether a provider-emitted `Ended` for `threadId` should be swallowed because
   * it trails a just-suppressed transient `Error` or an explicit user stop. Keeps
   * a failed attempt's teardown from flashing before retry, and keeps a provider
   * stop's synchronous teardown event from terminalizing the turn as interrupted
   * before stopSession can durably record cancelled. Consulted by the composition
   * root before broadcasting and by the `Ended` cleanup path.
   */
  shouldSuppressTurnEnded(threadId: string): boolean {
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
  shouldSuppressTurnComplete(threadId: string): boolean {
    return this.endedSuppressionThreads.has(threadId);
  }

  /** Suppress a matching provider terminal event while an explicit stop owns the turn. */
  shouldSuppressStoppingTerminal(threadId: string, turnExecutionId?: string | null): boolean {
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
    dispatch: ReturnType<TurnRuntimeController["getCurrentRetryDispatch"]>,
    error: unknown,
  ): dispatch is NonNullable<ReturnType<TurnRuntimeController["getCurrentRetryDispatch"]>> {
    return dispatch !== null
      && !dispatch.retryInFlight
      && this.turnErrorPolicy.shouldRetry(error, dispatch.attempt);
  }

  /** Restore the provider and runtime state needed for a fresh retry attempt. */
  private async prepareTransientRetry(
    threadId: string,
    dispatch: NonNullable<ReturnType<TurnRuntimeController["getCurrentRetryDispatch"]>>,
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
    if (!this.eventApplication.resetAssistantTextForRetry(threadId, dispatch.turnRequest.turnExecutionId)) return false;
    this.endedSuppressionThreads.delete(threadId);
    return true;
  }

  /** Evict one pooled session without turning an eviction failure into a fatal send failure. */
  private async evictRetrySession(
    threadId: string,
    dispatch: NonNullable<ReturnType<TurnRuntimeController["getCurrentRetryDispatch"]>>,
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
    this.eventApplication.clearSessionCursorForRetry(threadId);
  }

  /** Record a bounded retry with the original error available for diagnosis. */
  private logTransientRetry(
    threadId: string,
    dispatch: NonNullable<ReturnType<TurnRuntimeController["getCurrentRetryDispatch"]>>,
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
    dispatch: NonNullable<ReturnType<TurnRuntimeController["getCurrentRetryDispatch"]>>,
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
    dispatch: NonNullable<ReturnType<TurnRuntimeController["getCurrentRetryDispatch"]>>,
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
    dispatch: NonNullable<ReturnType<TurnRuntimeController["getCurrentRetryDispatch"]>>,
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
    const turnExecutionId = dispatch.turnRequest.turnExecutionId;
    logger.error("Provider send failed", { threadId, error: rawMessage });

    try {
      const resolvedProvider = this.providerRegistry.resolve(effectiveProvider);
      this.emitProviderEvent(resolvedProvider, {
        type: "error",
        threadId,
        turnExecutionId,
        error: rawMessage,
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

    this.providerEventIngress.start(this.providerRegistry, this.turnEventPipeline);
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
   * Admit a complete turn command, then retain only runtime-owned provider dispatch.
   */
  async sendMessage(command: SendMessageCommand): Promise<void> {
    const admitted = await this.turnAdmissions.admit(command, this.runtimeAdmissionAuthority());
    if (admitted.kind !== "dispatch") return;
    await this.dispatchPreparedTurn(admitted);
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
    let runtimeSnapshot: TurnRuntimeSnapshot;
    try {
      this.threadCreation.startInitialAgent(created.startupId);
      runtimeSnapshot = await this.sendInitialMessageAndSnapshot(created.command, (err) => {
        logger.error("createAndSend initial send failed", {
          threadId: created.thread.id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.threadCreation.failInitialAgent(created.startupId);
      });
      if (runtimeSnapshot.turnExecutionId) this.threadCreation.completeInitialAgent(created.startupId);
    } catch (error) {
      this.threadCreation.failInitialAgent(created.startupId);
      throw error;
    }
    return {
      ...created.thread,
      runtimeSnapshot,
      ...(created.thread.warnings?.length ? { warnings: created.thread.warnings } : {}),
    };
  }

  /** Dispatch a queued Turn that the automatic Setup lifecycle claimed after commit. */
  async dispatchQueuedAutomaticTurn(
    submission: WorkspaceEnvironmentQueuedTurnSubmission,
  ): Promise<WorkspaceEnvironmentAutomaticSetupDispatch> {
    const startupId = this.threadCreation.startQueuedAgent(submission.threadId);
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
        this.threadCreation.completeInitialAgent(startupId);
        resolveStarted();
      },
    });
    try {
      await Promise.race([
        started,
        send.then(() => {
          throw new Error(`Queued Turn finished without runtime dispatch: ${submission.threadId}`);
        }),
      ]);
    } catch (error) {
      this.threadCreation.failInitialAgent(startupId);
      throw error;
    }
    return { completion };
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

  /** Return narrow runtime capabilities for server-owned diagnostics and recovery infrastructure. */
  runtimeAccess(): AgentRuntimeAccess {
    return {
      activeCount: () => this.activeCount(),
      activeThreadIds: () => this.activeThreadIds(),
      runtimeSnapshots: () => this.runtimeSnapshots(),
    };
  }

  /** Stop all active agent sessions (for graceful shutdown). */
  async stopAll(): Promise<void> {
    const ids = [...this.activeSessionIds];
    await Promise.all(
      ids.map(async (threadId) => {
        await this.featureEffects.stopDescendants(threadId);
        const sessionId = `mcode-${threadId}`;
        const thread = this.runtimePersistence.load(threadId);
        const providerId = thread?.provider as ProviderId | undefined;
        if (!providerId) return;
        try {
          const provider = this.providerRegistry.resolve(providerId);
          await provider.stopSession(sessionId);
        } catch {
          // best-effort
        }
      }),
    );
    this.activeSessionIds.clear();
    for (const [threadId, token] of this.activeMutationReservations) {
      this.mutationReservations.release(threadId, token);
    }
    this.activeMutationReservations.clear();
  }
}
