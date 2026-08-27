import { inject, injectable } from "tsyringe";
import { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { ParentAssistantTextCheckpointService } from "../turns/parent-assistant-text-checkpoint-service.js";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { deriveTurnAssistantMessageId } from "../turns/turn-assistant-message-id.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import type { SendMessageCommand } from "../orchestration/agent-service.js";
import type { TurnRecovery } from "@mcode/contracts";

const UNPROVED_EXECUTION_REASON =
  "The provider could not prove that this execution was still active after restart.";

/** Reconciles durable turn checkpoints after a server process restart. */
@injectable()
export class TurnRecoveryService {
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
    for (const checkpoint of this.canonicalSink.listUnmaterializedTerminalCheckpoints()) {
      const checkpointChunks = this.parentAssistantTextCheckpoints.restoreChunks(checkpoint.executionId);
      const recoveredNarrative = this.canonicalSink.loadParentNarrativeRecovery(checkpoint.turnId);
      if (checkpointChunks.length === 0 && recoveredNarrative.length === 0) continue;
      if (!this.canonicalSink.reopenUnmaterializedTerminalCheckpoint(checkpoint.executionId)) {
        throw new Error(`Unmaterialized terminal checkpoint was not recoverable: ${checkpoint.executionId}`);
      }
    }
    this.parentAssistantTextCheckpoints.retireTerminalCheckpoints();
    const interrupted: string[] = [];
    for (const checkpoint of this.canonicalSink.listUnfinishedCheckpoints()) {
      const checkpointChunks = this.parentAssistantTextCheckpoints.restoreChunks(checkpoint.executionId);
      const canonicalAssistant = this.canonicalSink.loadTerminalProjection(checkpoint.turnId).message;
      const recoveredNarrative = this.canonicalSink.loadParentNarrativeRecovery(checkpoint.turnId);
      const recoveredText = canonicalAssistant
        ? ""
        : checkpointChunks.map((chunk) => chunk.text).join("");
      const stagedAssistant = !canonicalAssistant && (recoveredText.length > 0 || recoveredNarrative.length > 0)
        ? this.stageRecoveredAssistantProjection(checkpoint.threadId, checkpoint.executionId, recoveredText)
        : undefined;
      this.canonicalSink.markUnresolvedCodexChildDeliveriesUnknown(checkpoint.executionId);
      this.canonicalSink.interruptUnfinishedExecution(
        checkpoint.executionId,
        UNPROVED_EXECUTION_REASON,
        stagedAssistant,
        (assistant, interruptedNarrative) => {
          if (recoveredNarrative.length > 0) {
            this.narrativeStore.persistRecoveredNarrative(assistant.id, interruptedNarrative);
          }
        },
        recoveredNarrative,
      );
      if (checkpointChunks.length > 0 && !this.parentAssistantTextCheckpoints.retire(checkpoint.executionId)) {
        throw new Error(`Recovered assistant text checkpoint was not retired: ${checkpoint.executionId}`);
      }
      this.threadRepo.updateStatus(checkpoint.threadId, "interrupted");
      interrupted.push(checkpoint.executionId);
    }
    return { interrupted };
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

  /** List explicit actions for interrupted and errored executions. */
  listRecoveries(): TurnRecovery[] {
    return this.canonicalSink.listInterruptedCheckpoints().map((checkpoint) => ({
      threadId: checkpoint.threadId,
      executionId: checkpoint.executionId,
      acceptedThrough: checkpoint.lastAcceptedSequence,
      durableThrough: checkpoint.lastDurableSequence,
      phase: checkpoint.phase,
      error: checkpoint.error,
      actions: ["retry" as const],
    }));
  }

  /** Dispatch an interrupted turn's accepted user input as a new provider execution. */
  async retry(
    executionId: string,
    dispatch: (command: SendMessageCommand) => Promise<void>,
  ): Promise<void> {
    const checkpoint = this.canonicalSink
      .listInterruptedCheckpoints()
      .find((candidate) => candidate.executionId === executionId);
    if (!checkpoint) throw new Error(`Recoverable execution not found: ${executionId}`);
    const message = this.canonicalSink.loadUserMessage(checkpoint.turnId);
    if (!message) throw new Error(`Accepted user input not found: ${executionId}`);
    const thread = this.threadRepo.findById(checkpoint.threadId);
    if (!thread || !["interrupted", "errored"].includes(thread.status)) {
      throw new Error(`Recoverable thread not found: ${checkpoint.threadId}`);
    }
    const attachments = this.attachmentService.prepareRetryAttachments(
      thread.id,
      message.attachments ?? [],
    );
    await dispatch({
      threadId: thread.id,
      content: message.content,
      model: thread.model ?? undefined,
      permissionMode: thread.permission_mode ?? undefined,
      attachments,
      reasoningLevel: thread.reasoning_level ?? undefined,
      provider: thread.provider as SendMessageCommand["provider"],
      interactionMode: thread.interaction_mode ?? undefined,
      orchestrationMode: thread.orchestration_mode ?? undefined,
      copilotAgent: thread.copilot_agent ?? undefined,
      contextWindow: thread.context_window_mode ?? undefined,
      thinking: thread.thinking ?? undefined,
      codexFastMode: thread.codex_fast_mode ?? undefined,
      replyToMessageId: message.reply_to_message_id ?? undefined,
      quotedText: message.quoted_text ?? undefined,
      mentions: message.mentions ?? undefined,
      previewAnnotations: message.previewAnnotations ?? undefined,
      forceFreshSession: true,
      retryOfExecutionId: executionId,
    });
  }
}
