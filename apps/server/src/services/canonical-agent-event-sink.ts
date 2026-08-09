import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import {
  AgentItemSchema,
  AgentThreadSchema,
  AgentTurnSchema,
  CanonicalAgentEventEnvelopeSchema,
  CollaborationActionSchema,
  CANONICAL_AGENT_EVENT_BATCH_MAX,
  createAgentModelState,
  reduceAgentEvent,
  reduceAgentEventBatch,
  type AgentItem,
  type AgentModelState,
  type AgentThread,
  type AgentTurn,
  type CanonicalAgentEvent,
  type CanonicalAgentEventEnvelope,
  type CollaborationAction,
  type ConversationNarrativeBatch,
  type Message,
  type NarrativeEntry,
  type ProviderIdentity,
} from "@mcode/contracts";
import { broadcast } from "../transport/push.js";

/** Server input before accepted sequence, durable revision, and server timestamps are assigned. */
export interface CanonicalAgentEventDraft {
  eventId: string;
  routing: CanonicalAgentEventEnvelope["routing"];
  sourceProviderId: string;
  sourceIdentities: readonly ProviderIdentity[];
  sourceSequence?: number;
  providerTimestamp?: string;
  payload: CanonicalAgentEvent;
}

/** Durable progress written with one semantic batch. */
export interface CanonicalAgentCheckpoint {
  executionId: string;
  threadId: string;
  turnId: string;
  lastAcceptedSequence: number;
  lastDurableSequence: number;
  nativeCursor: unknown | null;
  phase: string;
  terminalOutcome: "completed" | "errored" | "cancelled" | null;
  error: string | null;
  updatedAt: string;
}

/** Input for one atomic canonical semantic batch. */
export interface CanonicalAgentCommitInput {
  threadId: string;
  turnId: string;
  executionId: string;
  phase: string;
  terminalOutcome?: "completed" | "errored" | "cancelled";
  error?: string;
  nativeCursor?: unknown;
  events: readonly CanonicalAgentEventDraft[] | (() => readonly CanonicalAgentEventDraft[]);
  /** Compatibility writes execute inside the canonical transaction. */
  projectCompatibility?: () => void;
  /** Prevents replay from repeating compatibility writes for an accepted semantic phase. */
  replayGuard?: "execution-started" | "terminal-confirmed";
}

/** Observable result after one canonical batch commits. */
export interface CanonicalAgentCommitResult {
  outcome: "committed" | "duplicate" | "terminal-outcome-confirmed";
  conversationRevision: number;
  rosterRevision: number;
  acceptedThrough: number;
  durableThrough: number;
  events: readonly CanonicalAgentEventEnvelope[];
}

/** Legacy projection captured inside the canonical terminal transaction. */
export interface CanonicalParentTurnProjection {
  message: Message | null;
  narrative: readonly NarrativeEntry[];
}

/** Canonical conversation rows used by the staged compatibility read. */
export interface CanonicalConversationProjection {
  messages: Message[];
  narrativeByMessage: Record<string, ConversationNarrativeBatch>;
  hasMore: boolean;
}

type EventApplication = {
  event: CanonicalAgentEventEnvelope;
  outcome: ReturnType<typeof reduceAgentEvent>["outcome"];
};

/** Publishes one committed canonical semantic batch. */
export type CanonicalAgentEventPublisher = (
  events: readonly CanonicalAgentEventEnvelope[],
) => void;

/** Publishes a canonical semantic batch on the server push channel. */
export const publishCanonicalAgentEvents: CanonicalAgentEventPublisher = (events) => {
  const threadId = events[0]?.routing.threadId;
  if (!threadId) throw new Error("Canonical publication requires at least one event");
  broadcast("agent.canonical", { threadId, events: [...events] });
};

/** Owns validation, semantic reduction, atomic canonical persistence, and post-commit publication. */
@injectable()
export class CanonicalAgentEventSink {
  constructor(
    @inject("Database") private readonly db: Database.Database,
    @inject("CanonicalAgentEventPublisher")
    private readonly publish: CanonicalAgentEventPublisher = publishCanonicalAgentEvents,
  ) {}

  /** Commit one semantic batch and publish only the applied events after SQLite commits. */
  commit(input: CanonicalAgentCommitInput): CanonicalAgentCommitResult {
    const transaction = this.db.transaction(() => this.commitInsideTransaction(input));
    const result = transaction();
    if (result.events.length > 0) this.publish(result.events);
    return result;
  }

