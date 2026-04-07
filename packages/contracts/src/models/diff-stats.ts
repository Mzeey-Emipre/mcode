import { z } from "zod";

/** Per-file addition/deletion counts from git diff --numstat. */
export const DiffStatsSchema = z.object({
  filePath: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

/** Type inferred from DiffStatsSchema. */
export type DiffStats = z.infer<typeof DiffStatsSchema>;
