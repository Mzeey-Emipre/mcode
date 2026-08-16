/**
 * Git HEAD file watcher service.
 * Watches each workspace's .git/HEAD file for changes and broadcasts a
 * `branch.changed` push event when the active branch switches.
 */

import { injectable, inject } from "tsyringe";
import { watch, existsSync, type FSWatcher } from "fs";
import { join, dirname, basename } from "path";
import { logger } from "@mcode/shared";
import { broadcast } from "../transport/push";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import type { GitExecutor } from "./git-executor/index.js";
import type { GitService } from "../features/projects/index.js";
import { ThreadService } from "./thread-service.js";

/** Debounce delay in milliseconds to batch rapid HEAD file writes (e.g., during rebase). */
const DEBOUNCE_MS = 200;

/** Internal state for a single active workspace watcher. */
interface WatcherEntry {
  /** The fs.watch FSWatcher instance. */
  watcher: FSWatcher;
  /** Pending debounce timer handle, or null when idle. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Watches workspace `.git/HEAD` files for changes and broadcasts
 * `branch.changed` push events to connected clients.
 */
@injectable()
export class GitWatcherService {
  private readonly watchers = new Map<string, WatcherEntry>();
  private readonly threadWatchers = new Map<string, WatcherEntry>();
  private onThreadCheckoutChanged: ((threadId: string) => void) | null = null;

  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject("GitService") private readonly gitService: GitService,
    @inject(ThreadService) private readonly threadService: ThreadService,
  ) {}

  /** Register a callback invoked after a thread checkout branch/state changes. */
  setThreadCheckoutChangedListener(listener: ((threadId: string) => void) | null): void {
    this.onThreadCheckoutChanged = listener;
  }

