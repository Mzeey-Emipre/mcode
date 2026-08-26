import { useCallback } from "react";
import { getHandoffStatus, getThreadRecord } from "@/features/conversation/state";
import { useThreadStore } from "@/stores/threadStore";
import { useHandoffQueuedSend, type HandoffQueuedSend } from "../queue/useHandoffQueuedSend";
import {
  dispatchHandoffQueuedSend,
  retainFailedHandoffQueuedSend,
} from "./handoff-queued-send-dispatch";

type HandoffStatus = "generating" | "ready" | "fallback" | "error" | undefined;

/** Inputs that connect handoff readiness to a Composer send. */
export interface UseComposerHandoffDispatchOptions {
  threadId?: string;
  handoffStatus: HandoffStatus;
}

/** Queues a child-thread submit until handoff context is ready, then dispatches it exactly once. */
export function useComposerHandoffDispatch({
  threadId,
  handoffStatus,
}: UseComposerHandoffDispatchOptions): {
  queuedSend: HandoffQueuedSend | null;
  queueIfGenerating(queued: HandoffQueuedSend): boolean;
} {
  const getCurrentHandoffStatus = useCallback(
    () =>
      threadId
        ? getHandoffStatus(getThreadRecord(useThreadStore.getState().records, threadId))
        : undefined,
    [threadId],
  );
  const dispatch = useCallback(
    async (queued: HandoffQueuedSend) => {
      if (!threadId) return;
      try {
        await dispatchHandoffQueuedSend(threadId, queued);
      } catch {
        retainFailedHandoffQueuedSend(threadId, queued);
      }
    },
    [threadId],
  );

  return useHandoffQueuedSend({
    threadId,
    handoffStatus,
    getCurrentHandoffStatus,
    onDispatch: dispatch,
  });
}
