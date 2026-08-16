import { useCallback, useState } from "react";
import { useToastStore } from "@/stores/toastStore";
import { usePreviewReferenceQueueStore } from "../state/previewReferenceQueueStore";
import { MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME } from "@mcode/contracts";
import type { McodeBrowserCapture, PreviewAnnotationPayload } from "@mcode/contracts";
import type { PreviewAnnotationSnapshotRequest } from "@/transport/desktop-bridge";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import { normalizePreviewPageIdentity, usePreviewAnnotationStore } from "../state/previewAnnotationStore";

type CaptureResult =
  | {
      ok: true;
      meta: {
        id: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
        sourcePath: string;
      };
      previewBytes: Uint8Array;
      capture: McodeBrowserCapture;
    }
  | { ok: false; error: string };

type ContextCaptureResult =
  | { ok: true; capture: McodeBrowserCapture }
  | { ok: false; error: string };

const CAPTURE_ERROR_SILENT = new Set(["cancelled", "capture-interrupted", "navigated-away"]);

const CAPTURE_ERROR_LABEL: Record<string, string> = {
  "no-window": "Preview is unavailable.",
  "no-preview": "Keep the preview visible and load a page first.",
  "empty-capture": "Nothing was captured.",
  "capture-failed": "Screenshot failed.",
  "region-too-small": "Drag a larger box (at least a few pixels).",
  "no-hit": "Click an element on the page.",
};

function formatCaptureError(code: string): string {
  return CAPTURE_ERROR_LABEL[code] ?? code;
}

function showCaptureErrorIfNeeded(res: CaptureResult | ContextCaptureResult): void {
  if (res.ok || CAPTURE_ERROR_SILENT.has(res.error)) return;
  useToastStore.getState().show("error", "Could not capture preview", formatCaptureError(res.error));
}

/** Discriminator for the source of a successful capture. */
export type PreviewCaptureKind = "viewport" | "region" | "element" | "context";

/** Options for the {@link usePreviewCapture} hook. */
export interface UsePreviewCaptureOptions {
  /** Thread id that owns this capture session. */
  readonly threadId: string;
  /** Callback to push bounds sync before capturing. */
  readonly pushSync: (visible: boolean) => Promise<void>;
  /**
   * Fires after every successful attachment so the host can surface an inline
   * confirmation. The composer chip already exists but may be off-screen at
   * narrow widths; this callback lets the preview surface acknowledge the
   * action where the user is actually looking.
   */
  readonly onSuccess?: (kind: PreviewCaptureKind) => void;
}

/** State and callbacks returned by {@link usePreviewCapture}. */
export interface PreviewCaptureState {
  /** True while a full-viewport capture is in progress. */
  readonly captureBusy: boolean;
  /** True while a region drag-crop capture is in progress. */
  readonly regionBusy: boolean;
  /** True while an element-pick capture is in progress. */
  readonly elementPickBusy: boolean;
  /** True while a context-only capture is in progress. */
  readonly contextBusy: boolean;
  /** True when any capture mode is active (disables other capture buttons). */
  readonly anyCaptureActive: boolean;
  readonly onAddPictureReference: () => Promise<void>;
  readonly onAddRegionPictureReference: () => Promise<void>;
  /**
   * Fires one element-pick session and resolves with whether the session
   * actually attached an element. Design mode reads this so it can re-arm on
   * success and exit on cancel / error / Esc without inspecting the queue.
   */
  readonly onAddElementPickPictureReference: () => Promise<{ ok: boolean }>;
  readonly onAddPageContextOnly: () => Promise<void>;
  /** Create a saved Preview annotation from an element pick instead of a normal attachment. */
  readonly onAddElementAnnotation: () => Promise<{ ok: boolean }>;
  /** Capture the full visible viewport for a saved Preview annotation. */
  readonly captureAnnotationSnapshot: (
    overlay: PreviewAnnotationSnapshotRequest,
  ) => Promise<PreviewAnnotationPayload["snapshot"] | null>;
}

