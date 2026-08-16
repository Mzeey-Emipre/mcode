/** Workspace lifecycle service used by server composition roots. */
export { WorkspaceService } from "./lifecycle/workspace-service.js";

/** Enriches workspaces with filesystem and thread metadata. */
export { WorkspaceEnricher } from "./lifecycle/workspace-enricher.js";

/** Browses host directories for project selection. */
export { FilesystemBrowser } from "./lifecycle/filesystem-browser.js";

/** Provides project Git and worktree operations. */
export { GitService } from "../../services/git-service.js";

/** Removes managed worktree directories with bounded safety checks. */
export { WorktreeDirectoryRemover } from "../../services/worktree-directory-remover.js";
