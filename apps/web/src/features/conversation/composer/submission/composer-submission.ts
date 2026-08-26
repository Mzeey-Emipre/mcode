import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type { AttachedBrowserCapture, PreviewAnnotationBundle } from "@mcode/contracts";
import { appendBrowserCaptureFence } from "@/features/preview/capture/browser-capture-append";
import { appendPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";

/** Inputs that form the user-visible and provider-facing representations of one Composer submit. */
export interface ComposerSubmissionInput {
  rawInput: string;
  attachments: PendingAttachment[];
  previewAnnotations: PreviewAnnotationBundle | undefined;
}

/** One normalized Composer submit, including browser capture metadata for queue spill cleanup. */
export interface ComposerSubmission {
  content: string;
  displayContent: string;
  browserCaptures: AttachedBrowserCapture[];
}

/** Build the transport payload shared by the immediate-send and queued-send actions. */
export function createComposerSubmission({
  rawInput,
  attachments,
  previewAnnotations,
}: ComposerSubmissionInput): ComposerSubmission {
  const browserCaptures: AttachedBrowserCapture[] = [];
  for (const attachment of attachments) {
    if (!attachment.browserCapture) continue;
    browserCaptures.push({ attachmentId: attachment.id, ...attachment.browserCapture });
  }

  const contentWithCaptures =
    browserCaptures.length === 0
      ? rawInput
      : appendBrowserCaptureFence(rawInput, browserCaptures);

  return {
    content: appendPreviewAnnotationFence(contentWithCaptures, previewAnnotations).trim(),
    displayContent: rawInput.trim(),
    browserCaptures,
  };
}
