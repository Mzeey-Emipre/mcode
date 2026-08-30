import { create } from "zustand";
import type {
  BrowserPreviewBounds,
  BrowserPreviewElementStyle,
  ComposerAnnotationPayload,
  DiffAnnotationPayload,
  McodeBrowserCaptureV2,
  PreviewAnnotationBundle,
  PreviewAnnotationPayload,
  PreviewAnnotationVisualProposal,
} from "@mcode/contracts";
import { isDiffAnnotationPayload, PreviewAnnotationBundleSchema } from "@mcode/contracts";

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

/** Saved local code comment with stable identity and creation ordering. */
export interface SavedDiffAnnotation extends DiffAnnotationPayload {
  /** Stable sort key independent of display number. */
  readonly createdAt: number;
}

/** Input captured by a Dev diff line before it becomes a saved annotation. */
export interface DiffAnnotationInput {
  /** Workspace-relative file path. */
  readonly filePath: string;
  /** Diff side that owns the target line. */
  readonly side: DiffAnnotationPayload["side"];
  /** Target line number on that side. */
  readonly line: number;
  /** Source line text shown to the agent for context. */
  readonly lineContent: string;
  /** User review note. */
  readonly note: string;
}

interface PreviewAnnotationStore {
  /** Saved annotation sets keyed by thread id. */
  readonly byThread: Record<string, SavedPreviewAnnotation[]>;
  /** Saved Dev code comments keyed by thread id. */
  readonly diffByThread: Record<string, SavedDiffAnnotation[]>;
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
  /** Saves a local diff line comment into the thread bundle. */
  saveDiffAnnotation(threadId: string, input: DiffAnnotationInput, id?: string): SavedDiffAnnotation;
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

function renumberAnnotations(
  preview: readonly SavedPreviewAnnotation[],
  diff: readonly SavedDiffAnnotation[],
): { preview: SavedPreviewAnnotation[]; diff: SavedDiffAnnotation[] } {
  const ordered = [...preview, ...diff].sort((a, b) => a.createdAt - b.createdAt);
  const numbers = new Map(ordered.map((annotation, index) => [annotation.id, index + 1]));
  return {
    preview: preview.map((annotation) => ({
      ...annotation,
      displayNumber: numbers.get(annotation.id) ?? annotation.displayNumber,
    })),
    diff: diff.map((annotation) => ({
      ...annotation,
      displayNumber: numbers.get(annotation.id) ?? annotation.displayNumber,
    })),
  };
}

function visualSummary(proposedChanges: PreviewAnnotationVisualProposal | undefined): string | undefined {
  if (!proposedChanges) return undefined;
  const labels = Object.keys(proposedChanges)
    .map((key) => key.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`))
    .join(", ");
  return labels ? `Change ${labels}.` : undefined;
}

function savedPreviewAnnotation(
  existing: readonly SavedPreviewAnnotation[],
  draft: PreviewDraftAnnotation,
  id: string | undefined,
): SavedPreviewAnnotation {
  const note = draft.note.trim();
  return {
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
    note: note || undefined,
    changeSummary: note ? undefined : visualSummary(draft.proposedChanges),
    proposedChanges: draft.proposedChanges,
    snapshot: draft.snapshot!,
  };
}

function replaceOrAppendPreviewAnnotation(
  existing: readonly SavedPreviewAnnotation[],
  annotation: SavedPreviewAnnotation,
  replacesId: string | undefined,
): SavedPreviewAnnotation[] {
  return replacesId
    ? existing.map((row) => row.id === replacesId ? annotation : row)
    : [...existing, annotation];
}

/** Zustand store for thread-scoped Preview annotation sets. */
export const usePreviewAnnotationStore = create<PreviewAnnotationStore>((set, get) => ({
  byThread: {},
  diffByThread: {},
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
    const annotation = savedPreviewAnnotation(existing, draft, id);
    const nextPreview = replaceOrAppendPreviewAnnotation(existing, annotation, id);
    const next = renumberAnnotations(nextPreview, get().diffByThread[threadId] ?? []);
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: next.preview },
      diffByThread: { ...state.diffByThread, [threadId]: next.diff },
      drafts: { ...state.drafts, [threadId]: undefined },
    }));
    return next.preview.find((row) => row.id === annotation.id) ?? annotation;
  },

  saveDiffAnnotation(threadId, input, id) {
    const existing = get().diffByThread[threadId] ?? [];
    const note = input.note.trim();
    if (!note) throw new Error("code comment note is required");
    const annotation: SavedDiffAnnotation = {
      kind: "diff",
      id: id ?? crypto.randomUUID(),
      createdAt: id ? (existing.find((row) => row.id === id)?.createdAt ?? Date.now()) : Date.now(),
      displayNumber: 1,
      filePath: input.filePath,
      side: input.side,
      line: input.line,
      lineContent: input.lineContent,
      note,
    };
    const nextDiff = id
      ? existing.map((row) => (row.id === id ? annotation : row))
      : [...existing, annotation];
    const next = renumberAnnotations(get().byThread[threadId] ?? [], nextDiff);
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: next.preview },
      diffByThread: { ...state.diffByThread, [threadId]: next.diff },
    }));
    return next.diff.find((row) => row.id === annotation.id) ?? annotation;
  },

  deleteAnnotation(threadId, id) {
    const next = renumberAnnotations(
      (get().byThread[threadId] ?? []).filter((row) => row.id !== id),
      (get().diffByThread[threadId] ?? []).filter((row) => row.id !== id),
    );
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: next.preview },
      diffByThread: { ...state.diffByThread, [threadId]: next.diff },
    }));
  },

  discardPage(threadId, pageIdentity) {
    const next = renumberAnnotations(
      (get().byThread[threadId] ?? []).filter((row) => row.pageIdentity !== pageIdentity),
      get().diffByThread[threadId] ?? [],
    );
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: next.preview },
      diffByThread: { ...state.diffByThread, [threadId]: next.diff },
    }));
  },

  clearThread(threadId) {
    set((state) => {
      const byThread = { ...state.byThread };
      const diffByThread = { ...state.diffByThread };
      const drafts = { ...state.drafts };
      delete byThread[threadId];
      delete diffByThread[threadId];
      delete drafts[threadId];
      return { byThread, diffByThread, drafts };
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
    const preview: SavedPreviewAnnotation[] = [];
    const diff: SavedDiffAnnotation[] = [];
    parsed.data.annotations.forEach((annotation, index) => {
      if (isDiffAnnotationPayload(annotation)) {
        diff.push({ ...annotation, createdAt: baseCreatedAt + index });
      } else {
        preview.push({ ...annotation, createdAt: baseCreatedAt + index });
      }
    });
    const annotations = renumberAnnotations(preview, diff);
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: annotations.preview },
      diffByThread: { ...state.diffByThread, [threadId]: annotations.diff },
      drafts: { ...state.drafts, [threadId]: undefined },
    }));
    return true;
  },

  buildBundle(threadId) {
    const annotations: Array<ComposerAnnotationPayload & { createdAt: number }> = [
      ...(get().byThread[threadId] ?? []),
      ...(get().diffByThread[threadId] ?? []),
    ];
    if (annotations.length === 0) return undefined;
    return {
      schemaVersion: 1,
      annotations: annotations
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(({ createdAt: _createdAt, ...annotation }) => annotation),
    };
  },
}));
