import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { useToastStore } from "@/stores/toastStore";
import type { ComposerFormController } from "../draft/useComposerFormController";
import { createComposerSubmission } from "./composer-submission";
import type { PreparedComposerSubmission } from "./composer-submission-types";

/** Inputs required to snapshot and validate a Composer submit. */
export interface PrepareComposerSubmissionOptions {
  annotationScopeId?: string;
  form: ComposerFormController;
  isThreadScaffold: boolean;
  discardEmptyEdit(): boolean;
  resolvePreviewAnnotations(
    annotations: PreviewAnnotationBundle | undefined,
  ): PreviewAnnotationBundle | undefined;
}

/** Reads, validates, and normalizes the current Composer form for transport. */
export async function prepareComposerSubmission({
  annotationScopeId,
  form,
  isThreadScaffold,
  discardEmptyEdit,
  resolvePreviewAnnotations,
}: PrepareComposerSubmissionOptions): Promise<PreparedComposerSubmission | null> {
  if (await form.attachmentBindings.awaitPreparation()) return null;

  const snapshot = form.readSubmission();
  const currentAnnotations = readPreviewAnnotations(annotationScopeId);
  const previewAnnotations = resolvePreviewAnnotations(currentAnnotations);
  if (isEmptySubmission(
    snapshot.rawInput,
    snapshot.attachments.length,
    snapshot.selectedTextComments.length,
    previewAnnotations,
  )) {
    discardEmptyEdit();
    return null;
  }
  if (isThreadScaffold) return null;

  try {
    const prepared = createComposerSubmission({
      rawInput: snapshot.rawInput,
      attachments: snapshot.attachments,
      previewAnnotations,
    });
    return {
      snapshot,
      prepared,
      trimmed: snapshot.rawInput.trim(),
      goalObjective: snapshot.goalPending ? snapshot.rawInput.trim() : undefined,
      attachmentMetas: form.snapshotAttachmentMetas(),
      currentAnnotations,
      previewAnnotations,
    };
  } catch (error) {
    showPreparationFailure(error);
    return null;
  }
}

/** Reads the annotation bundle attached to this Composer scope. */
function readPreviewAnnotations(
  annotationScopeId: string | undefined,
): PreviewAnnotationBundle | undefined {
  return annotationScopeId
    ? usePreviewAnnotationStore.getState().buildBundle(annotationScopeId)
    : undefined;
}

/** Determines whether a form snapshot has no message-bearing content. */
function isEmptySubmission(
  rawInput: string,
  attachmentCount: number,
  selectedTextCommentCount: number,
  previewAnnotations: PreviewAnnotationBundle | undefined,
): boolean {
  return rawInput.trim().length === 0
    && attachmentCount === 0
    && selectedTextCommentCount === 0
    && !previewAnnotations;
}

/** Displays a payload-normalization failure without mutating the current draft. */
function showPreparationFailure(error: unknown): void {
  useToastStore.getState().show(
    "error",
    "Could not send message",
    error instanceof Error ? error.message : "Invalid page preview payload",
  );
}