  /** Load one canonical thread record. */
  loadThread(threadId: string): AgentThread | null {
    const row = this.db.prepare("SELECT * FROM canonical_agent_threads WHERE id = ?").get(threadId);
    return row ? this.threadFromRow(row as Record<string, unknown>) : null;
  }

  /** Load one canonical turn record. */
  loadTurn(turnId: string): AgentTurn | null {
    const row = this.db.prepare("SELECT * FROM canonical_agent_turns WHERE id = ?").get(turnId);
    return row ? this.turnFromRow(row as Record<string, unknown>) : null;
  }

  /** Load the canonical turn bound to one Mcode execution identity. */
  loadTurnByExecution(executionId: string): AgentTurn | null {
    const row = this.db
      .prepare("SELECT * FROM canonical_agent_turns WHERE execution_id = ?")
      .get(executionId);
    return row ? this.turnFromRow(row as Record<string, unknown>) : null;
  }

  /** Load one durable ingest checkpoint. */
  loadCheckpoint(executionId: string): CanonicalAgentCheckpoint | null {
    const row = this.db
      .prepare("SELECT * FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(executionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      executionId: String(row.execution_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      lastAcceptedSequence: Number(row.last_accepted_sequence),
      lastDurableSequence: Number(row.last_durable_sequence),
      nativeCursor: row.native_cursor_json == null ? null : JSON.parse(String(row.native_cursor_json)),
      phase: String(row.phase),
      terminalOutcome: row.terminal_outcome as CanonicalAgentCheckpoint["terminalOutcome"],
      error: row.error == null ? null : String(row.error),
      updatedAt: String(row.updated_at),
    };
  }

  /** Load the canonical assistant projection needed to replay terminal post-commit effects. */
  loadTerminalProjection(turnId: string): { message: Message | null; toolCallCount: number } {
    const messageRow = this.db.prepare(`
      SELECT payload_json
      FROM canonical_agent_items
      WHERE turn_id = ?
        AND kind = 'message'
        AND json_extract(payload_json, '$.projection') = 'message'
        AND json_extract(payload_json, '$.message.role') = 'assistant'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(turnId) as { payload_json: string } | undefined;
    const countRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_items
      WHERE turn_id = ?
        AND json_extract(payload_json, '$.projection') = 'toolCall'
    `).get(turnId) as { count: number };
    return {
      message: messageRow
        ? (JSON.parse(messageRow.payload_json) as { message: Message }).message
        : null,
      toolCallCount: Number(countRow.count),
    };
  }

  /** Commit the canonical start of one ordinary user-triggered parent turn. */
  startParentTurn(input: {
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
    projectUserMessage: () => Message;
  }): CanonicalAgentCommitResult {
    let userMessage: Message | null = null;
    const now = new Date().toISOString();
    return this.commit({
      threadId: input.thread.id,
      turnId: input.turnId,
      executionId: input.executionId,
      phase: "running",
      replayGuard: "execution-started",
      projectCompatibility: () => {
        userMessage = input.projectUserMessage();
      },
      events: () => {
        if (!userMessage) throw new Error("Canonical user-message projection did not produce a row");
        return this.parentTurnStartEvents(input, userMessage, now);
      },
    });
  }

  /** Commit the first terminal result and its message and narrative projection. */
  finishParentTurn(input: {
    threadId: string;
    turnId: string;
    executionId: string;
    providerId: string;
    providerIdentities: readonly ProviderIdentity[];
    outcome: "completed" | "errored" | "cancelled";
    error?: string;
    projectTurn: () => CanonicalParentTurnProjection;
  }): CanonicalAgentCommitResult {
    let projection: CanonicalParentTurnProjection | null = null;
    const endedAt = new Date().toISOString();
    return this.commit({
      threadId: input.threadId,
      turnId: input.turnId,
      executionId: input.executionId,
      phase: input.outcome,
      terminalOutcome: input.outcome,
      error: input.error,
      replayGuard: "terminal-confirmed",
      projectCompatibility: () => {
        projection = input.projectTurn();
      },
      events: () => this.parentTurnTerminalEvents(input, projection, endedAt),
    });
  }

