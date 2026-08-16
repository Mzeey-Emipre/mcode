import {
  PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
  type PullRequestCloseRequest,
  type PullRequestCloseResult,
  type PullRequestIdentity,
  type PullRequestMergeRequest,
  type PullRequestMergeResult,
  type PullRequestMutationError,
  type PullRequestPostCommentRequest,
  type PullRequestPostCommentResult,
  type PullRequestSetReadinessRequest,
  type PullRequestSetReadinessResult,
  type PullRequestSubmitReviewRequest,
  type PullRequestSubmitReviewResult,
} from "@mcode/contracts";
import { create } from "zustand";
import {
  getPullRequestMutationTransport,
  type PullRequestMutationTransport,
} from "@/transport/pull-request-mutations";
import {
  getPullRequestTransport,
  type PullRequestTransport,
} from "@/transport/pull-requests";
import { usePullRequestCodeStore } from "./pullRequestCodeStore";
import { getPullRequestDetailKey, usePullRequestDetailStore } from "./pullRequestDetailStore";
import { usePullRequestReviewDraftStore } from "./pullRequestReviewDraftStore";
import { usePullRequestStore } from "./pullRequestStore";

/** Independently confirmed remote effect for one pull request. */
export type PullRequestMutationEffect =
  | "comment"
  | "review"
  | "readiness"
  | "close"
  | "merge";

/** Lifecycle of one explicit, non-cancellable remote mutation. */
export type PullRequestMutationStatus = "idle" | "submitting" | "error" | "accepted";

type PullRequestMutationRequest =
  | PullRequestPostCommentRequest
  | PullRequestSubmitReviewRequest
  | PullRequestSetReadinessRequest
  | PullRequestCloseRequest
  | PullRequestMergeRequest;

/** Result union returned by the five explicit mutation methods. */
export type PullRequestMutationResult =
  | PullRequestPostCommentResult
  | PullRequestSubmitReviewResult
  | PullRequestSetReadinessResult
  | PullRequestCloseResult
  | PullRequestMergeResult;

/** One identity-and-effect lane retained for safe same-key retries. */
export interface PullRequestMutationLane {
  effect: PullRequestMutationEffect;
  status: PullRequestMutationStatus;
  idempotencyKey: string | null;
  request: PullRequestMutationRequest | null;
  error: PullRequestMutationError | null;
  result: PullRequestMutationResult | null;
  draftSnapshotKey: string | null;
  updatedAt: number;
}

type PullRequestOutcomeUnknownLane = PullRequestMutationLane & {
  status: "error";
  error: PullRequestMutationError;
};

/** Optional transports used by mutation actions and their read-cache refresh. */
export interface PullRequestMutationDependencies {
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
}

/** Public state and actions for explicit pull request remote effects. */
export interface PullRequestMutationStoreState {
  lanes: Record<string, PullRequestMutationLane>;
  commentDrafts: Record<string, string>;
  setCommentDraft: (identity: PullRequestIdentity, body: string) => boolean;
  postComment: (
    request: Omit<PullRequestPostCommentRequest, "idempotencyKey">,
    dependencies?: PullRequestMutationDependencies,
  ) => Promise<PullRequestPostCommentResult>;
  submitReview: (
    request: Omit<PullRequestSubmitReviewRequest, "idempotencyKey">,
    draftSnapshotKey: string,
    dependencies?: PullRequestMutationDependencies,
  ) => Promise<PullRequestSubmitReviewResult>;
  setReadiness: (
    request: Omit<PullRequestSetReadinessRequest, "idempotencyKey">,
    dependencies?: PullRequestMutationDependencies,
  ) => Promise<PullRequestSetReadinessResult>;
  close: (
    request: Omit<PullRequestCloseRequest, "idempotencyKey">,
    dependencies?: PullRequestMutationDependencies,
  ) => Promise<PullRequestCloseResult>;
  merge: (
    request: Omit<PullRequestMergeRequest, "idempotencyKey">,
    dependencies?: PullRequestMutationDependencies,
  ) => Promise<PullRequestMergeResult>;
  retry: (
    identity: PullRequestIdentity,
    effect: PullRequestMutationEffect,
    dependencies?: PullRequestMutationDependencies,
  ) => Promise<PullRequestMutationResult | null>;
  acknowledgeOutcomeUnknownAfterRefresh: (
    identity: PullRequestIdentity,
    refresh: () => Promise<boolean> | boolean,
  ) => Promise<boolean>;
  clearLane: (identity: PullRequestIdentity, effect: PullRequestMutationEffect) => void;
  reset: () => void;
}

