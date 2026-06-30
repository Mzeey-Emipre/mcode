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

/** Identifies where a thread-goal lookup result came from. */
export const GoalLookupSourceSchema = lazySchema(() =>
  z.enum(["codex-native", "codex-cache", "claude-wrapper", "claude-native-command", "claude-cache", "unsupported"]),
);

/** Identifies why a thread-goal lookup returned no authoritative open goal. */
export const GoalLookupReasonSchema = lazySchema(() =>
  z.enum(["not-materialized", "closed", "missing", "unsupported-provider", "busy"]),
);

/** Provider-neutral active-goal lookup result for thread switch hydration. */
export const GoalLookupResultSchema = lazySchema(() =>
  z.object({
    goal: GoalStateSchema().nullable(),
    authoritative: z.boolean(),
    source: GoalLookupSourceSchema(),
    reason: GoalLookupReasonSchema().optional(),
  }),
);

/** Identifies where a thread-goal lookup result came from. */
export type GoalLookupSource = z.infer<ReturnType<typeof GoalLookupSourceSchema>>;

/** Identifies why a thread-goal lookup returned no authoritative open goal. */
export type GoalLookupReason = z.infer<ReturnType<typeof GoalLookupReasonSchema>>;

/** Provider-neutral active-goal lookup result for thread switch hydration. */
export type GoalLookupResult = z.infer<ReturnType<typeof GoalLookupResultSchema>>;

/** Returns true while a goal still needs provider or user follow-up. */
export function isGoalOpen(goal: GoalState | null | undefined): goal is GoalState {
  return goal != null && isGoalStatusOpen(goal.status);
}

/** Returns true for every non-terminal goal status. */
export function isGoalStatusOpen(status: GoalStatus): boolean {
  return status !== "complete";
}
