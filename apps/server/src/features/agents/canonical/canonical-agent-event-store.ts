import type Database from "better-sqlite3";
import {
  CanonicalAgentEventEnvelopeSchema,
  reduceAgentEventBatch,
  type AgentModelState,
  type AgentThread,
  type CanonicalAgentEventEnvelope,
  type TurnOutcome,
} from "@mcode/contracts";
import type {
  CanonicalAgentCommitResult,
  CanonicalAgentEventDraft,
} from "./canonical-agent-event-sink.js";
import { decideCanonicalExecutionLifecycle } from "./canonical-execution-lifecycle.js";

/** Provider-neutral durable progress for one canonical execution. */
export interface CanonicalAgentEventStoreCheckpoint {
  executionId: string;
  threadId: string;
  turnId: string;
  lastAcceptedSequence: number;
  lastDurableSequence: number;
  recoveryCursor: unknown | null;
  phase: string;
  terminalOutcome: TurnOutcome | null;
  error: string | null;
  updatedAt: string;
}

/** One canonical batch expressed without provider transport details. */
export interface CanonicalAgentEventStoreInput {
  threadId: string;
  turnId: string;
  executionId: string;
  phase: string;
  terminalOutcome?: TurnOutcome;
  error?: string;
  recoveryCursor?: unknown;
  events: readonly CanonicalAgentEventDraft[] | (() => readonly CanonicalAgentEventDraft[]);
  projectCompatibility?: () => void;
  replayGuard?: "execution-started" | "terminal-confirmed";
  onOverflow?: () => void;
  persistCheckpoint?: boolean;
}

/** Operations supplied by the owner of canonical state and compatibility projection. */
export interface CanonicalAgentEventStoreOperations {
  loadThread(threadId: string): AgentThread | null;
  loadCheckpoint(executionId: string): CanonicalAgentEventStoreCheckpoint | null;
  loadState(threadId: string, executionId: string): AgentModelState;
  boundEvents(
    input: CanonicalAgentEventStoreInput,
    events: readonly CanonicalAgentEventDraft[],
    checkpoint: CanonicalAgentEventStoreCheckpoint | null,
  ): readonly CanonicalAgentEventDraft[];
  createEnvelope(
    draft: CanonicalAgentEventDraft,
    acceptedSequence: number,
    durableRevision: number,
    timestamp: string,
  ): CanonicalAgentEventEnvelope;
  assertDuplicate(draft: CanonicalAgentEventDraft, stored: CanonicalAgentEventEnvelope): void;
  applyEvents(
    state: AgentModelState,
    events: readonly CanonicalAgentEventEnvelope[],
  ): readonly { event: CanonicalAgentEventEnvelope; outcome: string }[];
  persistState(
    state: AgentModelState,
    threadId: string,
    turnId: string,
    executionId: string,
    conversationChanged: boolean,
    events: readonly CanonicalAgentEventEnvelope[],
  ): void;
  insertEvent(event: CanonicalAgentEventEnvelope): void;
  persistCheckpoint(checkpoint: CanonicalAgentEventStoreCheckpoint): void;
  recover(input: CanonicalAgentEventStoreInput, error: unknown): CanonicalAgentCommitResult | null;
  record(events: CanonicalAgentCommitResult["events"]): void;
  publish(result: CanonicalAgentCommitResult): CanonicalAgentCommitResult;
}

interface CommitContext {
  thread: AgentThread | null;
  checkpoint: CanonicalAgentEventStoreCheckpoint | null;
}

/** Commits canonical state atomically, then separates durable state from publication. */
export class CanonicalAgentEventStore {
  constructor(
    private readonly db: Database.Database,
    private readonly operations: CanonicalAgentEventStoreOperations,
  ) {}

  /** Applies one semantic batch in a SQLite transaction and publishes only after it commits. */
  commit(input: CanonicalAgentEventStoreInput): CanonicalAgentCommitResult {
    const transaction = this.db.transaction(() => this.applyWithinTransaction(input));
    let result: CanonicalAgentCommitResult;
    try {
      result = transaction();
    } catch (error) {
      const recovered = this.operations.recover(input, error);
      if (!recovered) throw error;
      result = recovered;
    }
    this.operations.record(result.events);
    return this.operations.publish(result);
  }

  /** Applies a semantic batch inside an already-open transaction without publication. */
  applyWithinTransaction(input: CanonicalAgentEventStoreInput): CanonicalAgentCommitResult {
    const context = this.commitContext(input);
    const replayed = this.replayed(input, context);
    if (replayed) return replayed;
    const drafts = this.eventDrafts(input, context.checkpoint);
    const existing = this.existingEvents(drafts);
    const newDrafts = drafts.filter((draft) => !existing.has(draft.eventId));
    if (newDrafts.length === 0) return this.duplicateResult(context.thread, context.checkpoint);
    return this.persistNewEvents(input, context, newDrafts);
  }

