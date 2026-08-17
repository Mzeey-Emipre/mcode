import { Lifecycle, type DependencyContainer } from "tsyringe";

import {
  GithubPullRequestClient,
  GithubService,
  PrDraftService,
  PullRequestMutationService,
  PullRequestService,
  ReviewWorktreeService,
} from "../index.js";

/** Register the GitHub client, pull-request services, and review worktree service. */
export function registerPullRequestServices(container: DependencyContainer): void {
  container.register(
    GithubService,
    { useClass: GithubService },
    { lifecycle: Lifecycle.Singleton },
  );
  const githubPullRequestClient = new GithubPullRequestClient();
  const pullRequestService = new PullRequestService(githubPullRequestClient);
  container.registerInstance(GithubPullRequestClient, githubPullRequestClient);
  container.registerInstance(PullRequestService, pullRequestService);
  container.registerInstance(
    PullRequestMutationService,
    new PullRequestMutationService(githubPullRequestClient, pullRequestService),
  );
  container.register(
    ReviewWorktreeService,
    { useClass: ReviewWorktreeService },
    { lifecycle: Lifecycle.Singleton },
  );
}

/** Register pull-request draft generation after provider availability is ready. */
export function registerPullRequestDraftService(container: DependencyContainer): void {
  container.register(
    PrDraftService,
    { useClass: PrDraftService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("PrDraftService", {
    useFactory: (c) => c.resolve(PrDraftService),
  });
}
