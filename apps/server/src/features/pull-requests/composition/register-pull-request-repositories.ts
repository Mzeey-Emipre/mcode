import { Lifecycle, type DependencyContainer } from "tsyringe";

import { PullRequestReviewLinkRepo } from "../reviews/persistence/pull-request-review-link-repo.js";

/** Register pull-request review linkage persistence. */
export function registerPullRequestRepositories(container: DependencyContainer): void {
  container.register(
    PullRequestReviewLinkRepo,
    { useClass: PullRequestReviewLinkRepo },
    { lifecycle: Lifecycle.Singleton },
  );
}
