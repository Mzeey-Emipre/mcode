import { create } from "zustand";

const MAX_DRAFT_BODY_BYTES = 64 * 1024;
const MAX_DRAFT_COUNT = 100;
const MAX_DRAFT_TOTAL_BYTES = 1024 * 1024;

/** Pull request snapshot that owns one session-only review draft. */
export interface PullRequestDraftSnapshot {
  identityKey: string;
  baseOid: string;
  headOid: string;
}

/** Snapshot-qualified location for one local inline review draft. */
export interface PullRequestDraftCoordinate {
  subjectType: "line" | "file";
  path: string;
  side: "left" | "right" | null;
  startSide: "left" | "right" | null;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  commitOid: string | null;
}

/** Session-only inline comment or reply waiting for a later review submission. */
export interface PullRequestReviewDraft {
  localId: string;
  snapshotKey: string;
  identityKey: string;
  baseOid: string;
  headOid: string;
  kind: "inline" | "reply";
  path: string;
  coordinate: PullRequestDraftCoordinate | null;
  threadProviderNodeId: string | null;
  body: string;
  bodyBytes: number;
  createdAt: number;
  updatedAt: number;
  outdated: boolean;
}

/** Snapshot-qualified overall body and event selected for one pending review. */
export interface PullRequestReviewSummaryDraft {
  identityKey: string;
  snapshotKey: string;
  baseOid: string;
  headOid: string;
  event: "approve" | "comment" | "request_changes";
  body: string;
  bodyBytes: number;
  outdated: boolean;
}

/** Input used to create one bounded session review draft. */
export interface CreatePullRequestReviewDraftInput {
  snapshot: PullRequestDraftSnapshot;
  kind: PullRequestReviewDraft["kind"];
  path: string;
  coordinate?: PullRequestDraftCoordinate | null;
  threadProviderNodeId?: string | null;
  body?: string;
}

/** Result of a bounded draft mutation. */
export type PullRequestReviewDraftMutationResult =
  | { ok: true; localId: string }
  | {
      ok: false;
      reason: "body_too_large" | "draft_limit" | "total_too_large" | "not_found";
    };

/** In-memory state and actions for a bounded pull request review draft. */
export interface PullRequestReviewDraftStoreState {
  drafts: Record<string, PullRequestReviewDraft>;
  summaryDrafts: Record<string, PullRequestReviewSummaryDraft>;
  order: string[];
  totalBodyBytes: number;
  placementRevision: number;
  contentRevision: number;
  createDraft: (
    input: CreatePullRequestReviewDraftInput,
  ) => PullRequestReviewDraftMutationResult;
  updateDraft: (
    localId: string,
    body: string,
  ) => PullRequestReviewDraftMutationResult;
  setSummaryDraft: (
    snapshot: PullRequestDraftSnapshot,
    input: Pick<PullRequestReviewSummaryDraft, "body" | "event">,
  ) => PullRequestReviewDraftMutationResult;
  removeDraft: (localId: string) => void;
  removeAcceptedDrafts: (snapshotKey: string, localIds: readonly string[]) => void;
  clearSummaryDraft: (snapshotKey: string, acceptedBody?: string) => void;
  reconcileActiveSnapshot: (snapshot: PullRequestDraftSnapshot) => void;
  clearSnapshot: (snapshotKey: string) => void;
  reset: () => void;
}

const textEncoder = new TextEncoder();

function bodyBytes(body: string): number {
  return textEncoder.encode(body).byteLength;
}

/** Return the stable key for one pull request base and head snapshot. */
export function getPullRequestReviewDraftSnapshotKey(
  snapshot: PullRequestDraftSnapshot,
): string {
  return `${snapshot.identityKey}:${snapshot.baseOid}:${snapshot.headOid}`;
}

