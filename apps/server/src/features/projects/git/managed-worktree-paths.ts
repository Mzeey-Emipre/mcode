import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { getMcodeDir } from "@mcode/shared";
import { normalizePathForComparison } from "../../../shared/filesystem/path-identity.js";

/** Resolve the base directory for one repository's Mcode-managed worktrees. */
export function getManagedWorktreeBaseDir(repoPath: string): string {
  return NodePath.join(getMcodeDir(), "worktrees", managedWorktreeSlug(repoPath));
}

/** Resolve and create the base directory for one repository's managed worktrees. */
export function ensureManagedWorktreeBaseDir(repoPath: string): string {
  const directory = getManagedWorktreeBaseDir(repoPath);
  NodeFS.mkdirSync(directory, { recursive: true });
  return directory;
}

/** Return whether a candidate path stays within a base path after normalization. */
export function isPathWithin(
  basePath: string,
  candidatePath: string,
  platform: NodeJS.Platform,
): boolean {
  const relativePath = NodePath.relative(
    normalizePathForComparison(basePath, platform),
    normalizePathForComparison(candidatePath, platform),
  );
  return relativePath === "" || (!relativePath.startsWith("..") && !NodePath.isAbsolute(relativePath));
}

function managedWorktreeSlug(repoPath: string): string {
  return NodePath.basename(repoPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
