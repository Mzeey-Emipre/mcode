import { z } from "zod";

/** Git branch metadata. */
export const GitBranchSchema = z.object({
  name: z.string(),
  shortSha: z.string(),
  type: z.enum(["local", "remote", "worktree"]),
  isCurrent: z.boolean(),
});
/** Git branch metadata record. */
export type GitBranch = z.infer<typeof GitBranchSchema>;

/**
 * A git ref string safe to interpolate into a git argv. Rejects a leading `-`
 * (which git would parse as a flag — argument injection) and restricts to the
 * characters git refnames and short SHAs actually use. Used to validate the
 * user-picked base/target of a Branch comparison before they reach `git diff`.
 */
export const GitRefSchema = z
  .string()
  .regex(/^(?!-)[A-Za-z0-9._/-]+$/, "invalid git ref");

/**
 * A resolved Branch comparison: the base→target ref pair the Review tab's Branch
 * view diffs (always three-dot, `base...target`), plus the refs available to
 * populate the pickers. The default pair is resolved per
 * `docs/adr/0007-branch-comparison-default-and-range.md` before the diff call.
 * `base`/`target` are null only when no comparison can be formed (unborn branch,
 * or no base could be detected and the user must pick one).
 */
export const BranchComparisonSchema = z.object({
  /** Base ref (the "from" side); null when unresolved (unborn / no base). */
  base: z.string().nullable(),
  /** Target ref (the "to" side); null when unresolved (unborn / no base). */
  target: z.string().nullable(),
  /** Refs available to populate the base/target pickers (local, remote, worktree). */
  refs: z.array(GitBranchSchema),
  /** True when HEAD has no commits yet — the diff is an explicit empty state. */
  isUnborn: z.boolean(),
});
/** Resolved Branch comparison record. */
export type BranchComparison = z.infer<typeof BranchComparisonSchema>;

/** A git worktree registered in the repository. */
export const WorktreeSchema = z.object({
  name: z.string(),
  path: z.string(),
  branch: z.string(),
  managed: z.boolean(),
});
/** Worktree metadata registered in the repository. */
export type WorktreeInfo = z.infer<typeof WorktreeSchema>;

export { GitCommitSchema, type GitCommit } from "./models/git-commit.js";
