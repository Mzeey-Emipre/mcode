import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import type { AgentEvent } from "@mcode/contracts";

import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { PARENT_TURN_DURABILITY, type ParentTurnDurability } from "./parent-turn-durability.js";
import { TURN_FINALIZER, TurnFinalizer } from "./turn-finalizer.js";

/** Owns conversation-message projection for normalized provider events. */
@injectable()
export class TurnConversationProjectionService {
  constructor(
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    @inject(MessageRepo) private readonly messages: MessageRepo,
    @inject(TURN_FINALIZER) private readonly finalizer: TurnFinalizer,
    @inject(PARENT_TURN_DURABILITY) private readonly parentTurns: ParentTurnDurability,
  ) {}

  /** Assign renderer identity and buffer a provider assistant message until terminal materialization. */
  bufferAssistantMessage(
    event: Extract<AgentEvent, { type: "message" }>,
    postTurnGoalReceipt: boolean,
  ): void {
    const model = this.threads.findById(event.threadId)?.model ?? null;
    if (postTurnGoalReceipt) {
      this.materializeGoalReceipt(event, model);
      return;
    }
    const attachments = this.finalizer.getBufferedAssistantAttachments(event.threadId);
    const messageId = this.finalizer.bufferAssistantBody(event.threadId, event.content, model, attachments);
    event.messageId = messageId;
    event.model = model;
    if (attachments.length > 0) event.attachments = attachments;
    this.finalizer.resetStreamingText(event.threadId);
  }

  /** Persist the divider that marks a completed provider compaction. */
  persistCompactionDivider(threadId: string): void {
    const sequence = this.messages.getLatestSequenceIncludingInternal(threadId) + 1;
    this.messages.create(threadId, "system", "Context compacted", sequence);
  }

  /** Persist a bounded provider notice before it is published to the client. */
  persistSystemNotice(event: Extract<AgentEvent, { type: "system" }>): void {
    const sequence = this.messages.getLatestSequenceIncludingInternal(event.threadId) + 1;
    event.messageId = this.messages.createSystemNotice(
      event.threadId, event.message ?? "", sequence, event.systemNotice,
    ).id;
  }

  /** Remove diagnostics from a previous provider session before publishing startup. */
  beginNoticeSession(event: Extract<AgentEvent, { type: "system" }>): void {
    this.messages.beginNoticeSession(event.threadId, event.systemNotice?.sessionId);
  }

  /** Start the deterministic reliability harness parent turn with its durable user message. */
  startReliabilityTurn(threadId: string, executionId: string): void {
    const thread = this.threads.findById(threadId);
    if (!thread) throw new Error(`Reliability stream thread not found: ${threadId}`);
    const sequence = this.messages.getLatestSequenceIncludingInternal(threadId) + 1;
    this.parentTurns.startParentTurn({
      thread: {
        id: thread.id,
        workspaceId: thread.workspace_id,
        providerId: thread.provider,
        createdAt: thread.created_at,
      },
      turnId: NodeCrypto.randomUUID(),
      executionId,
      permissionMode: "supervised",
      approvalReviewMode: "manual",
      approvalReviewReason: "manual-requested",
      providerIdentities: [],
      projectUserMessage: () => this.messages.create(
        threadId,
        "user",
        "Reliability harness assistant stream",
        sequence,
      ),
    });
  }

  private materializeGoalReceipt(
    event: Extract<AgentEvent, { type: "message" }>,
    model: string | null,
  ): void {
    const { messages } = this.messages.listByThread(event.threadId, 1);
    const last = messages[messages.length - 1] ?? null;
    const sequence = this.messages.getLatestSequenceIncludingInternal(event.threadId) + 1;
    const receipt = last?.role === "assistant" && last.content === event.content
      ? last
      : this.messages.create(event.threadId, "assistant", event.content, sequence, undefined, undefined, undefined, model);
    event.messageId = receipt.id;
    event.model = model;
  }
}
