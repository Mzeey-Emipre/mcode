import { create } from "zustand";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type {
  ContextWindowMode,
  MessageMention,
  ReasoningLevel,
  SelectedTextComment,
  SelectedTextCommentSource,
} from "@mcode/contracts";
import {
  collectSpillPathsFromPendingAttachments,
  releaseBrowserCaptureSpills,
} from "@/features/preview/capture/browser-capture-spill";

/** Restorable open-editor state for one selected-text comment in a ComposerDraft. */
export interface SelectedTextCommentEditorDraft {
  /** The immutable selected-text source that the editor targets. */
  source: SelectedTextCommentSource;
  /** Saved comment being edited. Omit while the editor creates a new comment. */
  commentId?: string;
  /** Current note text, including unsaved changes. */
  note: string;
  /** Current structured mention metadata, including unsaved changes. */
  mentions: MessageMention[];
  /** The first Escape warning has been shown. */
  escapeWarned: boolean;
  /** The first close or outside warning has been shown. */
  outsideWarned: boolean;
  /** The editor is anchored to its source range or to an aggregate card. */
  anchor: "source" | "card";
}

/** Draft state for a single composer instance, keyed by thread ID. */
export interface ComposerDraft {
  input: string;
  mentions?: MessageMention[];
  /** Saved selected-text comments awaiting persistence with this draft. */
  selectedTextComments?: SelectedTextComment[];
  /** Open selected-text comment editor state restored with this draft. */
  selectedTextCommentEditor?: SelectedTextCommentEditorDraft;
  attachments: PendingAttachment[];
  modelId: string;
  /** Provider ID stored alongside the model because multiple providers share model IDs. */
  provider?: string;
  reasoning: ReasoningLevel;
  /**
   * Per-thread context window override. Undefined falls back to the thread's
   * persisted mode (or the global settings default). Honored only by Claude
   * provider for models that support a 1M-context beta header.
   */
  contextWindow?: ContextWindowMode;
  /**
   * Per-thread thinking toggle override. Undefined falls back to the thread's
   * persisted toggle (or the global settings default). Honored only by models
   * that expose a thinking toggle (Haiku 4.5).
   */
  /**
   * Per-thread Codex fast-tier override. Undefined in drafts means "not captured
   * in this saved draft"; Composer falls back to thread settings.
   */
  codexFastMode?: boolean | null;
}

interface ComposerDraftState {
  drafts: Record<string, ComposerDraft>;

  /** Prefill text set by the empty-state prompt chips, consumed once by the Composer. */
  pendingPrefill: string | null;

  /** Save a draft for a thread. Skips storage only when it has no sendable content. */
  saveDraft: (threadId: string, draft: ComposerDraft) => void;

  /** Retrieve the saved draft for a thread, or undefined if none exists. */
  getDraft: (threadId: string) => ComposerDraft | undefined;

  /** Remove the draft for a thread (e.g. after sending a message). */
  clearDraft: (threadId: string) => void;

  /** Remove a draft after the submitting Composer takes over attachment cleanup. */
  removeDraftAfterAttachmentTransfer: (threadId: string) => void;

  /** Set a prefill text to be picked up by the Composer on next render. */
  setPendingPrefill: (text: string) => void;

  /** Clear the pending prefill after the Composer has consumed it. */
  clearPendingPrefill: () => void;
}

function draftHasNoSendableContent(draft: ComposerDraft): boolean {
  return draft.input.trim() === ""
    && draft.attachments.length === 0
    && (draft.selectedTextComments?.length ?? 0) === 0
    && !draft.selectedTextCommentEditor;
}

function releaseAttachmentResources(attachments: readonly PendingAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  const spillPaths = collectSpillPathsFromPendingAttachments(attachments);
  if (spillPaths.length > 0) void releaseBrowserCaptureSpills(spillPaths);
}

function removeDraft(
  drafts: Record<string, ComposerDraft>,
  threadId: string,
): Record<string, ComposerDraft> {
  const nextDrafts = { ...drafts };
  delete nextDrafts[threadId];
  return nextDrafts;
}

function revokeReplacedAttachmentPreviewUrls(
  existing: ComposerDraft | undefined,
  draft: ComposerDraft,
): void {
  if (!existing) return;
  const retainedUrls = new Set(draft.attachments.map((attachment) => attachment.previewUrl));
  releaseAttachmentResources(existing.attachments.filter(
    (attachment) => attachment.previewUrl && !retainedUrls.has(attachment.previewUrl),
  ));
}

/** Zustand store for per-thread composer draft persistence. */
export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  drafts: {},
  pendingPrefill: null,

  saveDraft: (threadId, draft) => {
    const existing = get().drafts[threadId];
    if (draftHasNoSendableContent(draft)) {
      // Don't store empty drafts; clean up if one existed
      if (!existing) return;
      releaseAttachmentResources(existing.attachments);
      set({ drafts: removeDraft(get().drafts, threadId) });
      return;
    }
    // Revoke blob URLs from the previous draft that are not reused in the new one
    revokeReplacedAttachmentPreviewUrls(existing, draft);
    set({ drafts: { ...get().drafts, [threadId]: draft } });
  },

  getDraft: (threadId) => {
    return get().drafts[threadId];
  },

  clearDraft: (threadId) => {
    const draft = get().drafts[threadId];
    if (!draft) return;
    releaseAttachmentResources(draft.attachments);
    set({ drafts: removeDraft(get().drafts, threadId) });
  },

  removeDraftAfterAttachmentTransfer: (threadId) => {
    if (!get().drafts[threadId]) return;
    set({ drafts: removeDraft(get().drafts, threadId) });
  },

  setPendingPrefill: (text) => set({ pendingPrefill: text }),

  clearPendingPrefill: () => set({ pendingPrefill: null }),
}));
