import { create } from "zustand";
import type { AttachmentMeta, PermissionMode } from "@/transport";
import type {
  ContextWindowMode,
  MessageMention,
  PreviewAnnotationBundle,
  ReasoningLevel,
  OrchestrationMode,
} from "@mcode/contracts";
import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";

/** A message waiting to be sent while the thread is busy with another turn. */
export interface QueuedMessage {
  id: string;
  content: string;
  /** Optional display-only variant of content (e.g. stripped of internal markup). */
  displayContent?: string;
  /** Selected typed mentions with offsets into content. Plain typed @text is not included. */
  mentions?: MessageMention[];
  /** Saved preview annotations to send with the queued message. */
  previewAnnotations?: PreviewAnnotationBundle;
  attachments: AttachmentMeta[];
  model: string;
  permissionMode: PermissionMode;
  /** Reasoning effort level to apply when the message is sent. */
  reasoningLevel?: ReasoningLevel;
  /** Provider-native proactive delegation mode for this queued turn. */
  orchestrationMode?: OrchestrationMode;
  /** Provider to use; undefined means inherit the thread's stored provider. */
  provider?: string;
  /** Copilot sub-agent to use; undefined means inherit the thread's stored agent. */
  copilotAgent?: string;
  /** Claude context window mode for this turn; undefined means inherit from thread/settings. */
  contextWindow?: ContextWindowMode;
  /** Haiku thinking toggle for this turn; undefined means inherit from thread/settings. */
  thinking?: boolean;
  /** Codex OpenAI fast tier for this queued send; undefined inherits at dequeue. */
  codexFastMode?: boolean;
  /** Goal objective installed atomically when this queued turn dispatches. */
  goalObjective?: string;
  replyToMessageId?: string;
  /** Quoted text excerpt for the reply. */
  quotedText?: string;
  /** Preview spill paths to unlink when this item is removed from the queue or the send path fails after dequeue. */
  browserCaptureSpillPaths?: string[];
  /** Unix timestamp (ms) when this message was enqueued. */
  queuedAt: number;
}

const MAX_QUEUE_DEPTH = 20;

interface QueueState {
  /** Per-thread message queues. */
  queues: Record<string, QueuedMessage[]>;
  /** Toast text shown briefly after enqueue. Null when hidden. */
  toast: string | null;
  /**
   * Thread ID whose queue is currently frozen because the user is editing
   * a message in the composer. Auto-drain skips this thread until the edit
   * is saved or cancelled.
   */
  editingThreadId: string | null;

  /** Mark a thread as having an in-progress queue edit (or clear it). */
  setEditingThreadId: (threadId: string | null) => void;
  enqueue: (
    threadId: string,
    message: Omit<QueuedMessage, "id" | "queuedAt">,
  ) => boolean;
  dequeueNext: (threadId: string) => QueuedMessage | undefined;
  removeFromQueue: (threadId: string, messageId: string) => void;
  clearQueue: (threadId: string) => void;
  /**
   * Rewrite the content (and optional display variant) of a queued message
   * without changing its position or other metadata. No-op if the message
   * is no longer in the queue.
   */
  editMessage: (
    threadId: string,
    messageId: string,
    content: string,
    displayContent?: string,
    mentions?: MessageMention[],
  ) => void;
  /**
   * Move a queued message to a new index (0-based). Indices are clamped to the
   * queue length. No-op if the message is no longer in the queue.
   */
  moveMessage: (threadId: string, messageId: string, toIndex: number) => void;
  /**
   * Remove a specific queued message and return it. Used by "Send now" to
   * extract a message before promoting it past the running turn.
   * Does NOT release browser-capture spills (the caller is sending the
   * message and still owns them).
   */
  popMessage: (threadId: string, messageId: string) => QueuedMessage | undefined;
  /**
   * Insert a message at a specific index (clamped). Used when the user
   * saves an edit pulled out via `popMessage` - the edited message goes
   * back to the same slot it was extracted from, instead of being appended
   * to the tail by `enqueue`. Honours the {@link MAX_QUEUE_DEPTH} cap.
   * Returns false when the queue is full (caller may release spills).
   */
  insertAt: (
    threadId: string,
    index: number,
    message: Omit<QueuedMessage, "id" | "queuedAt">,
  ) => boolean;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(set: (partial: Partial<QueueState>) => void, text: string) {
  if (toastTimer) clearTimeout(toastTimer);
  set({ toast: text });
  toastTimer = setTimeout(() => set({ toast: null }), 1800);
}

/**
 * Zustand store managing per-thread message queues.
 *
 * Messages are enqueued when the agent is busy and drained FIFO when the
 * turn completes. Supports reorder, edit-in-place, pop-for-send-now, and
 * an editing lock that pauses auto-drain while a message is open in the composer.
 */
export const useQueueStore = create<QueueState>((set, get) => ({
  queues: {},
  toast: null,
  editingThreadId: null,

  setEditingThreadId: (threadId) => set({ editingThreadId: threadId }),

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
    const current = get().queues[threadId] ?? [];
    const msg = current.find((m) => m.id === messageId);
    if (msg?.browserCaptureSpillPaths?.length) {
      void releaseBrowserCaptureSpills(msg.browserCaptureSpillPaths);
    }
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: (state.queues[threadId] ?? []).filter((m) => m.id !== messageId),
      },
    }));
  },

  clearQueue: (threadId) => {
    const list = get().queues[threadId] ?? [];
    const paths = list.flatMap((m) => m.browserCaptureSpillPaths ?? []);
    if (paths.length > 0) void releaseBrowserCaptureSpills(paths);
    set((state) => {
      const next = { ...state.queues };
      delete next[threadId];
      return { queues: next };
    });
  },

  editMessage: (threadId, messageId, content, displayContent, mentions) => {
    set((state) => {
      const current = state.queues[threadId];
      if (!current) return state;
      const idx = current.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;
      const updated: QueuedMessage = {
        ...current[idx],
        content,
        displayContent: displayContent ?? content,
        mentions,
      };
      const nextList = [...current];
      nextList[idx] = updated;
      return { queues: { ...state.queues, [threadId]: nextList } };
    });
  },

  moveMessage: (threadId, messageId, toIndex) => {
    set((state) => {
      const current = state.queues[threadId];
      if (!current || current.length < 2) return state;
      const fromIndex = current.findIndex((m) => m.id === messageId);
      if (fromIndex === -1) return state;
      const clamped = Math.max(0, Math.min(toIndex, current.length - 1));
      if (clamped === fromIndex) return state;
      const nextList = [...current];
      const [item] = nextList.splice(fromIndex, 1);
      nextList.splice(clamped, 0, item);
      return { queues: { ...state.queues, [threadId]: nextList } };
    });
  },

  popMessage: (threadId, messageId) => {
    const current = get().queues[threadId];
    if (!current) return undefined;
    const msg = current.find((m) => m.id === messageId);
    if (!msg) return undefined;
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: (state.queues[threadId] ?? []).filter((m) => m.id !== messageId),
      },
    }));
    return msg;
  },

  insertAt: (threadId, index, message) => {
    const current = get().queues[threadId] ?? [];
    if (current.length >= MAX_QUEUE_DEPTH) {
      showToast(set, "Queue full");
      return false;
    }
    const clamped = Math.max(0, Math.min(index, current.length));
    const entry: QueuedMessage = {
      ...message,
      id: crypto.randomUUID(),
      queuedAt: Date.now(),
    };
    const nextList = [...current];
    nextList.splice(clamped, 0, entry);
    set((state) => ({
      queues: { ...state.queues, [threadId]: nextList },
    }));
    return true;
  },
}));
