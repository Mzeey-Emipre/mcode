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
  /** Preview spill paths to unlink when this item is permanently removed from the queue. */
  browserCaptureSpillPaths?: string[];
  /** Unix timestamp (ms) when this message was enqueued. */
  queuedAt: number;
}

const MAX_QUEUE_DEPTH = 20;

interface QueuedDispatchLease {
  message: QueuedMessage;
  index: number;
  generation: number;
}

interface QueueState {
  /** Per-thread message queues. */
  queues: Record<string, QueuedMessage[]>;
  /** A claimed queued message that remains queue-owned until transport settles. */
  inFlightQueuedMessages: Record<string, QueuedDispatchLease | undefined>;
  /** Removed leases retained only until their transport call settles and spills can be released safely. */
  disposedQueuedMessages: Record<string, QueuedDispatchLease[]>;
  /** Incremented by Clear all or deletion so a failed lease cannot recreate a removed queue. */
  queueGenerations: Record<string, number>;
  /** Threads whose queued messages require an explicit Continue before automatic drain resumes. */
  autoDrainSuppressedThreadIds: Set<string>;
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
  /** Atomically reserve the next visible message for one queued send. */
  claimNextQueuedMessage: (threadId: string) => QueuedMessage | undefined;
  /** Atomically reserve one visible message for Send now. */
  claimQueuedMessage: (threadId: string, messageId: string) => QueuedMessage | undefined;
  /** Commit an accepted queued send or restore a failed lease at its original FIFO position. */
  settleQueuedDispatch: (threadId: string, messageId: string, accepted: boolean) => void;
  /** Block automatic drain until the user explicitly continues this thread. */
  suppressAutoDrain: (threadId: string) => void;
  /** Allow automatic drain after an explicit Continue. */
  resumeAutoDrain: (threadId: string) => void;
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
   * Remove a specific queued message and return it. Used by the queue editor
   * while it prepares the edited replacement.
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

function queueDepth(state: Pick<QueueState, "queues" | "inFlightQueuedMessages">, threadId: string): number {
  return (state.queues[threadId]?.length ?? 0) + (state.inFlightQueuedMessages[threadId] ? 1 : 0);
}

function settleDisposedQueuedMessage(
  state: QueueState,
  threadId: string,
  messageId: string,
  accepted: boolean,
): { patch: Partial<QueueState>; releasePaths?: string[] } | null {
  const disposed = state.disposedQueuedMessages[threadId] ?? [];
  const index = disposed.findIndex((item) => item.message.id === messageId);
  if (index === -1) return null;
  const disposedQueuedMessages = { ...state.disposedQueuedMessages };
  const remaining = disposed.filter((_, itemIndex) => itemIndex !== index);
  if (remaining.length === 0) delete disposedQueuedMessages[threadId];
  else disposedQueuedMessages[threadId] = remaining;
  return {
    patch: { disposedQueuedMessages },
    ...(!accepted ? { releasePaths: disposed[index].message.browserCaptureSpillPaths } : {}),
  };
}

function settleActiveQueuedMessage(
  state: QueueState,
  threadId: string,
  messageId: string,
  accepted: boolean,
): { patch: Partial<QueueState>; releasePaths?: string[] } | null {
  const lease = state.inFlightQueuedMessages[threadId];
  if (!lease || lease.message.id !== messageId) return null;
  const inFlightQueuedMessages = { ...state.inFlightQueuedMessages };
  delete inFlightQueuedMessages[threadId];
  if (accepted) return { patch: { inFlightQueuedMessages } };
  if (lease.generation !== (state.queueGenerations[threadId] ?? 0)) {
    return { patch: { inFlightQueuedMessages }, releasePaths: lease.message.browserCaptureSpillPaths };
  }
  const messages = [...(state.queues[threadId] ?? [])];
  messages.splice(Math.min(lease.index, messages.length), 0, lease.message);
  return {
    patch: {
      inFlightQueuedMessages,
      queues: { ...state.queues, [threadId]: messages },
      autoDrainSuppressedThreadIds: new Set(state.autoDrainSuppressedThreadIds).add(threadId),
    },
  };
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
  inFlightQueuedMessages: {},
  disposedQueuedMessages: {},
  queueGenerations: {},
  autoDrainSuppressedThreadIds: new Set<string>(),
  toast: null,
  editingThreadId: null,

  setEditingThreadId: (threadId) => set({ editingThreadId: threadId }),

  enqueue: (threadId, message) => {
    const state = get();
    if (queueDepth(state, threadId) >= MAX_QUEUE_DEPTH) {
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

    const count = queueDepth(get(), threadId);
    showToast(set, count > 1 ? `Queued \u00b7 ${count} pending` : "Queued");

    return true;
  },

  claimNextQueuedMessage: (threadId) => {
    const current = get().queues[threadId] ?? [];
    return get().claimQueuedMessage(threadId, current[0]?.id ?? "");
  },

  claimQueuedMessage: (threadId, messageId) => {
    const state = get();
    if (state.inFlightQueuedMessages[threadId]) return undefined;
    const current = state.queues[threadId] ?? [];
    const index = current.findIndex((message) => message.id === messageId);
    if (index === -1) return undefined;
    const message = current[index];
    set((latest) => {
      if (latest.inFlightQueuedMessages[threadId]) return latest;
      const messages = latest.queues[threadId] ?? [];
      const currentIndex = messages.findIndex((item) => item.id === messageId);
      if (currentIndex === -1) return latest;
      return {
        queues: { ...latest.queues, [threadId]: messages.filter((item) => item.id !== messageId) },
        inFlightQueuedMessages: {
          ...latest.inFlightQueuedMessages,
          [threadId]: {
            message: messages[currentIndex],
            index: currentIndex,
            generation: latest.queueGenerations[threadId] ?? 0,
          },
        },
      };
    });
    return get().inFlightQueuedMessages[threadId]?.message.id === message.id ? message : undefined;
  },

  settleQueuedDispatch: (threadId, messageId, accepted) => {
    let releasePaths: string[] | undefined;
    set((state) => {
      const settled = settleDisposedQueuedMessage(state, threadId, messageId, accepted)
        ?? settleActiveQueuedMessage(state, threadId, messageId, accepted);
      if (!settled) return state;
      releasePaths = settled.releasePaths;
      return settled.patch;
    });
    if (releasePaths?.length) void releaseBrowserCaptureSpills(releasePaths);
  },

  suppressAutoDrain: (threadId) => {
    set((state) => {
      if (state.autoDrainSuppressedThreadIds.has(threadId)) return state;
      return { autoDrainSuppressedThreadIds: new Set([...state.autoDrainSuppressedThreadIds, threadId]) };
    });
  },

  resumeAutoDrain: (threadId) => {
    set((state) => {
      if (!state.autoDrainSuppressedThreadIds.has(threadId)) return state;
      const autoDrainSuppressedThreadIds = new Set(state.autoDrainSuppressedThreadIds);
      autoDrainSuppressedThreadIds.delete(threadId);
      return { autoDrainSuppressedThreadIds };
    });
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
      const inFlightQueuedMessages = { ...state.inFlightQueuedMessages };
      const activeLease = inFlightQueuedMessages[threadId];
      delete inFlightQueuedMessages[threadId];
      const disposedQueuedMessages = activeLease
        ? {
            ...state.disposedQueuedMessages,
            [threadId]: [...(state.disposedQueuedMessages[threadId] ?? []), activeLease],
          }
        : state.disposedQueuedMessages;
      const queueGenerations = {
        ...state.queueGenerations,
        [threadId]: (state.queueGenerations[threadId] ?? 0) + 1,
      };
      const autoDrainSuppressedThreadIds = new Set(state.autoDrainSuppressedThreadIds);
      autoDrainSuppressedThreadIds.delete(threadId);
      return {
        queues: next,
        inFlightQueuedMessages,
        disposedQueuedMessages,
        queueGenerations,
        autoDrainSuppressedThreadIds,
      };
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
    const state = get();
    const current = state.queues[threadId] ?? [];
    if (queueDepth(state, threadId) >= MAX_QUEUE_DEPTH) {
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
