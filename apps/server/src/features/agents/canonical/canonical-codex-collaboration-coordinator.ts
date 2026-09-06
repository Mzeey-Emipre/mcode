import * as NodeCrypto from "node:crypto";
import type Database from "better-sqlite3";
import {
  CANONICAL_SUBAGENT_TASK_MAX_LENGTH,
  resolveSubagentDisplayName,
  resolveSubagentMetadata,
} from "@mcode/contracts";
import type {
  AgentItem,
  AgentThread,
  AgentTurn,
  CanonicalAgentEvent,
  CollaborationAction,
  NarrativeEntry,
  ProviderIdentity,
} from "@mcode/contracts";
import type {
  CanonicalChildTurnFinishInput,
  CodexChildDeliveryInput,
  CodexChildDelegation,
  CodexChildDelegationInput,
  CodexChildIdentityInput,
  CodexChildItemInput,
  CodexChildRetryInput,
  CodexChildRoutingDiagnosticInput,
  CodexChildTurnStartInput,
  CodexChildTurnFinishInput,
} from "../collaboration/codex-collaboration-durability.js";
import type {
  CanonicalAgentCommitInput,
  CanonicalAgentCommitResult,
  CanonicalAgentEventDraft,
} from "./canonical-agent-event-sink.js";

/** Generic persistence operations required by the Codex child-thread protocol. */
export interface CanonicalCodexCollaborationOperations {
  loadThread(threadId: string): AgentThread | null;
  loadTurn(turnId: string): AgentTurn | null;
  loadTurnByExecution(executionId: string): AgentTurn | null;
  loadItem(itemId: string): AgentItem | null;
  actionFromRow(row: Record<string, unknown>): CollaborationAction;
  turnFromRow(row: Record<string, unknown>): AgentTurn;
  executionIdForTurn(turnId: string): string;
  commit(input: CanonicalAgentCommitInput): void;
  commitInsideTransaction(input: CanonicalAgentCommitInput): CanonicalAgentCommitResult;
  publishCommitted(results: readonly CanonicalAgentCommitResult[]): void;
  itemDraft(
    executionId: string,
    thread: AgentThread,
    turn: AgentTurn,
    item: AgentItem,
    eventId?: string,
  ): CanonicalAgentEventDraft;
  actionDraft(
    executionId: string,
    thread: AgentThread,
    action: CollaborationAction,
    eventId?: string,
  ): CanonicalAgentEventDraft;
  loadAction(actionId: string): CollaborationAction | null;
  cacheTurnExecution(executionId: string, turnId: string): void;
  recordProviderDiagnostic(input: { turnId: string; executionId: string; event: unknown }): void;
}

interface ResolvedDiagnosticTurn {
  turn: AgentTurn;
  executionId: string;
}

/** Owns Codex-native child delegation lookup and later lifecycle coordination. */
export class CanonicalCodexCollaborationCoordinator {
  constructor(
    private readonly db: Database.Database,
    private readonly operations: CanonicalCodexCollaborationOperations,
  ) {}

