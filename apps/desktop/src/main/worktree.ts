/**
 * Git worktree manager for thread isolation.
 * Ported from crates/mcode-core/src/worktree/mod.rs
 *
 * Uses shell `git` commands instead of libgit2 (git2 crate).
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { MCODE_DIR } from "./paths.js";

/** Resolve the worktree base directory path under the mcode data dir. */
function getWorktreeBaseDir(repoPath: string): string {
  return join(MCODE_DIR, "worktrees", worktreeSlug(repoPath));
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

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  managed: boolean;
}

export interface GitBranchInfo {
  name: string;
  shortSha: string;
  type: "local" | "remote" | "worktree";
  isCurrent: boolean;
}

/** Validate a worktree name to prevent path traversal and other issues. */
export function validateName(name: string): void {
  if (!name || name.length > 100) {
    throw new Error("Worktree name must be 1-100 characters");
  }
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(
      `Worktree name contains invalid characters: ${name}`,
    );
  }
  if (name.startsWith(".")) {
    throw new Error("Worktree name cannot start with '.'");
  }
}

/**
 * Validate a git branch name against git-check-ref-format rules.
 * Rejects names that git would refuse or that could interfere with
 * git internals (e.g. `.lock` suffixes, reflog syntax).
 */
export function validateBranchName(branch: string): void {
  if (!branch || branch.length > 250) {
    throw new Error("Branch name must be 1-250 characters");
  }
  if (branch.startsWith("-")) {
    throw new Error("Branch name cannot start with '-'");
  }
  if (/[ \t~^:?*\[\\\x00-\x1f\x7f]/.test(branch) || branch.includes("..")) {
    throw new Error(`Branch name contains invalid characters: ${branch}`);
  }
  if (branch.endsWith(".lock") || branch.endsWith(".") || branch.endsWith("/")) {
    throw new Error(`Branch name has an invalid suffix: ${branch}`);
  }
  if (branch.includes("@{") || branch.includes("//")) {
    throw new Error(`Branch name contains invalid sequence: ${branch}`);
  }
  if (branch === "@") {
    throw new Error("Branch name cannot be '@'");
  }
  if (/(?:^|\/)\./.test(branch)) {
    throw new Error(`Branch name component cannot start with '.': ${branch}`);
  }
}

/**
 * Create a new git worktree for the given name.
 * Checks it out in `~/.mcode/worktrees/<workspace>/<name>`.
 * Uses the provided branchName, or defaults to `mcode/<name>`.
 */
export function createWorktree(
  repoPath: string,
  name: string,
  branchName?: string,
): WorktreeInfo {
  validateName(name);

  if (!existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  const branch = branchName ?? `mcode/${name}`;
  validateBranchName(branch);
  const wtPath = join(ensureWorktreeBaseDir(repoPath), name);

  if (existsSync(wtPath)) {
    throw new Error(`Worktree directory already exists: ${wtPath}`);
  }

  execFileSync("git", ["-C", repoPath, "worktree", "add", wtPath, "-b", branch], {
    stdio: "pipe",
  });

  return { name, path: wtPath, branch, managed: true };
}

/** Remove a git worktree by name. Returns true on success, false on failure. */
export function removeWorktree(repoPath: string, name: string, branchName?: string): boolean {
  validateName(name);

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
 * List all git worktrees for a repository using git porcelain output.
 * Returns all worktrees (except the main working tree) with a `managed`
 * flag indicating whether the worktree lives under the mcode base dir.
 * Returns [] if the git command fails.
 */
export function listWorktrees(repoPath: string): WorktreeInfo[] {
  const worktreesDir = getWorktreeBaseDir(repoPath).replace(/\\/g, "/").toLowerCase();
  // Normalize repo path for comparison to skip the main working tree
  const normalizedRepo = repoPath.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");

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
      currentBranch = line.slice("branch ".length).trim().replace("refs/heads/", "");
    } else if (line === "detached") {
      currentBranch = "(detached)";
    } else if (line.trim() === "" && currentPath) {
      const normalized = currentPath.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
      // Skip the main working tree (the repo itself)
      if (normalized !== normalizedRepo && currentBranch) {
        const name = currentPath.replace(/\\/g, "/").split("/").pop() || currentPath;
        const managed = normalized.startsWith(worktreesDir + "/");
        result.push({ name, path: currentPath, branch: currentBranch, managed });
      }
      currentPath = "";
      currentBranch = "";
    }
  }

  // Handle last entry (porcelain output may not end with blank line)
  if (currentPath && currentBranch) {
    const normalized = currentPath.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    if (normalized !== normalizedRepo) {
      const name = currentPath.replace(/\\/g, "/").split("/").pop() || currentPath;
      const managed = normalized.startsWith(worktreesDir + "/");
      result.push({ name, path: currentPath, branch: currentBranch, managed });
    }
  }

  return result;
}

/** Get the worktree path for a given name. */
export function worktreePath(repoPath: string, name: string): string {
  validateName(name);
  return join(getWorktreeBaseDir(repoPath), name);
}

// ---------------------------------------------------------------------------
// Branch inspection and checkout
// ---------------------------------------------------------------------------

/** List all branches (local, remote, and worktree-attached) in a repository. */
export function listBranches(repoPath: string): GitBranchInfo[] {
  const output = execFileSync(
    "git",
    [
      "-C", repoPath,
      "branch", "-a",
      "--format=%(refname:short)|||%(objectname:short)|||%(HEAD)|||%(worktreepath)",
    ],
    { stdio: "pipe", encoding: "utf-8" },
  );

  const branches: GitBranchInfo[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [refname, shortSha, head, worktreepath] = trimmed.split("|||");
    if (!refname || refname === "origin/HEAD") continue;

    let type: GitBranchInfo["type"];
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

  // Sort: current first, then local, then worktree, then remote
  const typeOrder: Record<GitBranchInfo["type"], number> = {
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

/** Get the current branch name for a repository. */
export function getCurrentBranch(repoPath: string): string {
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

/** Checkout an existing branch in the repository. Throws on failure. */
export function checkoutBranch(repoPath: string, branch: string): void {
  execFileSync("git", ["-C", repoPath, "checkout", branch], {
    stdio: "pipe",
  });
}

/** Check whether a branch ref exists in the repository. */
export function branchExists(repoPath: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", branch], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch a remote branch from origin and create a local tracking branch.
 * If the local branch already exists, updates it with the latest remote.
 * Throws on failure (e.g. branch not found on remote).
 */
export function fetchBranch(repoPath: string, branch: string): void {
  // Fetch the specific branch from origin
  execFileSync(
    "git",
    ["-C", repoPath, "fetch", "origin", branch],
    { stdio: "pipe" },
  );

  // Create or update local branch to track remote
  const localExists = branchExists(repoPath, branch);
  if (localExists) {
    // Update existing local branch to match remote
    execFileSync(
      "git",
      ["-C", repoPath, "branch", "-f", branch, `origin/${branch}`],
      { stdio: "pipe" },
    );
  } else {
    // Create local branch tracking remote
    execFileSync(
      "git",
      ["-C", repoPath, "branch", "--track", branch, `origin/${branch}`],
      { stdio: "pipe" },
    );
  }
}
