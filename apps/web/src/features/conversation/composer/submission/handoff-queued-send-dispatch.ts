import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import { useQueueStore } from "@/stores/queueStore";
import { useReplyStore } from "@/stores/replyStore";
import type { HandoffQueuedSend } from "../queue/useHandoffQueuedSend";
import { sendComposerThreadMessage } from "./composer-thread-message";

/** Sends a handoff-delayed Composer payload after its child thread is ready. */
export async function dispatchHandoffQueuedSend(
  threadId: string,
  queued: HandoffQueuedSend,
): Promise<void> {
  await sendComposerThreadMessage(threadId, queued);
  clearDispatchedReply(threadId, queued.replyToMessageId);
}

/** Returns a delayed send to the thread queue when its eventual transport fails. */
export function retainFailedHandoffQueuedSend(
  threadId: string,
  queued: HandoffQueuedSend,
): void {
  const retained = useQueueStore.getState().enqueue(
    threadId,
    createHandoffQueuePayload(queued),
  );
  if (!retained) void releaseBrowserCaptureSpills(queued.browserCaptureSpillPaths ?? []);
}

/** Maps a handoff payload onto the persistent thread-queue representation. */
function createHandoffQueuePayload(queued: HandoffQueuedSend) {
  const { selection } = queued;
  return {
    content: queued.content,
    displayContent: queued.displayContent,
    mentions: queued.mentions.length > 0 ? queued.mentions : undefined,
    previewAnnotations: queued.previewAnnotations,
    attachments: queued.attachments,
    model: selection.modelId,
    permissionMode: selection.permissionMode,
    reasoningLevel: selection.reasoning,
    orchestrationMode: queued.orchestrationMode,
    provider: selection.provider,
    copilotAgent: selection.provider === "copilot" ? selection.copilotAgent ?? undefined : undefined,
    contextWindow: selection.contextWindow ?? undefined,
    thinking: selection.thinking ?? undefined,
    codexFastMode: selection.provider === "codex" ? selection.codexFastMode ?? undefined : undefined,
    goalObjective: queued.goalObjective,
    replyToMessageId: queued.replyToMessageId,
    quotedText: queued.quotedText,
    browserCaptureSpillPaths: queued.browserCaptureSpillPaths,
  };
}

/** Removes a reply context only when it still matches the dispatched payload. */
function clearDispatchedReply(threadId: string, replyToMessageId: string | undefined): void {
  const activeReply = useReplyStore.getState().getReply(threadId);
  if (replyToMessageId && activeReply?.messageId === replyToMessageId) {
    useReplyStore.getState().clearReply(threadId);
  }
}
