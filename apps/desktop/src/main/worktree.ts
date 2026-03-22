/**
 * Git worktree manager for thread isolation.
 * Ported from crates/mcode-core/src/worktree/mod.rs
 *
 * Uses shell `git` commands instead of libgit2 (git2 crate).
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

/** Get the worktree base directory under ~/.mcode/worktrees/{workspace-slug}/ */
function getWorktreeBaseDir(repoPath: string): string {
  const slug = basename(repoPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const dir = join(homedir(), ".mcode", "worktrees", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
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
 * Create a new git worktree for the given name.
 * Creates branch `mcode/<name>` and checks it out in `~/.mcode/worktrees/<workspace>/<name>`.
 */
export function createWorktree(
  repoPath: string,
  name: string,
): WorktreeInfo {
  validateName(name);

  if (!existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  const branch = `mcode/${name}`;
  const wtPath = join(getWorktreeBaseDir(repoPath), name);

  if (existsSync(wtPath)) {
    throw new Error(`Worktree directory already exists: ${wtPath}`);
  }

  execFileSync("git", ["-C", repoPath, "worktree", "add", wtPath, "-b", branch], {
    stdio: "pipe",
  });

  return { name, path: wtPath, branch };
}

/** Remove a git worktree by name. Returns true on success, false on failure. */
export function removeWorktree(repoPath: string, name: string): boolean {
  validateName(name);

  const wtPath = join(getWorktreeBaseDir(repoPath), name);
  const branch = `mcode/${name}`;

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

/** List all mcode worktrees in a repository. */
export function listWorktrees(repoPath: string): WorktreeInfo[] {
  const worktreesDir = getWorktreeBaseDir(repoPath);

  if (!existsSync(worktreesDir)) {
    return [];
  }

  const entries = readdirSync(worktreesDir);
  const result: WorktreeInfo[] = [];

  for (const entry of entries) {
    const entryPath = join(worktreesDir, entry);
    try {
      if (statSync(entryPath).isDirectory()) {
        result.push({
          name: entry,
          path: entryPath,
          branch: `mcode/${entry}`,
        });
      }
    } catch {
      // Skip entries we cannot stat
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