/**
 * Manages capture handlers and busy states for the browser preview:
 * full-viewport screenshot, region crop, element pick, and context-only capture.
 */
export function usePreviewCapture({
  threadId,
  pushSync,
  onSuccess,
}: UsePreviewCaptureOptions): PreviewCaptureState {
  const [captureBusy, setCaptureBusy] = useState(false);
  const [regionBusy, setRegionBusy] = useState(false);
  const [elementPickBusy, setElementPickBusy] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);

  const anyCaptureActive = captureBusy || regionBusy || elementPickBusy || contextBusy;

  const onAddPictureReference = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReference || !threadId) return;

    setCaptureBusy(true);
    try {
      await pushSync(true);

      let res: CaptureResult;
      try {
        res = (await preview.capturePictureReference()) as CaptureResult;
      } catch {
        useToastStore.getState().show("error", "Could not capture preview", "Screenshot failed.");
        return;
      }

      showCaptureErrorIfNeeded(res);
      if (!res.ok) return;

      const copied = Uint8Array.from(res.previewBytes);
      const blob = new Blob([copied], { type: "image/png" });
      const previewUrl = URL.createObjectURL(blob);
      const attachment: PendingAttachment = {
        id: res.meta.id,
        name: res.meta.name,
        mimeType: res.meta.mimeType,
        sizeBytes: res.meta.sizeBytes,
        previewUrl,
        filePath: res.meta.sourcePath,
        browserCapture: res.capture,
      };
      usePreviewReferenceQueueStore.getState().enqueuePreviewReference(threadId, attachment);
      onSuccess?.("viewport");
    } finally {
      setCaptureBusy(false);
    }
  }, [pushSync, threadId, onSuccess]);

  const onAddRegionPictureReference = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReferenceRegion || !threadId) return;

    setRegionBusy(true);
    try {
      await pushSync(true);

      let res: CaptureResult;
      try {
        res = (await preview.capturePictureReferenceRegion()) as CaptureResult;
      } catch {
        useToastStore.getState().show("error", "Could not capture preview", "Screenshot failed.");
        return;
      }

      showCaptureErrorIfNeeded(res);
      if (!res.ok) return;

      const copied = Uint8Array.from(res.previewBytes);
      const blob = new Blob([copied], { type: "image/png" });
      const previewUrl = URL.createObjectURL(blob);
      const attachment: PendingAttachment = {
        id: res.meta.id,
        name: res.meta.name,
        mimeType: res.meta.mimeType,
        sizeBytes: res.meta.sizeBytes,
        previewUrl,
        filePath: res.meta.sourcePath,
        browserCapture: res.capture,
      };
      usePreviewReferenceQueueStore.getState().enqueuePreviewReference(threadId, attachment);
      onSuccess?.("region");
    } finally {
      setRegionBusy(false);
    }
  }, [pushSync, threadId, onSuccess]);

  const onAddElementPickPictureReference = useCallback(async (): Promise<{ ok: boolean }> => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReferenceElementPick || !threadId) return { ok: false };

    setElementPickBusy(true);
    try {
      await pushSync(true);

      let res: CaptureResult;
      try {
        res = (await preview.capturePictureReferenceElementPick()) as CaptureResult;
      } catch {
        useToastStore.getState().show("error", "Could not capture preview", "Screenshot failed.");
        return { ok: false };
      }

      showCaptureErrorIfNeeded(res);
      if (!res.ok) return { ok: false };

      const copied = Uint8Array.from(res.previewBytes);
      const blob = new Blob([copied], { type: "image/png" });
      const previewUrl = URL.createObjectURL(blob);
      const attachment: PendingAttachment = {
        id: res.meta.id,
        name: res.meta.name,
        mimeType: res.meta.mimeType,
        sizeBytes: res.meta.sizeBytes,
        previewUrl,
        filePath: res.meta.sourcePath,
        browserCapture: res.capture,
      };
      usePreviewReferenceQueueStore.getState().enqueuePreviewReference(threadId, attachment);
      onSuccess?.("element");
      return { ok: true };
    } finally {
      setElementPickBusy(false);
    }
  }, [pushSync, threadId, onSuccess]);

  const onAddPageContextOnly = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePageContext || !threadId) return;

    setContextBusy(true);
    try {
      await pushSync(true);

      let res: ContextCaptureResult;
      try {
        res = (await preview.capturePageContext()) as ContextCaptureResult;
      } catch {
        useToastStore.getState().show("error", "Could not capture preview", "Context capture failed.");
        return;
      }

      if (!res.ok) {
        showCaptureErrorIfNeeded(res);
        return;
      }

      const attachment: PendingAttachment = {
        id: crypto.randomUUID(),
        name: "Page context",
        mimeType: MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
        sizeBytes: 0,
        previewUrl: "",
        filePath: null,
        browserCapture: res.capture,
        contextOnly: true,
      };
      usePreviewReferenceQueueStore.getState().enqueuePreviewReference(threadId, attachment);
      onSuccess?.("context");
    } finally {
      setContextBusy(false);
    }
  }, [pushSync, threadId, onSuccess]);

  const captureAnnotationSnapshot = useCallback(async (
    overlay: PreviewAnnotationSnapshotRequest,
  ): Promise<PreviewAnnotationPayload["snapshot"] | null> => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.captureAnnotationSnapshot || !threadId) return null;
    await pushSync(true);
    let res: CaptureResult;
    try {
      res = (await preview.captureAnnotationSnapshot(overlay)) as CaptureResult;
    } catch {
      useToastStore.getState().show("error", "Could not save annotation", "Screenshot failed.");
      return null;
    }
    showCaptureErrorIfNeeded(res);
    if (!res.ok || res.capture.schemaVersion !== 2) return null;
    return {
      id: res.meta.id,
      name: res.meta.name,
      mimeType: "image/png",
      sizeBytes: res.meta.sizeBytes,
      sourcePath: res.meta.sourcePath,
      capture: res.capture,
    };
  }, [pushSync, threadId]);

  const onAddElementAnnotation = useCallback(async (): Promise<{ ok: boolean }> => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.capturePictureReferenceElementPick || !threadId) return { ok: false };

    setElementPickBusy(true);
    try {
      await pushSync(true);
      let res: CaptureResult;
      try {
        res = (await preview.capturePictureReferenceElementPick()) as CaptureResult;
      } catch {
        useToastStore.getState().show("error", "Could not capture preview", "Screenshot failed.");
        return { ok: false };
      }

      showCaptureErrorIfNeeded(res);
      if (!res.ok || res.capture.schemaVersion !== 2) return { ok: false };

      const elementStyle =
        res.capture.elementStyle && Object.keys(res.capture.elementStyle).length > 0
          ? res.capture.elementStyle
          : undefined;
      usePreviewAnnotationStore.getState().setDraft(threadId, {
        threadId,
        pageIdentity: normalizePreviewPageIdentity(res.capture.pageUrl),
        bounds: res.capture.bounds,
        selectorHint: res.capture.selectorHint ?? null,
        label: res.capture.selectorHint ?? null,
        pageContext: res.capture,
        ...(elementStyle ? { elementStyle } : {}),
        note: "",
      });
      onSuccess?.("element");
      return { ok: true };
    } finally {
      setElementPickBusy(false);
    }
  }, [pushSync, threadId, onSuccess]);

  return {
    captureBusy,
    regionBusy,
    elementPickBusy,
    contextBusy,
    anyCaptureActive,
    onAddPictureReference,
    onAddRegionPictureReference,
    onAddElementPickPictureReference,
    onAddPageContextOnly,
    onAddElementAnnotation,
    captureAnnotationSnapshot,
  };
}
