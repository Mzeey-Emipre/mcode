/**
 * Git branch name sanitization and validation helpers.
 * Extracted from the worktree manager for reuse across packages.
 */

/**
 * Validate a worktree name to prevent path traversal and other issues.
 * Throws on invalid input.
 */
export function validateWorktreeName(name: string): void {
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
 * Throws on invalid input.
 */
export function validateBranchName(branch: string): void {
  if (!branch || branch.length > 250) {
    throw new Error("Branch name must be 1-250 characters");
  }
  if (branch.startsWith("-")) {
    throw new Error("Branch name cannot start with '-'");
  }
  if (
    /[ \t~^:?*\[\\\x00-\x1f\x7f]/.test(branch) ||
    branch.includes("..")
  ) {
    throw new Error(`Branch name contains invalid characters: ${branch}`);
  }
  if (
    branch.endsWith(".lock") ||
    branch.endsWith(".") ||
    branch.endsWith("/")
  ) {
    throw new Error(`Branch name has an invalid suffix: ${branch}`);
  }
  if (branch.includes("@{") || branch.includes("//")) {
    throw new Error(`Branch name contains invalid sequence: ${branch}`);
  }
  if (branch === "@") {
    throw new Error("Branch name cannot be '@'");
  }
  if (/(?:^|\/)\./.test(branch)) {
    throw new Error(
      `Branch name component cannot start with '.': ${branch}`,
    );
  }
}

/**
 * Sanitize a string into a URL-safe slug suitable for worktree directory names.
 * Lowercases and replaces non-alphanumeric characters (except hyphens) with hyphens.
 */
export function toWorktreeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
