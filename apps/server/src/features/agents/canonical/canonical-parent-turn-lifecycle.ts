import type Database from "better-sqlite3";
import type {
  AgentThread,
  AgentTurn,
  CollaborationAction,
  Message,
  ParentNarrativeRecoveryItem,
  ProviderIdentity,
} from "@mcode/contracts";
import type {
  CanonicalAgentCheckpoint,
  CanonicalAgentCommitInput,
  CanonicalAgentCommitResult,
  CanonicalAgentEventDraft,
  CanonicalProviderContinuationInput,
  CanonicalParentTurnFinishInput,
  CanonicalParentTurnProjection,
} from "./canonical-agent-event-sink.js";

/** Input for starting one user-triggered parent execution. */
export interface CanonicalParentTurnStartInput {
  thread: {
    id: string;
    workspaceId: string;
    providerId: string;
    createdAt: string;
  };
  turnId: string;
  executionId: string;
  permissionMode: "supervised" | "full";
  providerIdentities: readonly ProviderIdentity[];
  retryOfExecutionId?: string;
  projectUserMessage: () => Message;
}

/** Durable operations required by the parent-turn lifecycle. */
export interface CanonicalParentTurnLifecycleOperations {
  commit(input: CanonicalAgentCommitInput): CanonicalAgentCommitResult;
  parentTurnStartEvents(
    input: CanonicalParentTurnStartInput,
    userMessage: Message,
    startedAt: string,
  ): CanonicalAgentEventDraft[];
  parentTurnTerminalEvents(
    input: CanonicalParentTurnFinishInput,
    projection: CanonicalParentTurnProjection | null,
    endedAt: string,
  ): CanonicalAgentEventDraft[];
  cacheExecution(executionId: string, turnId: string): void;
  loadTurn(turnId: string): AgentTurn | null;
  loadCollaborationAction(actionId: string): CollaborationAction | null;
  uniqueProviderIdentities(identities: readonly ProviderIdentity[]): ProviderIdentity[];
  executionIdForTurn(turnId: string): string;
  actionAcknowledgementDraft(
    executionId: string,
    thread: AgentThread,
    action: CollaborationAction,
  ): CanonicalAgentEventDraft;
  commitContinuation(input: {
    source: CanonicalAgentCommitInput;
    parent: CanonicalAgentCommitInput;
  }): { source: CanonicalAgentCommitResult; parent: CanonicalAgentCommitResult };
  loadCheckpoint(executionId: string): CanonicalAgentCheckpoint | null;
  loadTurnByExecution(executionId: string): AgentTurn | null;
  loadThread(threadId: string): AgentThread | null;
  loadTerminalProjection(turnId: string): { message: Message | null };
  interruptedNarrativeEvents(input: {
    checkpoint: CanonicalAgentCheckpoint;
    thread: AgentThread;
    executionId: string;
    narrative: readonly ParentNarrativeRecoveryItem[];
    endedAt: string;
  }): CanonicalAgentEventDraft[];
}

/** Inputs for recovering one execution that was unfinished at restart. */
export interface CanonicalParentTurnInterruptionInput {
  executionId: string;
  reason: string;
  stagedAssistant?: Message;
  finalizeCompatibility?: (
    assistant: Message,
    narrative: readonly ParentNarrativeRecoveryItem[],
  ) => void;
  recoveredNarrative?: readonly ParentNarrativeRecoveryItem[];
}

/** Coordinates start and terminal decisions for one parent execution. */
export class CanonicalParentTurnLifecycle {
  constructor(
    private readonly db: Database.Database,
    private readonly operations: CanonicalParentTurnLifecycleOperations,
  ) {}

