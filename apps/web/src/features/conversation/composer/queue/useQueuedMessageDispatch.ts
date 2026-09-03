import { useCallback } from "react";
import type { QueuedMessage } from "@/stores/queueStore";
import { useQueueStore } from "@/stores/queueStore";
import { useReplyStore } from "@/stores/replyStore";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";

/** Dispatches queued messages while preserving queue order and reply cleanup. */
export function useQueuedMessageDispatch(threadId: string | undefined): {
  resumeNext(): Promise<void>;
  sendNow(message: QueuedMessage): Promise<void>;
} {
  const dispatch = useCallback(
    async (message: QueuedMessage): Promise<void> => {
      if (!threadId) return;
      try {
        const sent = await useThreadStore.getState().sendMessage(
          threadId,
          message.content,
          message.model,
          message.permissionMode,
          message.attachments.length > 0 ? message.attachments : undefined,
          message.displayContent,
          message.reasoningLevel,
          message.provider,
          message.copilotAgent,
          message.contextWindow,
          message.thinking,
          message.codexFastMode,
          message.replyToMessageId,
          message.quotedText,
          undefined,
          message.mentions,
          message.previewAnnotations,
          message.goalObjective,
          message.orchestrationMode,
        );
        useQueueStore.getState().settleQueuedDispatch(threadId, message.id, sent);
        if (!sent) return;
        const activeReply = useReplyStore.getState().getReply(threadId);
        if (message.replyToMessageId && activeReply?.messageId === message.replyToMessageId) {
          useReplyStore.getState().clearReply(threadId);
        }
      } catch {
        useQueueStore.getState().settleQueuedDispatch(threadId, message.id, false);
      }
    },
    [threadId],
  );

  const resumeNext = useCallback(async (): Promise<void> => {
    if (!threadId) return;
    if (isThreadExecuting(threadId)) return;
    const queueState = useQueueStore.getState();
    const next = queueState.claimNextQueuedMessage(threadId);
    if (!next) return;
    queueState.resumeAutoDrain(threadId);
    await dispatch(next);
  }, [dispatch, threadId]);

  const sendNow = useCallback(
    async (message: QueuedMessage): Promise<void> => {
      if (!threadId) return;
      if (isThreadExecuting(threadId)) {
        useQueueStore.getState().moveMessage(threadId, message.id, 0);
        return;
      }
      const queued = useQueueStore.getState().claimQueuedMessage(threadId, message.id);
      if (queued) await dispatch(queued);
    },
    [dispatch, threadId],
  );

  return { resumeNext, sendNow };
}
