import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum recovery records returned or reconciled in one bounded operation. */
export const MAX_TURN_RECOVERIES = 100;

/** One turn interrupted by a specific backend restart. */
export const RecoveryIncidentEntrySchema = lazySchema(() =>
  z.object({
    workspaceId: z.string().trim().min(1).max(256),
    workspaceName: z.string().trim().min(1).max(256),
    threadId: z.string().trim().min(1).max(256),
    threadTitle: z.string().trim().min(1).max(512),
    executionId: z.string().uuid(),
    startedAt: z.string().datetime({ offset: true }),
    interruptedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().int().nonnegative(),
  }).strict(),
);
/** One turn interrupted by a specific backend restart. */
export type RecoveryIncidentEntry = z.infer<ReturnType<typeof RecoveryIncidentEntrySchema>>;

/** Restart-scoped recovery state that remains stable for the current server run. */
export const RecoveryIncidentSchema = lazySchema(() =>
  z.object({
    id: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    entries: z.array(RecoveryIncidentEntrySchema()).min(1).max(MAX_TURN_RECOVERIES),
  }).strict(),
);
/** Restart-scoped recovery state that remains stable for the current server run. */
export type RecoveryIncident = z.infer<ReturnType<typeof RecoveryIncidentSchema>>;
