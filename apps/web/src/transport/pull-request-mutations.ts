import type {
  PullRequestCloseRequest,
  PullRequestCloseResult,
  PullRequestMergeRequest,
  PullRequestMergeResult,
  PullRequestPostCommentRequest,
  PullRequestPostCommentResult,
  PullRequestSetReadinessRequest,
  PullRequestSetReadinessResult,
  PullRequestSubmitReviewRequest,
  PullRequestSubmitReviewResult,
} from "@mcode/contracts";
import { getTransport } from "./index";

/** Explicit, non-cancellable remote pull request mutation transport. */
export interface PullRequestMutationTransport {
  postComment(request: PullRequestPostCommentRequest): Promise<PullRequestPostCommentResult>;
  submitReview(request: PullRequestSubmitReviewRequest): Promise<PullRequestSubmitReviewResult>;
  setReadiness(
    request: PullRequestSetReadinessRequest,
  ): Promise<PullRequestSetReadinessResult>;
  close(request: PullRequestCloseRequest): Promise<PullRequestCloseResult>;
  merge(request: PullRequestMergeRequest): Promise<PullRequestMergeResult>;
}

/** Create the five explicit pull request mutation methods over the active connection. */
export function getPullRequestMutationTransport(): PullRequestMutationTransport {
  const transport = getTransport();
  return {
    postComment: (request) => transport.postPullRequestComment(request),
    submitReview: (request) => transport.submitPullRequestReview(request),
    setReadiness: (request) => transport.setPullRequestReadiness(request),
    close: (request) => transport.closePullRequest(request),
    merge: (request) => transport.mergePullRequest(request),
  };
}
