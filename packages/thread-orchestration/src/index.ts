/** Provider-neutral authority for an active internal thread-control lease. */
export interface InternalThreadControlAuthority {
  type: "internal";
  userId: "local-user";
  sourceThreadId: string;
  sourceTurnId: string;
  sourceToolCallId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
}

/** Lineage written when a thread is created through delegation. */
export interface ThreadDelegationLineage {
  coordinatorThreadId: string;
  creatorTurnId: string;
  creatorToolCallId: string;
  creationKind: "thread_delegation";
}

/** Return whether an internal caller may discover or target a thread. */
export function isInternalThreadTargetAllowed(
  authority: InternalThreadControlAuthority,
  targetThreadId: string,
): boolean {
  return authority.sourceThreadId !== targetThreadId;
}