  /** Starts one parent execution and atomically projects its user message. */
  start(input: CanonicalParentTurnStartInput): CanonicalAgentCommitResult {
    let userMessage: Message | null = null;
    const startedAt = new Date().toISOString();
    const result = this.operations.commit({
      threadId: input.thread.id,
      turnId: input.turnId,
      executionId: input.executionId,
      phase: "running",
      nativeCursor: input.providerIdentities.find((identity) => identity.provenance === "native"),
      replayGuard: "execution-started",
      projectCompatibility: () => {
        this.consumeRetry(input.retryOfExecutionId, startedAt);
        userMessage = input.projectUserMessage();
      },
      events: () => {
        if (!userMessage) throw new Error("Canonical user-message projection did not produce a row");
        return this.operations.parentTurnStartEvents(input, userMessage, startedAt);
      },
    });
    this.operations.cacheExecution(input.executionId, input.turnId);
    return result;
  }

  /** Commits the first terminal decision with its canonical and compatibility projections. */
  finish(input: CanonicalParentTurnFinishInput): CanonicalAgentCommitResult {
    let projection: CanonicalParentTurnProjection | null = null;
    const endedAt = new Date().toISOString();
    return this.operations.commit({
      threadId: input.threadId,
      turnId: input.turnId,
      executionId: input.executionId,
      phase: input.outcome,
      terminalOutcome: input.outcome,
      error: input.error,
      nativeCursor: input.providerIdentities.find((identity) => identity.provenance === "native"),
      replayGuard: "terminal-confirmed",
      projectCompatibility: () => {
        projection = input.projectTurn();
      },
      events: () => this.operations.parentTurnTerminalEvents(input, projection, endedAt),
    });
  }

  /** Interrupts only an execution that has no durable terminal decision. */
  interrupt(input: CanonicalParentTurnInterruptionInput): CanonicalAgentCommitResult {
    const context = this.unfinishedContext(input.executionId);
    this.assertStagedAssistant(input.stagedAssistant, context.checkpoint, input.executionId);
    const endedAt = new Date().toISOString();
    const recoveryProjection = this.recoveryProjection(
      input.stagedAssistant ?? this.operations.loadTerminalProjection(context.checkpoint.turnId).message,
      input.executionId,
    );
    const narrative = this.recoveredNarrative(
      input.recoveredNarrative ?? [],
      recoveryProjection,
      endedAt,
      input.executionId,
    );
    return this.operations.commit(this.interruptionCommit(
      input,
      context,
      recoveryProjection,
      narrative,
      endedAt,
    ));
  }

  /** Starts a parent execution that a child provider explicitly continued. */
  continue(input: CanonicalProviderContinuationInput): AgentTurn {
    const context = this.continuationContext(input);
    const existing = this.operations.loadTurnByExecution(input.executionId);
    if (existing) return existing;
    const started = this.continuationTurn(input, context);
    const committed = this.operations.commitContinuation(this.continuationCommit(input, context, started));
    const duplicate = committed.parent.outcome === "duplicate" ? this.operations.loadTurn(input.turnId) : null;
    if (duplicate) return duplicate;
    this.operations.cacheExecution(input.executionId, input.turnId);
    const persisted = this.operations.loadTurn(input.turnId);
    if (!persisted) throw new Error(`Provider continuation turn was not persisted: ${input.turnId}`);
    return persisted;
  }

  private continuationContext(input: CanonicalProviderContinuationInput): {
    parentThread: AgentThread;
    sourceThread: AgentThread;
    action: CollaborationAction;
    sourceIdentities: ProviderIdentity[];
    startedAt: string;
  } {
    const parentThread = this.operations.loadThread(input.parentThreadId);
    if (!parentThread) throw new Error(`Canonical parent thread not found: ${input.parentThreadId}`);
    const action = this.operations.loadCollaborationAction(input.triggerActionId);
    if (!action || action.target.threadId !== parentThread.id) {
      throw new Error(`Provider continuation action does not target parent: ${input.triggerActionId}`);
    }
    const sourceTurn = this.operations.loadTurn(action.source.turnId);
    if (!sourceTurn || sourceTurn.threadId !== action.source.threadId) {
      throw new Error(`Provider continuation source turn is not canonical: ${action.source.turnId}`);
    }
    const sourceThread = this.operations.loadThread(action.source.threadId);
    if (!sourceThread) throw new Error(`Provider continuation source thread not found: ${action.source.threadId}`);
    const sourceIdentities = input.providerIdentities.length > 0
      ? this.operations.uniqueProviderIdentities(input.providerIdentities)
      : parentThread.providerIdentities;
    return { parentThread, sourceThread, action, sourceIdentities, startedAt: new Date().toISOString() };
  }

