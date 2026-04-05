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
