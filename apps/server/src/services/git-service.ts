/**
 * Git operations service.
 * Manages branches, worktrees, checkout, and fetch operations using the
 * injected GitExecutor abstraction. All git invocations go through the
 * executor so tests can swap in FakeGitExecutor and production code benefits
 * from per-repo serialisation and rev-parse caching.
 */

import { injectable, inject } from "tsyringe";
import { rm, rename, rmdir } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { join, basename, dirname, resolve, relative, isAbsolute } from "path";
import { getMcodeDir, validateBranchName, validateWorktreeName, logger } from "@mcode/shared";
import type { GitBranch, WorktreeInfo, GitCommit, BranchComparison } from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import type { GitExecutor } from "./git-executor/index.js";

/**
 * Options for fs.rm when removing worktree directories.
 * maxRetries handles transient EBUSY locks from antivirus/indexers on Windows.
 */
const RM_RETRY_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;

/** Max retries for rmdir on parent directories (handles transient Windows NTFS/AV locks). */
const PARENT_RMDIR_MAX_RETRIES = 5;

/** Delay between rmdir retries in milliseconds. */
const PARENT_RMDIR_RETRY_DELAY_MS = 300;

/**
 * Options for {@link GitService.removeWorktree}.
 * Controls which worktree path is removed and whether the associated branch is deleted.
 */
interface RemoveWorktreeOptions {
  /**
   * Exact branch name to delete after the worktree is removed.
   * When omitted and deleteBranch is true, removeWorktree falls back to `mcode/<worktree-name>`.
   */
  branchName?: string;
  /**
   * Whether removeWorktree should attempt `git branch -d` after cleaning up the worktree.
   * Defaults to true; when false, branchName is ignored and no branch deletion is attempted.
   */
  deleteBranch?: boolean;
  /**
   * Exact filesystem path of the worktree to remove.
   * When omitted, removeWorktree derives the managed path under the mcode worktree directory from the worktree name.
   */
  worktreePath?: string;
}

/** Resolve the worktree base directory path under the mcode data dir. */
function getWorktreeBaseDir(repoPath: string): string {
  return join(getMcodeDir(), "worktrees", worktreeSlug(repoPath));
}

