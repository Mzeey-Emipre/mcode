/**
 * Git operations service.
 * Manages branches, worktrees, checkout, and fetch operations using shell git commands.
 * Extracted from apps/desktop/src/main/worktree.ts.
 */

import { injectable, inject } from "tsyringe";
import { execFileSync, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { rm } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { getMcodeDir, validateBranchName, validateWorktreeName, logger } from "@mcode/shared";
import type { GitBranch, WorktreeInfo, GitCommit } from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo";

const execFile = promisify(execFileCb);

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

/** Check whether a branch ref exists in the repository. */
function branchExists(repoPath: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", branch], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/** Handles all git branch, worktree, checkout, and fetch operations. */
@injectable()
export class GitService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  /** List all branches (local, remote, and worktree-attached) for a workspace. */
  listBranches(workspaceId: string): GitBranch[] {
    const workspace = this.requireWorkspace(workspaceId);
    return listBranchesForPath(workspace.path);
  }

  /** Get the current branch name for a workspace. */
  getCurrentBranch(workspaceId: string): string {
    const workspace = this.requireWorkspace(workspaceId);
    return getCurrentBranchForPath(workspace.path);
  }

  /** Checkout an existing branch in the workspace repository. */
  checkout(workspaceId: string, branch: string): void {
    const workspace = this.requireWorkspace(workspaceId);
    execFileSync("git", ["-C", workspace.path, "checkout", branch], {
      stdio: "pipe",
    });
  }

  /** List all git worktrees registered for a workspace. */
  listWorktrees(workspaceId: string): WorktreeInfo[] {
    const workspace = this.requireWorkspace(workspaceId);
    return listWorktreesForPath(workspace.path);
  }

  /**
   * Fetch a remote branch from origin and create a local tracking branch.
   * When prNumber is provided, fetches via `refs/pull/<n>/head` refspec.
   */
  fetchBranch(
    workspaceId: string,
    branch: string,
    prNumber?: number,
  ): void {
    const workspace = this.requireWorkspace(workspaceId);
    fetchBranchForPath(workspace.path, branch, prNumber);
  }

  /**
   * Create a new git worktree in the mcode data directory.
   * Returns the worktree metadata including the filesystem path.
   */
  createWorktree(
    repoPath: string,
    name: string,
    branchName?: string,
  ): WorktreeInfo {
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

    if (branchExists(repoPath, branch)) {
      execFileSync(
        "git",
        ["-C", repoPath, "worktree", "add", wtPath, branch],
        { stdio: "pipe" },
      );
    } else {
      execFileSync(
        "git",
        ["-C", repoPath, "worktree", "add", wtPath, "-b", branch],
        { stdio: "pipe" },
      );
    }

    return { name, path: wtPath, branch, managed: true };
  }

  /** Remove a git worktree by name. Returns true if the directory was cleaned up. */
  async removeWorktree(
    repoPath: string,
    name: string,
    branchName?: string,
  ): Promise<boolean> {
    validateWorktreeName(name);

    const wtPath = join(getWorktreeBaseDir(repoPath), name);
    const branch = branchName ?? `mcode/${name}`;
    validateBranchName(branch);

    // 1. Try git worktree remove
    try {
      await execFile(
        "git",
        ["-C", repoPath, "worktree", "remove", wtPath, "--force"],
        { timeout: 30_000 },
      );
    } catch (err) {
      logger.warn("git worktree remove failed", {
        wtPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Prune stale worktree metadata
    try {
      await execFile("git", ["-C", repoPath, "worktree", "prune"], {
        timeout: 10_000,
      });
    } catch (err) {
      logger.warn("git worktree prune failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Fallback: remove directory manually if git didn't clean it up
    if (existsSync(wtPath)) {
      logger.warn(
        "Worktree directory still exists after git remove, falling back to fs.rm",
        { wtPath },
      );
      try {
        await rm(wtPath, { recursive: true, force: true });
      } catch (err) {
        logger.error("Fallback fs.rm failed", {
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

    // 5. Delete the branch
    try {
      await execFile("git", ["-C", repoPath, "branch", "-d", branch], {
        timeout: 10_000,
      });
    } catch (err) {
      logger.warn("Branch deletion failed (may not exist)", {
        branch,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return true;
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

  /** Get commit log for a workspace. When baseBranch is provided, only returns commits on branch that are not on baseBranch. */
  async log(workspaceId: string, branch?: string, limit = 50, baseBranch?: string): Promise<GitCommit[]> {
    const workspace = this.requireWorkspace(workspaceId);

    // Auto-detect default branch when baseBranch is omitted but branch is specified
    const resolvedBase = baseBranch !== undefined
      ? baseBranch
      : branch !== undefined
        ? await this.detectDefaultBranch(workspace.path)
        : undefined;

    const args = [
      "-C", workspace.path,
      "log",
      "--pretty=format:MCODE_SEP%H|||%h|||%s|||%an|||%aI",
      "--numstat",
      `-${limit}`,
    ];
    if (resolvedBase && branch) {
      args.push(`${resolvedBase}..${branch}`);
    } else if (resolvedBase) {
      args.push(`${resolvedBase}..HEAD`);
    } else if (branch) {
      args.push(branch);
    }

    const { stdout } = await execFile("git", args, { timeout: 10_000 });

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
      const filesChanged = lines.slice(1).filter((l) => l.includes("\t")).length;

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
      const { stdout } = await execFile("git", args, { timeout: 10_000 });
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
        const { stdout } = await execFile("git", args2, { timeout: 10_000 });
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
      const { stdout } = await execFile("git", nameOnlyArgs, { timeout: 5_000 });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      // Root commit — diff against empty tree
      const emptyTree = "4b825dc642cb6eb9a060e54bf899d69f82049264";
      try {
        const { stdout } = await execFile(
          "git",
          ["-C", workspace.path, "diff", "--name-only", `${emptyTree}..${sha}`],
          { timeout: 5_000 },
        );
        return stdout.trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    }
  }

  /** Per-repo cache: avoids re-running mutating git commands on every log call. */
  private readonly defaultBranchCache = new Map<string, string>();

  /** Detect the default upstream branch (e.g. main, master) for a repository. */
  private async detectDefaultBranch(repoPath: string): Promise<string> {
    const cached = this.defaultBranchCache.get(repoPath);
    if (cached !== undefined) return cached;

    const result = await this.resolveDefaultBranch(repoPath);
    this.defaultBranchCache.set(repoPath, result);
    return result;
  }

  /** Resolve the default branch by probing git refs in order of cheapness. */
  private async resolveDefaultBranch(repoPath: string): Promise<string> {
    // 1. Ask the remote tracking ref (fast, no network, works if origin/HEAD is set)
    try {
      const { stdout } = await execFile(
        "git",
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
      await execFile(
        "git",
        ["-C", repoPath, "remote", "set-head", "origin", "--auto"],
        { timeout: 1_500 },
      );
      const { stdout } = await execFile(
        "git",
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim().replace(/^[^/]+\//, "");
    } catch (err) {
      logger.debug("[detectDefaultBranch] set-head failed, falling back to HEAD", { repoPath, err });
    }

    // 3. Last resort: use whatever HEAD currently points at (works for local-only repos)
    try {
      const { stdout } = await execFile(
        "git",
        ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim();
    } catch (err) {
      logger.debug("[detectDefaultBranch] rev-parse failed, defaulting to main", { repoPath, err });
      return "main";
    }
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }
}

// ---------------------------------------------------------------------------
// Standalone helper functions (not on the class, to keep them testable)
// ---------------------------------------------------------------------------

/** List all branches (local, remote, worktree-attached) for a repository path. */
function listBranchesForPath(repoPath: string): GitBranch[] {
  const output = execFileSync(
    "git",
    [
      "-C",
      repoPath,
      "branch",
      "-a",
      "--format=%(refname:short)|||%(objectname:short)|||%(HEAD)|||%(worktreepath)",
    ],
    { stdio: "pipe", encoding: "utf-8" },
  );

  const branches: GitBranch[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [refname, shortSha, head, worktreepath] = trimmed.split("|||");
    if (!refname || refname === "origin/HEAD") continue;

    let type: GitBranch["type"];
    if (worktreepath && worktreepath.length > 0) {
      type = "worktree";
    } else if (refname.startsWith("origin/")) {
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

/** Get the current branch name for a repository path. */
export function getCurrentBranchForPath(repoPath: string): string {
  try {
    const output = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"],
      { stdio: "pipe", encoding: "utf-8" },
    );
    return output.trim() || "main";
  } catch {
    return "main";
  }
}

/** List all git worktrees for a repository path. */
function listWorktreesForPath(repoPath: string): WorktreeInfo[] {
  const worktreesDir = getWorktreeBaseDir(repoPath)
    .replace(/\\/g, "/")
    .toLowerCase();
  const normalizedRepo = repoPath
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/\/+$/, "");

  let output: string;
  try {
    output = execFileSync(
      "git",
      ["-C", repoPath, "worktree", "list", "--porcelain"],
      { stdio: "pipe", encoding: "utf-8" },
    );
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
function fetchBranchForPath(
  repoPath: string,
  branch: string,
  prNumber?: number,
): void {
  validateBranchName(branch);

  let fetchOk = true;
  try {
    if (prNumber != null) {
      execFileSync(
        "git",
        [
          "-C",
          repoPath,
          "fetch",
          "origin",
          `+pull/${prNumber}/head:${branch}`,
        ],
        { stdio: "pipe" },
      );
    } else {
      execFileSync("git", ["-C", repoPath, "fetch", "origin", branch], {
        stdio: "pipe",
      });
    }
  } catch {
    fetchOk = false;
  }

  if (fetchOk && prNumber == null) {
    const localExists = branchExists(repoPath, branch);
    if (localExists) {
      execFileSync(
        "git",
        ["-C", repoPath, "branch", "-f", branch, `origin/${branch}`],
        { stdio: "pipe" },
      );
    } else {
      execFileSync(
        "git",
        [
          "-C",
          repoPath,
          "branch",
          "--track",
          branch,
          `origin/${branch}`,
        ],
        { stdio: "pipe" },
      );
    }
  } else if (!fetchOk && !branchExists(repoPath, branch)) {
    throw new Error(`Branch "${branch}" not found locally or on origin`);
  }
}