  private continuationTurn(
    input: CanonicalProviderContinuationInput,
    context: { action: CollaborationAction; parentThread: AgentThread; sourceIdentities: ProviderIdentity[]; startedAt: string },
  ): AgentTurn {
    return {
      id: input.turnId,
      threadId: context.parentThread.id,
      status: "Pending",
      trigger: {
        kind: "child",
        sourceThreadId: context.action.source.threadId,
        sourceTurnId: context.action.source.turnId,
        sourceItemId: context.action.source.itemId,
      },
      permissionMode: input.permissionMode,
      providerIdentities: context.sourceIdentities,
      startedAt: null,
      endedAt: null,
      createdAt: context.startedAt,
      updatedAt: context.startedAt,
    };
  }

  private continuationCommit(
    input: CanonicalProviderContinuationInput,
    context: {
      parentThread: AgentThread;
      sourceThread: AgentThread;
      action: CollaborationAction;
      sourceIdentities: ProviderIdentity[];
      startedAt: string;
    },
    turn: AgentTurn,
  ): { source: CanonicalAgentCommitInput; parent: CanonicalAgentCommitInput } {
    const acknowledgedAction: CollaborationAction = {
      ...context.action,
      target: { threadId: context.parentThread.id, turnId: turn.id },
      status: "Acknowledged",
      updatedAt: context.startedAt,
    };
    const parent = {
      ...context.parentThread,
      activityState: "Active" as const,
      providerIdentities: context.sourceIdentities,
      updatedAt: context.startedAt,
    };
    const routing = { threadId: parent.id, turnId: turn.id, executionId: input.executionId };
    return {
      source: {
        threadId: context.sourceThread.id,
        turnId: context.action.source.turnId,
        executionId: this.operations.executionIdForTurn(context.action.source.turnId),
        phase: "running",
        events: [this.operations.actionAcknowledgementDraft(
          this.operations.executionIdForTurn(context.action.source.turnId),
          context.sourceThread,
          acknowledgedAction,
        )],
      },
      parent: {
        threadId: parent.id,
        turnId: turn.id,
        executionId: input.executionId,
        phase: "running",
        replayGuard: "execution-started",
        events: [
          {
            eventId: `${input.executionId}:thread`,
            routing: { threadId: parent.id, executionId: input.executionId },
            sourceProviderId: parent.providerId,
            sourceIdentities: context.sourceIdentities,
            payload: { type: "thread.recorded", thread: parent },
          },
          {
            eventId: `${input.executionId}:turn-created`,
            routing,
            sourceProviderId: parent.providerId,
            sourceIdentities: context.sourceIdentities,
            payload: { type: "turn.created", turn },
          },
          {
            eventId: `${input.executionId}:turn-started`,
            routing,
            sourceProviderId: parent.providerId,
            sourceIdentities: context.sourceIdentities,
            payload: { type: "turn.started", startedAt: context.startedAt },
          },
        ],
      },
    };
  }

  private unfinishedContext(executionId: string): {
    checkpoint: CanonicalAgentCheckpoint;
    thread: AgentThread;
  } {
    const checkpoint = this.operations.loadCheckpoint(executionId);
    const turn = this.operations.loadTurnByExecution(executionId);
    if (!checkpoint || !turn) throw new Error(`Canonical execution not found: ${executionId}`);
    if (checkpoint.terminalOutcome || !["Pending", "Running"].includes(turn.status)) {
      throw new Error(`Canonical execution is not unfinished: ${executionId}`);
    }
    const thread = this.operations.loadThread(checkpoint.threadId);
    if (!thread) throw new Error(`Canonical thread not found: ${checkpoint.threadId}`);
    return { checkpoint, thread };
  }