  /** Loads the one Codex child delegation sourced by a canonical parent item. */
  loadDelegation(parentThreadId: string, parentItemId: string): CodexChildDelegation | null {
    const row = this.db.prepare(`
      SELECT *
      FROM canonical_collaboration_actions
      WHERE source_thread_id = ?
        AND source_item_id = ?
        AND kind = 'delegate'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(parentThreadId, parentItemId) as Record<string, unknown> | undefined;
    return row ? this.toDelegation(row, parentItemId) : null;
  }

  /** Loads the unique Codex child delegation registered for one native receiver thread. */
  loadDelegationByReceiverThreadId(nativeThreadId: string): CodexChildDelegation | null {
    const receiver = codexReceiverIdentity(nativeThreadId);
    const rows = this.db.prepare(`
      SELECT action.*
      FROM canonical_collaboration_actions AS action
      JOIN json_each(action.provider_identities_json) AS provider_identity
        ON json_extract(provider_identity.value, '$.providerId') = ?
       AND json_extract(provider_identity.value, '$.scope') = ?
       AND json_extract(provider_identity.value, '$.value') = ?
       AND json_extract(provider_identity.value, '$.provenance') = ?
      WHERE action.kind = 'delegate'
      LIMIT 2
    `).all(
      receiver.providerId,
      receiver.scope,
      receiver.value,
      receiver.provenance,
    ) as Record<string, unknown>[];
    if (rows.length > 1) throw new Error(`Codex receiver identity is ambiguous: ${nativeThreadId}`);
    return rows[0] ? this.toDelegation(rows[0], nativeThreadId) : null;
  }

  /** Persists one Codex child terminal outcome while preserving the first terminal state. */
  finishChildTurn(input: CodexChildTurnFinishInput): AgentTurn {
    const turn = this.loadChildTurn(input.childThreadId, input.nativeTurnId);
    if (!turn) throw new Error(`Codex child turn not found: ${input.nativeTurnId}`);
    return isTerminalTurn(turn) ? turn : this.finishChildTurnRecord(turn, input.outcome, input.error);
  }

  /** Terminalizes the latest running canonical child turn by its durable thread identity. */
  finishLatestChildTurn(input: CanonicalChildTurnFinishInput): AgentTurn | null {
    const row = this.db.prepare(`
      SELECT *
      FROM canonical_agent_turns
      WHERE thread_id = ? AND status = 'Running'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(input.childThreadId) as Record<string, unknown> | undefined;
    return row
      ? this.finishChildTurnRecord(this.operations.turnFromRow(row), input.outcome, input.error)
      : null;
  }

  /** Persists one Codex child message, reasoning item, tool call, or tool result exactly once. */
  recordChildItem(input: CodexChildItemInput): AgentItem {
    const turn = this.loadChildTurn(input.childThreadId, input.nativeTurnId);
    if (!turn) throw new Error(`Codex child turn not found: ${input.nativeTurnId}`);
    const itemId = `item:codex-child:${hashCodexKey(`${turn.id}:${input.nativeItemId}:${this.childItemEventKey(input)}:${input.kind}`)}`;
    const existing = this.operations.loadItem(itemId);
    if (existing) return this.updateExistingChildItem(existing, input, itemId);

    const thread = this.operations.loadThread(input.childThreadId);
    if (!thread) throw new Error(`Codex child thread not found: ${input.childThreadId}`);
    const item = this.createChildItem(input, itemId, thread, turn);
    const executionId = this.operations.executionIdForTurn(turn.id);
    this.operations.commit({
      threadId: thread.id,
      turnId: turn.id,
      executionId,
      phase: "running",
      events: [this.operations.itemDraft(executionId, thread, turn, item)],
    });
    return item;
  }

  /** Marks a child delivery as unknown without making the uncertain child reusable. */
  markDeliveryUnknown(input: CodexChildDeliveryInput): CodexChildDelegation {
    return this.updateDelivery(input, "unknown");
  }

  /** Marks a provider-confirmed child rejection as failed and unavailable. */
  markDeliveryRejected(input: CodexChildDeliveryInput): CodexChildDelegation {
    return this.updateDelivery(input, "rejected");
  }

  /** Marks dispatched child deliveries as uncertain when their owning execution cannot be resumed. */
  markUnresolvedDeliveriesUnknown(executionId: string, maximum: number): string[] {
    const rows = this.db.prepare(`
      SELECT action.*
      FROM canonical_collaboration_actions action
      JOIN canonical_agent_turns source_turn ON source_turn.id = action.source_turn_id
      WHERE source_turn.execution_id = ?
        AND action.status IN ('Pending', 'Dispatched')
        AND action.target_turn_id IS NULL
        AND action.delivery_unknown = 0
      ORDER BY action.created_at ASC, action.id ASC
      LIMIT ?
    `).all(executionId, maximum + 1) as Record<string, unknown>[];
    if (rows.length > maximum) throw new Error(`Canonical unresolved child delivery count exceeds ${maximum}`);
    const actionIds: string[] = [];
    for (const row of rows) {
      const action = this.operations.actionFromRow(row);
      const parentThread = this.requireThread(action.source.threadId, "Canonical unresolved child delivery");
      const childThread = this.requireThread(action.target.threadId, "Canonical unresolved child delivery");
      this.commitDeliveryState({ parentThread, childThread, action: this.unknownAction(action), executionId });
      actionIds.push(action.id);
    }
    return actionIds;
  }

  /** Adds exact Codex receiver-thread identities to a provisional delegation. */
  registerReceiverThreadIds(
    input: CodexChildIdentityInput & { receiverThreadIds: readonly string[] },
  ): CodexChildDelegation {
    const delegation = this.requireDelegation(input.parentThreadId, input.parentItemId);
    this.assertDeliveryCanBeAcknowledged(delegation.collaborationAction);
    this.assertNoConflictingNativeThread(delegation, input.nativeThreadId, input.parentItemId);
    const action = this.actionWithReceivers(delegation.collaborationAction, input.receiverThreadIds);
    if (sameProviderIdentities(action, delegation.collaborationAction)) return delegation;
    this.commitParentAction(input, action, this.receiverActionSuffix(action));
    return { ...delegation, collaborationAction: action };
  }

  /** Binds a child only when its native thread identity is an exact registered receiver. */
  bindChildIdentity(input: CodexChildIdentityInput): CodexChildDelegation {
    const delegation = this.requireDelegation(input.parentThreadId, input.parentItemId);
    this.assertDeliveryCanBeAcknowledged(delegation.collaborationAction);
    this.assertRegisteredReceiver(delegation.collaborationAction, input.nativeThreadId);
    this.assertNoConflictingNativeThread(delegation, input.nativeThreadId, input.parentItemId);
    if (this.childNativeThread(delegation.childThread)) return this.acknowledgeExistingBinding(input, delegation);
    return this.persistNewBinding(input, delegation);
  }

  /** Provisions one Starting child and one directional Dispatched action exactly once. */
  startDelegation(input: CodexChildDelegationInput): CodexChildDelegation {
    const normalized = normalizeDelegationInput(input);
    const existing = this.loadDelegation(input.parentThreadId, input.parentItemId);
    return existing
      ? this.updateExistingDelegation(input, normalized, existing)
      : this.createDelegation(input, normalized);
  }

  /** Creates a linked replacement child for a failed or uncertain delivery. */
  retryDelegation(input: CodexChildRetryInput): CodexChildDelegation {
    const previous = this.operations.loadAction(input.previousActionId);
    this.assertRetryable(previous, input);
    return this.startDelegation({ ...input, replacementForActionId: input.previousActionId });
  }

  /** Creates and starts a canonical child turn after exact native turn evidence. */
  startChildTurn(input: CodexChildTurnStartInput): AgentTurn {
    const delegation = this.bindChildIdentity(input);
    const childThread = delegation.childThread;
    const existing = this.loadChildTurn(childThread.id, input.nativeTurnId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const turnId = `turn:codex-child:${NodeCrypto.randomUUID()}`;
    const executionId = NodeCrypto.randomUUID();
    const identities = childTurnIdentities(childThread, input.nativeTurnId);
    const action = this.resolveChildTriggerAction(input, delegation, childThread);
    const turn = newChildTurn(turnId, childThread.id, action, identities, now);
    const promptItem = input.prompt === undefined
      ? undefined
      : this.childPromptItem(turn, childThread, action, input.prompt, now);
    this.commitChildTurnStart(turn, childThread, action, identities, promptItem, executionId, input.nativeTurnId);
    const persisted = this.operations.loadTurn(turnId);
    if (!persisted) throw new Error(`Codex child turn was not persisted: ${turnId}`);
    this.operations.cacheTurnExecution(executionId, persisted.id);
    return persisted;
  }

  /** Finds parent tool calls whose projected output is owned by Codex child coordination. */
  ownedToolCallIds(narrative: readonly NarrativeEntry[]): ReadonlySet<string> {
    const childrenByParent = new Map<string, string[]>();
    const owned = new Set<string>();
    for (const entry of narrative) {
      if (entry.kind !== "toolCall") continue;
      const record = entry.record as Record<string, unknown>;
      if (typeof record.id !== "string") continue;
      if (isCodexSpawnRecord(record)) owned.add(record.id);
      this.indexChildToolCall(childrenByParent, record);
    }
    this.addDescendantToolCalls(owned, childrenByParent);
    return owned;
  }

  /** Persists a recoverable diagnostic item when Codex child routing cannot be attributed. */
  recordRoutingDiagnostic(input: CodexChildRoutingDiagnosticInput): boolean {
    const resolved = this.resolveDiagnosticTurn(input);
    if (!resolved || resolved.turn.threadId !== input.threadId) return false;
    this.operations.recordProviderDiagnostic({
      turnId: resolved.turn.id,
      executionId: resolved.executionId,
      event: { type: "codex-child-routing-failure", reason: input.reason, event: input.event },
    });
    const thread = this.operations.loadThread(resolved.turn.threadId);
    if (!thread) return false;
    const itemId = routingFailureItemId(resolved.turn.id, input);
    if (this.operations.loadItem(itemId)) return true;
    const item = newRoutingFailureItem(itemId, thread, resolved.turn, input);
    this.operations.commit({
      threadId: thread.id,
      turnId: resolved.turn.id,
      executionId: resolved.executionId,
      phase: "running",
      events: [this.operations.itemDraft(resolved.executionId, thread, resolved.turn, item)],
    });
    return true;
  }

  private toDelegation(row: Record<string, unknown>, identifier: string): CodexChildDelegation {
    const collaborationAction = this.operations.actionFromRow(row);
    const childThread = this.operations.loadThread(collaborationAction.target.threadId);
    const parentItem = this.operations.loadItem(collaborationAction.source.itemId);
    if (!childThread || !parentItem) throw new Error(`Codex child delegation is incomplete: ${identifier}`);
    return { childThread, parentItem, collaborationAction };
  }

  private requireDelegation(parentThreadId: string, parentItemId: string): CodexChildDelegation {
    const delegation = this.loadDelegation(parentThreadId, parentItemId);
    if (!delegation) throw new Error(`Codex child delegation not found: ${parentItemId}`);
    return delegation;
  }

  private requireThread(threadId: string, label: string): AgentThread {
    const thread = this.operations.loadThread(threadId);
    if (!thread) throw new Error(`${label} is incomplete: ${threadId}`);
    return thread;
  }

  private unknownAction(action: CollaborationAction): CollaborationAction {
    return { ...action, status: "Dispatched", deliveryUnknown: true, updatedAt: new Date().toISOString() };
  }

  private updateDelivery(
    input: CodexChildDeliveryInput,
    outcome: "unknown" | "rejected",
  ): CodexChildDelegation {
    const delegation = this.requireDelegation(input.parentThreadId, input.parentItemId);
    this.assertDeliveryCanChange(delegation.collaborationAction, outcome);
    if (this.isCurrentDeliveryState(delegation.collaborationAction, outcome)) return delegation;
    if (delegation.collaborationAction.source.turnId !== input.parentTurnId) {
      throw new Error(`Codex child delivery source turn conflict: ${input.parentItemId}`);
    }
    const parentThread = this.requireThread(input.parentThreadId, "Codex parent thread");
    const action = this.actionWithDeliveryOutcome(delegation.collaborationAction, outcome);
    this.commitDeliveryState({
      parentThread,
      childThread: delegation.childThread,
      action,
      executionId: this.operations.executionIdForTurn(action.source.turnId),
    });
    return this.unavailableDelegation(delegation, action);
  }

  private assertDeliveryCanChange(action: CollaborationAction, outcome: "unknown" | "rejected"): void {
    if (outcome === "unknown" && action.status === "Failed" && !action.deliveryUnknown) {
      throw new Error(`Cannot replace confirmed Codex child rejection: ${action.id}`);
    }
    if (outcome === "rejected" && action.status === "Acknowledged" && !action.deliveryUnknown) {
      throw new Error(`Cannot reject acknowledged Codex child delivery: ${action.id}`);
    }
  }

  private isCurrentDeliveryState(action: CollaborationAction, outcome: "unknown" | "rejected"): boolean {
    return (outcome === "unknown" && action.deliveryUnknown)
      || (outcome === "rejected" && action.status === "Failed" && !action.deliveryUnknown);
  }

  private actionWithDeliveryOutcome(
    action: CollaborationAction,
    outcome: "unknown" | "rejected",
  ): CollaborationAction {
    return {
      ...action,
      status: outcome === "rejected" ? "Failed" : "Dispatched",
      deliveryUnknown: outcome === "unknown",
      updatedAt: new Date().toISOString(),
    };
  }

  private unavailableDelegation(
    delegation: CodexChildDelegation,
    collaborationAction: CollaborationAction,
  ): CodexChildDelegation {
    return {
      ...delegation,
      childThread: { ...delegation.childThread, activityState: "Unavailable", updatedAt: collaborationAction.updatedAt },
      collaborationAction,
    };
  }

  private commitDeliveryState(input: {
    parentThread: AgentThread;
    childThread: AgentThread;
    action: CollaborationAction;
    executionId: string;
  }): void {
    const now = input.action.updatedAt;
    const childExecutionId = deterministicUuid(`${input.executionId}:codex-child:${input.action.id}:${input.action.status}`);
    const results = this.db.transaction(() => ({
      parent: this.commitParentDelivery(input, now, childExecutionId),
      child: this.commitChildUnavailable(input, now, childExecutionId),
    }))();
    this.operations.publishCommitted([results.parent, results.child]);
  }

  private commitParentDelivery(
    input: { parentThread: AgentThread; action: CollaborationAction; executionId: string },
    now: string,
    childExecutionId: string,
  ): CanonicalAgentCommitResult {
    const thread = { ...input.parentThread, rosterRevision: input.parentThread.rosterRevision + 1, updatedAt: now };
    return this.operations.commitInsideTransaction({
      threadId: input.parentThread.id,
      turnId: input.action.source.turnId,
      executionId: input.executionId,
      phase: "running",
      events: [{
        eventId: `${childExecutionId}:parent-thread`,
        routing: { threadId: input.parentThread.id, executionId: input.executionId },
        sourceProviderId: input.parentThread.providerId,
        sourceIdentities: input.parentThread.providerIdentities,
        payload: { type: "thread.recorded", thread },
      }, this.operations.actionDraft(input.executionId, input.parentThread, input.action, `${childExecutionId}:action`)],
    });
  }

  private commitChildUnavailable(
    input: { childThread: AgentThread; action: CollaborationAction },
    now: string,
    executionId: string,
  ): CanonicalAgentCommitResult {
    const thread = { ...input.childThread, activityState: "Unavailable" as const, updatedAt: now };
    return this.operations.commitInsideTransaction({
      threadId: input.childThread.id,
      turnId: input.action.source.turnId,
      executionId,
      phase: "delivery",
      persistCheckpoint: false,
      events: [{
        eventId: `${executionId}:child-thread`,
        routing: { threadId: input.childThread.id, executionId },
        sourceProviderId: input.childThread.providerId,
        sourceIdentities: input.childThread.providerIdentities,
        payload: { type: "thread.recorded", thread },
      }],
    });
  }

  private assertDeliveryCanBeAcknowledged(action: CollaborationAction): void {
    if (action.status === "Failed" && !action.deliveryUnknown) {
      throw new Error(`Cannot acknowledge confirmed Codex child rejection: ${action.id}`);
    }
  }

  private assertNoConflictingNativeThread(
    delegation: CodexChildDelegation,
    nativeThreadId: string,
    parentItemId: string,
  ): void {
    const nativeThread = this.childNativeThread(delegation.childThread);
    if (nativeThread && nativeThread.value !== nativeThreadId) {
      throw new Error(`Codex child native thread identity conflict: ${parentItemId}`);
    }
  }

  private actionWithReceivers(
    action: CollaborationAction,
    receiverThreadIds: readonly string[],
  ): CollaborationAction {
    return {
      ...action,
      providerIdentities: uniqueProviderIdentities([
        ...action.providerIdentities,
        ...receiverThreadIds.filter(Boolean).map(codexReceiverIdentity),
      ]),
      updatedAt: new Date().toISOString(),
    };
  }

  private receiverActionSuffix(action: CollaborationAction): string {
    const receiverKey = action.providerIdentities
      .filter((identity) => identity.scope === "parentItem")
      .map((identity) => identity.value)
      .sort()
      .join("|");
    return `receivers:${hashCodexKey(receiverKey)}`;
  }

  private commitParentAction(
    input: CodexChildIdentityInput,
    action: CollaborationAction,
    suffix: string,
  ): void {
    const thread = this.requireThread(input.parentThreadId, "Codex parent thread");
    this.operations.commit({
      threadId: thread.id,
      turnId: input.parentTurnId,
      executionId: input.parentExecutionId,
      phase: "running",
      events: [this.operations.actionDraft(
        input.parentExecutionId,
        thread,
        action,
        `${input.parentExecutionId}:codex-child:${hashCodexKey(input.parentItemId)}:${suffix}`,
      )],
    });
  }

  private assertRegisteredReceiver(action: CollaborationAction, nativeThreadId: string): void {
    const receiver = codexReceiverIdentity(nativeThreadId);
    const exists = action.providerIdentities.some((identity) => (
      identity.providerId === receiver.providerId
      && identity.scope === receiver.scope
      && identity.value === receiver.value
    ));
    if (!exists) throw new Error(`Codex child identity is not a registered receiver: ${nativeThreadId}`);
  }

  private childNativeThread(thread: AgentThread): ProviderIdentity | undefined {
    return thread.providerIdentities.find((identity) => (
      identity.providerId === "codex" && identity.scope === "thread"
    ));
  }

  private acknowledgeExistingBinding(
    input: CodexChildIdentityInput,
    delegation: CodexChildDelegation,
  ): CodexChildDelegation {
    if (delegation.collaborationAction.status === "Acknowledged") return delegation;
    const action = acknowledgeAction(delegation.collaborationAction);
    this.commitParentAction(input, action, "acknowledge");
    return { ...delegation, collaborationAction: action };
  }

  private persistNewBinding(
    input: CodexChildIdentityInput,
    delegation: CodexChildDelegation,
  ): CodexChildDelegation {
    const childThread = {
      ...delegation.childThread,
      providerIdentities: [...delegation.childThread.providerIdentities, nativeThreadIdentity(input.nativeThreadId)],
      updatedAt: new Date().toISOString(),
    };
    const action = acknowledgeAction(delegation.collaborationAction, childThread.updatedAt);
    this.commitParentBinding(input, childThread, action);
    return { childThread, parentItem: delegation.parentItem, collaborationAction: action };
  }

  private commitParentBinding(
    input: CodexChildIdentityInput,
    childThread: AgentThread,
    action: CollaborationAction,
  ): void {
    const thread = this.requireThread(input.parentThreadId, "Codex parent thread");
    const childExecutionId = `${input.parentExecutionId}:codex-child:${hashCodexKey(input.nativeThreadId)}`;
    this.operations.commit({
      threadId: thread.id,
      turnId: input.parentTurnId,
      executionId: input.parentExecutionId,
      phase: "running",
      events: [{
        eventId: `${childExecutionId}:bound`,
        routing: { threadId: thread.id, executionId: input.parentExecutionId },
        sourceProviderId: thread.providerId,
        sourceIdentities: action.providerIdentities,
        payload: {
          type: "child-thread.bound",
          parentThreadId: thread.id,
          childThreadId: childThread.id,
          providerIdentity: nativeThreadIdentity(input.nativeThreadId),
        },
      }, this.operations.actionDraft(
        input.parentExecutionId,
        thread,
        action,
        `${input.parentExecutionId}:codex-child:${hashCodexKey(input.nativeThreadId)}:action`,
      )],
    });
  }

  private updateExistingDelegation(
    input: CodexChildDelegationInput,
    normalized: NormalizedDelegationInput,
    existing: CodexChildDelegation,
  ): CodexChildDelegation {
    const updatedItem = this.updatedParentItem(existing.parentItem, input, normalized);
    const updatedAction = this.updatedDelegationAction(existing.collaborationAction, normalized.prompt);
    const itemChanged = !this.isSameParentItem(updatedItem, existing.parentItem);
    const actionChanged = updatedAction !== existing.collaborationAction;
    if (!itemChanged && !actionChanged) {
      this.recordLatePrompt(existing, normalized.prompt);
      return existing;
    }
    const parentThread = this.requireThread(input.parentThreadId, "Codex parent thread");
    const parentTurn = this.operations.loadTurn(input.parentTurnId);
    if (!parentTurn || parentTurn.threadId !== parentThread.id) {
      throw new Error(`Codex parent turn is not canonical: ${input.parentTurnId}`);
    }
    const eventId = parentItemMetadataEventId(
      input,
      normalized,
      existing.parentItem.updatedAt,
      updatedItem.providerIdentities,
    );
    this.operations.commit({
      threadId: parentThread.id,
      turnId: parentTurn.id,
      executionId: input.parentExecutionId,
      phase: "running",
      events: [
        ...(itemChanged
          ? [this.operations.itemDraft(input.parentExecutionId, parentThread, parentTurn, updatedItem, eventId)]
          : []),
        ...(actionChanged
          ? [this.operations.actionDraft(input.parentExecutionId, parentThread, updatedAction, `${eventId}:action`)]
          : []),
      ],
    });
    const delegation = {
      ...existing,
      parentItem: itemChanged ? updatedItem : existing.parentItem,
      collaborationAction: updatedAction,
    };
    this.recordLatePrompt(delegation, normalized.prompt);
    return delegation;
  }

  private updatedDelegationAction(
    action: CollaborationAction,
    prompt: string | undefined,
  ): CollaborationAction {
    if (!prompt || action.message === prompt) return action;
    return { ...action, message: prompt, updatedAt: new Date().toISOString() };
  }

  private updatedParentItem(
    existing: AgentItem,
    input: CodexChildDelegationInput,
    normalized: NormalizedDelegationInput,
  ): AgentItem {
    const providerIdentities = uniqueProviderIdentities([...existing.providerIdentities, ...input.providerIdentities]);
    return {
      ...existing,
      providerIdentities,
      payload: withDelegationMetadata(existing.payload, normalized),
      updatedAt: new Date().toISOString(),
    };
  }

  private isSameParentItem(left: AgentItem, right: AgentItem): boolean {
    return JSON.stringify(left.payload) === JSON.stringify(right.payload)
      && JSON.stringify(left.providerIdentities) === JSON.stringify(right.providerIdentities);
  }

  private createDelegation(
    input: CodexChildDelegationInput,
    normalized: NormalizedDelegationInput,
  ): CodexChildDelegation {
    const parentThread = this.requireThread(input.parentThreadId, "Codex parent thread");
    const parentTurn = this.operations.loadTurn(input.parentTurnId);
    if (!parentTurn || parentTurn.threadId !== parentThread.id) {
      throw new Error(`Codex parent turn is not canonical: ${input.parentTurnId}`);
    }
    const now = new Date().toISOString();
    const childThread = newChildThread(parentThread, now);
    const parentItem = newDelegationParentItem(input, normalized, parentThread, parentTurn, childThread, now);
    const action = newDelegationAction(input, normalized, parentThread, parentItem, childThread, now);
    this.commitNewDelegation(input, parentThread, parentTurn, childThread, parentItem, action);
    return { childThread, parentItem, collaborationAction: action };
  }

  private commitNewDelegation(
    input: CodexChildDelegationInput,
    parentThread: AgentThread,
    parentTurn: AgentTurn,
    childThread: AgentThread,
    parentItem: AgentItem,
    action: CollaborationAction,
  ): void {
    this.operations.commit({
      threadId: parentThread.id,
      turnId: parentTurn.id,
      executionId: input.parentExecutionId,
      phase: "running",
      projectCompatibility: () => this.ensureCompatibilityThread(childThread),
      events: [this.childThreadCreatedEvent(input, parentThread, childThread),
        this.operations.itemDraft(input.parentExecutionId, parentThread, parentTurn, parentItem),
        this.operations.actionDraft(input.parentExecutionId, parentThread, action)],
    });
  }

  private childThreadCreatedEvent(
    input: CodexChildDelegationInput,
    parentThread: AgentThread,
    childThread: AgentThread,
  ): CanonicalAgentEventDraft {
    return {
      eventId: `${input.parentExecutionId}:codex-child:${hashCodexKey(input.parentItemId)}:thread`,
      routing: { threadId: parentThread.id, executionId: input.parentExecutionId },
      sourceProviderId: parentThread.providerId,
      sourceIdentities: [...input.providerIdentities],
      rosterRevision: parentThread.rosterRevision + 1,
      payload: { type: "child-thread.recorded", parentThreadId: parentThread.id, childThread },
    };
  }

  private ensureCompatibilityThread(thread: AgentThread): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO threads (
        id, workspace_id, title, status, mode, branch, created_at, updated_at,
        deleted_at, provider, parent_thread_id
      ) VALUES (?, ?, ?, 'active', 'direct', '', ?, ?, ?, 'codex', ?)
    `).run(
      thread.id,
      thread.workspaceId,
      "Sub-agent",
      thread.createdAt,
      thread.updatedAt,
      null,
      thread.parentThreadId ?? null,
    );
  }

  private recordLatePrompt(delegation: CodexChildDelegation, prompt: string | undefined): void {
    const turnId = delegation.collaborationAction.target.turnId;
    if (!prompt || !turnId) return;
    const childTurn = this.operations.loadTurn(turnId);
    if (!childTurn || childTurn.threadId !== delegation.childThread.id) return;
    const itemId = `item:codex-child-prompt:${hashCodexKey(turnId)}`;
    if (this.operations.loadItem(itemId)) return;
    const now = new Date().toISOString();
    const item = this.latePromptItem(delegation, childTurn, itemId, prompt, now);
    const executionId = this.operations.executionIdForTurn(turnId);
    this.operations.commit({
      threadId: delegation.childThread.id,
      turnId,
      executionId,
      phase: "running",
      events: [this.operations.itemDraft(executionId, delegation.childThread, childTurn, item)],
    });
  }

  private latePromptItem(
    delegation: CodexChildDelegation,
    turn: AgentTurn,
    itemId: string,
    prompt: string,
    now: string,
  ): AgentItem {
    const action = delegation.collaborationAction;
    return {
      id: itemId,
      threadId: delegation.childThread.id,
      turnId: turn.id,
      kind: "message",
      providerIdentities: turn.providerIdentities,
      payload: {
        projection: "message",
        message: newChildPromptMessage(turn.id, delegation.childThread.id, prompt, now, this.nextChildMessageSequence(delegation.childThread.id), action),
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  private assertRetryable(action: CollaborationAction | null, input: CodexChildRetryInput): void {
    if (!action) throw new Error(`Codex child action not found: ${input.previousActionId}`);
    if (action.source.threadId !== input.parentThreadId) {
      throw new Error(`Codex child retry source thread conflict: ${input.previousActionId}`);
    }
    if (action.status !== "Failed" && !action.deliveryUnknown) {
      throw new Error(`Codex child action is not retryable: ${input.previousActionId}`);
    }
  }

  private resolveChildTriggerAction(
    input: CodexChildTurnStartInput,
    delegation: CodexChildDelegation,
    childThread: AgentThread,
  ): CollaborationAction {
    const action = input.triggerActionId
      ? this.operations.loadAction(input.triggerActionId)
      : delegation.collaborationAction;
    if (!action || action.target.threadId !== childThread.id) {
      throw new Error(`Codex child trigger action does not target child: ${input.triggerActionId}`);
    }
    this.assertDeliveryCanBeAcknowledged(action);
    return action;
  }

  private indexChildToolCall(childrenByParent: Map<string, string[]>, record: Record<string, unknown>): void {
    if (typeof record.parent_tool_call_id !== "string" || typeof record.id !== "string") return;
    const children = childrenByParent.get(record.parent_tool_call_id) ?? [];
    children.push(record.id);
    childrenByParent.set(record.parent_tool_call_id, children);
  }

  private resolveDiagnosticTurn(input: CodexChildRoutingDiagnosticInput): ResolvedDiagnosticTurn | null {
    const byExecution = input.executionId ? this.operations.loadTurnByExecution(input.executionId) : null;
    const byItem = this.turnForParentItem(input.parentItemId);
    const turn = byExecution ?? byItem;
    if (!turn) return null;
    return {
      turn,
      executionId: byExecution && input.executionId
        ? input.executionId
        : this.operations.executionIdForTurn(turn.id),
    };
  }

  private turnForParentItem(parentItemId: string | undefined): AgentTurn | null {
    if (!parentItemId) return null;
    const item = this.operations.loadItem(parentItemId);
    return item ? this.operations.loadTurn(item.turnId) : null;
  }

  private addDescendantToolCalls(
    owned: Set<string>,
    childrenByParent: ReadonlyMap<string, readonly string[]>,
  ): void {
    const queue = [...owned];
    for (let index = 0; index < queue.length; index += 1) {
      const children = childrenByParent.get(queue[index]!);
      if (!children) continue;
      for (const childId of children) {
        if (owned.has(childId)) continue;
        owned.add(childId);
        queue.push(childId);
      }
    }
  }

  private childPromptItem(
    turn: AgentTurn,
    thread: AgentThread,
    action: CollaborationAction,
    prompt: string,
    now: string,
  ): AgentItem {
    return {
      id: `item:codex-child-prompt:${hashCodexKey(turn.id)}`,
      threadId: thread.id,
      turnId: turn.id,
      kind: "message",
      providerIdentities: turn.providerIdentities,
      payload: {
        projection: "message",
        message: newChildPromptMessage(turn.id, thread.id, prompt, now, this.nextChildMessageSequence(thread.id), action),
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  private commitChildTurnStart(
    turn: AgentTurn,
    childThread: AgentThread,
    action: CollaborationAction,
    identities: readonly ProviderIdentity[],
    promptItem: AgentItem | undefined,
    executionId: string,
    nativeTurnId: string,
  ): void {
    const sourceThread = this.requireThread(action.source.threadId, "Codex child action source thread");
    const sourceExecutionId = this.operations.executionIdForTurn(action.source.turnId);
    const acknowledged = {
      ...action,
      target: { threadId: childThread.id, turnId: turn.id },
      status: "Acknowledged" as const,
      deliveryUnknown: false,
      updatedAt: turn.createdAt,
    };
    const results = this.db.transaction(() => ({
      child: this.commitChildTurnStartRecord(turn, childThread, identities, promptItem, executionId),
      parent: this.commitParentAcknowledgement(sourceThread, acknowledged, sourceExecutionId, nativeTurnId),
    }))();
    this.operations.publishCommitted([results.child, results.parent]);
  }

  private commitChildTurnStartRecord(
    turn: AgentTurn,
    childThread: AgentThread,
    identities: readonly ProviderIdentity[],
    promptItem: AgentItem | undefined,
    executionId: string,
  ): CanonicalAgentCommitResult {
    return this.operations.commitInsideTransaction({
      threadId: childThread.id,
      turnId: turn.id,
      executionId,
      phase: "running",
      events: childTurnStartEvents(turn, childThread, identities, promptItem, executionId, this.operations),
    });
  }

  private commitParentAcknowledgement(
    thread: AgentThread,
    action: CollaborationAction,
    executionId: string,
    nativeTurnId: string,
  ): CanonicalAgentCommitResult {
    return this.operations.commitInsideTransaction({
      threadId: thread.id,
      turnId: action.source.turnId,
      executionId,
      phase: "running",
      events: [this.operations.actionDraft(
        executionId,
        thread,
        action,
        `${executionId}:codex-child:${hashCodexKey(nativeTurnId)}:turn`,
      )],
    });
  }

  private loadChildTurn(childThreadId: string, nativeTurnId: string): AgentTurn | null {
    const rows = this.db.prepare(`
      SELECT *
      FROM canonical_agent_turns
      WHERE thread_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(childThreadId) as Record<string, unknown>[];
    for (const row of rows) {
      const turn = this.operations.turnFromRow(row);
      if (hasNativeTurnIdentity(turn, nativeTurnId)) return turn;
    }
    return null;
  }

  private finishChildTurnRecord(
    turn: AgentTurn,
    outcome: CodexChildTurnFinishInput["outcome"],
    error: string | undefined,
  ): AgentTurn {
    const thread = this.operations.loadThread(turn.threadId);
    if (!thread) throw new Error(`Codex child thread not found: ${turn.threadId}`);
    const executionId = this.operations.executionIdForTurn(turn.id);
    const endedAt = new Date().toISOString();
    this.operations.commit({
      threadId: thread.id,
      turnId: turn.id,
      executionId,
      phase: outcome,
      terminalOutcome: outcome,
      error,
      replayGuard: "terminal-confirmed",
      events: [
        this.childIdleThreadEvent(thread, executionId, endedAt),
        this.childTerminalEvent(thread, turn, executionId, outcome, error, endedAt),
      ],
    });
    const finished = this.operations.loadTurn(turn.id);
    if (!finished) throw new Error(`Codex child terminal state was not persisted: ${turn.id}`);
    return finished;
  }

  private updateExistingChildItem(
    existing: AgentItem,
    input: CodexChildItemInput,
    itemId: string,
  ): AgentItem {
    if (input.kind !== "message") {
      if (!this.matchesExistingChildPayload(existing, input)) throw this.childItemConflict(itemId);
      return existing;
    }
    if (input.eventKey !== "stream" && input.eventKey !== "stream-complete") {
      if (!this.matchesExistingChildMessage(existing, input)) throw this.childItemConflict(itemId);
      return existing;
    }
    return this.updateStreamedChildMessage(existing, input, itemId);
  }

  private updateStreamedChildMessage(
    existing: AgentItem,
    input: CodexChildItemInput,
    itemId: string,
  ): AgentItem {
    const content = this.streamedChildMessageContent(existing, input);
    if (content === undefined) throw this.childItemConflict(itemId);
    const message = existing.payload.message;
    if (!isRecord(message)) throw this.childItemConflict(itemId);
    const thread = this.operations.loadThread(input.childThreadId);
    if (!thread) throw new Error(`Codex child thread not found: ${input.childThreadId}`);
    const turn = this.loadChildTurn(input.childThreadId, input.nativeTurnId);
    if (!turn) throw new Error(`Codex child turn not found: ${input.nativeTurnId}`);
    if (isTerminalTurn(turn)) {
      return existing;
    }
    const item = {
      ...existing,
      payload: {
        ...existing.payload,
        message: { ...message, content },
        nativeItemId: input.nativeItemId,
        eventKey: input.eventKey,
      },
      updatedAt: new Date().toISOString(),
    };
    const executionId = this.operations.executionIdForTurn(turn.id);
    this.operations.commit({
      threadId: thread.id,
      turnId: turn.id,
      executionId,
      phase: "running",
      events: [this.operations.itemDraft(executionId, thread, turn, item, `${executionId}:item:${item.id}:${input.eventKey}:${hashCodexKey(content)}`)],
    });
    return item;
  }

  private streamedChildMessageContent(existing: AgentItem, input: CodexChildItemInput): string | undefined {
    if (
      (input.eventKey !== "stream" && input.eventKey !== "stream-complete")
      || !isRecord(existing.payload.message)
      || typeof existing.payload.message.content !== "string"
    ) return undefined;
    const inputMessage = childMessageSource(input.payload);
    if (typeof inputMessage.content !== "string") return undefined;
    if (typeof inputMessage.id === "string" && inputMessage.id !== existing.payload.message.id) return undefined;
    return input.eventKey === "stream-complete"
      ? inputMessage.content
      : `${existing.payload.message.content}${inputMessage.content}`;
  }

  private childItemEventKey(input: CodexChildItemInput): string {
    return input.kind === "message" && (input.eventKey === "stream" || input.eventKey === "stream-complete")
      ? "stream"
      : input.eventKey;
  }

  private matchesExistingChildPayload(existing: AgentItem, input: CodexChildItemInput): boolean {
    return JSON.stringify(existing.payload)
      === JSON.stringify({ ...input.payload, nativeItemId: input.nativeItemId, eventKey: input.eventKey });
  }

  private matchesExistingChildMessage(existing: AgentItem, input: CodexChildItemInput): boolean {
    const existingMessage = existing.payload.message;
    const inputMessage = childMessageSource(input.payload);
    return existing.payload.projection === "message"
      && input.payload.projection === "message"
      && isRecord(existingMessage)
      && existingMessage.content === inputMessage.content
      && (inputMessage.role ?? "assistant") === (existingMessage.role ?? "assistant");
  }

  private createChildItem(
    input: CodexChildItemInput,
    itemId: string,
    thread: AgentThread,
    turn: AgentTurn,
  ): AgentItem {
    const now = new Date().toISOString();
    const payload = input.kind === "message"
      ? this.normalizeChildMessagePayload(thread, input.payload)
      : input.payload;
    return {
      id: itemId,
      threadId: thread.id,
      turnId: turn.id,
      ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}),
      kind: input.kind,
      providerIdentities: turn.providerIdentities,
      payload: { ...payload, nativeItemId: input.nativeItemId, eventKey: input.eventKey },
      createdAt: now,
      updatedAt: now,
    };
  }

  private normalizeChildMessagePayload(
    thread: AgentThread,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const source = childMessageSource(payload);
    const sequence = this.childMessageSequence(thread.id, source);
    return {
      ...payload,
      projection: "message",
      message: {
        id: childMessageId(thread.id, sequence, source),
        thread_id: thread.id,
        role: childMessageRole(source),
        content: typeof source.content === "string" ? source.content : "",
        tool_calls: source.tool_calls ?? null,
        files_changed: source.files_changed ?? null,
        cost_usd: typeof source.cost_usd === "number" ? source.cost_usd : null,
        tokens_used: typeof source.tokens_used === "number" ? source.tokens_used : null,
        timestamp: typeof source.timestamp === "string" ? source.timestamp : new Date().toISOString(),
        sequence,
        attachments: source.attachments ?? null,
      },
    };
  }

  private childMessageSequence(threadId: string, source: Record<string, unknown>): number {
    const nextSequence = this.nextChildMessageSequence(threadId);
    return hasUsableChildMessageSequence(source.sequence, nextSequence)
      ? source.sequence
      : nextSequence;
  }

  private nextChildMessageSequence(childThreadId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_items
      WHERE thread_id = ?
        AND kind = 'message'
        AND json_extract(payload_json, '$.projection') = 'message'
    `).get(childThreadId) as { count: number };
    return Number(row.count);
  }

  private childItemConflict(itemId: string): Error {
    return new Error(`Codex child item identity conflict: ${itemId}`);
  }

  private childIdleThreadEvent(thread: AgentThread, executionId: string, endedAt: string) {
    return {
      eventId: `${executionId}:thread-idle`,
      routing: { threadId: thread.id, executionId },
      sourceProviderId: "codex",
      sourceIdentities: thread.providerIdentities,
      payload: { type: "thread.recorded" as const, thread: { ...thread, activityState: "Idle" as const, updatedAt: endedAt } },
    };
  }

  private childTerminalEvent(
    thread: AgentThread,
    turn: AgentTurn,
    executionId: string,
    outcome: CodexChildTurnFinishInput["outcome"],
    error: string | undefined,
    endedAt: string,
  ) {
    return {
      eventId: `${executionId}:turn-terminal`,
      routing: { threadId: thread.id, turnId: turn.id, executionId },
      sourceProviderId: "codex",
      sourceIdentities: thread.providerIdentities,
      payload: childTerminalPayload(outcome, error, endedAt),
    };
  }
}

function codexReceiverIdentity(nativeThreadId: string): ProviderIdentity {
  return {
    providerId: "codex",
    scope: "parentItem",
    value: `receiverThreadId:${nativeThreadId}`,
    provenance: "native",
  };
}

function hasNativeTurnIdentity(turn: AgentTurn, nativeTurnId: string): boolean {
  return turn.providerIdentities.some((identity) => (
    identity.providerId === "codex" && identity.scope === "turn" && identity.value === nativeTurnId
  ));
}

function isTerminalTurn(turn: AgentTurn): boolean {
  return ["Completed", "Cancelled", "Interrupted", "Errored"].includes(turn.status);
}

function childTerminalPayload(
  outcome: CodexChildTurnFinishInput["outcome"],
  error: string | undefined,
  endedAt: string,
): CanonicalAgentEvent {
  switch (outcome) {
    case "completed":
      return { type: "turn.completed", endedAt };
    case "cancelled":
      return { type: "turn.cancelled", endedAt, reason: error ?? "Child turn cancelled" };
    case "interrupted":
      return { type: "turn.interrupted", endedAt, reason: error ?? "Child turn interrupted" };
    case "errored":
      return { type: "turn.errored", endedAt, error: error ?? "Child turn failed" };
  }
}

function childMessageSource(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.message) ? payload.message : payload;
}

function childMessageRole(source: Record<string, unknown>): "user" | "assistant" | "system" {
  if (source.role === "user" || source.role === "assistant" || source.role === "system") {
    return source.role;
  }
  return "assistant";
}

function childMessageId(threadId: string, sequence: number, source: Record<string, unknown>): string {
  if (typeof source.id === "string" && source.id.length > 0) return source.id;
  const content = typeof source.content === "string" ? source.content : "";
  return `codex-child-message:${hashCodexKey(`${threadId}:${sequence}:${content}`)}`;
}

function hasUsableChildMessageSequence(value: unknown, nextSequence: number): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value >= nextSequence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexSpawnRecord(record: Record<string, unknown>): boolean {
  const input = record.tool_input;
  return isRecord(input) && input.codexCollabKind === "spawnAgent";
}

function hashCodexKey(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function deterministicUuid(value: string): string {
  const hash = NodeCrypto.createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function uniqueProviderIdentities(identities: readonly ProviderIdentity[]): ProviderIdentity[] {
  const result: ProviderIdentity[] = [];
  for (const identity of identities) {
    if (!result.some((candidate) => sameProviderIdentity(candidate, identity))) result.push(identity);
  }
  return result;
}

function sameProviderIdentity(left: ProviderIdentity, right: ProviderIdentity): boolean {
  return left.providerId === right.providerId
    && left.scope === right.scope
    && left.value === right.value;
}

function sameProviderIdentities(left: CollaborationAction, right: CollaborationAction): boolean {
  return JSON.stringify(left.providerIdentities) === JSON.stringify(right.providerIdentities);
}

function nativeThreadIdentity(nativeThreadId: string): ProviderIdentity {
  return { providerId: "codex", scope: "thread", value: nativeThreadId, provenance: "native" };
}

function acknowledgeAction(action: CollaborationAction, updatedAt = new Date().toISOString()): CollaborationAction {
  return { ...action, status: "Acknowledged", deliveryUnknown: false, updatedAt };
}

interface NormalizedDelegationInput {
  description: string | undefined;
  identity: string | undefined;
  model: string | undefined;
  reasoningEffort: string | undefined;
  prompt: string | undefined;
}

function normalizeDelegationInput(input: CodexChildDelegationInput): NormalizedDelegationInput {
  return {
    description: normalizeDelegationText(input.description),
    identity: resolveSubagentDisplayName({ agentName: input.identity }),
    model: resolveSubagentMetadata(input.model),
    reasoningEffort: resolveSubagentMetadata(input.reasoningEffort),
    prompt: normalizeDelegationText(input.prompt),
  };
}

function normalizeDelegationText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().slice(0, CANONICAL_SUBAGENT_TASK_MAX_LENGTH) || undefined;
}

function withDelegationMetadata(
  payload: Record<string, unknown>,
  normalized: NormalizedDelegationInput,
): Record<string, unknown> {
  const storesDescription = payload.projection !== "narrativeRecovery";
  return {
    ...payload,
    ...(storesDescription && normalized.description !== undefined
      ? { description: normalized.description }
      : {}),
    ...(normalized.identity !== undefined ? { identity: normalized.identity } : {}),
    ...(normalized.model !== undefined ? { model: normalized.model } : {}),
    ...(normalized.reasoningEffort !== undefined ? { reasoningEffort: normalized.reasoningEffort } : {}),
  };
}

function parentItemMetadataEventId(
  input: CodexChildDelegationInput,
  normalized: NormalizedDelegationInput,
  previousUpdatedAt: string,
  providerIdentities: readonly ProviderIdentity[],
): string {
  const metadataKey = hashCodexKey(JSON.stringify({
    previousUpdatedAt,
    description: normalized.description,
    identity: normalized.identity,
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort,
    prompt: normalized.prompt,
    providerIdentities: [...providerIdentities],
  }));
  return `${input.parentExecutionId}:codex-child:${hashCodexKey(input.parentItemId)}:metadata:${metadataKey}`;
}

function newChildThread(parentThread: AgentThread, now: string): AgentThread {
  return {
    id: `thread:codex-child:${NodeCrypto.randomUUID()}`,
    workspaceId: parentThread.workspaceId,
    parentThreadId: parentThread.id,
    rootThreadId: parentThread.rootThreadId,
    owningParentThreadId: parentThread.owningParentThreadId ?? parentThread.id,
    providerId: "codex",
    providerIdentities: [],
    activityState: "Starting",
    conversationRevision: 0,
    rosterRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function newDelegationParentItem(
  input: CodexChildDelegationInput,
  normalized: NormalizedDelegationInput,
  parentThread: AgentThread,
  parentTurn: AgentTurn,
  childThread: AgentThread,
  now: string,
): AgentItem {
  const receiverThreadIds = uniqueReceiverThreadIds(input.receiverThreadIds);
  return {
    id: input.parentItemId,
    threadId: parentThread.id,
    turnId: parentTurn.id,
    kind: "tool-call",
    providerIdentities: [...input.providerIdentities],
    payload: {
      projection: "codexSubagent",
      toolName: "Agent",
      childThreadId: childThread.id,
      receiverThreadIds,
      ...(input.replacementForActionId ? { replacementForActionId: input.replacementForActionId } : {}),
      ...(normalized.description !== undefined ? { description: normalized.description } : {}),
      ...(normalized.identity !== undefined ? { identity: normalized.identity } : {}),
      ...(normalized.model !== undefined ? { model: normalized.model } : {}),
      ...(normalized.reasoningEffort !== undefined ? { reasoningEffort: normalized.reasoningEffort } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function newDelegationAction(
  input: CodexChildDelegationInput,
  normalized: NormalizedDelegationInput,
  parentThread: AgentThread,
  parentItem: AgentItem,
  childThread: AgentThread,
  now: string,
): CollaborationAction {
  const receiverIdentities = uniqueReceiverThreadIds(input.receiverThreadIds).map(codexReceiverIdentity);
  return {
    id: `collaboration:codex:${hashCodexKey(`${parentThread.id}:${input.parentItemId}`)}`,
    kind: "delegate",
    source: { threadId: parentThread.id, turnId: parentItem.turnId, itemId: parentItem.id },
    target: { threadId: childThread.id },
    status: "Dispatched",
    deliveryUnknown: false,
    ...(normalized.prompt ? { message: normalized.prompt } : {}),
    providerIdentities: uniqueProviderIdentities([...input.providerIdentities, ...receiverIdentities]),
    createdAt: now,
    updatedAt: now,
  };
}

function uniqueReceiverThreadIds(receiverThreadIds: readonly string[] | undefined): string[] {
  return [...new Set(receiverThreadIds ?? [])].filter(Boolean);
}

function newChildPromptMessage(
  turnId: string,
  threadId: string,
  prompt: string,
  now: string,
  sequence: number,
  action: CollaborationAction,
): Record<string, unknown> {
  return {
    id: `codex-child-prompt:${hashCodexKey(turnId)}`,
    role: "user",
    content: prompt,
    thread_id: threadId,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: now,
    sequence,
    attachments: null,
    parentAgentProvenance: {
      parentThreadId: action.source.threadId,
      parentTurnId: action.source.turnId,
      parentItemId: action.source.itemId,
      providerIdentities: action.providerIdentities,
    },
  };
}

function childTurnIdentities(thread: AgentThread, nativeTurnId: string): ProviderIdentity[] {
  return [
    ...thread.providerIdentities,
    { providerId: "codex", scope: "turn", value: nativeTurnId, provenance: "native" },
  ];
}

function newChildTurn(
  turnId: string,
  threadId: string,
  action: CollaborationAction,
  providerIdentities: readonly ProviderIdentity[],
  now: string,
): AgentTurn {
  return {
    id: turnId,
    threadId,
    status: "Pending",
    trigger: {
      kind: "child",
      sourceThreadId: action.source.threadId,
      sourceTurnId: action.source.turnId,
      sourceItemId: action.source.itemId,
    },
    permissionMode: "full",
    approvalReviewMode: "manual",
    approvalReviewReason: "manual-requested",
    providerIdentities: [...providerIdentities],
    startedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function childTurnStartEvents(
  turn: AgentTurn,
  thread: AgentThread,
  identities: readonly ProviderIdentity[],
  promptItem: AgentItem | undefined,
  executionId: string,
  operations: CanonicalCodexCollaborationOperations,
): CanonicalAgentEventDraft[] {
  const events: CanonicalAgentEventDraft[] = [
    {
      eventId: `${executionId}:thread-active`,
      routing: { threadId: thread.id, executionId },
      sourceProviderId: "codex",
      sourceIdentities: identities,
      payload: { type: "thread.recorded", thread: { ...thread, activityState: "Active", updatedAt: turn.createdAt } },
    },
    {
      eventId: `${executionId}:turn-created`,
      routing: { threadId: thread.id, turnId: turn.id, executionId },
      sourceProviderId: "codex",
      sourceIdentities: identities,
      payload: { type: "turn.created", turn },
    },
    {
      eventId: `${executionId}:turn-started`,
      routing: { threadId: thread.id, turnId: turn.id, executionId },
      sourceProviderId: "codex",
      sourceIdentities: identities,
      payload: { type: "turn.started", startedAt: turn.createdAt },
    },
  ];
  if (promptItem) events.push(operations.itemDraft(executionId, thread, turn, promptItem));
  return events;
}

function routingFailureItemId(turnId: string, input: CodexChildRoutingDiagnosticInput): string {
  return `item:codex-child-routing-failure:${hashCodexKey(`${turnId}:${input.parentItemId ?? ""}:${input.reason}`)}`;
}

function newRoutingFailureItem(
  itemId: string,
  thread: AgentThread,
  turn: AgentTurn,
  input: CodexChildRoutingDiagnosticInput,
): AgentItem {
  const now = new Date().toISOString();
  return {
    id: itemId,
    threadId: thread.id,
    turnId: turn.id,
    ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}),
    kind: "error",
    providerIdentities: thread.providerIdentities,
    payload: {
      projection: "codexChildRoutingFailure",
      status: "action-required",
      recovery: "retry-child-routing",
      reason: input.reason,
      ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
}