const textEncoder = new TextEncoder();
const inFlightByLane = new Map<string, Promise<PullRequestMutationResult>>();
const MAX_MUTATION_LANES = 512;
const MAX_COMMENT_DRAFTS = 100;

/** Return the stable key for one identity and explicit remote effect. */
export function getPullRequestMutationLaneKey(
  identity: PullRequestIdentity,
  effect: PullRequestMutationEffect,
): string {
  return `${getPullRequestDetailKey(identity)}:${effect}`;
}

/** Return the stable identity key used by mutation-owned session drafts. */
export function getPullRequestMutationIdentityKey(identity: PullRequestIdentity): string {
  return getPullRequestDetailKey(identity);
}

/** Return the newest unknown-outcome receipt quarantining one pull request identity. */
export function getPullRequestOutcomeUnknownLane(
  lanes: Record<string, PullRequestMutationLane>,
  identity: PullRequestIdentity,
): PullRequestOutcomeUnknownLane | null {
  const identityPrefix = `${getPullRequestMutationIdentityKey(identity)}:`;
  let newest: PullRequestOutcomeUnknownLane | null = null;
  for (const [key, lane] of Object.entries(lanes)) {
    if (
      !key.startsWith(identityPrefix) ||
      lane.status !== "error" ||
      lane.error?.conflictReason !== "outcome_unknown" ||
      (newest && newest.updatedAt >= lane.updatedAt)
    ) {
      continue;
    }
    newest = lane as PullRequestOutcomeUnknownLane;
  }
  return newest;
}

function outcomeUnknown(): PullRequestMutationError {
  return {
    code: "conflict",
    conflictReason: "outcome_unknown",
    message: "The remote outcome could not be confirmed.",
  };
}

function withBoundedLane(
  lanes: Record<string, PullRequestMutationLane>,
  laneKey: string,
  lane: PullRequestMutationLane,
): Record<string, PullRequestMutationLane> {
  const next = { ...lanes, [laneKey]: lane };
  if (Object.keys(next).length <= MAX_MUTATION_LANES) return next;
  const evictable = Object.entries(next)
    .filter(([key, candidate]) => key !== laneKey && !laneMustBeRetained(candidate))
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt);
  while (Object.keys(next).length > MAX_MUTATION_LANES) {
    const oldest = evictable.shift();
    if (!oldest) break;
    delete next[oldest[0]];
  }
  return next;
}

function laneMustBeRetained(lane: PullRequestMutationLane): boolean {
  return (
    lane.status === "submitting" ||
    (lane.status === "error" && lane.error?.conflictReason === "outcome_unknown")
  );
}

function callMutation(
  effect: PullRequestMutationEffect,
  request: PullRequestMutationRequest,
  transport: PullRequestMutationTransport,
): Promise<PullRequestMutationResult> {
  switch (effect) {
    case "comment":
      return transport.postComment(request as PullRequestPostCommentRequest);
    case "review":
      return transport.submitReview(request as PullRequestSubmitReviewRequest);
    case "readiness":
      return transport.setReadiness(request as PullRequestSetReadinessRequest);
    case "close":
      return transport.close(request as PullRequestCloseRequest);
    case "merge":
      return transport.merge(request as PullRequestMergeRequest);
  }
}

function invalidateReadCaches(
  identity: PullRequestIdentity,
  transport: PullRequestTransport,
): void {
  void Promise.allSettled([
    usePullRequestStore.getState().invalidateAfterMutation(transport),
    usePullRequestDetailStore.getState().invalidateAfterMutation(identity, transport),
    usePullRequestCodeStore.getState().invalidateAfterMutation(identity, transport),
  ]);
}

