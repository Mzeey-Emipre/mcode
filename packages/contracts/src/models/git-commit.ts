import { z } from "zod";

/** Git commit metadata for log display. */
export const GitCommitSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  message: z.string(),
  author: z.string(),
  date: z.string(),
  filesChanged: z.number(),
});

/** Git commit metadata. */
export type GitCommit = z.infer<typeof GitCommitSchema>;
