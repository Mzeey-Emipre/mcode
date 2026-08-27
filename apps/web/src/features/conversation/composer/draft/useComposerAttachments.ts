import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type RefObject,
} from "react";
import type { AttachmentMeta } from "@/transport";
import { getTransport } from "@/transport";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import {
  isFileSupported,
  MAX_ATTACHMENTS,
} from "@mcode/contracts";
import { useToastStore } from "@/stores/toastStore";
import {
  collectSpillPathsFromPendingAttachments,
  releaseBrowserCaptureSpills,
} from "@/features/preview/capture/browser-capture-spill";
import {
  preparePathlessComposerAttachments,
  selectComposerAttachments,
  toComposerAttachmentMetas,
} from "./composer-attachment-operations";

/** Context that invalidates attachment preparation when the composer changes owner. */
export interface ComposerAttachmentContext {
  isNewThread: boolean;
  threadId?: string;
  workspaceId?: string;
}

/** Result of placing attachment rows in the bounded composer tray. */
export interface ComposerAttachmentAppendResult {
  acceptedCount: number;
  droppedCount: number;
}

/** Attachment operations and event handlers owned by one composer. */
export interface ComposerAttachments {
  attachments: PendingAttachment[];
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  isDragOver: boolean;
  preparationRevision: number;
  appendAttachments(nextAttachments: PendingAttachment[]): ComposerAttachmentAppendResult;
  replaceAttachments(nextAttachments: PendingAttachment[]): void;
  removeAttachment(id: string): void;
  snapshotAttachmentMetas(): AttachmentMeta[];
  detachAttachments(): PendingAttachment[];
  releaseAttachments(attachments: readonly PendingAttachment[]): void;
  collectAndClearAttachments(): AttachmentMeta[];
  waitForPreparationsBeforeSubmit(): Promise<boolean>;
  consumeDeferredSubmit(): boolean;
  handleAttachmentInputChange(event: ChangeEvent<HTMLInputElement>): void;
  handleAttachPick(): void;
  handlePaste(event: ClipboardEvent): void;
  handleDragEnter(event: DragEvent): void;
  handleDragLeave(event: DragEvent): void;
  handleDragOver(event: DragEvent): void;
  handleDrop(event: DragEvent): boolean;
  invalidatePreparations(): void;
}

function resolveNativeFilePath(file: File): string | null {
  try {
    return window.desktopBridge?.getPathForFile?.(file) ?? null;
  } catch {
    return null;
  }
}

