import type {
  PullRequestCreateReviewTaskRequest,
  PullRequestCreateReviewTaskResult,
  PullRequestReviewLinkRequest,
  PullRequestReviewLinkResult,
} from "@mcode/contracts";
import { getTransport } from "./index";

/** Narrow transport used only by local pull request Review-task workflows. */
export interface PullRequestReviewTaskTransport {
  /** Prepare or create a local Review task for one pull request. */
  createReviewTask(
    request: PullRequestCreateReviewTaskRequest,
  ): Promise<PullRequestCreateReviewTaskResult>;
  /** Resolve the durable pull request link for one thread. */
  reviewLink(request: PullRequestReviewLinkRequest): Promise<PullRequestReviewLinkResult>;
}

/** Create the Review-task transport over the active Mcode connection. */
export function getPullRequestReviewTaskTransport(): PullRequestReviewTaskTransport {
  const transport = getTransport();
  return {
    createReviewTask: (request) => transport.createPullRequestReviewTask(request),
    reviewLink: (request) => transport.getPullRequestReviewLink(request),
  };
}
