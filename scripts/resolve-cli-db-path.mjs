/**
 * Match server startup DB resolution for CLI tooling (`state:paths`, `db:info`).
 */
import { execFileSync } from "node:child_process";
import { getMcodeDir, resolveDbPath } from "../packages/shared/src/index.ts";

/**
 * Resolves the SQLite path the server would open: env override, then linked-worktree-local,
 * then hashed branch DB, then default file under `getMcodeDir()`.
 *
 * @returns {string}
 */
export function resolveCliDbPath() {
  const fromEnv = process.env.MCODE_DB_PATH?.trim();
  if (fromEnv) return fromEnv;

  const gitValues = resolveDevelopmentGitValues();
  return resolveDbPath(getMcodeDir(), gitValues);
}

function resolveGitValue(args) {
  try {
    return execFileSync("git", args, { encoding: "utf-8", timeout: 3000 }).trim();
  } catch {
    return undefined;
  }
}

function resolveDevelopmentGitValues() {
  let branch = process.env.MCODE_GIT_BRANCH?.trim();
  let gitToplevel = process.env.MCODE_GIT_TOPLEVEL?.trim();
  if (process.env.NODE_ENV === "production") return { branch, gitToplevel };
  if (!branch) {
    const resolvedBranch = resolveGitValue(["rev-parse", "--abbrev-ref", "HEAD"]);
    branch = resolvedBranch && resolvedBranch !== "HEAD" ? resolvedBranch : branch;
  }
  if (!gitToplevel) {
    gitToplevel = resolveGitValue(["rev-parse", "--show-toplevel"]);
  }
  return { branch, gitToplevel };
}
