import type { MessageMention, PreviewAnnotationBundle } from "@mcode/contracts";
import { collectBrowserCaptureSpillPaths, releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import { stripPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";
import { useQueueStore } from "@/stores/queueStore";
import { useReplyStore } from "@/stores/replyStore";
import { useToastStore } from "@/stores/toastStore";
import type { ComposerAgentSelection, ComposerFormController } from "../draft/useComposerFormController";
import type { ComposerQueueEdit } from "../queue/useComposerQueueEditing";
import type { HandoffQueuedSend } from "../queue/useHandoffQueuedSend";
import type { ComposerReplyContext, PreparedComposerSubmission } from "./composer-submission-types";

/** Inputs for creating a deferred handoff payload. */
export interface CreateHandoffQueuedSendOptions {
  submission: PreparedComposerSubmission;
  replyContext?: ComposerReplyContext;
}

/** Inputs for persisting a queued existing-thread submit. */
export interface QueueComposerSubmissionOptions {
  threadId?: string;
  editing: ComposerQueueEdit | null;
  submission: PreparedComposerSubmission;
  replyContext?: ComposerReplyContext;
}

/** Inputs for finishing a Composer submit that entered a queue. */
export interface CompleteQueuedComposerSubmissionOptions {
  threadId?: string;
  annotationScopeId?: string;
  annotations?: PreviewAnnotationBundle;
  goalObjective?: string;
  editing: ComposerQueueEdit | null;
  form: ComposerFormController;
  finishEditing(): void;
}

/** Creates the full payload retained while a child-thread handoff is generating. */
export function createHandoffQueuedSend({
  submission,
  replyContext,
}: CreateHandoffQueuedSendOptions): HandoffQueuedSend {
  const { snapshot, prepared } = submission;
  const browserCaptureSpillPaths = collectBrowserCaptureSpillPaths(prepared.browserCaptures);
  return {
    content: prepared.content,
    displayContent: prepared.displayContent,
    mentions: snapshot.mentions,
    previewAnnotations: submission.previewAnnotations,
    goalObjective: submission.goalObjective,
    orchestrationMode: snapshot.selection.orchestrationMode,
    attachments: submission.attachmentMetas,
    selection: snapshot.selection,
    replyToMessageId: replyContext?.messageId,
    quotedText: replyContext?.quotedText,
    browserCaptureSpillPaths: browserCaptureSpillPaths.length > 0 ? browserCaptureSpillPaths : undefined,
  };
}

/** Persists a prepared Composer submit in its target thread's queue. */
export function queueComposerSubmission({
  threadId,
  editing,
  submission,
  replyContext,
}: QueueComposerSubmissionOptions): boolean {
  if (!threadId) return false;
  const spillPaths = collectBrowserCaptureSpillPaths(submission.prepared.browserCaptures);
  const payload = createPersistentQueuePayload(submission, replyContext, spillPaths);
  const enqueued = editing
    ? useQueueStore.getState().insertAt(threadId, editing.originalIndex, payload)
    : useQueueStore.getState().enqueue(threadId, payload);
  if (!enqueued) void releaseBrowserCaptureSpills(spillPaths);
  return enqueued;
}

/** Applies the shared UI cleanup after a queued submit is accepted. */
export function completeQueuedComposerSubmission({
  threadId,
  annotationScopeId,
  annotations,
  goalObjective,
  editing,
  form,
  finishEditing,
}: CompleteQueuedComposerSubmissionOptions): void {
  form.clear("dispatch");
  clearQueuedAnnotations(annotationScopeId, annotations);
  if (goalObjective) form.setGoalPending(false);
  if (editing) showQueueEditSaved(editing);
  finishEditing();
  if (threadId) useReplyStore.getState().clearReply(threadId);
  form.focus();
}

/** Maps a prepared submit onto the persistent queue-store representation. */
function createPersistentQueuePayload(
  submission: PreparedComposerSubmission,
  replyContext: ComposerReplyContext | undefined,
  browserCaptureSpillPaths: string[],
) {
  const { snapshot, prepared } = submission;
  const selection = snapshot.selection;
  return {
    content: stripPreviewAnnotationFence(prepared.content),
    displayContent: prepared.displayContent,
    mentions: optionalMentions(snapshot.mentions),
    previewAnnotations: submission.previewAnnotations,
    attachments: submission.attachmentMetas,
    model: selection.modelId,
    permissionMode: selection.permissionMode,
    reasoningLevel: selection.reasoning,
    orchestrationMode: selection.orchestrationMode,
    provider: selection.provider,
    copilotAgent: optionalCopilotAgent(selection),
    contextWindow: selection.contextWindow ?? undefined,
    thinking: selection.thinking ?? undefined,
    codexFastMode: optionalCodexFastMode(selection),
    goalObjective: submission.goalObjective,
    replyToMessageId: replyContext?.messageId,
    quotedText: replyContext?.quotedText,
    browserCaptureSpillPaths: browserCaptureSpillPaths.length > 0 ? browserCaptureSpillPaths : undefined,
  };
}

/** Returns mentions only when the queue entry has at least one. */
function optionalMentions(mentions: MessageMention[]): MessageMention[] | undefined {
  return mentions.length > 0 ? mentions : undefined;
}

/** Keeps the Copilot choice scoped to Copilot submissions. */
function optionalCopilotAgent(selection: ComposerAgentSelection): string | undefined {
  return selection.provider === "copilot" ? selection.copilotAgent ?? undefined : undefined;
}

/** Keeps fast-mode metadata scoped to Codex submissions. */
function optionalCodexFastMode(selection: ComposerAgentSelection): boolean | undefined {
  return selection.provider === "codex" ? selection.codexFastMode ?? undefined : undefined;
}

/** Clears displayed annotations when their queued payload has been retained. */
function clearQueuedAnnotations(
  annotationScopeId: string | undefined,
  annotations: PreviewAnnotationBundle | undefined,
): void {
  if (!annotationScopeId || !annotations) return;
  usePreviewAnnotationStore.getState().clearThread(annotationScopeId);
  usePreviewDesignModeStore.getState().setActive(annotationScopeId, false);
}

/** Shows the original slot when a queued message was edited in place. */
function showQueueEditSaved(editing: ComposerQueueEdit): void {
  useToastStore.getState().show(
    "info",
    "Saved to queue",
    `Slot ${String(editing.originalIndex + 1).padStart(2, "0")}`,
  );
}