  /**
   * Resolve the absolute path to the HEAD file for the given workspace path.
   * Uses `git rev-parse --git-dir` to handle both main repos and worktrees.
   * Returns null if the path is not a git repository or the HEAD file is missing.
   */
  private async resolveHeadFile(workspacePath: string): Promise<string | null> {
    let gitDir: string;
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", workspacePath, "rev-parse", "--git-dir"],
      );
      gitDir = stdout.trim();
    } catch {
      logger.warn("GitWatcherService: not a git repo, skipping watcher", {
        workspacePath,
      });
      return null;
    }

    // `git rev-parse --git-dir` returns a relative path (`.git`) for the main
    // worktree and an absolute path for linked worktrees.
    const resolvedGitDir = gitDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(gitDir)
      ? gitDir
      : join(workspacePath, gitDir);

    const headFile = join(resolvedGitDir, "HEAD");
    if (!existsSync(headFile)) {
      logger.warn("GitWatcherService: HEAD file not found, skipping watcher", {
        headFile,
      });
      return null;
    }

    return headFile;
  }

  /**
   * Start watching the HEAD file for the given workspace.
   * A duplicate call for the same `workspaceId` is a no-op (existing watcher is kept).
   */
  async watchWorkspace(workspaceId: string, workspacePath: string): Promise<void> {
    if (this.watchers.has(workspaceId)) {
      return;
    }

    const headFile = await this.resolveHeadFile(workspacePath);
    if (!headFile) {
      return;
    }

    // Watch the parent directory rather than the HEAD file inode directly.
    // Git may atomically replace HEAD via rename(), which would create a new
    // inode and silently drop a file-level watcher on some platforms.
    const headDir = dirname(headFile);
    const headName = basename(headFile);

    let fsWatcher: FSWatcher;
    try {
      fsWatcher = watch(headDir, (_, filename) => {
        // Ignore events for other files in the .git directory
        if ((filename ?? headName) !== headName) return;

        const entry = this.watchers.get(workspaceId);
        if (!entry) return;

        // Debounce: cancel any pending timer and restart it
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
          entry.timer = null;
          void this.gitService.getCurrentBranchAt(workspacePath).then((branch) => {
            logger.info("GitWatcherService: branch changed", {
              workspaceId,
              branch,
            });
            broadcast("branch.changed", { workspaceId, branch });
          }).catch((err) => {
            logger.warn("GitWatcherService: failed to read branch after HEAD change", {
              workspaceId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, DEBOUNCE_MS);
      });

      fsWatcher.on("error", (err) => {
        logger.warn("GitWatcherService: watcher error, stopping watch", {
          workspaceId,
          headDir,
          error: err.message,
        });
        this.unwatchWorkspace(workspaceId);
      });
    } catch (err) {
      logger.warn("GitWatcherService: fs.watch failed, degrading gracefully", {
        workspaceId,
        headDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.watchers.set(workspaceId, { watcher: fsWatcher, timer: null });
    logger.info("GitWatcherService: watching HEAD", { workspaceId, headDir, headName });
  }

  /**
   * Start watching a worktree thread's HEAD file for external checkout changes.
   */
  async watchThreadWorktree(threadId: string, worktreePath: string): Promise<void> {
    if (this.threadWatchers.has(threadId)) return;

    const headFile = await this.resolveHeadFile(worktreePath);
    if (!headFile) return;

    const headDir = dirname(headFile);
    const headName = basename(headFile);

    let fsWatcher: FSWatcher;
    try {
      fsWatcher = watch(headDir, (_, filename) => {
        if ((filename ?? headName) !== headName) return;

        const entry = this.threadWatchers.get(threadId);
        if (!entry) return;

        if (entry.timer !== null) {
          clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
          entry.timer = null;
          void this.threadService.syncCheckoutFromHead(threadId).then((result) => {
            if (!result?.changed) return;
            const { thread } = result;
            try {
              this.onThreadCheckoutChanged?.(thread.id);
            } catch (err) {
              logger.warn("GitWatcherService: checkout-change listener failed", {
                threadId: thread.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            broadcast("thread.checkoutChanged", {
              threadId: thread.id,
              workspaceId: thread.workspace_id,
              branch: thread.branch,
              checkoutState: thread.checkout_state,
              baseBranch: thread.base_branch,
              prNumber: thread.pr_number,
              prStatus: thread.pr_status,
            });
          }).catch((err) => {
            logger.warn("GitWatcherService: failed to sync thread checkout after HEAD change", {
              threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, DEBOUNCE_MS);
      });

      fsWatcher.on("error", (err) => {
        logger.warn("GitWatcherService: thread watcher error, stopping watch", {
          threadId,
          headDir,
          error: err.message,
        });
        this.unwatchThreadWorktree(threadId);
      });
    } catch (err) {
      logger.warn("GitWatcherService: thread fs.watch failed, degrading gracefully", {
        threadId,
        headDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.threadWatchers.set(threadId, { watcher: fsWatcher, timer: null });
    logger.info("GitWatcherService: watching thread HEAD", { threadId, headDir, headName });
  }

  /**
   * Attempt to start watching a workspace that was previously detected as non-git.
   * Called on thread.list to catch `git init` within a session.
   * Returns true if the workspace is now a git repo and the watcher was started.
   */
  async retryWatch(workspaceId: string, workspacePath: string): Promise<boolean> {
    if (this.watchers.has(workspaceId)) return true;

    const headFile = await this.resolveHeadFile(workspacePath);
    if (!headFile) return false;

    // The folder is now a git repo — update the DB, start watching, notify clients.
    this.workspaceRepo.setIsGitRepo(workspaceId, true);
    await this.watchWorkspace(workspaceId, workspacePath);

    logger.info("GitWatcherService: non-git workspace became a git repo", {
      workspaceId,
    });

    broadcast("workspace.gitStatusChanged", {
      workspaceId,
      isGitRepo: true,
    });

    return true;
  }

  /**
   * Stop watching the HEAD file for the given workspace.
   * Safe to call when no watcher exists for the workspace.
   */
  unwatchWorkspace(workspaceId: string): void {
    const entry = this.watchers.get(workspaceId);
    if (!entry) {
      return;
    }

    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    try {
      entry.watcher.close();
    } catch {
      // Ignore close errors
    }
    this.watchers.delete(workspaceId);
    logger.info("GitWatcherService: stopped watching", { workspaceId });
  }

  /** Stop watching a thread worktree HEAD file. */
  unwatchThreadWorktree(threadId: string): void {
    const entry = this.threadWatchers.get(threadId);
    if (!entry) return;

    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    try {
      entry.watcher.close();
    } catch {
      // Ignore close errors
    }
    this.threadWatchers.delete(threadId);
    logger.info("GitWatcherService: stopped watching thread", { threadId });
  }

  /** Close all active watchers. Called on server shutdown. */
  dispose(): void {
    const ids = [...this.watchers.keys()];
    for (const id of ids) {
      this.unwatchWorkspace(id);
    }
    const threadIds = [...this.threadWatchers.keys()];
    for (const id of threadIds) {
      this.unwatchThreadWorktree(id);
    }
    logger.info("GitWatcherService: all watchers disposed");
  }
}
