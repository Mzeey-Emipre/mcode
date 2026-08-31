/**
 * Centralized Mcode data directory resolution.
 * Reads the MCODE_DATA_DIR environment variable, falling back to
 * `~/.mcode` (production) or `~/.mcode-dev` (development).
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Resolve the absolute path to the Mcode data directory.
 * Prefers the `MCODE_DATA_DIR` env var when set, otherwise falls back
 * to `~/.mcode` (production) or `~/.mcode-dev` (development).
 *
 * The dir name is evaluated at call time (not import time) so that
 * callers can set NODE_ENV before the first invocation.
 */
export function getMcodeDir(): string {
  if (process.env.MCODE_DATA_DIR) return process.env.MCODE_DATA_DIR;
  const dirName =
    process.env.NODE_ENV !== "production" ? ".mcode-dev" : ".mcode";
  return NodePath.join(NodeOS.homedir(), dirName);
}

/**
 * Safe single path segment under `browser-capture-spill/` derived from a workspace id.
 * Falls back to a short hash when the id contains characters unsafe for directory names.
 */
export function spillWorkspaceDirSegment(workspaceId: string): string {
  const t = workspaceId.trim();
  if (t.length === 0) return "unknown";
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(t)) return t;
  return NodeCrypto.createHash("sha256").update(t).digest("hex").slice(0, 24);
}

/**
 * Returns true when `repoRoot/.git` is a file, meaning this checkout is a linked git worktree
 * rather than the primary repository directory.
 */
export function isLinkedGitWorktree(repoRoot: string): boolean {
  const gitPath = NodePath.join(repoRoot, ".git");
  try {
    return NodeFS.lstatSync(gitPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the SQLite database file path.
 *
 * In non-production, if `gitToplevel` points at a linked worktree (a `.git` pointer file rather
 * than a directory), returns `<gitToplevel>/.mcode-local/mcode.db` so each worktree keeps its DB inside the checkout.
 *
 * Otherwise in non-production with a branch name, returns `<mcodeDir>/dbs/dev-<hash>.db`.
 * Fallback: `<mcodeDir>/mcode.db`.
 */
export function resolveDbPath(
  mcodeDir: string,
  opts?: { branch?: string; gitToplevel?: string },
): string {
  const isProduction = process.env.NODE_ENV === "production";
  const gitToplevel = opts?.gitToplevel?.trim();
  if (!isProduction && gitToplevel && isLinkedGitWorktree(gitToplevel)) {
    return NodePath.join(gitToplevel, ".mcode-local", "mcode.db");
  }

  const branch = opts?.branch?.trim();
  if (isProduction || !branch) {
    return NodePath.join(mcodeDir, "mcode.db");
  }
  const hash = NodeCrypto.createHash("sha256").update(branch).digest("hex").slice(0, 12);
  return NodePath.join(mcodeDir, "dbs", `dev-${hash}.db`);
}