/** Owns attachment staging and bounded composer-tray lifecycle. */
export function useComposerAttachments(context: ComposerAttachmentContext): ComposerAttachments {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const composerMountedRef = useRef(true);
  const attachmentPreparationGenerationRef = useRef(0);
  const pendingAttachmentPreparationsRef = useRef(new Set<Promise<void>>());
  const pendingPathlessAttachmentCountRef = useRef(0);
  const attachmentPreparationFailureCountRef = useRef(0);
  const sendAfterAttachmentPreparationRef = useRef<{ failureCount: number } | null>(null);
  const [preparationRevision, setPreparationRevision] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  const commitAttachments = useCallback((nextAttachments: PendingAttachment[]) => {
    attachmentsRef.current = nextAttachments;
    setAttachments(nextAttachments);
  }, []);

  const isAttachmentPreparationCurrent = useCallback(
    (generation: number): boolean =>
      composerMountedRef.current && attachmentPreparationGenerationRef.current === generation,
    [],
  );

  const invalidatePreparations = useCallback(() => {
    attachmentPreparationGenerationRef.current += 1;
    pendingAttachmentPreparationsRef.current.clear();
    pendingPathlessAttachmentCountRef.current = 0;
    sendAfterAttachmentPreparationRef.current = null;
  }, []);

  useEffect(() => {
    invalidatePreparations();
    return invalidatePreparations;
  }, [context.isNewThread, context.threadId, context.workspaceId, invalidatePreparations]);

  useEffect(() => {
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
      invalidatePreparations();
    };
  }, [invalidatePreparations]);

  const appendAttachments = useCallback((nextAttachments: PendingAttachment[]): ComposerAttachmentAppendResult => {
    if (nextAttachments.length === 0) return { acceptedCount: 0, droppedCount: 0 };

    const remaining = MAX_ATTACHMENTS
      - attachmentsRef.current.length
      - pendingPathlessAttachmentCountRef.current;
    const accepted = remaining > 0 ? nextAttachments.slice(0, remaining) : [];
    const dropped = nextAttachments.slice(accepted.length);
    for (const attachment of dropped) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    if (accepted.length > 0) {
      commitAttachments([...attachmentsRef.current, ...accepted]);
    }
    return { acceptedCount: accepted.length, droppedCount: dropped.length };
  }, [commitAttachments]);

  const replaceAttachments = useCallback((nextAttachments: PendingAttachment[]) => {
    invalidatePreparations();
    commitAttachments(nextAttachments);
  }, [commitAttachments, invalidatePreparations]);

  const persistPathlessAttachment = useCallback(async (file: File, mimeType: string) => {
    const arrayBuffer = await file.arrayBuffer();
    const bridge = window.desktopBridge;
    return bridge?.saveClipboardFile
      ? bridge.saveClipboardFile(new Uint8Array(arrayBuffer), mimeType, file.name)
      : getTransport().saveClipboardFile(arrayBuffer, mimeType, file.name);
  }, []);

  const preparePathlessAttachments = useCallback((files: File[]) => {
    const generation = attachmentPreparationGenerationRef.current;
    const reservedAttachmentCount = files.length;
    pendingPathlessAttachmentCountRef.current += reservedAttachmentCount;
    let reservationReleased = false;
    const releaseReservation = () => {
      if (reservationReleased) return;
      pendingPathlessAttachmentCountRef.current -= reservedAttachmentCount;
      reservationReleased = true;
    };
    const preparation = preparePathlessComposerAttachments({
      files,
      isCurrent: () => isAttachmentPreparationCurrent(generation),
      persist: persistPathlessAttachment,
      reportFailure: () => {
        attachmentPreparationFailureCountRef.current += 1;
        useToastStore.getState().show(
          "error",
          "Could not attach file",
          "The file was not saved. Try again.",
        );
      },
      commit: (prepared) => {
        releaseReservation();
        appendAttachments(prepared);
      },
    });

    pendingAttachmentPreparationsRef.current.add(preparation);
    setPreparationRevision((revision) => revision + 1);
    void preparation.finally(() => {
      if (!isAttachmentPreparationCurrent(generation)) return;
      pendingAttachmentPreparationsRef.current.delete(preparation);
      releaseReservation();
      setPreparationRevision((revision) => revision + 1);
    });
  }, [appendAttachments, isAttachmentPreparationCurrent, persistPathlessAttachment]);

  const addFiles = useCallback((files: File[], filePaths?: (string | null)[]) => {
    const remaining = MAX_ATTACHMENTS
      - attachmentsRef.current.length
      - pendingPathlessAttachmentCountRef.current;
    if (remaining <= 0) return;

    const { nativeAttachments, pathlessFiles } = selectComposerAttachments({
      files,
      filePaths,
      availableSlots: remaining,
    });

    appendAttachments(nativeAttachments);
    if (pathlessFiles.length > 0) preparePathlessAttachments(pathlessFiles);
  }, [appendAttachments, preparePathlessAttachments]);

  const handleAttachmentInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list?.length) return;
    const files = Array.from(list);
    addFiles(files, files.map(resolveNativeFilePath));
    event.target.value = "";
  }, [addFiles]);

  const handleAttachPick = useCallback(() => {
    attachmentInputRef.current?.click();
  }, []);

  const removeAttachment = useCallback((id: string) => {
    const removed = attachmentsRef.current.find((attachment) => attachment.id === id);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    const spillPaths = collectSpillPathsFromPendingAttachments(removed ? [removed] : []);
    if (spillPaths.length > 0) void releaseBrowserCaptureSpills(spillPaths);
    commitAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id));
  }, [commitAttachments]);

  const handlePaste = useCallback((event: ClipboardEvent) => {
    const fromFiles = Array.from(event.clipboardData.files);
    const fromItems: File[] = [];
    for (const item of Array.from(event.clipboardData.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (!fromFiles.some((candidate) => candidate.name === file.name && candidate.size === file.size)) {
        fromItems.push(file);
      }
    }
    const supported = [...fromFiles, ...fromItems].filter((file) => isFileSupported(file.name));
    if (supported.length === 0) return;

    event.preventDefault();
    addFiles(supported, supported.map(resolveNativeFilePath));
  }, [addFiles]);

  const handleDragEnter = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((event: DragEvent): boolean => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const supported = Array.from(event.dataTransfer.files).filter((file) => isFileSupported(file.name));
    if (supported.length === 0) return false;
    addFiles(supported, supported.map(resolveNativeFilePath));
    return true;
  }, [addFiles]);

  const snapshotAttachmentMetas = useCallback((): AttachmentMeta[] => {
    return toComposerAttachmentMetas(attachmentsRef.current);
  }, []);

  const detachAttachments = useCallback((): PendingAttachment[] => {
    invalidatePreparations();
    const currentAttachments = attachmentsRef.current;
    commitAttachments([]);
    return currentAttachments;
  }, [commitAttachments, invalidatePreparations]);

  const releaseAttachments = useCallback((attachmentsToRelease: readonly PendingAttachment[]) => {
    for (const attachment of attachmentsToRelease) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    const spillPaths = collectSpillPathsFromPendingAttachments(attachmentsToRelease);
    if (spillPaths.length > 0) void releaseBrowserCaptureSpills(spillPaths);
  }, []);

  const collectAndClearAttachments = useCallback((): AttachmentMeta[] => {
    const currentAttachments = detachAttachments();
    const metas = toComposerAttachmentMetas(currentAttachments);
    releaseAttachments(currentAttachments);
    return metas;
  }, [detachAttachments, releaseAttachments]);

  const waitForPreparationsBeforeSubmit = useCallback(async (): Promise<boolean> => {
    const pendingPreparations = [...pendingAttachmentPreparationsRef.current];
    if (pendingPreparations.length === 0) return false;
    sendAfterAttachmentPreparationRef.current = {
      failureCount: attachmentPreparationFailureCountRef.current,
    };
    await Promise.all(pendingPreparations);
    return true;
  }, []);

  const consumeDeferredSubmit = useCallback((): boolean => {
    const deferredSubmit = sendAfterAttachmentPreparationRef.current;
    if (!deferredSubmit || pendingAttachmentPreparationsRef.current.size > 0) return false;
    sendAfterAttachmentPreparationRef.current = null;
    return attachmentPreparationFailureCountRef.current === deferredSubmit.failureCount;
  }, []);

  return {
    attachments,
    attachmentInputRef,
    isDragOver,
    preparationRevision,
    appendAttachments,
    replaceAttachments,
    removeAttachment,
    snapshotAttachmentMetas,
    detachAttachments,
    releaseAttachments,
    collectAndClearAttachments,
    waitForPreparationsBeforeSubmit,
    consumeDeferredSubmit,
    handleAttachmentInputChange,
    handleAttachPick,
    handlePaste,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    invalidatePreparations,
  };
}
