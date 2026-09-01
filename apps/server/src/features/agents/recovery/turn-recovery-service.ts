import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { ParentAssistantTextCheckpointService } from "../turns/parent-assistant-text-checkpoint-service.js";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { deriveTurnAssistantMessageId } from "../turns/turn-assistant-message-id.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import type { SendMessageCommand } from "../orchestration/agent-service.js";
import type { RecoveryIncident } from "@mcode/contracts";

const UNPROVED_EXECUTION_REASON =
  "The provider could not prove that this execution was still active after restart.";

/** Reconciles durable turn checkpoints after a server process restart. */
@injectable()
export class TurnRecoveryService {
  private currentIncident: RecoveryIncident | null = null;

  constructor(
    @inject(CanonicalAgentBoundary) private readonly canonicalSink: CanonicalAgentBoundary,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
    @inject(ParentAssistantTextCheckpointService)
    private readonly parentAssistantTextCheckpoints: ParentAssistantTextCheckpointService,
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(NarrativeStore) private readonly narrativeStore: NarrativeStore,
  ) {}

  /** Interrupt executions for which no current provider can prove the exact live execution. */
  reconcileOnStartup(): { interrupted: string[] } {
    this.parentAssistantTextCheckpoints.importRecoveryJournals();
    this.reopenMaterializableTerminalCheckpoints();
    this.parentAssistantTextCheckpoints.retireTerminalCheckpoints();
    const checkpoints = this.canonicalSink.listUnfinishedCheckpoints();
    if (checkpoints.length === 0) {
      this.currentIncident = null;
      return { interrupted: [] };
    }
    const incident = { id: NodeCrypto.randomUUID(), createdAt: new Date().toISOString() };
    const interrupted = checkpoints.map((checkpoint) => this.interruptUnfinishedCheckpoint(checkpoint, incident.id));
    const entries = this.canonicalSink.listRecoveryIncidentEntries(incident.id).map((entry) => ({
      ...entry,
      durationMs: this.durationMs(entry.startedAt, entry.interruptedAt),
    }));
    this.currentIncident = entries.length > 0 ? { ...incident, entries } : null;
    return { interrupted };
  }

  private reopenMaterializableTerminalCheckpoints(): void {
    for (const checkpoint of this.canonicalSink.listUnmaterializedTerminalCheckpoints()) {
      const hasChunks = this.parentAssistantTextCheckpoints.restoreChunks(checkpoint.executionId).length > 0;
      const hasNarrative = this.canonicalSink.loadParentNarrativeRecovery(checkpoint.turnId).length > 0;
      if (hasChunks || hasNarrative) this.reopenTerminalCheckpoint(checkpoint.executionId);
    }
  }

  private reopenTerminalCheckpoint(executionId: string): void {
    if (!this.canonicalSink.reopenUnmaterializedTerminalCheckpoint(executionId)) {
      throw new Error(`Unmaterialized terminal checkpoint was not recoverable: ${executionId}`);
    }
  }

  private interruptUnfinishedCheckpoint(
    checkpoint: ReturnType<CanonicalAgentBoundary["listUnfinishedCheckpoints"]>[number],
    recoveryIncidentId: string,
  ): string {
    const checkpointChunks = this.parentAssistantTextCheckpoints.restoreChunks(checkpoint.executionId);
    const canonicalAssistant = this.canonicalSink.loadTerminalProjection(checkpoint.turnId).message;
    const recoveredNarrative = this.canonicalSink.loadParentNarrativeRecovery(checkpoint.turnId);
    const recoveredText = canonicalAssistant ? "" : checkpointChunks.map((chunk) => chunk.text).join("");
    const stagedAssistant = this.stageRecoveredAssistant(
      checkpoint.threadId,
      checkpoint.executionId,
      canonicalAssistant !== null,
      recoveredText,
      recoveredNarrative.length,
    );
    this.canonicalSink.markUnresolvedCodexChildDeliveriesUnknown(checkpoint.executionId);
    this.canonicalSink.interruptUnfinishedExecution(
      checkpoint.executionId,
      UNPROVED_EXECUTION_REASON,
      stagedAssistant,
      this.persistInterruptedNarrative(recoveredNarrative.length),
      recoveredNarrative,
      recoveryIncidentId,
    );
    this.retireRecoveredChunks(checkpoint.executionId, checkpointChunks.length);
    this.threadRepo.updateStatus(checkpoint.threadId, "interrupted");
    return checkpoint.executionId;
  }

  private stageRecoveredAssistant(
    threadId: string,
    executionId: string,
    hasCanonicalAssistant: boolean,
    recoveredText: string,
    narrativeCount: number,
  ) {
    if (hasCanonicalAssistant || (recoveredText.length === 0 && narrativeCount === 0)) return undefined;
    return this.stageRecoveredAssistantProjection(threadId, executionId, recoveredText);
  }