/** Bounded session-only pull request draft store. */
export const usePullRequestReviewDraftStore =
  create<PullRequestReviewDraftStoreState>((set, get) => ({
    drafts: {},
    summaryDrafts: {},
    order: [],
    totalBodyBytes: 0,
    placementRevision: 0,
    contentRevision: 0,

    createDraft: (input) => {
      const body = input.body ?? "";
      const bytes = bodyBytes(body);
      const state = get();
      if (bytes > MAX_DRAFT_BODY_BYTES) {
        return { ok: false, reason: "body_too_large" };
      }
      if (state.order.length >= MAX_DRAFT_COUNT) {
        return { ok: false, reason: "draft_limit" };
      }
      if (state.totalBodyBytes + bytes > MAX_DRAFT_TOTAL_BYTES) {
        return { ok: false, reason: "total_too_large" };
      }

      const now = Date.now();
      const localId = crypto.randomUUID();
      const snapshotKey = getPullRequestReviewDraftSnapshotKey(input.snapshot);
      const draft: PullRequestReviewDraft = {
        localId,
        snapshotKey,
        identityKey: input.snapshot.identityKey,
        baseOid: input.snapshot.baseOid,
        headOid: input.snapshot.headOid,
        kind: input.kind,
        path: input.path,
        coordinate: input.coordinate ?? null,
        threadProviderNodeId: input.threadProviderNodeId ?? null,
        body,
        bodyBytes: bytes,
        createdAt: now,
        updatedAt: now,
        outdated: false,
      };
      set({
        drafts: { ...state.drafts, [localId]: draft },
        order: [...state.order, localId],
        totalBodyBytes: state.totalBodyBytes + bytes,
        placementRevision: state.placementRevision + 1,
      });
      return { ok: true, localId };
    },

    updateDraft: (localId, body) => {
      const state = get();
      const draft = state.drafts[localId];
      if (!draft) return { ok: false, reason: "not_found" };
      const bytes = bodyBytes(body);
      if (bytes > MAX_DRAFT_BODY_BYTES) {
        return { ok: false, reason: "body_too_large" };
      }
      const nextTotal = state.totalBodyBytes - draft.bodyBytes + bytes;
      if (nextTotal > MAX_DRAFT_TOTAL_BYTES) {
        return { ok: false, reason: "total_too_large" };
      }
      set({
        drafts: {
          ...state.drafts,
          [localId]: {
            ...draft,
            body,
            bodyBytes: bytes,
            updatedAt: Date.now(),
          },
        },
        totalBodyBytes: nextTotal,
        contentRevision: state.contentRevision + 1,
      });
      return { ok: true, localId };
    },

    setSummaryDraft: (snapshot, input) => {
      const state = get();
      const bytes = bodyBytes(input.body);
      if (bytes > MAX_DRAFT_BODY_BYTES) {
        return { ok: false, reason: "body_too_large" };
      }
      const previous = state.summaryDrafts[snapshot.identityKey];
      const nextTotal = state.totalBodyBytes - (previous?.bodyBytes ?? 0) + bytes;
      if (nextTotal > MAX_DRAFT_TOTAL_BYTES) {
        return { ok: false, reason: "total_too_large" };
      }
      const snapshotKey = getPullRequestReviewDraftSnapshotKey(snapshot);
      set({
        summaryDrafts: {
          ...state.summaryDrafts,
          [snapshot.identityKey]: {
            identityKey: snapshot.identityKey,
            snapshotKey,
            baseOid: snapshot.baseOid,
            headOid: snapshot.headOid,
            event: input.event,
            body: input.body,
            bodyBytes: bytes,
            outdated: false,
          },
        },
        totalBodyBytes: nextTotal,
        contentRevision: state.contentRevision + 1,
      });
      return { ok: true, localId: snapshotKey };
    },

    removeDraft: (localId) => {
      const state = get();
      const draft = state.drafts[localId];
      if (!draft) return;
      const drafts = { ...state.drafts };
      delete drafts[localId];
      set({
        drafts,
        order: state.order.filter((id) => id !== localId),
        totalBodyBytes: state.totalBodyBytes - draft.bodyBytes,
        placementRevision: state.placementRevision + 1,
      });
    },

    removeAcceptedDrafts: (snapshotKey, localIds) => {
      if (localIds.length === 0) return;
      const state = get();
      const accepted = new Set(localIds);
      const removedIds = state.order.filter((localId) => {
        const draft = state.drafts[localId];
        return draft?.snapshotKey === snapshotKey && accepted.has(localId);
      });
      if (removedIds.length === 0) return;
      const removed = new Set(removedIds);
      const drafts = { ...state.drafts };
      let totalBodyBytes = state.totalBodyBytes;
      for (const localId of removedIds) {
        totalBodyBytes -= drafts[localId]?.bodyBytes ?? 0;
        delete drafts[localId];
      }
      set({
        drafts,
        order: state.order.filter((localId) => !removed.has(localId)),
        totalBodyBytes,
        placementRevision: state.placementRevision + 1,
      });
    },

    clearSummaryDraft: (snapshotKey, acceptedBody) => {
      const state = get();
      const entry = Object.entries(state.summaryDrafts).find(
        ([, draft]) => draft.snapshotKey === snapshotKey,
      );
      if (!entry) return;
      const [identityKey, draft] = entry;
      if (acceptedBody !== undefined && draft.body !== acceptedBody) return;
      const summaryDrafts = { ...state.summaryDrafts };
      delete summaryDrafts[identityKey];
      set({
        summaryDrafts,
        totalBodyBytes: state.totalBodyBytes - draft.bodyBytes,
        contentRevision: state.contentRevision + 1,
      });
    },

    reconcileActiveSnapshot: (snapshot) => {
      const state = get();
      const activeSnapshotKey = getPullRequestReviewDraftSnapshotKey(snapshot);
      let changed = false;
      const drafts = Object.fromEntries(
        Object.entries(state.drafts).map(([localId, draft]) => {
          if (draft.identityKey !== snapshot.identityKey) return [localId, draft];
          const outdated = draft.snapshotKey !== activeSnapshotKey;
          if (draft.outdated === outdated) return [localId, draft];
          changed = true;
          return [localId, { ...draft, outdated }];
        }),
      );
      const summaryDraft = state.summaryDrafts[snapshot.identityKey];
      const summaryOutdated = summaryDraft?.snapshotKey !== activeSnapshotKey;
      const summaryDrafts =
        summaryDraft && summaryDraft.outdated !== summaryOutdated
          ? {
              ...state.summaryDrafts,
              [snapshot.identityKey]: { ...summaryDraft, outdated: summaryOutdated },
            }
          : state.summaryDrafts;
      if (summaryDrafts !== state.summaryDrafts) changed = true;
      if (changed) {
        set({
          drafts,
          summaryDrafts,
          placementRevision: state.placementRevision + 1,
        });
      }
    },

    clearSnapshot: (snapshotKey) => {
      const state = get();
      const removedIds = new Set(
        state.order.filter((localId) => state.drafts[localId]?.snapshotKey === snapshotKey),
      );
      const matchingSummary = Object.entries(state.summaryDrafts).find(
        ([, draft]) => draft.snapshotKey === snapshotKey,
      );
      if (removedIds.size === 0 && !matchingSummary) return;
      const drafts = Object.fromEntries(
        Object.entries(state.drafts).filter(([localId]) => !removedIds.has(localId)),
      );
      const order = state.order.filter((localId) => !removedIds.has(localId));
      const summaryDrafts = { ...state.summaryDrafts };
      if (matchingSummary) delete summaryDrafts[matchingSummary[0]];
      const totalBodyBytes = order.reduce(
        (total, localId) => total + (drafts[localId]?.bodyBytes ?? 0),
        Object.values(summaryDrafts).reduce(
          (total, draft) => total + draft.bodyBytes,
          0,
        ),
      );
      set({
        drafts,
        summaryDrafts,
        order,
        totalBodyBytes,
        placementRevision: state.placementRevision + 1,
      });
    },

    reset: () =>
      set((state) => ({
        drafts: {},
        summaryDrafts: {},
        order: [],
        totalBodyBytes: 0,
        placementRevision: state.placementRevision + 1,
        contentRevision: state.contentRevision + 1,
      })),
  }));
