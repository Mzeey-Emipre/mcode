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

/** Persists private workspace environment documents with revision checks. */
export {
  WorkspaceEnvironmentService,
} from "./environment/workspace-environment-service.js";
/** Owns retained Project Action execution and lifecycle. */
export {
  ProjectActionService,
  PROJECT_ACTION_CLOCK_TOKEN,
  PROJECT_ACTION_RUN_ID_FACTORY_TOKEN,
} from "./environment/project-action-service.js";
export type {
  ProjectActionClock,
  ProjectActionRunIdFactory,
} from "./environment/project-action-service.js";
export { WorkspaceEnvironmentServiceError } from "./environment/workspace-environment-errors.js";
