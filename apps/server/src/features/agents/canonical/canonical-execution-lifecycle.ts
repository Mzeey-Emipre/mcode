import type { TurnOutcome } from "@mcode/contracts";

/** Durable lifecycle evidence for one exact execution. */
export interface CanonicalExecutionLifecycleState {
  exists: boolean;
  terminalOutcome: TurnOutcome | null;
}

/** Requested lifecycle transition for one exact execution. */
export interface CanonicalExecutionLifecycleRequest {
  replayGuard?: "execution-started" | "terminal-confirmed";
  terminalOutcome?: TurnOutcome;
}

/** The result of comparing a requested lifecycle transition with durable evidence. */
export type CanonicalExecutionLifecycleDecision = "accept" | "duplicate" | "conflict";

/** Decides whether one execution can start or accept a terminal outcome. */
export function decideCanonicalExecutionLifecycle(
  state: CanonicalExecutionLifecycleState,
  request: CanonicalExecutionLifecycleRequest,
): CanonicalExecutionLifecycleDecision {
  if (request.replayGuard === "execution-started") return state.exists ? "duplicate" : "accept";
  if (!request.terminalOutcome || !state.terminalOutcome) return "accept";
  return request.terminalOutcome === state.terminalOutcome ? "duplicate" : "conflict";
}
