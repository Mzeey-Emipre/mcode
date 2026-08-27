import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type { MessageMention, PreviewAnnotationBundle } from "@mcode/contracts";
import { collectBrowserCaptureSpillPaths } from "@/features/preview/capture/browser-capture-spill";
import { stripPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";
import type { QueuedMessage } from "@/stores/queueStore";
import { createComposerSubmission } from "../submission/composer-submission";
import type { ComposerAgentSelection } from "../draft/composer-selection-state";

/** Reply context that remains attached to a queued Composer message. */
export interface QueuedComposerReplyContext {
  messageId: string;
  quotedText?: string;
}

/** Inputs that serialize one Composer form into durable queue state. */
export interface QueuedComposerSerializationInput {
  attachments: PendingAttachment[];
  input: string;
  mentions: MessageMention[];
  previewAnnotations?: PreviewAnnotationBundle;
  selection: ComposerAgentSelection;
  goalPending: boolean;
  replyContext?: QueuedComposerReplyContext;
}

function serializeQueuedAttachments(
  attachments: readonly PendingAttachment[],
): QueuedMessage["attachments"] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sourcePath: attachment.filePath ?? "",
  }));
}

function serializeQueuedSelection(
  selection: ComposerAgentSelection,
): Pick<
  QueuedMessage,
  | "model"
  | "permissionMode"
  | "reasoningLevel"
  | "orchestrationMode"
  | "provider"
  | "copilotAgent"
  | "contextWindow"
  | "thinking"
  | "codexFastMode"
> {
  return {
    model: selection.modelId,
    permissionMode: selection.permissionMode,
    reasoningLevel: selection.reasoning,
    orchestrationMode: selection.orchestrationMode,
    provider: selection.provider,
    copilotAgent:
      selection.provider === "copilot" ? selection.copilotAgent ?? undefined : undefined,
    contextWindow: selection.contextWindow ?? undefined,
    thinking: selection.thinking ?? undefined,
    codexFastMode:
      selection.provider === "codex" ? selection.codexFastMode ?? undefined : undefined,
  };
}

/** Serializes the current Composer form without clearing or mutating its live state. */
export function serializeQueuedComposerForm({
  attachments,
  input,
  mentions,
  previewAnnotations,
  selection,
  goalPending,
  replyContext,
}: QueuedComposerSerializationInput): Omit<QueuedMessage, "id" | "queuedAt"> {
  const submission = createComposerSubmission({
    rawInput: input,
    attachments,
    previewAnnotations,
  });
  const browserCaptureSpillPaths = collectBrowserCaptureSpillPaths(submission.browserCaptures);

  return {
    content: stripPreviewAnnotationFence(submission.content),
    displayContent: submission.displayContent,
    mentions: mentions.length > 0 ? mentions : undefined,
    previewAnnotations,
    attachments: serializeQueuedAttachments(attachments),
    ...serializeQueuedSelection(selection),
    goalObjective: goalPending ? input.trim() : undefined,
    replyToMessageId: replyContext?.messageId,
    quotedText: replyContext?.quotedText,
    browserCaptureSpillPaths:
      browserCaptureSpillPaths.length > 0 ? browserCaptureSpillPaths : undefined,
  };
}
