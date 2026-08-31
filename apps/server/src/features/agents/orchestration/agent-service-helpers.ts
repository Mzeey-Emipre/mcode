import type {
  AgentEvent,
  AgentStopResult,
  Thread,
  TurnRuntimeSnapshot,
} from "@mcode/contracts";
import type { FinalizeTurnCommand } from "../turns/turn-event-pipeline.js";

/** Select serializable tool-result fields for the narrative projection. */
export function toolResultMetadata(event: Extract<AgentEvent, { type: "toolResult" }>): {
  outputTruncated?: true;
  outputTotalBytes?: number;
  outputArtifactPath?: string;
  exitCode?: number;
} {
  return {
    ...(event.outputTruncated === true ? { outputTruncated: true as const } : {}),
    ...(event.outputTotalBytes != null ? { outputTotalBytes: event.outputTotalBytes } : {}),
    ...(event.outputArtifactPath ? { outputArtifactPath: event.outputArtifactPath } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
  };
}

/** Return whether persisted thread state prevents a new provider turn. */
export function isStoppedThread(status: Thread["status"] | undefined): boolean {
  return status === undefined || ["paused", "stopped", "completed", "errored", "failed", "interrupted"].includes(status);
}

/** Return whether an event still belongs to a runtime that can change state. */
export function isActiveRuntimeExecution(
  runtime: TurnRuntimeSnapshot | null,
  executionId: string | undefined,
): boolean {
  const phase = runtime?.phase;
  return runtime?.turnExecutionId === executionId
    && (phase === "running" || phase === "finalizing");
}

/** Create the empty runtime shape used when no runtime exists for a thread. */
export function idleRuntime(threadId: string): TurnRuntimeSnapshot {
  return { threadId, turnExecutionId: null, phase: "idle" };
}

/** Return whether a runtime can still be stopped or terminalized. */
export function isRunningRuntime(runtime: TurnRuntimeSnapshot): boolean {
  return runtime.turnExecutionId !== null && (runtime.phase === "running" || runtime.phase === "finalizing");
}

/** Return whether a stop still owns the same live execution. */
export function ownsStoppedExecution(runtime: TurnRuntimeSnapshot, executionId: string | null): boolean {
  return isRunningRuntime(runtime) && runtime.turnExecutionId === executionId;
}

/** Derive the stop result from admission and provider dispatch state. */
export function stopDispatchState(
  runtime: TurnRuntimeSnapshot,
  dispatched: boolean | undefined,
  reservationState: string | undefined,
): AgentStopResult["dispatchState"] {
  if (!isRunningRuntime(runtime)) return "unknown";
  if (dispatched) return "dispatched";
  return reservationState === "activeTurn" || reservationState === "stopping" || reservationState === undefined
    ? "not-dispatched"
    : "unknown";
}

/** Convert legacy terminal labels to the pipeline source vocabulary. */
export function pipelineTerminalSource(source: string): FinalizeTurnCommand["source"] {
  if (source === "user stop") return "user-stop";
  if (source === "shutdown") return "shutdown";
  if (source.includes("checkpoint failure")) return "checkpoint-failure";
  return "provider";
}
