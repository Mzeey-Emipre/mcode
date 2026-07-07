import { create } from "zustand";
import type {
  BrowserPreviewBounds,
  BrowserPreviewElementStyle,
  McodeBrowserCaptureV2,
  PreviewAnnotationBundle,
  PreviewAnnotationPayload,
  PreviewAnnotationVisualProposal,
} from "@mcode/contracts";
import { PreviewAnnotationBundleSchema } from "@mcode/contracts";

/** Draft data captured from the Preview before it becomes a saved annotation. */
export interface PreviewDraftAnnotation {
  /** Thread that owns the draft. */
  readonly threadId: string;
  /** Normalized page identity used for visibility and grouping. */
  readonly pageIdentity: string;
  /** Target bounds in Preview viewport CSS pixels. */
  readonly bounds: BrowserPreviewBounds;
  /** Optional selector hint from capture context. */
  readonly selectorHint?: string | null;
  /** Optional target label from capture context. */
  readonly label?: string | null;
  /** Snapshot metadata saved after the draft bubble is visible. */
  readonly snapshot?: PreviewAnnotationPayload["snapshot"];
  /** Full page context captured with the snapshot. */
  readonly pageContext: McodeBrowserCaptureV2;
  /** Current computed visual style for the selected element. */
  readonly elementStyle?: BrowserPreviewElementStyle;
  /** User note text. */
  readonly note: string;
  /** Proposed visual style changes. */
  readonly proposedChanges?: PreviewAnnotationVisualProposal;
}

/** Saved annotation with stable identity and creation ordering. */
export interface SavedPreviewAnnotation extends PreviewAnnotationPayload {
  /** Stable sort key independent of display number. */
  readonly createdAt: number;
}

interface PreviewAnnotationStore {
  /** Saved annotation sets keyed by thread id. */
  readonly byThread: Record<string, SavedPreviewAnnotation[]>;
  /** Active unsaved drafts keyed by thread id. */
  readonly drafts: Record<string, PreviewDraftAnnotation | undefined>;
  /** Returns all saved annotations for a thread in creation order. */
  getThreadAnnotations(threadId: string): SavedPreviewAnnotation[];
  /** Returns saved annotations for a normalized page identity. */
  getPageAnnotations(threadId: string, pageIdentity: string): SavedPreviewAnnotation[];
  /** Starts or replaces the thread draft. */
  setDraft(threadId: string, draft: PreviewDraftAnnotation | undefined): void;
  /** Saves a draft or edited annotation into the thread bundle. */
  saveAnnotation(threadId: string, draft: PreviewDraftAnnotation, id?: string): SavedPreviewAnnotation;
  /** Deletes one saved annotation by stable id. */
  deleteAnnotation(threadId: string, id: string): void;
  /** Deletes saved annotations for the current page identity only. */
  discardPage(threadId: string, pageIdentity: string): void;
  /** Clears the full annotation set for a thread. */
  clearThread(threadId: string): void;
  /** Restores a validated outbound annotation bundle into a thread's saved set. */
  restoreBundle(threadId: string, bundle: PreviewAnnotationBundle | undefined): boolean;
  /** Builds the validated outbound bundle for a thread. */
  buildBundle(threadId: string): PreviewAnnotationBundle | undefined;
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
]);

/**
 * Normalizes a Preview URL so annotation visibility ignores fragments, query order, and tracking noise.
 */
export function normalizePreviewPageIdentity(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    const kept = Array.from(url.searchParams.entries())
      .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
      .sort(([aKey, aValue], [bKey, bValue]) =>
        aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
      );
    url.search = "";
    for (const [key, value] of kept) url.searchParams.append(key, value);
    return url.toString();
  } catch {
    return rawUrl.split("#", 1)[0]?.trim() ?? rawUrl.trim();
  }
}

function renumber(list: readonly SavedPreviewAnnotation[]): SavedPreviewAnnotation[] {
  return list.map((annotation, index) => ({
    ...annotation,
    displayNumber: index + 1,
  }));
}

