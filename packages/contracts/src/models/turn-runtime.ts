import { z } from "zod";

/** Stable identity assigned by Mcode to one logical provider turn. */
export const TurnExecutionIdSchema = z.string().uuid();
/** Stable identity assigned by Mcode to one logical provider turn. */
export type TurnExecutionId = z.infer<typeof TurnExecutionIdSchema>;

/** Lifecycle phase projected for one thread's current turn. */
export const TurnRuntimePhaseSchema = z.enum([
  "idle",
  "running",
  "finalizing",
  "completed",
  "errored",
  "cancelled",
]);
/** Lifecycle phase projected for one thread's current turn. */
export type TurnRuntimePhase = z.infer<typeof TurnRuntimePhaseSchema>;

/** Authoritative reconnect snapshot for one thread. */
export const TurnRuntimeSnapshotSchema = z.object({
  threadId: z.string().min(1),
  turnExecutionId: TurnExecutionIdSchema.nullable(),
  phase: TurnRuntimePhaseSchema,
});
/** Authoritative reconnect snapshot for one thread. */
export type TurnRuntimeSnapshot = z.infer<typeof TurnRuntimeSnapshotSchema>;