  /** Load canonical message and narrative items for one paginated conversation page. */
  loadConversationProjection(
    threadId: string,
    limit: number,
    before?: number,
  ): CanonicalConversationProjection {
    const clampedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM canonical_agent_items
      WHERE thread_id = ?
        AND kind = 'message'
        AND json_extract(payload_json, '$.projection') = 'message'
        AND json_extract(payload_json, '$.message.sequence') < ?
        AND COALESCE(json_extract(payload_json, '$.message.is_internal'), 0) = 0
      ORDER BY json_extract(payload_json, '$.message.sequence') DESC
      LIMIT ?
    `).all(threadId, before ?? Number.MAX_SAFE_INTEGER, clampedLimit + 1) as Array<{ payload_json: string }>;
    const hasMore = rows.length > clampedLimit;
    const messages = rows
      .slice(0, clampedLimit)
      .map((row) => (JSON.parse(row.payload_json) as { message: Message }).message)
      .sort((left, right) => left.sequence - right.sequence);
    const narrativeByMessage: Record<string, ConversationNarrativeBatch> = {};
    for (const message of messages) {
      narrativeByMessage[message.id] = { tools: [], thoughts: [], hooks: [] };
    }
    if (messages.length === 0) return { messages, narrativeByMessage, hasMore };

    const placeholders = messages.map(() => "?").join(", ");
    const narrativeRows = this.db.prepare(`
      SELECT kind, payload_json
      FROM canonical_agent_items
      WHERE thread_id = ?
        AND kind <> 'message'
        AND json_extract(payload_json, '$.record.message_id') IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(threadId, ...messages.map((message) => message.id)) as Array<{
      kind: string;
      payload_json: string;
    }>;
    for (const row of narrativeRows) {
      const payload = JSON.parse(row.payload_json) as { projection: string; record: Record<string, unknown> };
      const messageId = String(payload.record.message_id);
      const bucket = narrativeByMessage[messageId];
      if (!bucket) continue;
      if (payload.projection === "toolCall") {
        bucket.tools.push(payload.record as unknown as ConversationNarrativeBatch["tools"][number]);
      } else if (payload.projection === "narrationSegment") {
        bucket.thoughts.push(payload.record as unknown as ConversationNarrativeBatch["thoughts"][number]);
      } else if (payload.projection === "hook") {
        bucket.hooks.push(payload.record as unknown as ConversationNarrativeBatch["hooks"][number]);
      }
    }
    return { messages, narrativeByMessage, hasMore };
  }

