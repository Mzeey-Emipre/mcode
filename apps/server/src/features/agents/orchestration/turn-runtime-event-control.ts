import type { AgentEvent, TurnRuntimeSnapshot } from "@mcode/contracts";

import type { TurnOutcome } from "../turns/turn-outcome.js";

/** Injection token for the runtime controls used by normalized provider-event application. */
export const TURN_RUNTIME_EVENT_CONTROL = "TurnRuntimeEventControl";

/** Runtime lifecycle operations required to apply normalized provider events. */
export interface TurnRuntimeEventControl {
  /** Admit a provider-originated turn before it can own runtime state. */
  admitProviderTurn(threadId: string): boolean;
  /** Mark one admitted provider turn active for runtime accounting. */
  markProviderTurnActive(threadId: string): void;
  /** Return the current execution state for a thread. */
  snapshot(threadId: string): TurnRuntimeSnapshot | undefined;
  /** Apply a completed provider turn and release its runtime resources. */
  completeProviderTurn(event: Extract<AgentEvent, { type: "turnComplete" }>): boolean;
  /** Apply a provider failure and release its runtime resources. */
  failProviderTurn(event: Extract<AgentEvent, { type: "error" }>): boolean;
  /** Apply a provider stream end and release its runtime resources. */
  endProviderTurn(event: Extract<AgentEvent, { type: "ended" }>): boolean;
  /** Return whether a terminal event belongs to a stopping execution. */
  shouldSuppressStoppingTerminal(threadId: string, executionId?: string | null): boolean;
  /** Return whether an error should be suppressed while a retry is active. */
  suppressTransientError(event: Extract<AgentEvent, { type: "error" }>): boolean;
  /** Return whether an ended event remains private. */
  shouldSuppressTurnEnded(threadId: string): boolean;
  /** Return whether a completion event remains private. */
  shouldSuppressTurnComplete(threadId: string): boolean;
  /** Return whether a transient error remains private. */
  shouldSuppressTransientTurnError(threadId: string, errorMessage: string): boolean;
  /** Clear runtime-only resources after a terminal provider event. */
  clearTerminalState(threadId: string): void;
  /** Materialize one terminal turn through the single event pipeline. */
  finalizeTerminalTurn(threadId: string, outcome: TurnOutcome, source: string): Promise<boolean> | null;
  /** Return whether the pipeline already applied a deferred file effect. */
  consumeEarlyFileEffect(event: AgentEvent): boolean;
  /** Resume queued provider events after a durable checkpoint commits. */
  resumeEventPipeline(threadId: string): void;
  /** Discard queued provider events after terminal materialization. */
  discardEventPipeline(threadId: string, executionId?: string): void;
  /** Stop the active provider after a durability or queue failure. */
  stopForEventApplicationFailure(event: AgentEvent, reason: string): void;
  /** Reserve an execution for restart-reliability verification. */
  beginReliabilityTurn(threadId: string): string;
  /** Release a failed restart-reliability reservation. */
  releaseReliabilityTurn(threadId: string): void;
}
