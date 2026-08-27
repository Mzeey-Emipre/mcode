import type { GitComparisonService } from "./git-comparison-service.js";
import type { GitRepositoryService } from "./git-repository-service.js";
import type { GitWorktreeService } from "./git-worktree-service.js";
import type { PullRequestReviewGitService } from "./pull-request-review-git-service.js";
import type { WorktreeSafetyService } from "./worktree-safety-service.js";

export type { NormalizedGitRemote } from "./git-repository-service.js";
export type { RemoveWorktreeOptions } from "./git-worktree-service.js";
export { PullRequestReviewGitError } from "./pull-request-review-git-service.js";
export type {
  PullRequestReviewGitCandidate,
  PullRequestReviewGitProvisionRequest,
  PullRequestReviewGitProvisionResult,
  PullRequestReviewGitSource,
} from "./pull-request-review-git-service.js";
export type {
  BranchlessWorktreeRemovalSafety,
  NamedWorktreeRemovalSafety,
  WorktreeRemovalSafety,
} from "./worktree-safety-service.js";

/** Legacy structural type for tests that combine focused Git services. */
export type GitService = GitRepositoryService
  & GitWorktreeService
  & GitComparisonService
  & WorktreeSafetyService
  & PullRequestReviewGitService;
