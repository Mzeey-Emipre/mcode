import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import {
  AgentEventType,
  createSubagentPresentation,
  type AgentEvent,
  type ProviderId,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";

import { broadcast } from "../../../application/transport/push.js";
import { BrowserNarrativeEventSanitizer } from "../../browser-automation/index.js";
import type { ProviderEventIngressEvent } from "../../providers/composition/provider-event-ingress.js";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { TURN_FINALIZER, TurnFinalizer } from "./turn-finalizer.js";
import { TURN_FILE_EFFECTS, TurnFileEffects } from "./turn-file-effects.js";
import { ParentAssistantTextCheckpointService } from "./parent-assistant-text-checkpoint-service.js";
import { ParentAssistantTextCoordinator } from "./parent-assistant-text-coordinator.js";
import { ParentNarrativeRecoveryCoordinator } from "./parent-narrative-recovery-coordinator.js";
import { PARENT_TURN_DURABILITY, type ParentTurnDurability } from "./parent-turn-durability.js";
import { TurnConversationProjectionService } from "./turn-conversation-projection-service.js";
import { PostTerminalHookCompletionEffect } from "./post-terminal-hook-completion-effect.js";
import { ProviderSessionCursorPersistence } from "./provider-session-cursor-persistence.js";
import { TURN_FEATURE_EFFECTS, type TurnFeatureEffects } from "./turn-feature-effects.js";
import { TURN_RUNTIME_PERSISTENCE, type TurnRuntimePersistence } from "./turn-runtime-persistence.js";
import type { FinalizeTurnCommand, TurnEventApplication } from "./turn-event-pipeline.js";
import { toolResultMetadata } from "../orchestration/agent-service-helpers.js";
import {
  TURN_RUNTIME_EVENT_CONTROL,
  type TurnRuntimeEventControl,
} from "../orchestration/turn-runtime-event-control.js";
import { AgentEventPublicationRegistry } from "../orchestration/agent-event-publication-registry.js";

/** Applies normalized provider events after the runtime controller admits them in pipeline order. */
@injectable()
export class ProviderTurnEventApplication implements TurnEventApplication {
  private readonly parentAssistantText: ParentAssistantTextCoordinator;
  private readonly parentNarrativeRecovery: ParentNarrativeRecoveryCoordinator;
  private readonly browserNarrativeEventSanitizer: BrowserNarrativeEventSanitizer;
  private readonly preparedEvents = new WeakMap<object, AgentEvent | undefined>();
  private readonly terminalFinalizedThreads = new Set<string>();
  private readonly turnCompleteSeenByThread = new Set<string>();
  private readonly finalResponseExecutionByThread = new Map<string, string>();
  private readonly unclassifiedAssistantTextStartByExecution = new Map<string, number>();
  private readonly compactionInProgressByThread = new Set<string>();
  private readonly lastContextByThread = new Map<string, number>();
  private readonly lastContextWindowByThread = new Map<string, number>();
  private readonly ownedLateHookCompletions = new WeakSet<object>();

  constructor(
    @inject(TURN_FINALIZER) private readonly finalizer: TurnFinalizer,
    @inject(TURN_FILE_EFFECTS) private readonly fileEffects: TurnFileEffects,
    @inject(TurnConversationProjectionService)
    private readonly conversationProjection: TurnConversationProjectionService,
    @inject(PostTerminalHookCompletionEffect)
    private readonly lateHookCompletions: PostTerminalHookCompletionEffect,
    @inject(ProviderSessionCursorPersistence)
    private readonly sessionCursors: ProviderSessionCursorPersistence,
    @inject(PARENT_TURN_DURABILITY)
    private readonly parentDurability: ParentTurnDurability,
    @inject(TURN_RUNTIME_PERSISTENCE)
    private readonly runtimePersistence: TurnRuntimePersistence,
    @inject(NarrativeStore) private readonly narrative: NarrativeStore,
    @inject(ParentAssistantTextCheckpointService) checkpoints: ParentAssistantTextCheckpointService,
    @inject(TURN_FEATURE_EFFECTS) private readonly featureEffects: TurnFeatureEffects,
    @inject("Database") private readonly db: Database.Database,
    @inject(TURN_RUNTIME_EVENT_CONTROL) private readonly runtime: TurnRuntimeEventControl,
    @inject(AgentEventPublicationRegistry)
    private readonly publication: AgentEventPublicationRegistry,
  ) {
    this.parentAssistantText = new ParentAssistantTextCoordinator(
      parentDurability,
      checkpoints,
      (update) => {
        broadcast("turn.savingStatus", update);
        queueMicrotask(() => this.runtime.resumeEventPipeline(update.threadId));
      },
    );
    this.parentNarrativeRecovery = new ParentNarrativeRecoveryCoordinator(parentDurability, narrative);
    this.browserNarrativeEventSanitizer = new BrowserNarrativeEventSanitizer(
      (threadId, toolCallId) => this.narrative.getBufferedToolCalls(threadId)
        .find((toolCall) => toolCall.toolCallId === toolCallId)
        ?.toolName,
    );
  }

  /** Normalize one provider event after its exact runtime execution check. */
  prepare(event: AgentEvent | undefined): AgentEvent | undefined {
    if (!event) return undefined;
    if (this.preparedEvents.has(event as object)) return this.preparedEvents.get(event as object);
    const sanitized = this.browserNarrativeEventSanitizer.sanitize(event);
    const prepared = this.prepareSanitizedEvent(sanitized);
    this.preparedEvents.set(event as object, prepared);
    return prepared;
  }

  /** Apply one queue-admitted provider event and publish it only after its durable prerequisites complete. */
  apply(input: ProviderEventIngressEvent, event: AgentEvent, publish: boolean): boolean {
    const queued = this.queueVisibleAssistantText(input, event, publish);
    if (queued !== undefined) return queued;
    return this.applyPreparedEvent(input, event, publish);
  }

  /** Record a provider file mutation before its public event is available. */
  observeFileMutation(event: import("@mcode/contracts").ProviderFileMutationStart): void {
    this.fileEffects.observeProviderMutation(event);
  }

  /** Stop a turn only when its bounded pipeline cannot retain the event. */
  rejectForQueueCapacity(event: AgentEvent): void {
    this.runtime.stopForEventApplicationFailure(event, "Provider event queue capacity reached");
  }

  /** Return prior file finalization so the pipeline can fence a resumed turn. */
  previousFileFinalization(threadId: string): Promise<boolean> | undefined {
    return this.fileEffects.previousFinalization(threadId);
  }

  /** Start file tracking before a resumed provider turn applies public events. */
  beginResumedFileTracking(threadId: string): void {
    this.fileEffects.beginResumed(threadId);
  }

  /** Attribute a deferred tool start before the pipeline publishes it. */
  observeToolUse(event: Extract<AgentEvent, { type: "toolUse" }>): void {
    this.fileEffects.observeToolUse(event);
  }

  /** Attribute a deferred tool completion before the pipeline publishes it. */
  observeToolResult(event: Extract<AgentEvent, { type: "toolResult" }>): void {
    this.fileEffects.observeToolResult(event);
  }

  /** Materialize terminal state after the pipeline drains the earlier events for its turn. */
  finalize(command: FinalizeTurnCommand): Promise<boolean> | null {
    if (this.terminalFinalizedThreads.has(command.threadId)) return null;
    this.terminalFinalizedThreads.add(command.threadId);
    const executionId = this.runtime.snapshot(command.threadId)?.turnExecutionId;
    const finalization = this.fileEffects.finalize(
      command.threadId,
      command.outcome,
      executionId ?? undefined,
      command.source,
    );
    void finalization.finally(() => this.clearFinalizedEventState(command.threadId, executionId));
    return finalization;
  }

  /** Stream the private restart-reliability prefix through the same durable text owner. */
  streamReliabilityAssistantText(threadId: string): { threadId: string; executionId: string; text: string } {
    if (!this.publication.isBound()) {
      throw new Error("Agent event publication is unavailable for reliability streaming");
    }
    const executionId = this.runtime.beginReliabilityTurn(threadId);
    const text = "Durable assistant prefix for restart recovery.";
    try {
      this.conversationProjection.startReliabilityTurn(threadId, executionId);
      const event: Extract<AgentEvent, { type: "textDelta" }> = {
        type: AgentEventType.TextDelta,
        threadId,
        turnExecutionId: executionId,
        delta: text,
        isFinalResponse: true,
      };
      if (!this.queueParentAssistantText(event, () => {
        this.finalizer.appendStreamingText(threadId, text);
        this.publication.publish(event);
      })) {
        throw new Error("Reliability assistant text could not be queued");
      }
      if (!this.parentAssistantText.flush(executionId)) {
        throw new Error("Reliability assistant text could not be checkpointed");
      }
      return { threadId, executionId, text };
    } catch (error) {
      this.runtime.releaseReliabilityTurn(threadId);
      throw error;
    }
  }

  /** Start parent text durability after dispatch commits its execution identity. */
  beginPreparedTurn(threadId: string, executionId: string, turnId: string): void {
    this.finalizer.resetStreamingText(threadId);
    this.parentAssistantText.start(executionId, turnId);
    this.narrative.beginTurn(threadId);
    this.narrative.resetTurnCounters(threadId);
  }

  /** Record context supplied before provider dispatch. */
  recordContextSeed(threadId: string, tokens: number, contextWindow?: number): void {
    this.lastContextByThread.set(threadId, tokens);
    if (contextWindow) this.lastContextWindowByThread.set(threadId, contextWindow);
  }

  /** Reset visible text before the runtime retries the same provider execution. */
  resetAssistantTextForRetry(threadId: string, executionId: string): boolean {
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
    this.finalizer.resetStreamingText(threadId);
    return true;
  }

  /** Clear a stale provider cursor before the runtime retries with a fresh session. */
  clearSessionCursorForRetry(threadId: string): void {
    this.sessionCursors.clearForRetry(threadId);
  }

  /** Finish the parent text checkpoint before an explicit user stop finalizes it. */
  finishAssistantText(executionId: string): void {
    this.parentAssistantText.finish(executionId);
  }

  /** Continue an active response after the user accepts unrecoverable text. */
  continueWithoutSaving(executionId: string): void {
    if (!this.parentAssistantText.continueWithoutSaving(executionId)) {
      throw new Error("Unsaved continuation is unavailable for this execution");
    }
  }

  /** Return the saving status for active runtime snapshots. */
  savingStatus(executionId: string | null): import("@mcode/contracts").TurnRuntimeSnapshot["savingStatus"] {
    return executionId ? this.parentAssistantText.durabilityMode(executionId) : null;
  }

  private applyPreparedEvent(
    input: ProviderEventIngressEvent,
    event: AgentEvent,
    publish: boolean,
    textIsDurable = false,
  ): boolean {
    const terminal = isTerminal(event);
    const preparation = this.prepareEventForApplication(event, publish, textIsDurable, terminal);
    if (preparation !== undefined) return preparation;
    this.recordDiagnostic(input, event);
    const accepted = this.applyEvent(input.providerId, event);
    if (accepted === false) return true;
    if (terminal && accepted !== true) return false;
    if (!this.checkpointNarrative(event, publish)) return false;
    if (publish && this.ownedLateHookCompletions.delete(event as object)) return true;
    if (publish) this.publishAfterDurability(event, terminal);
    return true;
  }

  private queueVisibleAssistantText(
    input: ProviderEventIngressEvent,
    event: AgentEvent,
    publish: boolean,
  ): boolean | undefined {
    if (!publish || !this.publication.isBound() || event.type !== AgentEventType.TextDelta) return undefined;
    if (event.isFinalResponse === false || !event.turnExecutionId) return undefined;
    const queued = this.queueParentAssistantText(event, () => {
      void this.applyPreparedEvent(input, event, true, true);
    });
    return queued === "blocked" ? false : queued;
  }

  private applyEvent(providerId: ProviderId, event: AgentEvent): boolean | undefined {
    return this.applyNarrativeEvent(providerId, event) ?? this.applyLifecycleEvent(providerId, event);
  }

  private applyNarrativeEvent(providerId: ProviderId, event: AgentEvent): boolean | undefined {
    switch (event.type) {
      case AgentEventType.TextDelta: return this.applyTextDelta(event);
      case AgentEventType.GeneratedAttachment: return this.applyGeneratedAttachment(event);
      case AgentEventType.Message: return this.applyMessage(providerId, event);
      case AgentEventType.AssistantMessageBoundary: return this.applyAssistantMessageBoundary(event);
      case AgentEventType.ToolUse: return this.applyToolUse(event);
      case AgentEventType.HookStarted: return this.applyHookStarted(event);
      case AgentEventType.HookCompleted: return this.applyHookCompleted(event);
      case AgentEventType.ToolResult: return this.applyToolResult(event);
      default: return undefined;
    }
  }

  private applyLifecycleEvent(providerId: ProviderId, event: AgentEvent): boolean | undefined {
    switch (event.type) {
      case AgentEventType.TurnStarted: return this.applyTurnStarted(event);
      case AgentEventType.TurnComplete: return this.applyTurnComplete(event);
      case AgentEventType.Error: return this.applyError(event);
      case AgentEventType.Compacting: return this.applyCompacting(event);
      case AgentEventType.CompactSummary: return this.applyCompactSummary(event);
      case AgentEventType.System: return this.applySystem(providerId, event);
      case AgentEventType.Ended: return this.applyEnded(event);
      default: return true;
    }
  }

  private prepareEventForApplication(
    event: AgentEvent,
    publish: boolean,
    textIsDurable: boolean,
    terminal: boolean,
  ): boolean | undefined {
    if (!this.prepareTerminalText(event, publish, terminal)) return false;
    if (!publish || textIsDurable || this.parentAssistantText.prepareSemanticBoundary(event.threadId)) {
      return undefined;
    }
    return this.parentAssistantText.hasThreadStoppedForStorageFailure(event.threadId);
  }

  private applyTextDelta(event: Extract<AgentEvent, { type: "textDelta" }>): boolean {
    if (event.isFinalResponse === true) {
      this.finalizer.appendStreamingText(event.threadId, event.delta);
    } else if (event.isFinalResponse === false) {
      this.narrative.openOrExtendThought(event.threadId, event.delta);
    } else {
      this.recordUnclassifiedAssistantText(event);
      this.finalizer.appendStreamingText(event.threadId, event.delta);
    }
    this.featureEffects.onTextDelta(event.threadId, event.delta);
    return true;
  }

  private applyGeneratedAttachment(event: Extract<AgentEvent, { type: "generatedAttachment" }>): boolean {
    this.finalizer.bufferAssistantAttachments(event.threadId, [event.attachment]);
    return true;
  }

  private applyMessage(providerId: ProviderId, event: Extract<AgentEvent, { type: "message" }>): boolean {
    if (event.turnExecutionId) this.finalResponseExecutionByThread.set(event.threadId, event.turnExecutionId);
    try {
      this.conversationProjection.bufferAssistantMessage(event, this.isPostTurnGoalReceipt(event));
    } catch (error) {
      logger.error("Failed to persist assistant message", {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.featureEffects.onAssistantMessage(providerId, event);
    this.narrative.clearAgentStackOnMessage(event.threadId);
    if (this.featureEffects.needsAssistantMaterialization(event)) {
      this.finalizer.materializeAssistantRow(event.threadId);
    }
    this.featureEffects.persistAssistantMessage(event);
    return true;
  }

  private applyAssistantMessageBoundary(event: Extract<AgentEvent, { type: "assistantMessageBoundary" }>): boolean {
    if (event.isFinalResponse === true) {
      const finalText = this.narrative.takeOpenThought(event.threadId);
      if (finalText) this.finalizer.appendStreamingText(event.threadId, finalText);
      if (event.turnExecutionId) this.unclassifiedAssistantTextStartByExecution.delete(event.turnExecutionId);
      return true;
    }
    return event.isFinalResponse === false ? this.classifyUnclassifiedAssistantTextAsNarration(event) : true;
  }

  private applyToolUse(event: Extract<AgentEvent, { type: "toolUse" }>): boolean {
    this.narrative.closeOpenThought(event.threadId);
    const parentToolCallId = this.narrative.bufferToolCall(event.threadId, event);
    this.featureEffects.onToolUse(event.threadId, { ...event, parentToolCallId });
    if (!this.runtime.consumeEarlyFileEffect(event)) this.fileEffects.observeToolUse(event);
    return true;
  }

  private applyHookStarted(event: Extract<AgentEvent, { type: "hookStarted" }>): boolean {
    const late = this.turnCompleteSeenByThread.has(event.threadId);
    if (!late) this.narrative.closeOpenThought(event.threadId);
    this.narrative.openHook(event.threadId, {
      hookName: event.hookName,
      toolName: event.toolName ?? null,
      phase: late ? "stop" : event.hookType,
      payload: JSON.stringify({ hookType: late ? "stop" : event.hookType, toolName: late ? null : event.toolName ?? null }),
      sortOrder: this.narrative.nextSortOrder(event.threadId),
    });
    return true;
  }

  private applyHookCompleted(event: Extract<AgentEvent, { type: "hookCompleted" }>): boolean {
    const open = this.narrative.peekOpenHook(event.threadId, event.hookName);
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
    this.narrative.pushClosedHook(event.threadId, { ...completed, messageId: "" });
    this.narrative.removeOpenHook(event.threadId, event.hookName);
    if (this.turnCompleteSeenByThread.has(event.threadId)) {
      this.ownedLateHookCompletions.add(event);
      this.lateHookCompletions.schedule(event.threadId, completed, this.fileEffects.previousFinalization(event.threadId));
    }
    return true;
  }

  private applyToolResult(event: Extract<AgentEvent, { type: "toolResult" }>): boolean {
    if (!this.runtime.consumeEarlyFileEffect(event)) this.fileEffects.observeToolResult(event);
    this.narrative.updateBufferedToolCallOutput(
      event.threadId,
      event.toolCallId,
      event.output,
      event.isError,
      event.toolInput,
      toolResultMetadata(event),
    );
    this.featureEffects.onToolResult(event.threadId, event.toolCallId, event.output, event.isError);
    return true;
  }

  private applyTurnStarted(event: Extract<AgentEvent, { type: "turnStarted" }>): boolean {
    if (!this.runtime.admitProviderTurn(event.threadId)) return false;
    if (!this.runtime.consumeEarlyFileEffect(event)) this.fileEffects.beginResumed(event.threadId);
    this.runtime.markProviderTurnActive(event.threadId);
    this.narrative.resetTurnCounters(event.threadId);
    this.turnCompleteSeenByThread.delete(event.threadId);
    this.finalResponseExecutionByThread.delete(event.threadId);
    this.terminalFinalizedThreads.delete(event.threadId);
    return true;
  }

  private applyTurnComplete(event: Extract<AgentEvent, { type: "turnComplete" }>): boolean {
    if (this.runtime.shouldSuppressStoppingTerminal(event.threadId, event.turnExecutionId)) return false;
    if (this.runtime.shouldSuppressTurnComplete(event.threadId)) return false;
    const compacting = this.compactionInProgressByThread.has(event.threadId);
    if (compacting) {
      this.turnCompleteSeenByThread.add(event.threadId);
      this.recordContextUsage(event, true);
      return false;
    }
    if (!this.runtime.completeProviderTurn(event)) return false;
    this.turnCompleteSeenByThread.add(event.threadId);
    void this.runtime.finalizeTerminalTurn(event.threadId, "completed", "turnComplete");
    this.featureEffects.refreshAfterTurn(event.threadId);
    this.recordContextUsage(event, false);
    return true;
  }

  private applyError(event: Extract<AgentEvent, { type: "error" }>): boolean {
    if (this.runtime.shouldSuppressStoppingTerminal(event.threadId, event.turnExecutionId)) return false;
    if (this.runtime.suppressTransientError(event)) return false;
    if (!this.runtime.failProviderTurn(event)) return false;
    void this.runtime.finalizeTerminalTurn(event.threadId, "errored", "error");
    this.runtime.clearTerminalState(event.threadId);
    return true;
  }

  private applyCompacting(event: Extract<AgentEvent, { type: "compacting" }>): boolean {
    if (event.active) {
      this.lastContextByThread.set(event.threadId, 0);
      this.compactionInProgressByThread.add(event.threadId);
      return true;
    }
    this.compactionInProgressByThread.delete(event.threadId);
    try {
      this.conversationProjection.persistCompactionDivider(event.threadId);
    } catch (error) {
      logger.error("Failed to persist compaction system message", {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  private applyCompactSummary(event: Extract<AgentEvent, { type: "compactSummary" }>): boolean {
    try {
      this.runtimePersistence.recordCompactionSummary(event.threadId, event.summary);
    } catch (error) {
      logger.error("Failed to persist compaction summary", {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  private applySystem(providerId: ProviderId, event: Extract<AgentEvent, { type: "system" }>): boolean {
    this.sessionCursors.apply(providerId, event, this.runtime.snapshot(event.threadId)?.turnExecutionId ?? undefined);
    return true;
  }

  private applyEnded(event: Extract<AgentEvent, { type: "ended" }>): boolean {
    if (this.runtime.shouldSuppressStoppingTerminal(event.threadId, event.turnExecutionId)) return false;
    if (this.runtime.shouldSuppressTurnEnded(event.threadId)) return false;
    const accepted = this.runtime.endProviderTurn(event);
    if (!accepted || event.outcome === undefined) return accepted;
    const outcome = event.outcome === "cancelled" ? "interrupted" : event.outcome;
    void this.runtime.finalizeTerminalTurn(event.threadId, outcome, "ended");
    this.runtime.clearTerminalState(event.threadId);
    return true;
  }

  private prepareTerminalText(event: AgentEvent, publish: boolean, terminal: boolean): boolean {
    if (!publish || !terminal || !event.turnExecutionId) return true;
    if (this.parentAssistantText.finish(event.turnExecutionId)) return true;
    if (this.parentAssistantText.durabilityMode(event.turnExecutionId) !== "unsaved") {
      this.runtime.stopForEventApplicationFailure(
        event,
        "Assistant text recovery remained unavailable at turn finalization",
      );
    }
    return false;
  }

  private checkpointNarrative(event: AgentEvent, publish: boolean): boolean {
    if (!publish || this.isUnsavedNarrationBoundary(event)) return true;
    try {
      this.parentNarrativeRecovery.checkpoint(event);
      return true;
    } catch {
      this.runtime.stopForEventApplicationFailure(event, "Parent narrative recovery checkpoint failed");
      return false;
    }
  }

  private publishAfterDurability(event: AgentEvent, terminal: boolean): void {
    if (!terminal && !this.isLateHook(event)) {
      this.publish(event);
      return;
    }
    const finalization = this.fileEffects.previousFinalization(event.threadId);
    if (!finalization) {
      this.publish(event);
      return;
    }
    void finalization.then((persisted) => {
      if (persisted) this.publish(event);
    });
  }

  private publish(event: AgentEvent): void {
    this.publication.publish(
      event.type === AgentEventType.Ended && event.outcome === "cancelled"
        ? { ...event, outcome: "interrupted" }
        : event,
    );
  }

  private recordDiagnostic(input: ProviderEventIngressEvent, event: AgentEvent): void {
    if (input.sourceKind === "canonical-commit" && input.canonicalReceipt) return;
    if (!event.turnExecutionId) return;
    this.parentDurability.recordProviderDiagnostic({
      executionId: event.turnExecutionId,
      event,
      terminal: isTerminal(event),
    });
  }

  private prepareSanitizedEvent(event: AgentEvent): AgentEvent {
    if (event.type === AgentEventType.ToolUse && event.toolName === "Agent") {
      return {
        ...event,
        subagentPresentation: createSubagentPresentation(event.toolInput, event.toolCallId),
      };
    }
    if (event.type !== AgentEventType.ToolResult || !event.toolInput) return event;
    const bufferedAgent = this.narrative.getBufferedToolCalls(event.threadId)
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

  private queueParentAssistantText(
    event: Extract<AgentEvent, { type: "textDelta" }>,
    publish: () => void,
  ): boolean | "blocked" | undefined {
    return this.parentAssistantText.queueText(
      event,
      publish,
      (reason) => this.runtime.stopForEventApplicationFailure(event, reason),
    );
  }

  private recordUnclassifiedAssistantText(event: Extract<AgentEvent, { type: "textDelta" }>): void {
    const executionId = event.turnExecutionId;
    const sequence = executionId ? this.parentAssistantText.sequence(executionId) : undefined;
    if (executionId && sequence && !this.unclassifiedAssistantTextStartByExecution.has(executionId)) {
      this.unclassifiedAssistantTextStartByExecution.set(executionId, sequence);
    }
  }

  private classifyUnclassifiedAssistantTextAsNarration(
    event: Extract<AgentEvent, { type: "assistantMessageBoundary" }>,
  ): boolean {
    const executionId = event.turnExecutionId;
    if (!executionId) return this.clearUnclassifiedAssistantText(event.threadId);
    const firstSequence = this.unclassifiedAssistantTextStartByExecution.get(executionId);
    if (!firstSequence) return this.clearUnclassifiedAssistantText(event.threadId);
    if (this.parentAssistantText.durabilityMode(executionId) === "unsaved") {
      const staged = this.narrative.stageNarrationSegment(event.threadId, this.finalizer.getStreamingText(event.threadId));
      if (staged) this.narrative.applyStagedNarrationSegment(event.threadId, staged);
      this.parentAssistantText.resetSequence(executionId);
      this.unclassifiedAssistantTextStartByExecution.delete(executionId);
      this.finalizer.resetStreamingText(event.threadId);
      return true;
    }
    const text = this.parentAssistantText.checkpoints.restoreChunks(executionId)
      .filter((chunk) => chunk.lastSequence >= firstSequence)
      .map((chunk) => chunk.text)
      .join("");
    const staged = this.narrative.stageNarrationSegment(event.threadId, text);
    let confirm: (() => void) | undefined;
    try {
      this.db.transaction(() => {
        const checkpoint = this.parentNarrativeRecovery.prepareCheckpoint(
          event,
          staged ? this.narrative.recoverySnapshotWithStagedNarration(event.threadId, staged) : undefined,
        );
        checkpoint?.persist();
        if (!this.parentAssistantText.checkpoints.resetInTransaction(executionId)) {
          throw new Error(`Unclassified assistant text checkpoint was not reset: ${executionId}`);
        }
        confirm = checkpoint?.confirm;
      })();
    } catch {
      this.runtime.stopForEventApplicationFailure(event, "Parent narrative recovery checkpoint failed");
      return false;
    }
    this.parentAssistantText.checkpoints.discardRecoveryJournal(executionId);
    this.parentAssistantText.discard(executionId);
    confirm?.();
    if (staged) this.narrative.applyStagedNarrationSegment(event.threadId, staged);
    this.unclassifiedAssistantTextStartByExecution.delete(executionId);
    this.finalizer.resetStreamingText(event.threadId);
    return true;
  }

  private clearUnclassifiedAssistantText(threadId: string): true {
    this.narrative.closeOpenThought(threadId);
    this.finalizer.resetStreamingText(threadId);
    return true;
  }

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

  private clearFinalizedEventState(threadId: string, executionId: string | null | undefined): void {
    if (executionId) {
      this.parentAssistantText.discard(executionId);
      this.unclassifiedAssistantTextStartByExecution.delete(executionId);
      this.runtime.discardEventPipeline(threadId, executionId);
      this.parentNarrativeRecovery.clear(executionId);
    }
    if (this.finalResponseExecutionByThread.get(threadId) === executionId) {
      this.finalResponseExecutionByThread.delete(threadId);
    }
  }

  private isPostTurnGoalReceipt(event: Extract<AgentEvent, { type: "message" }>): boolean {
    return this.turnCompleteSeenByThread.has(event.threadId)
      && /^Goal achieved in \d+s\.$/.test(event.content.trim());
  }

  private isLateHook(event: AgentEvent): boolean {
    return this.turnCompleteSeenByThread.has(event.threadId)
      && (event.type === AgentEventType.HookStarted || event.type === AgentEventType.HookCompleted);
  }

  private isUnsavedNarrationBoundary(event: AgentEvent): boolean {
    return event.type === AgentEventType.AssistantMessageBoundary
      && event.isFinalResponse === false
      && event.turnExecutionId !== undefined
      && this.parentAssistantText.durabilityMode(event.turnExecutionId) === "unsaved";
  }
}

function isTerminal(event: AgentEvent): boolean {
  return event.type === AgentEventType.TurnComplete
    || event.type === AgentEventType.Error
    || (event.type === AgentEventType.Ended && event.outcome !== undefined);
}
