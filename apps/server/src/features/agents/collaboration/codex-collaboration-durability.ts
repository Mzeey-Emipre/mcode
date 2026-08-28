import type {
  AgentItem,
  AgentThread,
  AgentTurn,
  CollaborationAction,
  ProviderIdentity,
  TurnOutcome,
} from "@mcode/contracts";

/** Injection token for the narrow Codex-native collaboration durability boundary. */
export const CODEX_COLLABORATION_DURABILITY = Symbol("CodexCollaborationDurability");

/** The durable state created for one Codex provider-native child delegation. */
export interface CodexChildDelegation {
  childThread: AgentThread;
  parentItem: AgentItem;
  collaborationAction: CollaborationAction;
}

/** The records that start one Codex provider-native child delegation. */
export interface CodexChildDelegationInput {
  parentThreadId: string;
  parentTurnId: string;
  parentExecutionId: string;
  parentItemId: string;
  receiverThreadIds?: readonly string[];
  description?: string;
  prompt?: string;
  identity?: string;
  model?: string;
  reasoningEffort?: string;
  replacementForActionId?: string;
  providerIdentities: readonly ProviderIdentity[];
}

/** The exact native identity that connects a Codex child to its parent delegation. */
export interface CodexChildIdentityInput {
  parentThreadId: string;
  parentTurnId: string;
  parentExecutionId: string;
  parentItemId: string;
  nativeThreadId: string;
}

/** The input that starts a Codex child turn after native evidence arrives. */
export interface CodexChildTurnStartInput extends CodexChildIdentityInput {
  nativeTurnId: string;
  prompt?: string;
  triggerActionId?: string;
}

/** The input that persists one Codex child semantic item. */
export interface CodexChildItemInput {
  childThreadId: string;
  nativeTurnId: string;
  nativeItemId: string;
  eventKey: string;
  kind: AgentItem["kind"];
  payload: Record<string, unknown>;
  parentItemId?: string;
}

/** The input that terminalizes one Codex child turn by native turn identity. */
export interface CodexChildTurnFinishInput {
  childThreadId: string;
  nativeTurnId: string;
  outcome: TurnOutcome;
  error?: string;
}

/** The input that terminalizes the newest running canonical child turn. */
export interface CanonicalChildTurnFinishInput {
  childThreadId: string;
  outcome: TurnOutcome;
  error?: string;
}

/** The input that classifies a Codex child delivery after native evidence arrives. */
export interface CodexChildDeliveryInput extends CodexChildIdentityInput {}

/** The input that replaces a failed or uncertain Codex child delivery. */
export interface CodexChildRetryInput extends Omit<CodexChildDelegationInput, "replacementForActionId"> {
  previousActionId: string;
}

/** The bounded diagnostic recorded when attributed Codex child routing cannot persist. */
export interface CodexChildRoutingDiagnosticInput {
  threadId: string;
  parentItemId?: string;
  executionId?: string;
  event: unknown;
  reason: string;
}

/** The input that records one Codex-native collaboration action. */
export interface CodexCollaborationActionInput {
  actionId: string;
  kind: CollaborationAction["kind"];
  sourceThreadId: string;
  sourceTurnId: string;
  sourceExecutionId: string;
  sourceItemId: string;
  targetThreadId: string;
  targetTurnId?: string;
  status: CollaborationAction["status"];
  providerIdentities: readonly ProviderIdentity[];
  payload: Record<string, unknown>;
}

/** The input that starts a parent turn after Codex proves a continuation action. */
export interface CodexProviderContinuationInput {
  parentThreadId: string;
  turnId: string;
  executionId: string;
  permissionMode: AgentTurn["permissionMode"];
  providerIdentities: readonly ProviderIdentity[];
  triggerActionId: string;
}

/** Durable Codex-native collaboration operations that a future adapter can receive by construction. */
export interface CodexCollaborationDurability {
  loadThread(threadId: string): AgentThread | null;
  loadThreadByProviderIdentity(identity: ProviderIdentity): AgentThread | null;
  loadTurn(turnId: string): AgentTurn | null;
  loadTurnByExecution(executionId: string): AgentTurn | null;
  loadTurnByProviderIdentity(threadId: string, identity: ProviderIdentity): AgentTurn | null;
  loadLatestTurn(threadId: string): AgentTurn | null;
  loadExecutionIdForTurn(turnId: string): string;
  loadLatestPermissionMode(threadId: string): AgentTurn["permissionMode"] | null;
  loadCollaborationActionBySourceProviderIdentity(
    sourceThreadId: string,
    sourceTurnId: string,
    identity: ProviderIdentity,
  ): CollaborationAction | null;
  recordCollaborationAction(input: CodexCollaborationActionInput): CollaborationAction;
  startProviderContinuation(input: CodexProviderContinuationInput): AgentTurn;
  activateProviderContinuation(threadId: string): void;
  loadCodexChildDelegation(parentThreadId: string, parentItemId: string): CodexChildDelegation | null;
  loadCodexChildDelegationByReceiverThreadId(nativeThreadId: string): CodexChildDelegation | null;
  startCodexChildDelegation(input: CodexChildDelegationInput): CodexChildDelegation;
  markCodexChildDeliveryUnknown(input: CodexChildDeliveryInput): CodexChildDelegation;
  markCodexChildDeliveryRejected(input: CodexChildDeliveryInput): CodexChildDelegation;
  markUnresolvedCodexChildDeliveriesUnknown(executionId: string): string[];
  retryCodexChildDelegation(input: CodexChildRetryInput): CodexChildDelegation;
  registerCodexReceiverThreadIds(
    input: CodexChildIdentityInput & { receiverThreadIds: readonly string[] },
  ): CodexChildDelegation;
  bindCodexChildIdentity(input: CodexChildIdentityInput): CodexChildDelegation;
  startCodexChildTurn(input: CodexChildTurnStartInput): AgentTurn;
  recordCodexChildItem(input: CodexChildItemInput): AgentItem;
  finishCodexChildTurn(input: CodexChildTurnFinishInput): AgentTurn;
  finishCanonicalChildTurn(input: CanonicalChildTurnFinishInput): AgentTurn | null;
  recordCodexChildRoutingDiagnostic(input: CodexChildRoutingDiagnosticInput): boolean;
}
