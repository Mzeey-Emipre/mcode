import { create } from "zustand";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";

/**
 * Buffers preview-capture attachments until the thread's Composer drains them.
 * Crosses the Right Panel and main chat split without prop drilling.
 */
interface PreviewReferenceQueueState {
  /** Bumps when any thread gains queued items or a queue is drained. */
  signal: number;
  /** Pending preview references keyed by thread ID. */
  queueByThread: Record<string, PendingAttachment[]>;
  /** Queue a capture for the given thread (typically the active thread ID). */
  enqueuePreviewReference(threadId: string, attachment: PendingAttachment): void;
  /**
   * Removes and returns queued references for `threadId`.
   * Intended for a single consumer (Composer) per drain call.
   */
  drainPreviewReferences(threadId: string): PendingAttachment[];
  /** Drop queued preview references for a deleted thread. */
  clearThread(threadId: string): void;
}

function releasePreviewUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/** Zustand store: enqueue preview PNG captures; Composer drains by active thread ID. */
export const usePreviewReferenceQueueStore = create<PreviewReferenceQueueState>((set, get) => ({
  signal: 0,
  queueByThread: {},

  enqueuePreviewReference(threadId, attachment) {
    set((s) => ({
      signal: s.signal + 1,
      queueByThread: {
        ...s.queueByThread,
        [threadId]: [...(s.queueByThread[threadId] ?? []), attachment],
      },
    }));
  },

  drainPreviewReferences(threadId) {
    const queued = get().queueByThread[threadId] ?? [];
    if (queued.length === 0) return [];
    set((s) => {
      const next = { ...s.queueByThread };
      delete next[threadId];
      return { queueByThread: next, signal: s.signal + 1 };
    });
    return queued;
  },

  clearThread(threadId) {
    const queued = get().queueByThread[threadId] ?? [];
    for (const attachment of queued) {
      releasePreviewUrl(attachment.previewUrl);
    }
    if (queued.length === 0) return;
    set((s) => {
      const next = { ...s.queueByThread };
      delete next[threadId];
      return { queueByThread: next, signal: s.signal + 1 };
    });
  },
}));