function visualSummary(proposedChanges: PreviewAnnotationVisualProposal | undefined): string | undefined {
  if (!proposedChanges) return undefined;
  const labels = Object.keys(proposedChanges)
    .map((key) => key.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`))
    .join(", ");
  return labels ? `Change ${labels}.` : undefined;
}

/** Zustand store for thread-scoped Preview annotation sets. */
export const usePreviewAnnotationStore = create<PreviewAnnotationStore>((set, get) => ({
  byThread: {},
  drafts: {},

  getThreadAnnotations(threadId) {
    return get().byThread[threadId] ?? [];
  },

  getPageAnnotations(threadId, pageIdentity) {
    return (get().byThread[threadId] ?? []).filter((annotation) => annotation.pageIdentity === pageIdentity);
  },

  setDraft(threadId, draft) {
    set((state) => ({
      drafts: { ...state.drafts, [threadId]: draft },
    }));
  },

  saveAnnotation(threadId, draft, id) {
    if (!draft.snapshot) {
      throw new Error("annotation snapshot is required");
    }
    const existing = get().byThread[threadId] ?? [];
    const trimmedNote = draft.note.trim();
    const annotation: SavedPreviewAnnotation = {
      id: id ?? crypto.randomUUID(),
      createdAt: id ? (existing.find((row) => row.id === id)?.createdAt ?? Date.now()) : Date.now(),
      displayNumber: 1,
      pageIdentity: draft.pageIdentity,
      pageContext: draft.pageContext,
      targetContext: {
        label: draft.label ?? null,
        selectorHint: draft.selectorHint ?? null,
        bounds: draft.bounds,
      },
      note: trimmedNote || undefined,
      changeSummary: trimmedNote ? undefined : visualSummary(draft.proposedChanges),
      proposedChanges: draft.proposedChanges,
      snapshot: draft.snapshot,
    };
    const next = id
      ? existing.map((row) => (row.id === id ? annotation : row))
      : [...existing, annotation];
    const sorted = renumber([...next].sort((a, b) => a.createdAt - b.createdAt));
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: sorted },
      drafts: { ...state.drafts, [threadId]: undefined },
    }));
    return sorted.find((row) => row.id === annotation.id) ?? annotation;
  },

  deleteAnnotation(threadId, id) {
    const next = renumber((get().byThread[threadId] ?? []).filter((row) => row.id !== id));
    set((state) => ({ byThread: { ...state.byThread, [threadId]: next } }));
  },

  discardPage(threadId, pageIdentity) {
    const next = renumber((get().byThread[threadId] ?? []).filter((row) => row.pageIdentity !== pageIdentity));
    set((state) => ({ byThread: { ...state.byThread, [threadId]: next } }));
  },

  clearThread(threadId) {
    set((state) => {
      const byThread = { ...state.byThread };
      const drafts = { ...state.drafts };
      delete byThread[threadId];
      delete drafts[threadId];
      return { byThread, drafts };
    });
  },

  restoreBundle(threadId, bundle) {
    if (!bundle) {
      get().clearThread(threadId);
      return true;
    }
    const parsed = PreviewAnnotationBundleSchema().safeParse(bundle);
    if (!parsed.success) {
      get().clearThread(threadId);
      return false;
    }
    const baseCreatedAt = Date.now();
    const annotations = renumber(
      parsed.data.annotations.map((annotation, index) => ({
        ...annotation,
        createdAt: baseCreatedAt + index,
      })),
    );
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: annotations },
      drafts: { ...state.drafts, [threadId]: undefined },
    }));
    return true;
  },

  buildBundle(threadId) {
    const annotations = get().byThread[threadId] ?? [];
    if (annotations.length === 0) return undefined;
    return {
      schemaVersion: 1,
      annotations: annotations.map(({ createdAt: _createdAt, ...annotation }) => annotation),
    };
  },
}));