  private assertStagedAssistant(
    assistant: Message | undefined,
    checkpoint: CanonicalAgentCheckpoint,
    executionId: string,
  ): void {
    if (!assistant) return;
    if (assistant.thread_id === checkpoint.threadId && assistant.role === "assistant") return;
    throw new Error(`Recovered assistant projection does not belong to execution: ${executionId}`);
  }

  private recoveryProjection(assistant: Message | null, executionId: string): Message | null {
    if (!assistant) return null;
    return {
      ...assistant,
      is_internal: false,
      outcome: "interrupted",
      outcomeExecutionId: executionId,
    };
  }

  private recoveredNarrative(
    recoveredNarrative: readonly ParentNarrativeRecoveryItem[],
    assistant: Message | null,
    endedAt: string,
    executionId: string,
  ): ParentNarrativeRecoveryItem[] {
    if (recoveredNarrative.length === 0) return [];
    if (!assistant) throw new Error(`Recovered narrative has no assistant projection: ${executionId}`);
    return this.reconcileInterruptedNarrative(recoveredNarrative, assistant.id, endedAt);
  }

  private interruptionCommit(
    input: CanonicalParentTurnInterruptionInput,
    context: { checkpoint: CanonicalAgentCheckpoint; thread: AgentThread },
    assistant: Message | null,
    narrative: readonly ParentNarrativeRecoveryItem[],
    endedAt: string,
  ): CanonicalAgentCommitInput {
    return {
      threadId: context.checkpoint.threadId,
      turnId: context.checkpoint.turnId,
      executionId: input.executionId,
      phase: "interrupted",
      terminalOutcome: "interrupted",
      error: input.reason,
      nativeCursor: context.checkpoint.nativeCursor ?? undefined,
      projectCompatibility: () => this.projectInterruption(
        input,
        assistant,
        narrative,
      ),
      events: () => this.interruptionEvents(input.reason, context, assistant, narrative, endedAt),
    };
  }

  private projectInterruption(
    input: CanonicalParentTurnInterruptionInput,
    assistant: Message | null,
    narrative: readonly ParentNarrativeRecoveryItem[],
  ): void {
    if (!assistant) return;
    const updated = this.db.prepare(`
      UPDATE messages
      SET is_internal = 0, outcome = ?, outcome_execution_id = ?
      WHERE id = ? AND role = 'assistant'
    `).run("interrupted", input.executionId, assistant.id);
    if (input.stagedAssistant && updated.changes !== 1) {
      throw new Error(`Recovered assistant message was not staged: ${assistant.id}`);
    }
    input.finalizeCompatibility?.(assistant, narrative);
  }

  private interruptionEvents(
    reason: string,
    context: { checkpoint: CanonicalAgentCheckpoint; thread: AgentThread },
    assistant: Message | null,
    narrative: readonly ParentNarrativeRecoveryItem[],
    endedAt: string,
  ): CanonicalAgentEventDraft[] {
    const { checkpoint, thread } = context;
    return [
      this.idleEvent(checkpoint, thread, endedAt),
      ...this.assistantEvent(checkpoint, thread, assistant, endedAt),
      ...this.operations.interruptedNarrativeEvents({
        checkpoint,
        thread,
        executionId: checkpoint.executionId,
        narrative,
        endedAt,
      }),
      this.interruptedEvent(checkpoint, thread, reason, endedAt),
    ];
  }

  private idleEvent(
    checkpoint: CanonicalAgentCheckpoint,
    thread: AgentThread,
    endedAt: string,
  ): CanonicalAgentEventDraft {
    return {
      eventId: `${checkpoint.executionId}:recovery-thread-idle`,
      routing: { threadId: checkpoint.threadId, executionId: checkpoint.executionId },
      sourceProviderId: thread.providerId,
      sourceIdentities: thread.providerIdentities,
      payload: {
        type: "thread.recorded",
        thread: { ...thread, activityState: "Idle", updatedAt: endedAt },
      },
    };
  }

