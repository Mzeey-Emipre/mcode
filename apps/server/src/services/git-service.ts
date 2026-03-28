/**
 * Git operations service.
 * Manages branches, worktrees, checkout, and fetch operations using shell git commands.
 * Extracted from apps/desktop/src/main/worktree.ts.
 */

import { injectable, inject } from "tsyringe";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { getMcodeDir, validateBranchName, validateWorktreeName } from "@mcode/shared";
import type { GitBranch, WorktreeInfo } from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo";

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

  /** Remove a git worktree by name. Returns true on success. */
  removeWorktree(
    repoPath: string,
    name: string,
    branchName?: string,
  ): boolean {
    validateWorktreeName(name);

    const wtPath = join(getWorktreeBaseDir(repoPath), name);
    const branch = branchName ?? `mcode/${name}`;
    validateBranchName(branch);

    try {
      execFileSync(
        "git",
        ["-C", repoPath, "worktree", "remove", wtPath, "--force"],
        { stdio: "pipe" },
      );
    } catch {
      // Worktree may not exist; continue to prune
    }

    try {
      execFileSync("git", ["-C", repoPath, "worktree", "prune"], {
        stdio: "pipe",
      });
    } catch {
      // Prune failure is non-fatal
    }

    try {
      execFileSync("git", ["-C", repoPath, "branch", "-d", branch], {
        stdio: "pipe",
      });
    } catch {
      // Branch may not exist
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
function getCurrentBranchForPath(repoPath: string): string {
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