function finishAccepted(
  identity: PullRequestIdentity,
  effect: PullRequestMutationEffect,
  request: PullRequestMutationRequest,
  result: PullRequestMutationResult,
  draftSnapshotKey: string | null,
  readTransport: PullRequestTransport,
): void {
  if (effect === "comment" && result.ok && result.effect === "comment") {
    const identityKey = getPullRequestMutationIdentityKey(identity);
    usePullRequestMutationStore.setState((state) => ({
      commentDrafts:
        state.commentDrafts[identityKey] === (request as PullRequestPostCommentRequest).body
          ? Object.fromEntries(
              Object.entries(state.commentDrafts).filter(([key]) => key !== identityKey),
            )
          : state.commentDrafts,
    }));
  }
  if (
    effect === "review" &&
    result.ok &&
    result.effect === "review" &&
    draftSnapshotKey
  ) {
    const drafts = usePullRequestReviewDraftStore.getState();
    drafts.removeAcceptedDrafts(draftSnapshotKey, result.acceptedDraftIds);
    drafts.clearSummaryDraft(
      draftSnapshotKey,
      (request as PullRequestSubmitReviewRequest).body ?? "",
    );
  }
  invalidateReadCaches(identity, readTransport);
}

async function dispatchMutation(
  identity: PullRequestIdentity,
  effect: PullRequestMutationEffect,
  request: PullRequestMutationRequest,
  draftSnapshotKey: string | null,
  dependencies: PullRequestMutationDependencies = {},
): Promise<PullRequestMutationResult> {
  const laneKey = getPullRequestMutationLaneKey(identity, effect);
  const running = inFlightByLane.get(laneKey);
  if (running) return running;
  const retainedLane = getPullRequestOutcomeUnknownLane(
    usePullRequestMutationStore.getState().lanes,
    identity,
  );
  if (retainedLane) {
    return (
      retainedLane.result ?? {
        ok: false,
        error: retainedLane.error,
      }
    );
  }
  const mutationTransport =
    dependencies.mutationTransport ?? getPullRequestMutationTransport();
  const readTransport = dependencies.readTransport ?? getPullRequestTransport();
  const existingLane = usePullRequestMutationStore.getState().lanes[laneKey];
  if (
    !existingLane &&
    Object.keys(usePullRequestMutationStore.getState().lanes).length >=
      MAX_MUTATION_LANES &&
    Object.values(usePullRequestMutationStore.getState().lanes).every(laneMustBeRetained)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "Too many pull request mutations are still pending.",
      },
    };
  }
  usePullRequestMutationStore.setState((state) => ({
    lanes: withBoundedLane(state.lanes, laneKey, {
        effect,
        status: "submitting",
        idempotencyKey: request.idempotencyKey,
        request,
        error: null,
        result: null,
        draftSnapshotKey,
        updatedAt: Date.now(),
      }),
  }));

  const task = (async (): Promise<PullRequestMutationResult> => {
    let result: PullRequestMutationResult;
    try {
      result = await callMutation(effect, request, mutationTransport);
    } catch {
      result = { ok: false, error: outcomeUnknown() };
    }
    usePullRequestMutationStore.setState((state) => ({
      lanes: withBoundedLane(state.lanes, laneKey, {
          effect,
          status: result.ok ? "accepted" : "error",
          idempotencyKey: request.idempotencyKey,
          request,
          error: result.ok ? null : result.error,
          result,
          draftSnapshotKey,
          updatedAt: Date.now(),
        }),
    }));
    if (result.ok) {
      finishAccepted(identity, effect, request, result, draftSnapshotKey, readTransport);
    } else if (result.error.conflictReason === "permission_changed") {
      void usePullRequestStore.getState().loadCapabilities(readTransport);
    }
    return result;
  })().finally(() => {
    if (inFlightByLane.get(laneKey) === task) inFlightByLane.delete(laneKey);
  });
  inFlightByLane.set(laneKey, task);
  return task;
}