  private parentTurnStartEvents(
    input: {
      thread: { id: string; workspaceId: string; providerId: string; createdAt: string };
      turnId: string;
      executionId: string;
      permissionMode: "supervised" | "full";
      providerIdentities: readonly ProviderIdentity[];
    },
    message: Message,
    startedAt: string,
  ): CanonicalAgentEventDraft[] {
    const sourceIdentities = [...input.providerIdentities];
    const routing = { threadId: input.thread.id, turnId: input.turnId, executionId: input.executionId };
    const itemId = `message:${message.id}`;
    return [
      {
        eventId: `${input.executionId}:thread`,
        routing: { threadId: input.thread.id, executionId: input.executionId },
        sourceProviderId: input.thread.providerId,
        sourceIdentities,
        payload: {
          type: "thread.recorded",
          thread: {
            id: input.thread.id,
            workspaceId: input.thread.workspaceId,
            rootThreadId: input.thread.id,
            providerId: input.thread.providerId,
            providerIdentities: sourceIdentities,
            activityState: "Active",
            conversationRevision: 0,
            rosterRevision: 0,
            createdAt: input.thread.createdAt,
            updatedAt: startedAt,
          },
        },
      },
      {
        eventId: `${input.executionId}:turn-created`,
        routing,
        sourceProviderId: input.thread.providerId,
        sourceIdentities,
        payload: {
          type: "turn.created",
          turn: {
            id: input.turnId,
            threadId: input.thread.id,
            status: "Pending",
            trigger: { kind: "user" },
            permissionMode: input.permissionMode,
            providerIdentities: sourceIdentities,
            startedAt: null,
            endedAt: null,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        },
      },
      {
        eventId: `${input.executionId}:turn-started`,
        routing,
        sourceProviderId: input.thread.providerId,
        sourceIdentities,
        payload: { type: "turn.started", startedAt },
      },
      {
        eventId: `${input.executionId}:item:${itemId}`,
        routing: { ...routing, itemId },
        sourceProviderId: input.thread.providerId,
        sourceIdentities,
        payload: {
          type: "item.recorded",
          item: {
            id: itemId,
            threadId: input.thread.id,
            turnId: input.turnId,
            kind: "message",
            providerIdentities: sourceIdentities,
            payload: { projection: "message", message },
            createdAt: message.timestamp,
            updatedAt: message.timestamp,
          },
        },
      },
    ];
  }

  private parentTurnTerminalEvents(
    input: {
      threadId: string;
      turnId: string;
      executionId: string;
      providerId: string;
      providerIdentities: readonly ProviderIdentity[];
      outcome: "completed" | "errored" | "cancelled";
      error?: string;
    },
    projection: CanonicalParentTurnProjection | null,
    endedAt: string,
  ): CanonicalAgentEventDraft[] {
    const sourceIdentities = [...input.providerIdentities];
    const routing = { threadId: input.threadId, turnId: input.turnId, executionId: input.executionId };
    const terminalPayload: CanonicalAgentEvent = input.outcome === "completed"
      ? { type: "turn.completed", endedAt }
      : input.outcome === "cancelled"
        ? { type: "turn.interrupted", endedAt, reason: input.error ?? "Turn cancelled" }
        : { type: "turn.errored", endedAt, error: input.error ?? "Provider turn failed" };
    const events: CanonicalAgentEventDraft[] = [{
      eventId: `${input.executionId}:${terminalPayload.type}`,
      routing,
      sourceProviderId: input.providerId,
      sourceIdentities,
      payload: terminalPayload,
    }];
    const currentThread = this.loadThread(input.threadId);
    if (currentThread
      && JSON.stringify(currentThread.providerIdentities) !== JSON.stringify(sourceIdentities)) {
      events.unshift({
        eventId: `${input.executionId}:thread-identity`,
        routing: { threadId: input.threadId, executionId: input.executionId },
        sourceProviderId: input.providerId,
        sourceIdentities,
        payload: {
          type: "thread.recorded",
          thread: {
            ...currentThread,
            providerIdentities: sourceIdentities,
            updatedAt: endedAt,
          },
        },
      });
    }
    if (projection?.message) {
      events.push(this.projectionItemEvent(input, {
        id: `message:${projection.message.id}`,
        kind: "message",
        payload: { projection: "message", message: projection.message },
        createdAt: projection.message.timestamp,
      }));
    }
    for (const entry of projection?.narrative ?? []) {
      if (entry.kind === "assistantMessage") continue;
      const record = entry.record;
      const itemKind = entry.kind === "toolCall"
        ? "tool-call" as const
        : entry.kind === "narrationSegment"
          ? "reasoning" as const
          : "system" as const;
      const recordId = record.id;
      const createdAt = entry.kind === "toolCall"
        ? record.started_at
        : entry.kind === "narrationSegment"
          ? record.started_at
          : record.started_at;
      events.push(this.projectionItemEvent(input, {
        id: `${entry.kind}:${recordId}`,
        kind: itemKind,
        payload: { projection: entry.kind, record },
        createdAt,
        ...(entry.kind === "toolCall" && "parent_tool_call_id" in record && record.parent_tool_call_id
          ? { parentItemId: `toolCall:${record.parent_tool_call_id}` }
          : {}),
      }));
    }
    return events;
  }

  private projectionItemEvent(
    input: {
      threadId: string;
      turnId: string;
      executionId: string;
      providerId: string;
      providerIdentities: readonly ProviderIdentity[];
    },
    item: {
      id: string;
      kind: AgentItem["kind"];
      payload: Record<string, unknown>;
      createdAt: string;
      parentItemId?: string;
    },
  ): CanonicalAgentEventDraft {
    return {
      eventId: `${input.executionId}:item:${item.id}`,
      routing: {
        threadId: input.threadId,
        turnId: input.turnId,
        executionId: input.executionId,
        itemId: item.id,
      },
      sourceProviderId: input.providerId,
      sourceIdentities: [...input.providerIdentities],
      payload: {
        type: "item.recorded",
        item: {
          id: item.id,
          threadId: input.threadId,
          turnId: input.turnId,
          ...(item.parentItemId ? { parentItemId: item.parentItemId } : {}),
          kind: item.kind,
          providerIdentities: [...input.providerIdentities],
          payload: item.payload,
          createdAt: item.createdAt,
          updatedAt: item.createdAt,
        },
      },
    };
  }

  private commitInsideTransaction(input: CanonicalAgentCommitInput): CanonicalAgentCommitResult {
    const currentThread = this.loadThread(input.threadId);
    const currentCheckpoint = this.loadCheckpoint(input.executionId);
    const replayedStart = input.replayGuard === "execution-started" && currentCheckpoint;
    const replayedTerminal = input.replayGuard === "terminal-confirmed"
      && currentCheckpoint?.terminalOutcome;
    if (replayedStart || replayedTerminal) {
      const acceptedThrough = currentCheckpoint?.lastAcceptedSequence ?? 0;
      return {
        outcome: replayedTerminal ? "terminal-outcome-confirmed" : "duplicate",
        conversationRevision: currentThread?.conversationRevision ?? 0,
        rosterRevision: currentThread?.rosterRevision ?? 0,
        acceptedThrough,
        durableThrough: currentCheckpoint?.lastDurableSequence ?? acceptedThrough,
        events: [],
      };
    }

    input.projectCompatibility?.();
    const events = typeof input.events === "function" ? input.events() : input.events;
    if (events.length === 0) {
      throw new Error("Canonical semantic batch must contain at least one event");
    }
    if (events.length > CANONICAL_AGENT_EVENT_BATCH_MAX) {
      throw new Error(
        `Canonical semantic batch exceeds ${CANONICAL_AGENT_EVENT_BATCH_MAX} events`,
      );
    }
    if (events.some((event) => event.routing.executionId !== input.executionId)) {
      throw new Error("Canonical semantic batch contains another execution identity");
    }
    if (events.some((event) => event.routing.threadId !== input.threadId)) {
      throw new Error("Canonical semantic batch contains another thread identity");
    }
    const existingById = new Map<string, CanonicalAgentEventEnvelope>();
    for (const draft of events) {
      const row = this.db
        .prepare("SELECT envelope_json FROM canonical_agent_events WHERE event_id = ?")
        .get(draft.eventId) as { envelope_json: string } | undefined;
      if (!row) continue;
      const stored = CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelope_json));
      this.assertDuplicateMatches(draft, stored);
      existingById.set(draft.eventId, stored);
    }

