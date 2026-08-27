import { useCallback } from "react";
import type { QueuedMessage } from "@/stores/queueStore";
import { useQueueStore } from "@/stores/queueStore";
import { useReplyStore } from "@/stores/replyStore";
import { useThreadStore } from "@/stores/threadStore";
import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";

/** Dispatches queued messages while preserving queue order and reply cleanup. */
export function useQueuedMessageDispatch(threadId: string | undefined): {
  resumeNext(): Promise<void>;
  sendNow(message: QueuedMessage): Promise<void>;
} {
  const dispatch = useCallback(
    async (message: QueuedMessage): Promise<void> => {
      if (!threadId) return;
      try {
        await useThreadStore.getState().sendMessage(
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
        const activeReply = useReplyStore.getState().getReply(threadId);
        if (message.replyToMessageId && activeReply?.messageId === message.replyToMessageId) {
          useReplyStore.getState().clearReply(threadId);
        }
      } catch {
        void releaseBrowserCaptureSpills(message.browserCaptureSpillPaths ?? []);
      }
    },
    [threadId],
  );

  const resumeNext = useCallback(async (): Promise<void> => {
    if (!threadId) return;
    const next = useQueueStore.getState().dequeueNext(threadId);
    if (next) await dispatch(next);
  }, [dispatch, threadId]);

  const sendNow = useCallback(
    async (message: QueuedMessage): Promise<void> => {
      if (!threadId) return;
      if (useThreadStore.getState().runningThreadIds.has(threadId)) {
        useQueueStore.getState().moveMessage(threadId, message.id, 0);
        return;
      }
      const queued = useQueueStore.getState().popMessage(threadId, message.id);
      if (queued) await dispatch(queued);
    },
    [dispatch, threadId],
  );

  return { resumeNext, sendNow };
}
