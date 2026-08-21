import { z } from "zod";
import { AgentTurnExecutionIdSchema } from "../compat/agent-model.js";

/** Stable identity assigned by Mcode to one logical provider turn. */
export const TurnExecutionIdSchema = AgentTurnExecutionIdSchema;
/** Stable identity assigned by Mcode to one logical provider turn. */
export type TurnExecutionId = z.infer<typeof TurnExecutionIdSchema>;

/** Lifecycle phase projected for one thread's current turn. */
export const TurnRuntimePhaseSchema = z.enum([
  "idle",
  "running",
  "finalizing",
  "completed",
  "interrupted",
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

/** Provider dispatch boundary observed while servicing a user stop. */
export const AgentStopDispatchStateSchema = z.enum([
  "not-dispatched",
  "dispatched",
  "unknown",
]);
/** Provider dispatch boundary observed while servicing a user stop. */
export type AgentStopDispatchState = z.infer<typeof AgentStopDispatchStateSchema>;

/** Authoritative result returned by an agent.stop RPC. */
export const AgentStopResultSchema = z.object({
  threadId: z.string().min(1),
  turnExecutionId: TurnExecutionIdSchema.nullable(),
  snapshot: TurnRuntimeSnapshotSchema,
  status: z.enum(["cancelled", "already-terminal"]),
  dispatchState: AgentStopDispatchStateSchema,
}).strict();
/** Authoritative result returned by an agent.stop RPC. */
export type AgentStopResult = z.infer<typeof AgentStopResultSchema>;