  private commitContext(input: CanonicalAgentEventStoreInput): CommitContext {
    const thread = this.operations.loadThread(input.threadId);
    const checkpoint = this.operations.loadCheckpoint(input.executionId);
    return { thread, checkpoint };
  }

  private eventDrafts(
    input: CanonicalAgentEventStoreInput,
    checkpoint: CanonicalAgentEventStoreCheckpoint | null,
  ): readonly CanonicalAgentEventDraft[] {
    input.projectCompatibility?.();
    const drafts = typeof input.events === "function" ? input.events() : input.events;
    if (drafts.length === 0) throw new Error("Canonical semantic batch must contain at least one event");
    const bounded = this.operations.boundEvents(input, drafts, checkpoint);
    this.assertBatchRouting(bounded, input);
    return bounded;
  }

  private replayed(
    input: CanonicalAgentEventStoreInput,
    context: CommitContext,
  ): CanonicalAgentCommitResult | null {
    const decision = decideCanonicalExecutionLifecycle(
      {
        exists: context.checkpoint !== null,
        terminalOutcome: context.checkpoint?.terminalOutcome ?? null,
      },
      input,
    );
    return decision === "accept"
      ? null
      : this.replayedResult(context.thread, context.checkpoint, decision, input.replayGuard);
  }

  private persistNewEvents(
    input: CanonicalAgentEventStoreInput,
    context: CommitContext,
    newDrafts: readonly CanonicalAgentEventDraft[],
  ): CanonicalAgentCommitResult {
    const state = this.operations.loadState(input.threadId, input.executionId);
    const acceptedAt = new Date().toISOString();
    const candidateRevision = (context.thread?.conversationRevision ?? 0) + 1;
    let acceptedSequence = context.checkpoint?.lastAcceptedSequence ?? 0;
    let envelopes = newDrafts.map((draft) => {
      acceptedSequence += 1;
      return this.operations.createEnvelope(draft, acceptedSequence, candidateRevision, acceptedAt);
    });
    let reduction = this.requireAppliedReduction(state, envelopes);

    const conversationChanged = reduction.appliedCount > 0;
    const durableRevision = conversationChanged ? candidateRevision : context.thread?.conversationRevision ?? 0;
    if (durableRevision !== candidateRevision) {
      envelopes = envelopes.map((event) => ({ ...event, durableRevision }));
      reduction = this.requireAppliedReduction(state, envelopes);
    }
    const applications = this.operations.applyEvents(state, envelopes);
    const nextState = this.withConversationRevision(
      reduction.state,
      input.threadId,
      durableRevision,
      acceptedAt,
      conversationChanged,
    );
    this.operations.persistState(nextState, input.threadId, input.turnId, input.executionId, conversationChanged, envelopes);
    for (const event of envelopes) this.operations.insertEvent(event);
    this.persistCheckpoint(input, context.checkpoint, acceptedSequence, acceptedAt);
    return this.committedResult(nextState, input.threadId, context.thread, durableRevision, acceptedSequence, applications, conversationChanged);
  }

  private requireAppliedReduction(state: AgentModelState, events: readonly CanonicalAgentEventEnvelope[]) {
    const reduction = reduceAgentEventBatch(state, events);
    if (reduction.outcome === "rejected") throw new Error(`Canonical event ${reduction.eventId} rejected: ${reduction.reason}`);
    return reduction;
  }

  private committedResult(
    state: AgentModelState,
    threadId: string,
    priorThread: AgentThread | null,
    revision: number,
    sequence: number,
    applications: readonly { event: CanonicalAgentEventEnvelope; outcome: string }[],
    changed: boolean,
  ): CanonicalAgentCommitResult {
    const thread = state.threads[threadId] ?? priorThread;
    const ignoredTerminal = applications.some((entry) => entry.outcome === "terminal-outcome-confirmed");
    return {
      outcome: !changed && ignoredTerminal ? "terminal-outcome-confirmed" : "committed",
      conversationRevision: thread?.conversationRevision ?? revision,
      rosterRevision: thread?.rosterRevision ?? 0,
      acceptedThrough: sequence,
      durableThrough: sequence,
      events: applications.filter((entry) => entry.outcome === "applied").map((entry) => entry.event),
    };
  }

  private replayedResult(
    thread: AgentThread | null,
    checkpoint: CanonicalAgentEventStoreCheckpoint | null,
    decision: "duplicate" | "conflict",
    replayGuard: CanonicalAgentEventStoreInput["replayGuard"],
  ): CanonicalAgentCommitResult {
    const progress = this.replayProgress(checkpoint);
    const revisions = this.replayRevisions(thread);
    return {
      outcome: this.replayOutcome(decision, replayGuard, this.replayTerminalOutcome(checkpoint)),
      ...revisions,
      ...progress,
      events: [],
    };
  }

