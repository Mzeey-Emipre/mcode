import { inject, injectable } from "tsyringe";
import { CanonicalAgentEventSink } from "../canonical/canonical-agent-event-sink.js";
import { ThreadRepo } from "../../../repositories/thread-repo.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import type { SendMessageCommand } from "../orchestration/agent-service.js";
import type { TurnRecovery } from "@mcode/contracts";

const UNPROVED_EXECUTION_REASON =
  "The provider could not prove that this execution was still active after restart.";

/** Reconciles durable turn checkpoints after a server process restart. */
@injectable()
export class TurnRecoveryService {
  constructor(
    @inject(CanonicalAgentEventSink) private readonly canonicalSink: CanonicalAgentEventSink,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
  ) {}

  /** Interrupt executions for which no current provider can prove the exact live execution. */
  reconcileOnStartup(): { interrupted: string[] } {
    const interrupted: string[] = [];
    for (const checkpoint of this.canonicalSink.listUnfinishedCheckpoints()) {
      this.canonicalSink.markUnresolvedCodexChildDeliveriesUnknown(checkpoint.executionId);
      this.canonicalSink.interruptUnfinishedExecution(
        checkpoint.executionId,
        UNPROVED_EXECUTION_REASON,
      );
      this.threadRepo.updateStatus(checkpoint.threadId, "interrupted");
      interrupted.push(checkpoint.executionId);
    }
    return { interrupted };
  }

  /** List explicit actions for interrupted executions. */
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
    if (!checkpoint) throw new Error(`Interrupted execution not found: ${executionId}`);
    const message = this.canonicalSink.loadUserMessage(checkpoint.turnId);
    if (!message) throw new Error(`Accepted user input not found: ${executionId}`);
    const thread = this.threadRepo.findById(checkpoint.threadId);
    if (!thread || thread.status !== "interrupted") {
      throw new Error(`Interrupted thread not found: ${checkpoint.threadId}`);
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
