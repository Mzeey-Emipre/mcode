/** Provides GitHub pull-request lifecycle operations used by server composition. */
export { GithubService } from "./github/github-service.js";

/** Identifies a linked thread whose pull-request state should be refreshed. */
export type { PullRequestWatchTarget, PullRequestWatchSnapshot } from "./github/github-service.js";

/** Runs provider-neutral GitHub pull-request commands. */
export { GithubPullRequestClient } from "./github/github-pull-request-client.js";

/** Serves pull-request queries and review-task capabilities. */
export { PullRequestService } from "./queries/pull-request-service.js";

/** Executes explicit pull-request mutations after preflight. */
export { PullRequestMutationService } from "./mutations/pull-request-mutation-service.js";

/** Creates and restores pull-request review worktrees. */
export { ReviewWorktreeService } from "./reviews/review-worktree-service.js";

/** Polls linked pull requests for CI state and lifecycle changes. */
export { CiWatcherService } from "./status/ci-watcher.js";

/** Refreshes branch pull-request linkage after terminal turn publication. */
export { TurnPullRequestCompletionEffect } from "./lifecycle/turn-pull-request-completion-effect.js";

/** Generates pull-request titles and bodies from repository and thread context. */
export { PrDraftService } from "./drafts/pr-draft-service.js";