    const newDrafts = events.filter((draft) => !existingById.has(draft.eventId));
    if (newDrafts.length === 0) {
      const acceptedThrough = currentCheckpoint?.lastAcceptedSequence ?? 0;
      return {
        outcome: "duplicate",
        conversationRevision: currentThread?.conversationRevision ?? 0,
        rosterRevision: currentThread?.rosterRevision ?? 0,
        acceptedThrough,
        durableThrough: currentCheckpoint?.lastDurableSequence ?? acceptedThrough,
        events: [],
      };
    }

    const state = this.loadState(input.threadId, input.executionId);
    const acceptedAt = new Date().toISOString();
    const candidateRevision = (currentThread?.conversationRevision ?? 0) + 1;
    let acceptedSequence = currentCheckpoint?.lastAcceptedSequence ?? 0;
    let candidateEvents = newDrafts.map((draft) => {
      acceptedSequence += 1;
      return this.createEnvelope(draft, acceptedSequence, candidateRevision, acceptedAt);
    });
    let reduction = reduceAgentEventBatch(state, candidateEvents);
    if (reduction.outcome === "rejected") {
      throw new Error(`Canonical event ${reduction.eventId} rejected: ${reduction.reason}`);
    }

    const conversationChanged = reduction.appliedCount > 0;
    const conversationRevision = currentThread?.conversationRevision ?? 0;
    const durableRevision = conversationChanged ? conversationRevision + 1 : conversationRevision;
    if (durableRevision !== candidateRevision) {
      candidateEvents = candidateEvents.map((event) => ({ ...event, durableRevision }));
      reduction = reduceAgentEventBatch(state, candidateEvents);
      if (reduction.outcome === "rejected") {
        throw new Error(`Canonical event ${reduction.eventId} rejected: ${reduction.reason}`);
      }
    }

    const applications = this.applyIndividually(state, candidateEvents);
    const ignoredTerminal = applications.some((entry) => entry.outcome === "terminal-outcome-confirmed");
    let nextState = reduction.state;
    const thread = nextState.threads[input.threadId];
    if (thread && conversationChanged) {
      nextState = {
        ...nextState,
        threads: {
          ...nextState.threads,
          [thread.id]: {
            ...thread,
            conversationRevision: durableRevision,
            updatedAt: acceptedAt,
          },
        },
      };
    }

