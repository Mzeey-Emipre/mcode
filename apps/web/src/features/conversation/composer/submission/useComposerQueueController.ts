import { useCallback, useMemo } from "react";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
import type { ComposerFormController } from "../draft/useComposerFormController";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";
import { useComposerQueueEditing } from "../queue/useComposerQueueEditing";
import { useQueuedMessageDispatch } from "../queue/useQueuedMessageDispatch";
import { createQueuedComposerPayload, type QueuedComposerReplyContext } from "../queue/createQueuedComposerPayload";
import { useComposerHandoffDispatch } from "./useComposerHandoffDispatch";

type HandoffStatus = "generating" | "ready" | "fallback" | "error" | undefined;

/** Inputs that connect one Composer form to all queue lifecycles. */
export interface UseComposerQueueControllerOptions {
  threadId?: string;
  annotationScopeId?: string;
  handoffStatus: HandoffStatus;
  form: ComposerFormController;
  replyContext?: QueuedComposerReplyContext;
}

/** Owns handoff deferral, queue editing, and explicit queued-message dispatch for one Composer. */
export function useComposerQueueController({
  threadId,
  annotationScopeId,
  handoffStatus,
  form,
  replyContext,
}: UseComposerQueueControllerOptions) {
  const setPreviewDesignModeActive = usePreviewDesignModeStore((state) => state.setActive);
  const clearAnnotations = useCallback(() => {
    if (!annotationScopeId) return;
    usePreviewAnnotationStore.getState().clearThread(annotationScopeId);
    setPreviewDesignModeActive(annotationScopeId, false);
  }, [annotationScopeId, setPreviewDesignModeActive]);
  const restoreAnnotations = useCallback(
    (bundle: PreviewAnnotationBundle | undefined) => {
      if (!annotationScopeId) return;
      const restored = usePreviewAnnotationStore.getState().restoreBundle(annotationScopeId, bundle);
      setPreviewDesignModeActive(annotationScopeId, restored && Boolean(bundle?.annotations.length));
    },
    [annotationScopeId, setPreviewDesignModeActive],
  );
  const formForQueueEdit = useMemo(
    () => ({
      hasContent: () => form.state.hasContent,
      capture: (restoredPreviewAnnotations: PreviewAnnotationBundle | undefined) =>
        createQueuedComposerPayload({
          attachments: form.state.attachments,
          input: form.state.text,
          mentions: form.state.mentions,
          previewAnnotations:
            (annotationScopeId
              ? usePreviewAnnotationStore.getState().buildBundle(annotationScopeId)
              : undefined) ?? restoredPreviewAnnotations,
          selection: form.state.selection,
          goalPending: form.state.goalPending,
          replyContext,
        }),
      restore: form.restoreQueued,
      clear: () => {
        form.clear("queue-cancel");
      },
      invalidateAttachments: form.attachmentBindings.invalidatePreparation,
    }),
    [annotationScopeId, form, replyContext],
  );
  const annotationsForQueueEdit = useMemo(
    () => ({ restore: restoreAnnotations, clear: clearAnnotations }),
    [clearAnnotations, restoreAnnotations],
  );
  const editing = useComposerQueueEditing({
    threadId,
    form: formForQueueEdit,
    annotations: annotationsForQueueEdit,
  });
  const handoff = useComposerHandoffDispatch({
    threadId,
    handoffStatus,
  });
  const dispatch = useQueuedMessageDispatch(threadId);

  return {
    ...editing,
    ...handoff,
    resumeQueuedMessage: dispatch.resumeNext,
    sendQueuedMessageNow: dispatch.sendNow,
    clearAnnotations,
  };
}
