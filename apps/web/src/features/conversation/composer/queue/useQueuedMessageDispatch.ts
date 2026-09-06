import { useCallback } from "react";
import type { QueuedMessage } from "@/stores/queueStore";
import { useQueueStore } from "@/stores/queueStore";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";

/** Dispatches queued messages while preserving queue order. */
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
          undefined,
          undefined,
          undefined,
          message.mentions,
          message.previewAnnotations,
          message.goalObjective,
          message.orchestrationMode,
          undefined,
          message.approvalReviewMode,
        );
        useQueueStore.getState().settleQueuedDispatch(threadId, message.id, sent);
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
