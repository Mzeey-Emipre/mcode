import { isGoalControlCommand } from "@/lib/goal-command";
import { useThreadStore } from "@/stores/threadStore";

/** Resolve submit state from both the rendered value and the newest thread-store snapshot. */
export function isThreadRunningForSubmit(
  threadId: string | undefined,
  renderedIsAgentRunning: boolean,
): boolean {
  if (renderedIsAgentRunning) return true;
  return threadId ? useThreadStore.getState().runningThreadIds.has(threadId) : false;
}

/** Decide whether an existing-thread submit must wait behind the active turn. */
export function shouldQueueActiveThreadSubmit(
  threadId: string | undefined,
  renderedIsAgentRunning: boolean,
  branchFromMessageId: string | null | undefined,
  isNewThread: boolean | undefined,
  trimmedContent: string,
): boolean {
  return Boolean(
    isThreadRunningForSubmit(threadId, renderedIsAgentRunning) &&
      threadId &&
      !branchFromMessageId &&
      !isNewThread &&
      !isGoalControlCommand(trimmedContent),
  );
}
