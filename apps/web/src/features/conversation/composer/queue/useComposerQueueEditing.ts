import { useCallback, useRef, useState } from "react";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import {
  MCODE_BROWSER_CAPTURE_FENCE_CLOSE,
  MCODE_BROWSER_CAPTURE_FENCE_OPEN,
} from "@/features/preview/capture/browser-capture-append";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { scheduleDrainAfterEdit } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";

/** The queue slot currently restored into the Composer for editing. */
export interface ComposerQueueEdit {
  messageId: string;
  originalIndex: number;
}

/** The live Composer operations needed to restore or clear a queued message. */
export interface ComposerQueueEditForm {
  hasContent: () => boolean;
  capture: (
    restoredPreviewAnnotations: PreviewAnnotationBundle | undefined,
  ) => Omit<QueuedMessage, "id" | "queuedAt">;
  restore: (message: QueuedMessage) => void;
  clear: () => void;
  invalidateAttachments: () => void;
}

/** The preview annotation operations coupled to a queue-edit lifecycle. */
export interface ComposerQueueEditAnnotations {
  restore: (bundle: PreviewAnnotationBundle | undefined) => void;
  clear: () => void;
}

/** Inputs that connect queue editing to the current Composer form and annotation state. */
export interface UseComposerQueueEditingOptions {
  threadId: string | undefined;
  form: ComposerQueueEditForm;
  annotations: ComposerQueueEditAnnotations;
}

function toQueuePayload(message: QueuedMessage): Omit<QueuedMessage, "id" | "queuedAt"> {
  const { id, queuedAt, ...payload } = message;
  void id;
  void queuedAt;
  return payload;
}

/** Retains a preview capture when a user edits the surrounding queued message text. */
function preserveBrowserCapturePayload(
  payload: Omit<QueuedMessage, "id" | "queuedAt">,
  original: QueuedMessage | null,
): Omit<QueuedMessage, "id" | "queuedAt"> {
  if (!original) return payload;
  const start = original.content.indexOf(MCODE_BROWSER_CAPTURE_FENCE_OPEN);
  const closeIndex = original.content.indexOf(MCODE_BROWSER_CAPTURE_FENCE_CLOSE, start);
  if (start === -1 || closeIndex === -1) return payload;
  const end = closeIndex + MCODE_BROWSER_CAPTURE_FENCE_CLOSE.length;
  const browserCaptureFence = original.content.slice(start, end);
  const browserCaptureSpillPaths = [
    ...(payload.browserCaptureSpillPaths ?? []),
    ...(original.browserCaptureSpillPaths ?? []),
  ];
  return {
    ...payload,
    content: `${payload.content.trimEnd()}\n\n${browserCaptureFence}\n`,
    browserCaptureSpillPaths:
      browserCaptureSpillPaths.length > 0
        ? [...new Set(browserCaptureSpillPaths)]
        : undefined,
  };
}

/** Manages the pop, restore, swap, cancel, and completion lifecycle for one queued Composer message. */
export function useComposerQueueEditing({
  threadId,
  form,
  annotations,
}: UseComposerQueueEditingOptions): {
  editing: ComposerQueueEdit | null;
  loadIntoComposer: (message: QueuedMessage) => void;
  cancelEdit: () => void;
  discardEmptyEdit: () => boolean;
  finishEditing: () => void;
  resolvePreviewAnnotations: (
    currentPreviewAnnotations: PreviewAnnotationBundle | undefined,
  ) => PreviewAnnotationBundle | undefined;
  markRestoredPreviewAnnotationsCleared: () => void;
} {
  const [editing, setEditing] = useState<ComposerQueueEdit | null>(null);
  const originalMessageRef = useRef<QueuedMessage | null>(null);
  const restoredPreviewAnnotationsClearedRef = useRef(false);

  const finishEditing = useCallback(() => {
    originalMessageRef.current = null;
    restoredPreviewAnnotationsClearedRef.current = false;
    setEditing(null);
    useQueueStore.getState().setEditingThreadId(null);
  }, []);

  const resolvePreviewAnnotations = useCallback(
    (currentPreviewAnnotations: PreviewAnnotationBundle | undefined) =>
      currentPreviewAnnotations ??
      (editing && !restoredPreviewAnnotationsClearedRef.current
        ? originalMessageRef.current?.previewAnnotations
        : undefined),
    [editing],
  );

  const markRestoredPreviewAnnotationsCleared = useCallback(() => {
    if (editing && originalMessageRef.current?.previewAnnotations) {
      restoredPreviewAnnotationsClearedRef.current = true;
    }
  }, [editing]);

  const loadIntoComposer = useCallback(
    (message: QueuedMessage) => {
      if (!threadId) return;

      const queue = useQueueStore.getState();
      const targetIndex = (queue.queues[threadId] ?? []).findIndex(
        (queued) => queued.id === message.id,
      );
      if (targetIndex === -1) return;

      form.invalidateAttachments();
      if (editing && form.hasContent()) {
        const restoredPreviewAnnotations = restoredPreviewAnnotationsClearedRef.current
          ? undefined
          : originalMessageRef.current?.previewAnnotations;
        queue.insertAt(
          threadId,
          editing.originalIndex,
          preserveBrowserCapturePayload(
            form.capture(restoredPreviewAnnotations),
            originalMessageRef.current,
          ),
        );
      }

      const popped = queue.popMessage(threadId, message.id);
      if (!popped) return;

      originalMessageRef.current = popped;
      restoredPreviewAnnotationsClearedRef.current = false;
      setEditing({ messageId: popped.id, originalIndex: targetIndex });
      queue.setEditingThreadId(threadId);

      form.restore(popped);
      annotations.restore(popped.previewAnnotations);
    },
    [annotations, editing, form, threadId],
  );

  const cancelEdit = useCallback(() => {
    if (!threadId || !editing) return;

    form.invalidateAttachments();
    const original = originalMessageRef.current;
    if (original) {
      useQueueStore.getState().insertAt(threadId, editing.originalIndex, toQueuePayload(original));
    }
    finishEditing();
    annotations.clear();
    scheduleDrainAfterEdit(threadId);
    form.clear();
  }, [annotations, editing, finishEditing, form, threadId]);

  const discardEmptyEdit = useCallback((): boolean => {
    if (!threadId || !editing) return false;

    const slot = editing.originalIndex;
    const browserCaptureSpillPaths = originalMessageRef.current?.browserCaptureSpillPaths ?? [];
    finishEditing();
    annotations.clear();
    scheduleDrainAfterEdit(threadId);
    void releaseBrowserCaptureSpills(browserCaptureSpillPaths);
    useToastStore
      .getState()
      .show("info", "Removed from queue", `Slot ${String(slot + 1).padStart(2, "0")}`);
    return true;
  }, [annotations, editing, finishEditing, threadId]);

  return {
    editing,
    loadIntoComposer,
    cancelEdit,
    discardEmptyEdit,
    finishEditing,
    resolvePreviewAnnotations,
    markRestoredPreviewAnnotationsCleared,
  };
}
