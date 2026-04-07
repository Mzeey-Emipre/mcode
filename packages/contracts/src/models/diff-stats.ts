import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Per-file addition/deletion counts from git diff --numstat. */
export const DiffStatsSchema = lazySchema(() =>
  z.object({
    filePath: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
);

/** Type inferred from DiffStatsSchema. */
export type DiffStats = z.infer<ReturnType<typeof DiffStatsSchema>>;
