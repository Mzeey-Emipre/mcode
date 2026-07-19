import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum file effects retained and transported for one agent turn. */
export const MAX_TURN_FILE_EFFECTS = 256;

/** Net filesystem operation attributed to an explicit agent file mutation. */
export const FileEffectKindSchema = lazySchema(() =>
  z.enum(["added", "edited", "removed", "renamed"]),
);

/** A bounded, content-free description of one file changed by an agent turn. */
export const FileEffectSchema = lazySchema(() =>
  z.object({
    path: z.string().min(1).max(4096),
    kind: FileEffectKindSchema(),
    scope: z.enum(["workspace", "external"]),
    oldPath: z.string().min(1).max(4096).optional(),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    binary: z.boolean(),
    toolCallIds: z.array(z.string().min(1).max(256)).max(32),
  }),
);

/** Monotonic live and persisted aggregate for agent-attributed file effects. */
export const TurnFileEffectSummarySchema = lazySchema(() =>
  z.object({
    revision: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative().max(MAX_TURN_FILE_EFFECTS),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    effects: z.array(FileEffectSchema()).max(MAX_TURN_FILE_EFFECTS),
  }),
);

/** Net filesystem operation attributed to an explicit agent file mutation. */
export type FileEffect = z.infer<ReturnType<typeof FileEffectSchema>>;

/** Monotonic live and persisted aggregate for agent-attributed file effects. */
export type TurnFileEffectSummary = z.infer<ReturnType<typeof TurnFileEffectSummarySchema>>;
