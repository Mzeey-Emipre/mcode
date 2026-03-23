import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, isAbsolute } from "path";
import type { Workspace, Thread } from "./models.js";

/**
 * Determine the working directory for file operations.
 * Uses worktree path for worktree threads, workspace path otherwise.
 */
export function resolveWorkingDir(
  workspace: Workspace,
  thread: Thread | null,
): string {
  if (thread?.mode === "worktree" && thread.worktree_path) {
    return thread.worktree_path;
  }
  return workspace.path;
}

/**
 * List git-tracked files in the given directory.
 * Returns relative paths sorted by git's default ordering.
 */
export function listWorkspaceFiles(cwd: string): string[] {
  const output = execFileSync("git", ["ls-files"], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return output
    .toString("utf-8")
    .split("\n")
    .filter((line) => line.length > 0);
}

/**
 * Read file content by relative path within a workspace root.
 * Validates path stays within root to prevent traversal attacks.
 */
export function readFileContent(rootDir: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.includes("..")) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }

  const fullPath = resolve(rootDir, relativePath);
  const normalizedRoot = resolve(rootDir);

  if (!fullPath.startsWith(normalizedRoot)) {
    throw new Error(`File path escapes workspace root: ${relativePath}`);
  }

  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }

  return readFileSync(fullPath, "utf-8");
}
