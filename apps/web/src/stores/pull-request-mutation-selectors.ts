import type { PullRequestIdentity } from "@mcode/contracts";
import {
  getPullRequestMutationIdentityKey,
  getPullRequestMutationLaneKey,
  getPullRequestOutcomeUnknownLane,
  type PullRequestMutationEffect,
  type PullRequestMutationLane,
  type PullRequestMutationStoreState,
} from "./pullRequestMutationStore";

const EMPTY_LANES: Record<PullRequestMutationEffect, PullRequestMutationLane> = {
  comment: emptyLane("comment"),
  review: emptyLane("review"),
  readiness: emptyLane("readiness"),
  close: emptyLane("close"),
  merge: emptyLane("merge"),
};

function emptyLane(effect: PullRequestMutationEffect): PullRequestMutationLane {
  return {
    effect,
    status: "idle",
    idempotencyKey: null,
    request: null,
    error: null,
    result: null,
    draftSnapshotKey: null,
    updatedAt: 0,
  };
}

/** Select exactly one explicit remote-effect lane. */
export function selectPullRequestMutationLane(
  identity: PullRequestIdentity,
  effect: PullRequestMutationEffect,
): (state: PullRequestMutationStoreState) => PullRequestMutationLane {
  const key = getPullRequestMutationLaneKey(identity, effect);
  return (state) => state.lanes[key] ?? EMPTY_LANES[effect];
}

/** Select the session issue-comment body for one pull request. */
export function selectPullRequestCommentDraft(
  identity: PullRequestIdentity,
): (state: PullRequestMutationStoreState) => string {
  const key = getPullRequestMutationIdentityKey(identity);
  return (state) => state.commentDrafts[key] ?? "";
}

/** Select the identity-level unknown-outcome receipt blocking every remote effect. */
export function selectPullRequestOutcomeUnknownLane(
  identity: PullRequestIdentity,
): (state: PullRequestMutationStoreState) => PullRequestMutationLane | null {
  return (state) => getPullRequestOutcomeUnknownLane(state.lanes, identity);
}
