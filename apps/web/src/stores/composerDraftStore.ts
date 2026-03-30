import { create } from "zustand";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type { ReasoningLevel } from "@mcode/contracts";

export type { ReasoningLevel } from "@mcode/contracts";

/** Draft state for a single composer instance, keyed by thread ID. */
export interface ComposerDraft {
  input: string;
  attachments: PendingAttachment[];
  modelId: string;
  reasoning: ReasoningLevel;
}

interface ComposerDraftState {
  drafts: Record<string, ComposerDraft>;

  /** Save a draft for a thread. Skips storage if both input and attachments are empty. */
  saveDraft: (threadId: string, draft: ComposerDraft) => void;

  /** Retrieve the saved draft for a thread, or undefined if none exists. */
  getDraft: (threadId: string) => ComposerDraft | undefined;

  /** Remove the draft for a thread (e.g. after sending a message). */
  clearDraft: (threadId: string) => void;
}

/** Zustand store for per-thread composer draft persistence. */
export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  drafts: {},

  saveDraft: (threadId, draft) => {
    const isEmpty = draft.input.trim() === "" && draft.attachments.length === 0;
    if (isEmpty) {
      // Don't store empty drafts; clean up if one existed
      const existing = get().drafts[threadId];
      if (!existing) return;
      for (const att of existing.attachments) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      const rest = { ...get().drafts };
      delete rest[threadId];
      set({ drafts: rest });
      return;
    }
    // Revoke blob URLs from the previous draft that are not reused in the new one
    const existing = get().drafts[threadId];
    if (existing) {
      const newUrls = new Set(draft.attachments.map((a) => a.previewUrl));
      for (const att of existing.attachments) {
        if (att.previewUrl && !newUrls.has(att.previewUrl)) {
          URL.revokeObjectURL(att.previewUrl);
        }
      }
    }
    set({ drafts: { ...get().drafts, [threadId]: draft } });
  },

  getDraft: (threadId) => {
    return get().drafts[threadId];
  },

  clearDraft: (threadId) => {
    const draft = get().drafts[threadId];
    if (!draft) return;
    for (const att of draft.attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    const rest = { ...get().drafts };
    delete rest[threadId];
    set({ drafts: rest });
  },
}));
