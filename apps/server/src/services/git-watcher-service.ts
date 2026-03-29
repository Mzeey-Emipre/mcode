/**
 * Git HEAD file watcher service.
 * Watches each workspace's .git/HEAD file for changes and broadcasts a
 * `branch.changed` push event when the active branch switches.
 */

import { injectable } from "tsyringe";
import { watch, existsSync, type FSWatcher } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { logger } from "@mcode/shared";
import { broadcast } from "../transport/push";
import { getCurrentBranchForPath } from "./git-service";

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

  /**
   * Resolve the absolute path to the HEAD file for the given workspace path.
   * Uses `git rev-parse --git-dir` to handle both main repos and worktrees.
   * Returns null if the path is not a git repository or the HEAD file is missing.
   */
  private resolveHeadFile(workspacePath: string): string | null {
    let gitDir: string;
    try {
      const output = execFileSync(
        "git",
        ["-C", workspacePath, "rev-parse", "--git-dir"],
        { stdio: "pipe", encoding: "utf-8" },
      );
      gitDir = output.trim();
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
  watchWorkspace(workspaceId: string, workspacePath: string): void {
    if (this.watchers.has(workspaceId)) {
      return;
    }

    const headFile = this.resolveHeadFile(workspacePath);
    if (!headFile) {
      return;
    }

    let fsWatcher: FSWatcher;
    try {
      fsWatcher = watch(headFile, () => {
        const entry = this.watchers.get(workspaceId);
        if (!entry) return;

        // Debounce: cancel any pending timer and restart it
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
          entry.timer = null;
          const branch = getCurrentBranchForPath(workspacePath);
          logger.info("GitWatcherService: branch changed", {
            workspaceId,
            branch,
          });
          broadcast("branch.changed", { workspaceId, branch });
        }, DEBOUNCE_MS);
      });
    } catch (err) {
      logger.warn("GitWatcherService: fs.watch failed, degrading gracefully", {
        workspaceId,
        headFile,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.watchers.set(workspaceId, { watcher: fsWatcher, timer: null });
    logger.info("GitWatcherService: watching HEAD", { workspaceId, headFile });
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

  /** Close all active watchers. Called on server shutdown. */
  dispose(): void {
    const ids = [...this.watchers.keys()];
    for (const id of ids) {
      this.unwatchWorkspace(id);
    }
    logger.info("GitWatcherService: all watchers disposed");
  }
}
