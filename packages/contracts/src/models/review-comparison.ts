import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Change classification shown for one file in a Review comparison. */
export const ReviewFileChangeTypeSchema = lazySchema(() =>
  z.enum(["added", "modified", "deleted", "renamed", "copied"]),
);

/** Bounded file metadata returned with a Review comparison. */
export const ReviewFileChangeSchema = lazySchema(() =>
  z.object({
    path: z.string().min(1).max(4096),
    previousPath: z.string().min(1).max(4096).nullable(),
    changeType: ReviewFileChangeTypeSchema(),
    binary: z.boolean(),
  }),
);

/** One settled Review comparison shared by the diff and Files navigator. */
export const ReviewComparisonSchema = lazySchema(() =>
  z.object({
    files: z.array(ReviewFileChangeSchema()).max(10_000),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
);

/** Change classification shown for one file in a Review comparison. */
export type ReviewFileChange = z.infer<ReturnType<typeof ReviewFileChangeSchema>>;

/** One settled Review comparison shared by the diff and Files navigator. */
export type ReviewComparison = z.infer<ReturnType<typeof ReviewComparisonSchema>>;
