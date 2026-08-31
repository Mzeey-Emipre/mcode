import { z } from "zod";
import { TurnFileEffectSummarySchema } from "./file-effect.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Git snapshot refs for reconstructing diffs on demand. */
export const TurnSnapshotSchema = lazySchema(() => z.object({
  id: z.string(),
  message_id: z.string(),
  thread_id: z.string(),
  ref_before: z.string(),
  ref_after: z.string(),
  files_changed: z.array(z.string()),
  file_effects: TurnFileEffectSummarySchema().optional(),
  worktree_path: z.string().nullable(),
  created_at: z.string(),
}));

/** Git snapshot refs for reconstructing diffs on demand. */
export type TurnSnapshot = z.infer<ReturnType<typeof TurnSnapshotSchema>>;
