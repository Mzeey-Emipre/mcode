import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Provider-backed lifecycle state for a thread goal. */
export const GoalStatusSchema = lazySchema(() =>
  z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
);

/** Provider-backed lifecycle state for a thread goal. */
export type GoalStatus = z.infer<ReturnType<typeof GoalStatusSchema>>;

/** Controls that Mcode can truthfully offer for the current goal. */
export const GoalControlsSchema = lazySchema(() =>
  z.object({
    canInspect: z.boolean().optional(),
    canClear: z.boolean().optional(),
    canPause: z.boolean().optional(),
    canResume: z.boolean().optional(),
    canEdit: z.boolean().optional(),
  }),
);

/** Controls that Mcode can truthfully offer for the current goal. */
export type GoalControls = z.infer<ReturnType<typeof GoalControlsSchema>>;

/** Normalized goal metadata surfaced by providers that support thread goals. */
export const GoalStateSchema = lazySchema(() =>
  z.object({
    threadId: z.string().optional(),
    objective: z.string(),
    status: GoalStatusSchema(),
    tokenBudget: z.number().nullable(),
    tokensUsed: z.number(),
    timeUsedSeconds: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    providerId: z.string().optional(),
    source: z.enum(["mcode", "codex", "claude"]),
    controls: GoalControlsSchema(),
    turnId: z.string().nullable().optional(),
  }),
);

/** Normalized goal metadata surfaced by providers that support thread goals. */
export type GoalState = z.infer<ReturnType<typeof GoalStateSchema>>;