  private assistantEvent(
    checkpoint: CanonicalAgentCheckpoint,
    thread: AgentThread,
    assistant: Message | null,
    endedAt: string,
  ): CanonicalAgentEventDraft[] {
    if (!assistant) return [];
    return [{
      eventId: `${checkpoint.executionId}:recovery-assistant-outcome:${assistant.id}`,
      routing: {
        threadId: checkpoint.threadId,
        turnId: checkpoint.turnId,
        executionId: checkpoint.executionId,
        itemId: `message:${assistant.id}`,
      },
      sourceProviderId: thread.providerId,
      sourceIdentities: thread.providerIdentities,
      payload: {
        type: "item.recorded",
        item: {
          id: `message:${assistant.id}`,
          threadId: checkpoint.threadId,
          turnId: checkpoint.turnId,
          kind: "message",
          providerIdentities: thread.providerIdentities,
          payload: { projection: "message", message: assistant },
          createdAt: assistant.timestamp,
          updatedAt: endedAt,
        },
      },
    }];
  }

  private interruptedEvent(
    checkpoint: CanonicalAgentCheckpoint,
    thread: AgentThread,
    reason: string,
    endedAt: string,
  ): CanonicalAgentEventDraft {
    return {
      eventId: `${checkpoint.executionId}:recovery-interrupted`,
      routing: {
        threadId: checkpoint.threadId,
        turnId: checkpoint.turnId,
        executionId: checkpoint.executionId,
      },
      sourceProviderId: thread.providerId,
      sourceIdentities: thread.providerIdentities,
      payload: { type: "turn.interrupted", endedAt, reason },
    };
  }

  private reconcileInterruptedNarrative(
    items: readonly ParentNarrativeRecoveryItem[],
    messageId: string,
    endedAt: string,
  ): ParentNarrativeRecoveryItem[] {
    return items.map((item) => this.reconciledNarrativeItem(item, messageId, endedAt));
  }

  private reconciledNarrativeItem(
    item: ParentNarrativeRecoveryItem,
    messageId: string,
    endedAt: string,
  ): ParentNarrativeRecoveryItem {
    if (item.kind === "toolCall") return this.reconciledToolCall(item, messageId, endedAt);
    if (item.kind === "hook") return this.reconciledHook(item, messageId, endedAt);
    return { kind: "narrationSegment", record: { ...item.record, message_id: messageId } };
  }

  private reconciledToolCall(
    item: Extract<ParentNarrativeRecoveryItem, { kind: "toolCall" }>,
    messageId: string,
    endedAt: string,
  ): ParentNarrativeRecoveryItem {
    return {
      kind: "toolCall",
      record: {
        ...item.record,
        message_id: messageId,
        ...(item.record.status === "running" ? { status: "failed", completed_at: endedAt } : {}),
      },
    };
  }

  private reconciledHook(
    item: Extract<ParentNarrativeRecoveryItem, { kind: "hook" }>,
    messageId: string,
    endedAt: string,
  ): ParentNarrativeRecoveryItem {
    const durationMs = item.record.ended_at
      ? item.record.duration_ms
      : Math.max(0, Date.parse(endedAt) - Date.parse(item.record.started_at));
    return {
      kind: "hook",
      record: {
        ...item.record,
        message_id: messageId,
        duration_ms: durationMs,
        ended_at: item.record.ended_at ?? endedAt,
      },
    };
  }

  private consumeRetry(retryOfExecutionId: string | undefined, updatedAt: string): void {
    if (!retryOfExecutionId) return;
    const consumed = this.db.prepare(`
      UPDATE canonical_agent_ingest_checkpoints
      SET phase = 'retried', updated_at = ?
      WHERE execution_id = ?
        AND phase IN ('interrupted', 'errored')
        AND terminal_outcome IN ('interrupted', 'errored')
    `).run(updatedAt, retryOfExecutionId);
    if (consumed.changes !== 1) throw new Error(`Interrupted execution not found: ${retryOfExecutionId}`);
  }
}