  private persistInterruptedNarrative(recoveredNarrativeCount: number) {
    return (assistant: { id: string }, interruptedNarrative: Parameters<NarrativeStore["persistRecoveredNarrative"]>[1]) => {
      if (recoveredNarrativeCount > 0) {
        this.narrativeStore.persistRecoveredNarrative(assistant.id, interruptedNarrative);
      }
    };
  }

  private retireRecoveredChunks(executionId: string, chunkCount: number): void {
    if (chunkCount === 0) return;
    if (!this.parentAssistantTextCheckpoints.retire(executionId)) {
      throw new Error(`Recovered assistant text checkpoint was not retired: ${executionId}`);
    }
  }

  /** Stage recovered visible content before the canonical interruption makes it visible. */
  private stageRecoveredAssistantProjection(threadId: string, executionId: string, content: string) {
    const sequence = this.messageRepo.getLatestSequenceIncludingInternal(threadId) + 1;
    const messageId = deriveTurnAssistantMessageId(
      threadId,
      `recovery:${executionId}`,
    );
    this.messageRepo.createAssistantIdempotent({
      id: messageId,
      threadId,
      content,
      sequence,
      model: this.threadRepo.findById(threadId)?.model ?? null,
      isInternal: true,
    });
    const staged = this.messageRepo
      .listIncludingInternal(threadId)
      .find((message) => message.id === messageId);
    if (!staged) throw new Error(`Recovered assistant message was not staged: ${messageId}`);
    if (staged.content !== content) {
      throw new Error(`Recovered assistant text conflicts with staged message: ${messageId}`);
    }
    return staged;
  }

  /** Read the immutable incident created by this server startup. */
  currentRecoveryIncident(): RecoveryIncident | null {
    return this.currentIncident;
  }

  private durationMs(startedAt: string, interruptedAt: string): number {
    const durationMs = Date.parse(interruptedAt) - Date.parse(startedAt);
    if (!Number.isFinite(durationMs)) {
      throw new Error(`Recovery incident has invalid turn timestamps: ${startedAt}, ${interruptedAt}`);
    }
    return Math.max(0, durationMs);
  }

  /** Dispatch an interrupted turn's accepted user input as a new provider execution. */
  async retry(
    executionId: string,
    dispatch: (command: SendMessageCommand) => Promise<void>,
  ): Promise<void> {
    const checkpoint = this.canonicalSink.loadCheckpoint(executionId);
    if (!checkpoint || !["interrupted", "errored"].includes(checkpoint.phase)) {
      throw new Error(`Recoverable execution not found: ${executionId}`);
    }
    const message = this.canonicalSink.loadUserMessage(checkpoint.turnId);
    if (!message) throw new Error(`Accepted user input not found: ${executionId}`);
    const thread = this.threadRepo.findById(checkpoint.threadId);
    if (!thread || !["interrupted", "errored"].includes(thread.status)) {
      throw new Error(`Recoverable thread not found: ${checkpoint.threadId}`);
    }
    const attachments = this.attachmentService.prepareRetryAttachments(thread.id, message.attachments ?? []);
    await dispatch(this.retryCommand(thread, message, attachments, executionId));
  }

  private retryCommand(
    thread: NonNullable<ReturnType<ThreadRepo["findById"]>>,
    message: NonNullable<ReturnType<CanonicalAgentBoundary["loadUserMessage"]>>,
    attachments: ReturnType<AttachmentService["prepareRetryAttachments"]>,
    executionId: string,
  ): SendMessageCommand {
    return {
      threadId: thread.id,
      content: message.content,
      model: this.optionalValue(thread.model),
      permissionMode: this.optionalValue(thread.permission_mode),
      attachments,
      reasoningLevel: this.optionalValue(thread.reasoning_level),
      provider: thread.provider as SendMessageCommand["provider"],
      interactionMode: this.optionalValue(thread.interaction_mode),
      orchestrationMode: this.optionalValue(thread.orchestration_mode),
      copilotAgent: this.optionalValue(thread.copilot_agent),
      contextWindow: this.optionalValue(thread.context_window_mode),
      thinking: this.optionalValue(thread.thinking),
      codexFastMode: this.optionalValue(thread.codex_fast_mode),
      replyToMessageId: this.optionalValue(message.reply_to_message_id),
      quotedText: this.optionalValue(message.quoted_text),
      mentions: this.optionalValue(message.mentions),
      previewAnnotations: this.optionalValue(message.previewAnnotations),
      forceFreshSession: true,
      retryOfExecutionId: executionId,
    };
  }

  private optionalValue<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
  }
}
