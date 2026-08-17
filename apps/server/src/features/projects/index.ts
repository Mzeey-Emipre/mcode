/** Workspace lifecycle service used by server composition roots. */
export { WorkspaceService } from "./lifecycle/workspace-service.js";

/** Enriches workspaces with filesystem and thread metadata. */
export { WorkspaceEnricher } from "./lifecycle/workspace-enricher.js";

/** Browses host directories for project selection. */
export { FilesystemBrowser } from "./lifecycle/filesystem-browser.js";

/** Provides project Git and worktree operations. */
export {
  GitService,
  PullRequestReviewGitError,
} from "./git/git-service.js";
/** Watches project Git HEAD changes and synchronizes checkout state. */
export { GitWatcherService } from "./git/git-watcher-service.js";
export type {
  BranchlessWorktreeRemovalSafety,
  NamedWorktreeRemovalSafety,
  NormalizedGitRemote,
  PullRequestReviewGitCandidate,
  PullRequestReviewGitProvisionRequest,
  PullRequestReviewGitProvisionResult,
  PullRequestReviewGitSource,
  WorktreeRemovalSafety,
} from "./git/git-service.js";

/** Removes managed worktree directories with bounded safety checks. */
export {
  WorktreeDirectoryRemover,
} from "./worktrees/worktree-directory-remover.js";
export type { WorktreeDirectoryRemoverDependencies } from "./worktrees/worktree-directory-remover.js";

/** Provisions and schedules cleanup for project worktrees. */
export { ProjectWorktreeService } from "./worktrees/project-worktree-service.js";