  private duplicateResult(
    thread: AgentThread | null,
    checkpoint: CanonicalAgentEventStoreCheckpoint | null,
  ): CanonicalAgentCommitResult {
    const acceptedThrough = checkpoint?.lastAcceptedSequence ?? 0;
    return {
      outcome: "duplicate",
      conversationRevision: thread?.conversationRevision ?? 0,
      rosterRevision: thread?.rosterRevision ?? 0,
      acceptedThrough,
      durableThrough: checkpoint?.lastDurableSequence ?? acceptedThrough,
      events: [],
    };
  }

  private assertBatchRouting(events: readonly CanonicalAgentEventDraft[], input: CanonicalAgentEventStoreInput): void {
    if (events.some((event) => event.routing.executionId !== input.executionId)) {
      throw new Error("Canonical semantic batch contains another execution identity");
    }
    if (events.some((event) => event.routing.threadId !== input.threadId)) {
      throw new Error("Canonical semantic batch contains another thread identity");
    }
  }

  private existingEvents(events: readonly CanonicalAgentEventDraft[]): ReadonlySet<string> {
    const existing = new Set<string>();
    for (const draft of events) {
      const row = this.db.prepare("SELECT envelope_json FROM canonical_agent_events WHERE event_id = ?")
        .get(draft.eventId) as { envelope_json: string } | undefined;
      if (!row) continue;
      this.operations.assertDuplicate(draft, CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelope_json)));
      existing.add(draft.eventId);
    }
    return existing;
  }

  private withConversationRevision(
    state: AgentModelState,
    threadId: string,
    revision: number,
    updatedAt: string,
    changed: boolean,
  ): AgentModelState {
    const thread = state.threads[threadId];
    if (!thread || !changed) return state;
    return { ...state, threads: { ...state.threads, [thread.id]: { ...thread, conversationRevision: revision, updatedAt } } };
  }

  private persistCheckpoint(
    input: CanonicalAgentEventStoreInput,
    current: CanonicalAgentEventStoreCheckpoint | null,
    sequence: number,
    updatedAt: string,
  ): void {
    if (input.persistCheckpoint === false) return;
    this.operations.persistCheckpoint(this.checkpointToPersist(input, current, sequence, updatedAt));
  }

  private replayOutcome(
    decision: "duplicate" | "conflict",
    replayGuard: CanonicalAgentEventStoreInput["replayGuard"],
    terminalOutcome: TurnOutcome | null,
  ): CanonicalAgentCommitResult["outcome"] {
    if (decision === "conflict") return "conflict";
    if (replayGuard === "terminal-confirmed" && terminalOutcome) {
      return "terminal-outcome-confirmed";
    }
    return "duplicate";
  }

  private replayProgress(
    checkpoint: CanonicalAgentEventStoreCheckpoint | null,
  ): Pick<CanonicalAgentCommitResult, "acceptedThrough" | "durableThrough"> {
    const acceptedThrough = checkpoint?.lastAcceptedSequence ?? 0;
    return {
      acceptedThrough,
      durableThrough: checkpoint?.lastDurableSequence ?? acceptedThrough,
    };
  }

  private replayRevisions(
    thread: AgentThread | null,
  ): Pick<CanonicalAgentCommitResult, "conversationRevision" | "rosterRevision"> {
    return {
      conversationRevision: thread?.conversationRevision ?? 0,
      rosterRevision: thread?.rosterRevision ?? 0,
    };
  }

  private replayTerminalOutcome(
    checkpoint: CanonicalAgentEventStoreCheckpoint | null,
  ): TurnOutcome | null {
    return checkpoint?.terminalOutcome ?? null;
  }

  private checkpointToPersist(
    input: CanonicalAgentEventStoreInput,
    current: CanonicalAgentEventStoreCheckpoint | null,
    sequence: number,
    updatedAt: string,
  ): CanonicalAgentEventStoreCheckpoint {
    const terminalOutcome = current?.terminalOutcome ?? null;
    return {
      executionId: input.executionId,
      threadId: input.threadId,
      turnId: input.turnId,
      lastAcceptedSequence: sequence,
      lastDurableSequence: sequence,
      recoveryCursor: this.recoveryCursorToPersist(input, current),
      phase: terminalOutcome ? current!.phase : input.phase,
      terminalOutcome: terminalOutcome ?? input.terminalOutcome ?? null,
      error: terminalOutcome ? current!.error : input.error ?? null,
      updatedAt,
    };
  }

  private recoveryCursorToPersist(
    input: CanonicalAgentEventStoreInput,
    current: CanonicalAgentEventStoreCheckpoint | null,
  ): unknown | null {
    return input.recoveryCursor ?? current?.recoveryCursor ?? null;
  }
}
