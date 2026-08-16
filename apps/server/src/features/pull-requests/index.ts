/** Provides GitHub pull-request lifecycle operations used by server composition. */
export { GithubService } from "./github-service.js";

/** Identifies a linked thread whose pull-request state should be refreshed. */
export type { PullRequestWatchTarget, PullRequestWatchSnapshot } from "./github-service.js";

/** Runs provider-neutral GitHub pull-request commands. */
export { GithubPullRequestClient } from "./github-pull-request-client.js";

/** Serves pull-request queries and review-task capabilities. */
export { PullRequestService } from "./pull-request-service.js";

/** Executes explicit pull-request mutations after preflight. */
export { PullRequestMutationService } from "./pull-request-mutation-service.js";

/** Creates and restores pull-request review worktrees. */
export { ReviewWorktreeService } from "./review-worktree-service.js";
