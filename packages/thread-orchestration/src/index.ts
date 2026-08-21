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

/** Operation scopes granted to a paired external thread-control integration. */
export type ExternalThreadControlScope =
  | "projects:read"
  | "worktrees:read"
  | "threads:create"
  | "threads:read-owned"
  | "threads:read-project"
  | "threads:send-owned"
  | "threads:send-project"
  | "threads:stop-owned"
  | "threads:stop-project"
  | "worktrees:create"
  | "execution:full";

/** Server-owned authority for a paired external thread-control integration. */
export interface ExternalThreadControlAuthority {
  type: "external";
  /** Durable pairing identity derived by the authenticated external adapter. */
  pairingId?: string;
  /** Monotonic authority epoch; stale epochs cannot dispatch. */
  authorityEpoch?: number;
  integrationId: string;
  allowedWorkspaceIds: readonly string[];
  scopes: readonly ExternalThreadControlScope[];
  limits: {
    callsPerMinute: number;
    maxActiveThreads: number;
  };
}

/** Server-owned authority accepted by the shared thread-control service. */
export type ThreadControlAuthority =
  | InternalThreadControlAuthority
  | ExternalThreadControlAuthority;

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

export {
  MCODE_INSTRUCTIONS_MAX_CHARS,
  buildMcodeInstructionPlan,
  isExplicitMcodeThreadRequest,
  renderMcodeInstructions,
} from "./mcode-instructions.js";
export { MCODE_BROWSER_GUIDE } from "./browser-operating-guide.js";
export type {
  BuildMcodeInstructionPlanInput,
  McodeInstructionCapabilities,
  McodeInstructionPlan,
} from "./mcode-instructions.js";
