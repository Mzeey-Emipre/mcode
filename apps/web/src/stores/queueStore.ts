import { create } from "zustand";
import type { AttachmentMeta, PermissionMode } from "@/transport";
import type { ReasoningLevel } from "@mcode/contracts";

/** A message waiting to be sent while the thread is busy with another turn. */
export interface QueuedMessage {
  id: string;
  content: string;
  /** Optional display-only variant of content (e.g. stripped of internal markup). */
  displayContent?: string;
  attachments: AttachmentMeta[];
  model: string;
  permissionMode: PermissionMode;
  /** Reasoning effort level to apply when the message is sent. */
  reasoningLevel?: ReasoningLevel;
  /** Provider to use; undefined means inherit the thread's stored provider. */
  provider?: string;
  /** Unix timestamp (ms) when this message was enqueued. */
  queuedAt: number;
}

const MAX_QUEUE_DEPTH = 20;

interface QueueState {
  /** Per-thread message queues. */
  queues: Record<string, QueuedMessage[]>;
  /** Toast text shown briefly after enqueue. Null when hidden. */
  toast: string | null;

  enqueue: (
    threadId: string,
    message: Omit<QueuedMessage, "id" | "queuedAt">,
  ) => boolean;
  dequeueNext: (threadId: string) => QueuedMessage | undefined;
  removeFromQueue: (threadId: string, messageId: string) => void;
  clearQueue: (threadId: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(set: (partial: Partial<QueueState>) => void, text: string) {
  if (toastTimer) clearTimeout(toastTimer);
  set({ toast: text });
  toastTimer = setTimeout(() => set({ toast: null }), 1800);
}

export const useQueueStore = create<QueueState>((set, get) => ({
  queues: {},
  toast: null,

  enqueue: (threadId, message) => {
    const current = get().queues[threadId] ?? [];
    if (current.length >= MAX_QUEUE_DEPTH) {
      showToast(set, "Queue full");
      return false;
    }

    const entry: QueuedMessage = {
      ...message,
      id: crypto.randomUUID(),
      queuedAt: Date.now(),
    };

    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: [...(state.queues[threadId] ?? []), entry],
      },
    }));

    const count = (get().queues[threadId] ?? []).length;
    showToast(set, count > 1 ? `Queued \u00b7 ${count} pending` : "Queued");

    return true;
  },

  dequeueNext: (threadId) => {
    const current = get().queues[threadId] ?? [];
    if (current.length === 0) return undefined;

    const [next, ...rest] = current;
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: rest,
      },
    }));

    return next;
  },

  removeFromQueue: (threadId, messageId) => {
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: (state.queues[threadId] ?? []).filter(
          (m) => m.id !== messageId,
        ),
      },
    }));
  },

  clearQueue: (threadId) => {
    set((state) => {
      const next = { ...state.queues };
      delete next[threadId];
      return { queues: next };
    });
  },
}));