/** Fine-grained, bounded store for pull request mutation confirmations and retries. */
export const usePullRequestMutationStore = create<PullRequestMutationStoreState>(
  (set, get) => ({
    lanes: {},
    commentDrafts: {},

    setCommentDraft: (identity, body) => {
      if (textEncoder.encode(body).byteLength > PULL_REQUEST_MUTATION_BODY_MAX_BYTES) {
        return false;
      }
      const identityKey = getPullRequestMutationIdentityKey(identity);
      const state = get();
      const commentDrafts = { ...state.commentDrafts };
      if (!(identityKey in commentDrafts) && Object.keys(commentDrafts).length >= MAX_COMMENT_DRAFTS) {
        const emptyKey = Object.keys(commentDrafts).find(
          (key) => commentDrafts[key]?.trim().length === 0,
        );
        if (!emptyKey) return false;
        delete commentDrafts[emptyKey];
      }
      commentDrafts[identityKey] = body;
      set({ commentDrafts });
      return true;
    },

    postComment: (request, dependencies) =>
      dispatchMutation(
        request.identity,
        "comment",
        { ...request, idempotencyKey: crypto.randomUUID() },
        null,
        dependencies,
      ) as Promise<PullRequestPostCommentResult>,

    submitReview: (request, draftSnapshotKey, dependencies) =>
      dispatchMutation(
        request.identity,
        "review",
        { ...request, idempotencyKey: crypto.randomUUID() },
        draftSnapshotKey,
        dependencies,
      ) as Promise<PullRequestSubmitReviewResult>,

    setReadiness: (request, dependencies) =>
      dispatchMutation(
        request.identity,
        "readiness",
        { ...request, idempotencyKey: crypto.randomUUID() },
        null,
        dependencies,
      ) as Promise<PullRequestSetReadinessResult>,

    close: (request, dependencies) =>
      dispatchMutation(
        request.identity,
        "close",
        { ...request, idempotencyKey: crypto.randomUUID() },
        null,
        dependencies,
      ) as Promise<PullRequestCloseResult>,

    merge: (request, dependencies) =>
      dispatchMutation(
        request.identity,
        "merge",
        { ...request, idempotencyKey: crypto.randomUUID() },
        null,
        dependencies,
      ) as Promise<PullRequestMergeResult>,

    retry: (identity, effect, dependencies) => {
      const lane = get().lanes[getPullRequestMutationLaneKey(identity, effect)];
      if (!lane?.request || lane.status === "submitting") return Promise.resolve(null);
      return dispatchMutation(
        identity,
        effect,
        lane.request,
        lane.draftSnapshotKey,
        dependencies,
      );
    },

    acknowledgeOutcomeUnknownAfterRefresh: async (identity, refresh) => {
      const identityPrefix = `${getPullRequestMutationIdentityKey(identity)}:`;
      const receipts = new Map(
        Object.entries(get().lanes)
          .filter(
            ([key, lane]) =>
              key.startsWith(identityPrefix) &&
              lane.status === "error" &&
              lane.error?.conflictReason === "outcome_unknown",
          )
          .map(([key, lane]) => [
            key,
            { idempotencyKey: lane.idempotencyKey, updatedAt: lane.updatedAt },
          ]),
      );
      let refreshed: boolean;
      try {
        refreshed = await refresh();
      } catch {
        return false;
      }
      if (!refreshed) return false;
      set((state) => ({
        lanes: Object.fromEntries(
          Object.entries(state.lanes).filter(
            ([key, lane]) => {
              const receipt = receipts.get(key);
              return !(
                receipt &&
                lane.status === "error" &&
                lane.error?.conflictReason === "outcome_unknown" &&
                lane.idempotencyKey === receipt.idempotencyKey &&
                lane.updatedAt === receipt.updatedAt
              );
            },
          ),
        ),
      }));
      return true;
    },

    clearLane: (identity, effect) =>
      set((state) => {
        const laneKey = getPullRequestMutationLaneKey(identity, effect);
        if (!state.lanes[laneKey] || laneMustBeRetained(state.lanes[laneKey]!)) {
          return state;
        }
        const lanes = { ...state.lanes };
        delete lanes[laneKey];
        return { lanes };
      }),

    reset: () => {
      set((state) => ({
        lanes: Object.fromEntries(
          Object.entries(state.lanes).filter(([, lane]) => laneMustBeRetained(lane)),
        ),
        commentDrafts: {},
      }));
    },
  }),
);
