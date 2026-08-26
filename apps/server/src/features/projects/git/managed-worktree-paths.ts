import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { getMcodeDir } from "@mcode/shared";
import { normalizePathForComparison } from "../../../shared/filesystem/path-identity.js";

/** Resolve the base directory for one repository's Mcode-managed worktrees. */
export function getManagedWorktreeBaseDir(repoPath: string): string {
  return join(getMcodeDir(), "worktrees", managedWorktreeSlug(repoPath));
}

/** Resolve and create the base directory for one repository's managed worktrees. */
export function ensureManagedWorktreeBaseDir(repoPath: string): string {
  const directory = getManagedWorktreeBaseDir(repoPath);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Return whether a candidate path stays within a base path after normalization. */
export function isPathWithin(basePath: string, candidatePath: string): boolean {
  const relativePath = relative(
    normalizePathForComparison(basePath),
    normalizePathForComparison(candidatePath),
  );
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function managedWorktreeSlug(repoPath: string): string {
  return basename(repoPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