    this.persistState(
      nextState,
      input.threadId,
      input.turnId,
      input.executionId,
      conversationChanged,
    );
    for (const event of candidateEvents) this.insertEvent(event);

    const durableThrough = acceptedSequence;
    this.persistCheckpoint({
      executionId: input.executionId,
      threadId: input.threadId,
      turnId: input.turnId,
      lastAcceptedSequence: acceptedSequence,
      lastDurableSequence: durableThrough,
      nativeCursor: input.nativeCursor ?? currentCheckpoint?.nativeCursor ?? null,
      phase: currentCheckpoint?.terminalOutcome ? currentCheckpoint.phase : input.phase,
      terminalOutcome: currentCheckpoint?.terminalOutcome ?? input.terminalOutcome ?? null,
      error: currentCheckpoint?.terminalOutcome ? currentCheckpoint.error : input.error ?? null,
      updatedAt: acceptedAt,
    });

    const publishedEvents = applications
      .filter((entry) => entry.outcome === "applied")
      .map((entry) => entry.event);
    const persistedThread = nextState.threads[input.threadId] ?? currentThread;
    return {
      outcome: !conversationChanged && ignoredTerminal ? "terminal-outcome-confirmed" : "committed",
      conversationRevision: persistedThread?.conversationRevision ?? durableRevision,
      rosterRevision: persistedThread?.rosterRevision ?? 0,
      acceptedThrough: acceptedSequence,
      durableThrough,
      events: publishedEvents,
    };
  }

  private createEnvelope(
    draft: CanonicalAgentEventDraft,
    acceptedSequence: number,
    durableRevision: number,
    timestamp: string,
  ): CanonicalAgentEventEnvelope {
    const payload = draft.payload.type === "thread.recorded"
      ? {
          ...draft.payload,
          thread: {
            ...draft.payload.thread,
            conversationRevision: durableRevision,
          },
        }
      : draft.payload;
    return CanonicalAgentEventEnvelopeSchema.parse({
      ...draft,
      sourceIdentities: [...draft.sourceIdentities],
      acceptedSequence,
      durableRevision,
      serverTimestamps: { acceptedAt: timestamp, persistedAt: timestamp },
      payload,
    });
  }

  private assertDuplicateMatches(
    draft: CanonicalAgentEventDraft,
    stored: CanonicalAgentEventEnvelope,
  ): void {
    const storedPayload = stored.payload.type === "thread.recorded"
      && draft.payload.type === "thread.recorded"
      ? {
          ...stored.payload,
          thread: {
            ...stored.payload.thread,
            conversationRevision: draft.payload.thread.conversationRevision,
          },
        }
      : stored.payload;
    const comparable = {
      eventId: stored.eventId,
      routing: stored.routing,
      sourceProviderId: stored.sourceProviderId,
      sourceIdentities: stored.sourceIdentities,
      sourceSequence: stored.sourceSequence,
      providerTimestamp: stored.providerTimestamp,
      payload: storedPayload,
    };
    const normalizedDraft = JSON.parse(JSON.stringify({ ...draft, sourceIdentities: [...draft.sourceIdentities] }));
    if (JSON.stringify(normalizedDraft) !== JSON.stringify(JSON.parse(JSON.stringify(comparable)))) {
      throw new Error(`Canonical event identity conflict: ${draft.eventId}`);
    }
  }

  private applyIndividually(
    state: AgentModelState,
    events: readonly CanonicalAgentEventEnvelope[],
  ): EventApplication[] {
    const applications: EventApplication[] = [];
    let nextState = state;
    for (const event of events) {
      const result = reduceAgentEvent(nextState, event);
      applications.push({ event, outcome: result.outcome });
      if (result.outcome !== "routing-conflict" && result.outcome !== "sequence-conflict") {
        nextState = result.state;
      }
    }
    return applications;
  }

  private loadState(threadId: string, executionId: string): AgentModelState {
    const state = createAgentModelState();
    const thread = this.loadThread(threadId);
    if (thread) state.threads[thread.id] = thread;

    const turns = this.db
      .prepare("SELECT * FROM canonical_agent_turns WHERE thread_id = ?")
      .all(threadId) as Record<string, unknown>[];
    for (const row of turns) {
      const turn = this.turnFromRow(row);
      state.turns[turn.id] = turn;
    }

    const items = this.db
      .prepare("SELECT * FROM canonical_agent_items WHERE thread_id = ?")
      .all(threadId) as Record<string, unknown>[];
    for (const row of items) {
      const item = this.itemFromRow(row);
      state.items[item.id] = item;
    }

    const actions = this.db
      .prepare("SELECT * FROM canonical_collaboration_actions WHERE source_thread_id = ?")
      .all(threadId) as Record<string, unknown>[];
    for (const row of actions) {
      const action = this.actionFromRow(row);
      state.collaborationActions[action.id] = action;
    }

    const events = this.db
      .prepare("SELECT event_id, execution_id, accepted_sequence FROM canonical_agent_events WHERE thread_id = ?")
      .all(threadId) as Array<{ event_id: string; execution_id: string; accepted_sequence: number }>;
    for (const event of events) {
      state.appliedEventIds[event.event_id] = true;
      state.acceptedInputEventIds[`${event.execution_id}:${event.accepted_sequence}`] = event.event_id;
      const current = state.lastAcceptedSequenceByExecution[event.execution_id] ?? 0;
      state.lastAcceptedSequenceByExecution[event.execution_id] = Math.max(current, event.accepted_sequence);
    }
    const checkpoint = this.loadCheckpoint(executionId);
    if (checkpoint) {
      state.lastAcceptedSequenceByExecution[executionId] = checkpoint.lastAcceptedSequence;
    }
    return state;
  }

  private persistState(
    state: AgentModelState,
    threadId: string,
    turnId: string,
    executionId: string,
    conversationChanged: boolean,
  ): void {
    if (!conversationChanged) return;
    const thread = state.threads[threadId];
    if (thread) this.persistThread(thread);
    const turn = state.turns[turnId];
    if (turn?.threadId === threadId) this.persistTurn(turn, executionId);
    for (const item of Object.values(state.items)) {
      if (item.threadId === threadId) this.persistItem(item);
    }
    for (const action of Object.values(state.collaborationActions)) {
      if (action.source.threadId === threadId) this.persistAction(action);
    }
  }

  private persistThread(thread: AgentThread): void {
    const parsed = AgentThreadSchema.parse(thread);
    this.db.prepare(`
      INSERT INTO canonical_agent_threads (
        id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_id, provider_identities_json, activity_state, conversation_revision,
        roster_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_id = excluded.provider_id,
        provider_identities_json = excluded.provider_identities_json,
        activity_state = excluded.activity_state,
        conversation_revision = excluded.conversation_revision,
        roster_revision = excluded.roster_revision,
        updated_at = excluded.updated_at
    `).run(
      parsed.id,
      parsed.workspaceId,
      parsed.parentThreadId ?? null,
      parsed.rootThreadId,
      parsed.owningParentThreadId ?? null,
      parsed.providerId,
      JSON.stringify(parsed.providerIdentities),
      parsed.activityState,
      parsed.conversationRevision,
      parsed.rosterRevision,
      parsed.createdAt,
      parsed.updatedAt,
    );
  }

  private persistTurn(turn: AgentTurn, executionId: string): void {
    const parsed = AgentTurnSchema.parse(turn);
    this.db.prepare(`
      INSERT INTO canonical_agent_turns (
        id, thread_id, execution_id, status, trigger_json, permission_mode,
        provider_identities_json, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        provider_identities_json = excluded.provider_identities_json,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        updated_at = excluded.updated_at
    `).run(
      parsed.id,
      parsed.threadId,
      executionId,
      parsed.status,
      JSON.stringify(parsed.trigger),
      parsed.permissionMode,
      JSON.stringify(parsed.providerIdentities),
      parsed.startedAt,
      parsed.endedAt,
      parsed.createdAt,
      parsed.updatedAt,
    );
  }

  private persistItem(item: AgentItem): void {
    const parsed = AgentItemSchema.parse(item);
    this.db.prepare(`
      INSERT INTO canonical_agent_items (
        id, thread_id, turn_id, parent_item_id, kind, provider_identities_json,
        payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_item_id = excluded.parent_item_id,
        kind = excluded.kind,
        provider_identities_json = excluded.provider_identities_json,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      parsed.id,
      parsed.threadId,
      parsed.turnId,
      parsed.parentItemId ?? null,
      parsed.kind,
      JSON.stringify(parsed.providerIdentities),
      JSON.stringify(parsed.payload),
      parsed.createdAt,
      parsed.updatedAt,
    );
  }

  private persistAction(action: CollaborationAction): void {
    const parsed = CollaborationActionSchema.parse(action);
    this.db.prepare(`
      INSERT INTO canonical_collaboration_actions (
        id, kind, source_thread_id, source_turn_id, source_item_id, target_thread_id,
        target_turn_id, status, delivery_unknown, provider_identities_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        delivery_unknown = excluded.delivery_unknown,
        provider_identities_json = excluded.provider_identities_json,
        updated_at = excluded.updated_at
    `).run(
      parsed.id,
      parsed.kind,
      parsed.source.threadId,
      parsed.source.turnId,
      parsed.source.itemId,
      parsed.target.threadId,
      parsed.target.turnId ?? null,
      parsed.status,
      parsed.deliveryUnknown ? 1 : 0,
      JSON.stringify(parsed.providerIdentities),
      parsed.createdAt,
      parsed.updatedAt,
    );
  }

  private insertEvent(event: CanonicalAgentEventEnvelope): void {
    this.db.prepare(`
      INSERT INTO canonical_agent_events (
        event_id, thread_id, turn_id, execution_id, accepted_sequence,
        durable_revision, roster_revision, envelope_json, accepted_at, persisted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.routing.threadId,
      event.routing.turnId ?? null,
      event.routing.executionId,
      event.acceptedSequence,
      event.durableRevision,
      event.rosterRevision ?? null,
      JSON.stringify(event),
      event.serverTimestamps.acceptedAt,
      event.serverTimestamps.persistedAt,
    );
  }

  private persistCheckpoint(checkpoint: CanonicalAgentCheckpoint): void {
    this.db.prepare(`
      INSERT INTO canonical_agent_ingest_checkpoints (
        execution_id, thread_id, turn_id, last_accepted_sequence, last_durable_sequence,
        native_cursor_json, phase, terminal_outcome, error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        last_accepted_sequence = excluded.last_accepted_sequence,
        last_durable_sequence = excluded.last_durable_sequence,
        native_cursor_json = excluded.native_cursor_json,
        phase = excluded.phase,
        terminal_outcome = excluded.terminal_outcome,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      checkpoint.executionId,
      checkpoint.threadId,
      checkpoint.turnId,
      checkpoint.lastAcceptedSequence,
      checkpoint.lastDurableSequence,
      checkpoint.nativeCursor == null ? null : JSON.stringify(checkpoint.nativeCursor),
      checkpoint.phase,
      checkpoint.terminalOutcome,
      checkpoint.error,
      checkpoint.updatedAt,
    );
  }

  private threadFromRow(row: Record<string, unknown>): AgentThread {
    return AgentThreadSchema.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      ...(row.parent_thread_id == null ? {} : { parentThreadId: row.parent_thread_id }),
      rootThreadId: row.root_thread_id,
      ...(row.owning_parent_thread_id == null ? {} : { owningParentThreadId: row.owning_parent_thread_id }),
      providerId: row.provider_id,
      providerIdentities: JSON.parse(String(row.provider_identities_json)),
      activityState: row.activity_state,
      conversationRevision: row.conversation_revision,
      rosterRevision: row.roster_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private turnFromRow(row: Record<string, unknown>): AgentTurn {
    return AgentTurnSchema.parse({
      id: row.id,
      threadId: row.thread_id,
      status: row.status,
      trigger: JSON.parse(String(row.trigger_json)),
      permissionMode: row.permission_mode,
      providerIdentities: JSON.parse(String(row.provider_identities_json)),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private itemFromRow(row: Record<string, unknown>): AgentItem {
    return AgentItemSchema.parse({
      id: row.id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      ...(row.parent_item_id == null ? {} : { parentItemId: row.parent_item_id }),
      kind: row.kind,
      providerIdentities: JSON.parse(String(row.provider_identities_json)),
      payload: JSON.parse(String(row.payload_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private actionFromRow(row: Record<string, unknown>): CollaborationAction {
    return CollaborationActionSchema.parse({
      id: row.id,
      kind: row.kind,
      source: {
        threadId: row.source_thread_id,
        turnId: row.source_turn_id,
        itemId: row.source_item_id,
      },
      target: {
        threadId: row.target_thread_id,
        ...(row.target_turn_id == null ? {} : { turnId: row.target_turn_id }),
      },
      status: row.status,
      deliveryUnknown: Number(row.delivery_unknown) === 1,
      providerIdentities: JSON.parse(String(row.provider_identities_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