/** Resolve and ensure the worktree base directory exists. */
function ensureWorktreeBaseDir(repoPath: string): string {
  const dir = getWorktreeBaseDir(repoPath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function worktreeSlug(repoPath: string): string {
  return basename(repoPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * Retry rmdir for transient EBUSY/EPERM locks on Windows.
 * After a child directory is removed, NTFS journal updates, antivirus scans,
 * or the search indexer can briefly hold the parent directory.
 */
async function rmdirWithRetry(dirPath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rmdir(dirPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (
        (code === "EBUSY" || code === "EPERM") &&
        attempt < PARENT_RMDIR_MAX_RETRIES - 1
      ) {
        await new Promise<void>((r) => setTimeout(r, PARENT_RMDIR_RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Best-effort cleanup of empty managed parent directories after a worktree is removed.
 * Returns true if all empty parents were removed, false if any failed.
 */
async function removeEmptyManagedParentDirs(wtPath: string): Promise<boolean> {
  const managedRoot = resolve(getMcodeDir(), "worktrees");
  const rel = relative(managedRoot, resolve(wtPath));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return true;
  }

  let current = dirname(resolve(wtPath));
  while (current !== managedRoot) {
    try {
      await rmdirWithRetry(current);
      logger.info("Removed empty managed worktree parent dir", { path: current });
      current = dirname(current);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err
        ? String((err as NodeJS.ErrnoException).code)
        : "";
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        break;
      }
      if (code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      logger.warn("Failed to remove empty managed worktree parent dir", {
        path: current,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  return true;
}

/**
 * Reject a git ref that could smuggle a flag into a git argv (a leading `-`) or
 * contains characters outside what refnames and short SHAs use. Guards the
 * base/target of a Branch comparison before they are interpolated into a rev
 * range; the WS layer also validates via `GitRefSchema`, this is defense in
 * depth for any direct caller.
 */
function assertSafeRef(ref: string): void {
  if (!/^(?!-)[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`Unsafe git ref: ${ref}`);
  }
}

/** Handles all git branch, worktree, checkout, and fetch operations. */
@injectable()
export class GitService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
  ) {}

  /** List all branches (local, remote, and worktree-attached) for a workspace. */
  async listBranches(workspaceId: string): Promise<GitBranch[]> {
    const workspace = this.requireWorkspace(workspaceId);
    return this.listBranchesForPath(workspace.path);
  }

  /** Get the current branch name for a workspace. Returns null for non-git workspaces. */
  async getCurrentBranch(workspaceId: string): Promise<string | null> {
    const workspace = this.requireWorkspace(workspaceId);
    return this.getCurrentBranchForPath(workspace.path);
  }

  /**
   * Get the current branch name for an arbitrary repo path.
   * Use this instead of getCurrentBranch when you already have the resolved path
   * (e.g. a worktree directory that may differ from the workspace root).
   */
  async getCurrentBranchAt(repoPath: string): Promise<string | null> {
    return this.getCurrentBranchForPath(repoPath);
  }

  /** Checkout an existing branch in the workspace repository. */
  async checkout(workspaceId: string, branch: string): Promise<void> {
    validateBranchName(branch);
    const workspace = this.requireWorkspace(workspaceId);
    await this.gitExecutor.exec(["-C", workspace.path, "checkout", branch]);
  }

  /** List all git worktrees registered for a workspace. */
  async listWorktrees(workspaceId: string): Promise<WorktreeInfo[]> {
    const workspace = this.requireWorkspace(workspaceId);
    return this.listWorktreesForPath(workspace.path);
  }

  /** Check whether a filesystem path is a git-registered worktree for a repository. */
  async isRegisteredWorktreePath(repoPath: string, worktreePath: string): Promise<boolean> {
    const normalize = (value: string) =>
      resolve(value).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const target = normalize(worktreePath);
    const worktrees = await this.listWorktreesForPath(repoPath);
    return worktrees.some((worktree) => normalize(worktree.path) === target);
  }

  /**
   * Fetch a remote branch from origin and create a local tracking branch.
   * When prNumber is provided, fetches via `refs/pull/<n>/head` refspec.
   */
  async fetchBranch(
    workspaceId: string,
    branch: string,
    prNumber?: number,
  ): Promise<void> {
    const workspace = this.requireWorkspace(workspaceId);
    await this.fetchBranchForPath(workspace.path, branch, prNumber);
  }

  /**
   * Create a new git worktree in the mcode data directory.
   * Returns the worktree metadata including the filesystem path, whether this
   * call created the branch or attached to an existing one, and any non-fatal
   * warnings (e.g. post-checkout hook failures).
   */
  async createWorktree(
    repoPath: string,
    name: string,
    branchName?: string,
  ): Promise<WorktreeInfo & { createdBranch: boolean; warnings: string[] }> {
    validateWorktreeName(name);

    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    const branch = branchName ?? `mcode/${name}`;
    validateBranchName(branch);
    const wtPath = join(ensureWorktreeBaseDir(repoPath), name);

    if (existsSync(wtPath)) {
      throw new Error(`Worktree directory already exists: ${wtPath}`);
    }

    const createdBranch = !(await this.branchExists(repoPath, branch));
    const warnings: string[] = [];

    try {
      if (!createdBranch) {
        await this.gitExecutor.exec(["-C", repoPath, "worktree", "add", wtPath, branch]);
      } else {
        await this.gitExecutor.exec(["-C", repoPath, "worktree", "add", wtPath, "-b", branch]);
      }
    } catch (err) {
      // If the worktree's .git file exists, git initialized the worktree
      // successfully. The error likely comes from a post-checkout hook.
      // Treat it as a warning so the caller can still use the worktree.
      if (existsSync(join(wtPath, ".git"))) {
        const stderr =
          err instanceof Error && "stderr" in err
            ? String((err as { stderr: unknown }).stderr)
            : String(err);
        warnings.push(stderr || String(err));
        logger.warn("Worktree created but post-checkout hook failed", {
          wtPath,
          branch,
          error: stderr,
        });
      } else {
        throw err;
      }
    }

    return { name, path: wtPath, branch, managed: true, createdBranch, warnings };
  }

  /**
   * Remove a git worktree by name.
   * When deleteBranch is true, deletes options.branchName or the default managed branch.
   * When worktreePath is set, removes that exact worktree path instead of deriving
   * one under the managed mcode worktree directory.
   */
  async removeWorktree(
    repoPath: string,
    name: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<boolean> {
    validateWorktreeName(name);

    const wtPath = options.worktreePath ?? join(getWorktreeBaseDir(repoPath), name);
    const deleteBranch = options.deleteBranch ?? true;
    const branch = deleteBranch
      ? (options.branchName ?? `mcode/${name}`)
      : null;
    if (branch) {
      validateBranchName(branch);
    }

    await this.assertRemovableWorktreePath(repoPath, wtPath);

    // 1. Try git worktree remove
    try {
      await this.gitExecutor.exec(
        // Double --force: the second flag tells git to remove even if the
        // worktree directory is locked (e.g. held by a Windows process).
        ["-C", repoPath, "worktree", "remove", wtPath, "--force", "--force"],
        { timeout: 30_000 },
      );
    } catch (err) {
      logger.warn("git worktree remove failed", {
        wtPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Fallback: remove directory manually if git didn't clean it up.
    if (existsSync(wtPath)) {
      logger.warn(
        "Worktree directory still exists after git remove, falling back to fs.rm",
        { wtPath },
      );
      try {
        await rm(wtPath, RM_RETRY_OPTIONS);
      } catch (err) {
        logger.error("Fallback fs.rm failed", {
          wtPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Rename-then-delete: atomically unblock the path even if deletion is slow.
    // Renaming succeeds even when the directory has open handles, so the original
    // path becomes available immediately while the OS drains remaining handles.
    let deferredRm: Promise<void> | undefined;
    if (existsSync(wtPath)) {
      // Use a timestamp suffix to avoid collision with stale .deleting directories
      // left by previous crashed cleanup attempts.
      const pendingPath = `${wtPath}.deleting-${Date.now()}`;
      try {
        await rename(wtPath, pendingPath);
        logger.info("Renamed stuck worktree for deferred deletion", { wtPath, pendingPath });
        // Best-effort: .catch() intentionally swallows errors because the
        // original worktree path is already gone (renamed). If the deferred rm
        // fails the .deleting-* dir persists but the worktree is effectively
        // removed, so retrying the entire cleanup job would be pointless.
        deferredRm = rm(pendingPath, RM_RETRY_OPTIONS).catch(
          (err) => {
            logger.warn("Deferred deletion of renamed worktree failed", {
              pendingPath,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
      } catch (err) {
        logger.error("Rename-then-delete fallback failed", {
          wtPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4. Verify cleanup
    if (existsSync(wtPath)) {
      logger.error("Worktree directory could not be removed", { wtPath });
      return false;
    }

    // 5. Prune stale worktree metadata after any manual fallback removed the path.
    try {
      await this.gitExecutor.exec(["-C", repoPath, "worktree", "prune"], { timeout: 10_000 });
    } catch (err) {
      logger.warn("git worktree prune failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 6. Wait for any deferred deletion to finish so the parent directory is
    //    actually empty before we try to rmdir it.
    if (deferredRm) {
      await deferredRm;
    }

    // 7. Remove empty managed parent directories. Returns false on transient
    //    lock errors (EBUSY/EPERM) so the cleanup worker can retry later when
    //    the OS releases handles.
    const parentsCleaned = await removeEmptyManagedParentDirs(wtPath);

    // 8. Delete the branch when explicitly requested (independent of parent
    //    dir state - always attempt this).
    if (branch) {
      try {
        await this.gitExecutor.exec(["-C", repoPath, "branch", "-d", branch], { timeout: 10_000 });
      } catch (err) {
        logger.warn("Branch deletion failed (may not exist)", {
          branch,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return parentsCleaned;
  }

  /**
   * Reject fallback fs.rm when a caller-supplied worktree path is outside the
   * managed mcode worktree root and not registered with git for the repo.
   */
  private async assertRemovableWorktreePath(
    repoPath: string,
    worktreePath: string,
  ): Promise<void> {
    const managedRoot = resolve(getMcodeDir(), "worktrees");
    const rel = relative(managedRoot, resolve(worktreePath));
    const isManagedPath = !(rel.startsWith("..") || isAbsolute(rel));
    if (isManagedPath) return;

    const isRegistered = await this.isRegisteredWorktreePath(repoPath, worktreePath);
    if (!isRegistered) {
      throw new Error(
        `worktreePath is not a managed or registered worktree: ${worktreePath}`,
      );
    }
  }

  /**
   * Resolve the working directory for a thread, accounting for worktree mode.
   * Uses the thread's worktree_path when available, otherwise the workspace root.
   */
  resolveWorkingDir(
    workspacePath: string,
    threadMode: string | null,
    worktreePath: string | null,
  ): string {
    if (threadMode === "worktree" && worktreePath) {
      return worktreePath;
    }
    return workspacePath;
  }

  /** Get commit log for a workspace. When baseBranch is provided, only returns commits on branch that are not on baseBranch. Pass repoPath to run from a worktree directory instead of the workspace root. */
  async log(
    workspaceId: string,
    branch?: string,
    limit = 50,
    baseBranch?: string,
    repoPath?: string,
    skip = 0,
    includeStats = true,
  ): Promise<GitCommit[]> {
    const workspace = this.requireWorkspace(workspaceId);
    const effectivePath = repoPath ?? workspace.path;

    if (branch !== undefined) assertSafeRef(branch);
    if (baseBranch !== undefined) assertSafeRef(baseBranch);

    // Auto-detect default branch when baseBranch is omitted but branch is specified
    const resolvedBase = baseBranch !== undefined
      ? baseBranch
      : branch !== undefined
        ? await this.detectDefaultComparisonRef(effectivePath)
        : undefined;

    const args = [
      "-C", effectivePath,
      "log",
      "--pretty=format:MCODE_SEP%H|||%h|||%s|||%an|||%aI",
      `-${limit}`,
    ];
    if (skip > 0) args.push(`--skip=${skip}`);
    if (includeStats) args.push("--numstat");
    // When running from a worktree path, HEAD is the checked-out branch — no need to name it.
    const headRef = repoPath ? "HEAD" : branch;
    if (resolvedBase && headRef) {
      args.push(`${resolvedBase}..${headRef}`);
    } else if (resolvedBase) {
      args.push(`${resolvedBase}..HEAD`);
    } else if (branch) {
      args.push(branch);
    }

    let stdout: string;
    try {
      const result = await this.gitExecutor.exec(args, { timeout: 10_000 });
      stdout = result.stdout;
    } catch {
      return [];
    }

    const commits: GitCommit[] = [];
    // Each block starts with MCODE_SEP; split on that separator
    const blocks = stdout.split("MCODE_SEP").filter(Boolean);

    for (const block of blocks) {
      const lines = block.split("\n");
      const meta = lines[0];
      if (!meta) continue;

      const [sha, shortSha, message, author, date] = meta.split("|||");
      if (!sha) continue;

      // numstat lines have format: additions\tdeletions\tfilename
      const filesChanged = includeStats
        ? lines.slice(1).filter((l) => l.includes("\t")).length
        : 0;

      commits.push({
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        message: message ?? "",
        author: author ?? "",
        date: date ?? "",
        filesChanged,
      });
    }

    return commits;
  }

  /** Get unified diff for a specific git commit. */
  async commitDiff(
    workspaceId: string,
    sha: string,
    filePath?: string,
    maxLines?: number,
  ): Promise<string> {
    if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
      throw new Error(`Invalid git SHA: ${sha}`);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const args = ["-C", workspace.path, "diff", "--find-renames", `${sha}~1..${sha}`];
    if (filePath) args.push("--", filePath);

    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();
      if (maxLines) {
        return result.split("\n").slice(0, maxLines).join("\n");
      }
      return result;
    } catch {
      // Handle root commit (no parent): diff against empty tree
      try {
        const emptyTree = "4b825dc642cb6eb9a060e54bf899d69f82049264";
        const args2 = ["-C", workspace.path, "diff", "--find-renames", `${emptyTree}..${sha}`];
        if (filePath) args2.push("--", filePath);
        const { stdout } = await this.gitExecutor.exec(args2, { timeout: 10_000 });
        return stdout.trim();
      } catch {
        return "";
      }
    }
  }

  /** Get the list of files changed in a specific git commit. */
  async commitFiles(workspaceId: string, sha: string): Promise<string[]> {
    if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
      throw new Error(`Invalid git SHA: ${sha}`);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const nameOnlyArgs = ["-C", workspace.path, "diff", "--name-only", `${sha}~1..${sha}`];
    try {
      const { stdout } = await this.gitExecutor.exec(nameOnlyArgs, { timeout: 5_000 });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      // Root commit — diff against empty tree
      const emptyTree = "4b825dc642cb6eb9a060e54bf899d69f82049264";
      try {
        const { stdout } = await this.gitExecutor.exec(
          ["-C", workspace.path, "diff", "--name-only", `${emptyTree}..${sha}`],
          { timeout: 5_000 },
        );
        return stdout.trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    }
  }

  /**
   * List files in a working tree for the given stage. `staged` selects the
   * index-versus-HEAD diff (`git diff --cached`); otherwise the
   * working-tree-versus-index diff (`git diff`). Reads the workspace root by
   * default; pass `repoPath` (a thread's worktree) to read that checkout instead.
   */
  async workingTreeFiles(workspaceId: string, staged: boolean, repoPath?: string): Promise<string[]> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const args = ["-C", cwd, "diff", "--name-only"];
    if (staged) args.push("--cached");
    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get the unified diff for a working tree at the given stage. `staged` selects
   * the index-versus-HEAD diff; otherwise working-tree-versus-index. Reads the
   * workspace root by default; pass `repoPath` to read a thread's worktree.
   * Optionally scoped to a single file and truncated.
   */
  async workingTreeDiff(
    workspaceId: string,
    staged: boolean,
    filePath?: string,
    maxLines?: number,
    repoPath?: string,
  ): Promise<string> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const args = ["-C", cwd, "diff", "--find-renames"];
    if (staged) args.push("--cached");
    if (filePath) args.push("--", filePath);
    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();
      return maxLines ? result.split("\n").slice(0, maxLines).join("\n") : result;
    } catch {
      return "";
    }
  }

  /**
   * List files that differ between two refs as a three-dot comparison
   * (`base...target`, the symmetric-difference range — only what changed on the
   * target side since the two diverged). `base`/`target` default to the detected
   * default branch and HEAD respectively, preserving the legacy `base...HEAD`
   * behavior for callers that pass neither. The default pair the Branch view
   * uses is resolved by {@link resolveBranchComparison} per ADR 0007 and passed
   * explicitly. Reads the workspace root by default; pass `repoPath` to read a
   * thread's worktree. Returns an empty list when the refs match.
   */
  async branchFiles(
    workspaceId: string,
    base?: string,
    target?: string,
    repoPath?: string,
  ): Promise<string[]> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const resolvedBase = base ?? (await this.detectDefaultBranch(cwd));
    if (!resolvedBase) return [];
    const resolvedTarget = target ?? "HEAD";
    assertSafeRef(resolvedBase);
    assertSafeRef(resolvedTarget);
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", cwd, "diff", "--name-only", `${resolvedBase}...${resolvedTarget}`],
        { timeout: 10_000 },
      );
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get the unified diff between two refs as a three-dot comparison
   * (`base...target`). `base`/`target` default to the detected default branch and
   * HEAD; see {@link branchFiles} for the range semantics. Reads the workspace
   * root by default; pass `repoPath` to read a thread's worktree. Optionally
   * scoped to a single file and truncated.
   */
  async branchDiff(
    workspaceId: string,
    base?: string,
    target?: string,
    filePath?: string,
    maxLines?: number,
    repoPath?: string,
  ): Promise<string> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const resolvedBase = base ?? (await this.detectDefaultBranch(cwd));
    if (!resolvedBase) return "";
    const resolvedTarget = target ?? "HEAD";
    assertSafeRef(resolvedBase);
    assertSafeRef(resolvedTarget);
    const args = ["-C", cwd, "diff", "--find-renames", `${resolvedBase}...${resolvedTarget}`];
    if (filePath) args.push("--", filePath);
    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();
      return maxLines ? result.split("\n").slice(0, maxLines).join("\n") : result;
    } catch {
      return "";
    }
  }

  /**
   * Parse a `git diff --numstat` stdout block into a totalled { additions, deletions } pair.
   * Binary files emit "-\t-\t<path>" — those lines count as 0 for both columns, matching
   * the behaviour of the file-list methods which still include the file in their output.
   */
  private parseNumstatTotal(stdout: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const line of stdout.trim().split("\n")) {
      if (!line.includes("\t")) continue;
      const [addStr, delStr] = line.split("\t");
      additions += addStr === "-" ? 0 : parseInt(addStr ?? "0", 10);
      deletions += delStr === "-" ? 0 : parseInt(delStr ?? "0", 10);
    }
    return { additions, deletions };
  }

  /**
   * Return total additions and deletions for a Review-panel git view.
   * Ref semantics match the corresponding file-list methods so the stat
   * total always agrees with the file list the panel shows:
   *
   * - `unstaged` → working tree vs index (`git diff --numstat`)
   * - `staged`   → index vs HEAD (`git diff --numstat --cached`)
   * - `branch`   → three-dot symmetric diff (`git diff --numstat base...target`)
   * - `commit`   → parent vs commit (`git diff --numstat sha~1 sha`), with the
   *   standard empty-tree fallback for root commits
   *
   * Pass `repoPath` to read a thread's worktree instead of the workspace root.
   */
  async reviewDiffStats(
    workspaceId: string,
    view: "unstaged" | "staged" | "branch" | "commit",
    opts: { base?: string; target?: string; sha?: string },
    repoPath?: string,
  ): Promise<{ additions: number; deletions: number }> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const empty = { additions: 0, deletions: 0 };

    if (view === "unstaged" || view === "staged") {
      const args = ["-C", cwd, "diff", "--numstat"];
      if (view === "staged") args.push("--cached");
      try {
        const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
        return this.parseNumstatTotal(stdout);
      } catch {
        return empty;
      }
    }

    if (view === "branch") {
      const resolvedBase = opts.base ?? (await this.detectDefaultBranch(cwd));
      if (!resolvedBase) return empty;
      const resolvedTarget = opts.target ?? "HEAD";
      assertSafeRef(resolvedBase);
      assertSafeRef(resolvedTarget);
      try {
        const { stdout } = await this.gitExecutor.exec(
          ["-C", cwd, "diff", "--numstat", `${resolvedBase}...${resolvedTarget}`],
          { timeout: 10_000 },
        );
        return this.parseNumstatTotal(stdout);
      } catch {
        return empty;
      }
    }

    // commit view
    const sha = opts.sha;
    if (!sha || !/^[0-9a-fA-F]{4,40}$/.test(sha)) {
      throw new Error(`Invalid or missing git SHA for commit view: ${sha}`);
    }
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", cwd, "diff", "--numstat", `${sha}~1`, sha],
        { timeout: 10_000 },
      );
      return this.parseNumstatTotal(stdout);
    } catch {
      // Root commit — diff against the empty tree
      const emptyTree = "4b825dc642cb6eb9a060e54bf899d69f82049264";
      try {
        const { stdout } = await this.gitExecutor.exec(
          ["-C", cwd, "diff", "--numstat", emptyTree, sha],
          { timeout: 10_000 },
        );
        return this.parseNumstatTotal(stdout);
      } catch {
        return empty;
      }
    }
  }

  /**
   * Resolve the default Branch comparison for a checkout, plus the refs that
   * populate the base/target pickers. Implements the priority ladder from
   * `docs/adr/0007-branch-comparison-default-and-range.md`:
   *
   * 1. Tracked upstream (`@{upstream}`) when set.
   * 2. Remote default ref (`origin/<repo-default>`) when `origin` exists.
   * 3. Local default branch for feature branches in repos with no remote.
   * 4. On the local-only default branch with no upstream — no comparison
   *    (`isComparisonAvailable: false`; Branch view disabled).
   *
   * Detached HEAD compares the best available base to `HEAD`. Unborn branches
   * return `isUnborn: true`. When no base can be detected on a feature branch,
   * `base` is null and the user picks one in the ref picker.
   *
   * Reads the workspace root by default; pass `repoPath` to resolve against a
   * thread's worktree so "current branch" is the thread's branch.
   */
  async resolveBranchComparison(workspaceId: string, repoPath?: string): Promise<BranchComparison> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const refs = await this.listBranchesForPath(cwd);

    if (!(await this.hasCommits(cwd))) {
      return { base: null, target: null, refs, isUnborn: true, isComparisonAvailable: false };
    }

    const defaultBranch = await this.detectDefaultBranch(cwd);
    const originDefaultRef = await this.detectOriginDefaultRef(cwd);
    const current = await this.getCurrentBranchForPath(cwd);
    const upstream =
      current && current !== "HEAD" ? await this.getUpstreamRef(cwd) : null;
    const onDefaultBranch = defaultBranch !== null && current === defaultBranch;

    const unavailable = (
      comparison: Omit<BranchComparison, "isComparisonAvailable">,
    ): BranchComparison => ({ ...comparison, isComparisonAvailable: false });

    const available = (
      comparison: Omit<BranchComparison, "isComparisonAvailable">,
    ): BranchComparison => ({ ...comparison, isComparisonAvailable: true });

    // Detached HEAD (no branch name): compare the best base to HEAD. Three-dot
    // semantics resolve the merge-base internally, so an explicit base is enough.
    if (!current || current === "HEAD") {
      const base = upstream ?? originDefaultRef ?? defaultBranch;
      if (!base) {
        return unavailable({ base: null, target: "HEAD", refs, isUnborn: false });
      }
      return available({ base, target: "HEAD", refs, isUnborn: false });
    }

    // 1. Tracked upstream — most accurate when the branch has a remote tracking ref.
    if (upstream) {
      if (onDefaultBranch) {
        return available({ base: current, target: upstream, refs, isUnborn: false });
      }
      return available({ base: upstream, target: current, refs, isUnborn: false });
    }

    // 2. Remote default ref when origin exists but this branch has no upstream.
    if (originDefaultRef) {
      if (onDefaultBranch) {
        return available({ base: current, target: originDefaultRef, refs, isUnborn: false });
      }
      return available({ base: originDefaultRef, target: current, refs, isUnborn: false });
    }

    // 3. Local-only feature branch: compare against the detected local default.
    if (!onDefaultBranch && defaultBranch) {
      return available({ base: defaultBranch, target: current, refs, isUnborn: false });
    }

    // 4. Local-only default branch — nothing meaningful to compare.
    if (onDefaultBranch) {
      return unavailable({ base: current, target: current, refs, isUnborn: false });
    }

    // Feature branch with no detectable base — user must pick in the ref picker.
    return available({ base: null, target: current, refs, isUnborn: false });
  }

  /** Return the abbreviated upstream ref for the current branch, or null when unset. */
  private async getUpstreamRef(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--abbrev-ref", "@{upstream}"],
        { timeout: 5_000 },
      );
      const ref = stdout.trim();
      if (!ref || ref === "@{upstream}") return null;
      return ref;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the remote-qualified default ref (`origin/main`, etc.) without
   * falling back to a local branch name.
   */
  private async detectOriginDefaultRef(repoPath: string): Promise<string | null> {
    const cached = this.originDefaultRefCache.get(repoPath);
    if (cached !== undefined) return cached;

    const result = await this.resolveOriginDefaultRef(repoPath);
    this.originDefaultRefCache.set(repoPath, result);
    return result;
  }

  /** Resolve `origin/<repo-default>` via origin/HEAD; null when no origin remote. */
  private async resolveOriginDefaultRef(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim();
    } catch (err) {
      logger.debug("[detectOriginDefaultRef] origin/HEAD not set, trying set-head", {
        repoPath,
        err,
      });
    }

    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "remote", "set-head", "origin", "--auto"],
        { timeout: 1_500 },
      );
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim();
    } catch (err) {
      logger.debug("[detectOriginDefaultRef] set-head failed", { repoPath, err });
    }

    return null;
  }

  /** Whether HEAD resolves to a commit (false on an unborn branch / empty repo). */
  private async hasCommits(repoPath: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--verify", "--quiet", "HEAD"],
        { timeout: 5_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Push a branch to the origin remote, creating the upstream tracking ref if needed. */
  async push(repoPath: string, branch: string): Promise<void> {
    validateBranchName(branch);
    await this.gitExecutor.exec(
      ["-C", repoPath, "push", "--set-upstream", "origin", branch],
      { timeout: 60_000 },
    );
  }

  /** Return a diff stat summary between two refs. */
  async diffStat(repoPath: string, base: string, head: string): Promise<string> {
    const { stdout } = await this.gitExecutor.exec(
      ["-C", repoPath, "diff", "--stat", `${base}...${head}`],
      { timeout: 30_000 },
    );
    return stdout.trim();
  }

  /**
   * Check whether the working tree at repoPath has no uncommitted changes.
   * Returns true only for genuinely clean trees or paths git reports as
   * "not a git repository". Other failures (timeouts, permission errors)
   * return false so a dirty repo is never silently labelled clean — the
   * UI then surfaces the warning state instead of the green "clean" pill.
   */
  async isWorkingTreeClean(repoPath: string): Promise<boolean> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "status", "--porcelain"],
        { timeout: 5_000 },
      );
      return stdout.trim() === "";
    } catch (err) {
      const stderr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr?: string }).stderr ?? "")
          : "";
      if (/not a git repository/i.test(stderr)) return true;
      logger.warn("git status failed while checking workspace cleanliness", {
        repoPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }

  // ---------------------------------------------------------------------------
  // Private git helpers (formerly module-level functions)
  // ---------------------------------------------------------------------------

  /** Check whether a branch ref exists in the repository. */
  private async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(["-C", repoPath, "rev-parse", "--verify", branch]);
      return true;
    } catch {
      return false;
    }
  }

  /** Get the current branch name for a repository path. Returns null for non-git paths. */
  private async getCurrentBranchForPath(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"],
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** List all branches (local, remote, worktree-attached) for a repository path. */
  private async listBranchesForPath(repoPath: string): Promise<GitBranch[]> {
    let output: string;
    try {
      const { stdout } = await this.gitExecutor.exec([
        "-C",
        repoPath,
        "branch",
        "-a",
        "--format=%(refname)|||%(refname:short)|||%(objectname:short)|||%(HEAD)|||%(worktreepath)",
      ]);
      output = stdout;
    } catch {
      return [];
    }

    const branches: GitBranch[] = [];

    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const [fullRefname, refname, shortSha, head, worktreepath] = trimmed.split("|||");
      // Skip remote HEAD symrefs (refs/remotes/*/HEAD)
      if (!fullRefname || !refname || /\/HEAD$/.test(fullRefname)) continue;

      let type: GitBranch["type"];
      if (worktreepath && worktreepath.length > 0) {
        type = "worktree";
      } else if (fullRefname.startsWith("refs/remotes/")) {
        type = "remote";
      } else {
        type = "local";
      }

      branches.push({
        name: refname,
        shortSha: shortSha ?? "",
        type,
        isCurrent: head === "*",
      });
    }

    const typeOrder: Record<GitBranch["type"], number> = {
      local: 0,
      worktree: 1,
      remote: 2,
    };

    return branches.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      const orderDiff = typeOrder[a.type] - typeOrder[b.type];
      if (orderDiff !== 0) return orderDiff;
      return a.name.localeCompare(b.name);
    });
  }

  /** List all git worktrees for a repository path. */
  private async listWorktreesForPath(repoPath: string): Promise<WorktreeInfo[]> {
    const worktreesDir = getWorktreeBaseDir(repoPath)
      .replace(/\\/g, "/")
      .toLowerCase();
    const normalizedRepo = repoPath
      .replace(/\\/g, "/")
      .toLowerCase()
      .replace(/\/+$/, "");

    let output: string;
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "worktree", "list", "--porcelain"],
      );
      output = stdout;
    } catch {
      return [];
    }

    const result: WorktreeInfo[] = [];
    let currentPath = "";
    let currentBranch = "";

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length).trim();
        currentBranch = "";
      } else if (line.startsWith("branch ")) {
        currentBranch = line
          .slice("branch ".length)
          .trim()
          .replace("refs/heads/", "");
      } else if (line === "detached") {
        currentBranch = "(detached)";
      } else if (line.trim() === "" && currentPath) {
        const normalized = currentPath
          .replace(/\\/g, "/")
          .toLowerCase()
          .replace(/\/+$/, "");
        if (normalized !== normalizedRepo && currentBranch) {
          const name =
            currentPath.replace(/\\/g, "/").split("/").pop() || currentPath;
          const managed = normalized.startsWith(worktreesDir + "/");
          result.push({ name, path: currentPath, branch: currentBranch, managed });
        }
        currentPath = "";
        currentBranch = "";
      }
    }

    // Handle last entry (porcelain output may not end with blank line)
    if (currentPath && currentBranch) {
      const normalized = currentPath
        .replace(/\\/g, "/")
        .toLowerCase()
        .replace(/\/+$/, "");
      if (normalized !== normalizedRepo) {
        const name =
          currentPath.replace(/\\/g, "/").split("/").pop() || currentPath;
        const managed = normalized.startsWith(worktreesDir + "/");
        result.push({ name, path: currentPath, branch: currentBranch, managed });
      }
    }

    return result;
  }

  /**
   * Fetch a remote branch from origin and create a local tracking branch.
   * When prNumber is provided, fetches via `refs/pull/<n>/head` refspec.
   */
  private async fetchBranchForPath(
    repoPath: string,
    branch: string,
    prNumber?: number,
  ): Promise<void> {
    validateBranchName(branch);

    let fetchOk = true;
    try {
      if (prNumber != null) {
        await this.gitExecutor.exec([
          "-C",
          repoPath,
          "fetch",
          "origin",
          `+pull/${prNumber}/head:${branch}`,
        ]);
      } else {
        await this.gitExecutor.exec(["-C", repoPath, "fetch", "origin", branch]);
      }
    } catch {
      fetchOk = false;
    }

    if (fetchOk && prNumber == null) {
      const localExists = await this.branchExists(repoPath, branch);
      if (localExists) {
        await this.gitExecutor.exec(
          ["-C", repoPath, "branch", "-f", branch, `origin/${branch}`],
        );
      } else {
        await this.gitExecutor.exec(
          ["-C", repoPath, "branch", "--track", branch, `origin/${branch}`],
        );
      }
    } else if (!fetchOk && !(await this.branchExists(repoPath, branch))) {
      throw new Error(`Branch "${branch}" not found locally or on origin`);
    }
  }

  /** Per-repo cache: avoids re-running mutating git commands on every log call. */
  private readonly defaultBranchCache = new Map<string, string | null>();
  private readonly defaultComparisonRefCache = new Map<string, string | null>();
  private readonly originDefaultRefCache = new Map<string, string | null>();

  /** Detect the default comparison ref for commit ranges, preferring the remote-qualified ref. */
  private async detectDefaultComparisonRef(repoPath: string): Promise<string | null> {
    const cached = this.defaultComparisonRefCache.get(repoPath);
    if (cached !== undefined) return cached;

    const result = await this.resolveDefaultComparisonRef(repoPath);
    this.defaultComparisonRefCache.set(repoPath, result);
    return result;
  }

  /** Resolve the default comparison ref, preserving `origin/main` when available. */
  private async resolveDefaultComparisonRef(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim();
    } catch (err) {
      logger.debug("[detectDefaultComparisonRef] origin/HEAD not set, trying set-head", { repoPath, err });
    }

    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "remote", "set-head", "origin", "--auto"],
        { timeout: 1_500 },
      );
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim();
    } catch (err) {
      logger.debug("[detectDefaultComparisonRef] set-head failed, falling back to local default", { repoPath, err });
    }

    return this.detectDefaultBranch(repoPath);
  }

  /** Detect the default upstream branch (e.g. main, master) for a repository. */
  private async detectDefaultBranch(repoPath: string): Promise<string | null> {
    const cached = this.defaultBranchCache.get(repoPath);
    if (cached !== undefined) return cached;

    const result = await this.resolveDefaultBranch(repoPath);
    this.defaultBranchCache.set(repoPath, result);
    return result;
  }

  /** Resolve the default comparison branch by probing git refs in order of cheapness. */
  private async resolveDefaultBranch(repoPath: string): Promise<string | null> {
    // 1. Ask the remote tracking ref (fast, no network, works if origin/HEAD is set)
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim().replace(/^[^/]+\//, "");
    } catch (err) {
      logger.debug("[detectDefaultBranch] origin/HEAD not set, trying set-head", { repoPath, err });
    }

    // 2. Ask the remote to set origin/HEAD, then re-read it.
    // Timeout is short (1 500 ms) so an unreachable remote doesn't block the caller.
    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "remote", "set-head", "origin", "--auto"],
        { timeout: 1_500 },
      );
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim().replace(/^[^/]+\//, "");
    } catch (err) {
      logger.debug("[detectDefaultBranch] set-head failed, falling back to HEAD", { repoPath, err });
    }

    // 3. Local-only repos have no origin/HEAD; prefer established default branch
    // names when they exist instead of treating the current feature branch as base.
    for (const branchName of ["main", "master", "develop", "trunk"]) {
      try {
        await this.gitExecutor.exec(
          ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
          { timeout: 5_000 },
        );
        return branchName;
      } catch {
        // Keep probing the next conventional default name.
      }
    }

    logger.debug("[detectDefaultBranch] no default branch detected", { repoPath });
    return null;
  }
}
