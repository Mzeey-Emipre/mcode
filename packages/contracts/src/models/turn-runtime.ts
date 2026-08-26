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

/** Server-authoritative assistant-text saving state for one active execution. */
export const TurnSavingStatusSchema = z.object({
  threadId: z.string().min(1),
  executionId: TurnExecutionIdSchema,
  mode: z.enum(["durable", "saving-delayed", "unsaved", "stopping"]),
}).strict();
/** Server-authoritative assistant-text saving state for one active execution. */
export type TurnSavingStatus = z.infer<typeof TurnSavingStatusSchema>;

/** Authoritative reconnect snapshot for one thread. */
export const TurnRuntimeSnapshotSchema = z.object({
  threadId: z.string().min(1),
  turnExecutionId: TurnExecutionIdSchema.nullable(),
  phase: TurnRuntimePhaseSchema,
  savingStatus: TurnSavingStatusSchema.shape.mode.nullable().optional(),
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
