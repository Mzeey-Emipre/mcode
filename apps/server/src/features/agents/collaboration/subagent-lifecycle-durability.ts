import type {
  CanonicalSubagentRoster,
  CanonicalSubagentRosterRequest,
  CanonicalSubagentStopRequest,
} from "@mcode/contracts";

/** Injection token for durable sub-agent lifecycle state. */
export const SUBAGENT_LIFECYCLE_DURABILITY = Symbol("SubagentLifecycleDurability");

/** Provider-native identity and durable status required to stop one sub-agent turn. */
export interface SubagentStopTarget {
  childThread: { id: string; providerId: string };
  latestTurn: { status: string } | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
}

/** Narrow durable state needed by sub-agent roster and stop operations. */
export interface SubagentLifecycleDurability {
  loadSubagentRoster(request: CanonicalSubagentRosterRequest): CanonicalSubagentRoster;
  loadSubagentStopTarget(request: CanonicalSubagentStopRequest): SubagentStopTarget | null;
  loadActiveSubagentStopTargets(owningParentThreadId: string): SubagentStopTarget[];
  interruptSubagentTurns(childThreadIds: readonly string[], reason: string): void;
  finishSubagentTurn(input: {
    childThreadId: string;
    nativeTurnId: string;
    outcome: "interrupted";
    error: string;
  }): { status: string };
}
