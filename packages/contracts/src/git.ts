import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** Git branch metadata. */
export const GitBranchSchema = lazySchema(() => z.object({
  name: z.string(),
  shortSha: z.string(),
  type: z.enum(["local", "remote", "worktree"]),
  isCurrent: z.boolean(),
}));
/** Git branch metadata record. */
export type GitBranch = z.infer<ReturnType<typeof GitBranchSchema>>;

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
 * A user-supplied branch name safe for creating a new branch. This is stricter
 * than a generic ref because it rejects reserved names and traversal-like
 * sequences before they cross into a mutating git command.
 */
export const GitBranchNameSchema = z
  .string()
  .min(1)
  .max(250)
  .regex(/^(?!-)[A-Za-z0-9._/-]+$/, "invalid git branch name")
  .refine((name) => !name.includes(".."), "invalid git branch name")
  .refine((name) => name !== "HEAD", "invalid git branch name");

/** Remote repository metadata resolved from a checkout's origin remote. */
export const GitRemoteUrlSchema = lazySchema(() => z.object({
  /** Normalized https web URL, or null when no usable remote exists. */
  webUrl: z.string().url().refine((value) => value.startsWith("https://"), {
    message: "webUrl must be an https URL",
  }).nullable(),
  /** Repository label shown in the UI, usually "org/repo". */
  label: z.string().min(1),
}));
/** Remote repository metadata resolved from git config. */
export type GitRemoteUrl = z.infer<ReturnType<typeof GitRemoteUrlSchema>>;

/**
 * A resolved Branch comparison: the base→target ref pair the Review tab's Branch
 * view diffs (always three-dot, `base...target`), plus the refs available to
 * populate the pickers. The default pair is resolved per
 * `docs/adr/0007-branch-comparison-default-and-range.md` before the diff call.
 * `base`/`target` are null only when no comparison can be formed (unborn branch,
 * or no base could be detected and the user must pick one).
 */
export const BranchComparisonSchema = lazySchema(() => z.object({
  /** Base ref (the "from" side); null when unresolved (unborn / no base). */
  base: z.string().nullable(),
  /** Target ref (the "to" side); null when unresolved (unborn / no base). */
  target: z.string().nullable(),
  /** Refs available to populate the base/target pickers (local, remote, worktree). */
  refs: z.array(GitBranchSchema()),
  /** True when HEAD has no commits yet — the diff is an explicit empty state. */
  isUnborn: z.boolean(),
  /**
   * False when no meaningful Branch comparison exists (local-only default branch
   * with no upstream). The Branch view is disabled until git state changes.
   */
  isComparisonAvailable: z.boolean(),
}));
/** Resolved Branch comparison record. */
export type BranchComparison = z.infer<ReturnType<typeof BranchComparisonSchema>>;

/** A git worktree registered in the repository. */
export const WorktreeSchema = lazySchema(() => z.object({
  name: z.string(),
  path: z.string(),
  branch: z.string(),
  managed: z.boolean(),
}));
/** Worktree metadata registered in the repository. */
export type WorktreeInfo = z.infer<ReturnType<typeof WorktreeSchema>>;

export { GitCommitSchema, type GitCommit } from "./models/git-commit.js";
