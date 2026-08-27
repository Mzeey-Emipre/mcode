import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { inject, injectable } from "tsyringe";
import {
  AgentItemSchema,
  AgentThreadSchema,
  AgentTurnSchema,
  CanonicalAgentEventEnvelopeSchema,
  CollaborationActionSchema,
  canonicalSubagentTerminalOutcome,
  CanonicalSubagentRosterRequestSchema,
  CanonicalSubagentRosterSchema,
  type CanonicalSubagentRoster,
  type CanonicalSubagentRosterRequest,
  type CanonicalSubagentStopRequest,
  type CanonicalSubagentRosterRow,
  CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH,
  CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
  CANONICAL_SUBAGENT_TASK_MAX_LENGTH,
  CONVERSATION_HISTORY_PAGE_MAX_MESSAGES,
  MAX_TURN_RECOVERIES,
  ProviderIdentitySchema,
  resolveSubagentDisplayName,
  resolveSubagentMetadata,
  CANONICAL_AGENT_EVENT_BATCH_MAX,
  CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS,
  createAgentModelState,
  reduceAgentEvent,
  reduceAgentEventBatch,
  type AgentItem,
  type AgentModelState,
  type AgentThread,
  type AgentTurn,
  type CanonicalAgentEvent,
  type CanonicalAgentEventEnvelope,
  type CanonicalAgentReconnectRecovery,
  type CanonicalAgentRevision,
  type CollaborationAction,
  type ConversationNarrativeBatch,
  type Message,
  type NarrativeEntry,
  ParentNarrativeRecoveryItemSchema,
  type ProviderIdentity,
  type ParentNarrativeRecoveryItem,
  type TurnOutcome,
  ToolCallRecordSchema,
  ThoughtSegmentRecordSchema,
} from "@mcode/contracts";
import { broadcast } from "../../../application/transport/push.js";
import {
  ACTIVE_TURN_WRITE_BATCH_LIMITS,
  runBoundedWriteBatches,
  type WriteBatchResult,
} from "../../../runtime/persistence/sqlite/bounded-write-batches.js";
import {
  CanonicalAgentDiagnostics,
  type CanonicalDiagnosticExport,
} from "../observability/canonical-agent-diagnostics.js";

/** Capacity held back so volatile input cannot consume every semantic batch slot. */
export const CANONICAL_AGENT_CONTROL_EVENT_RESERVE = 16;
const CANONICAL_EXECUTION_DIAGNOSTIC_INDEX_CAPACITY = 128;
const CANONICAL_DIAGNOSTIC_EXPORT_EVENT_CAPACITY = 1_024;

/** Server input before accepted sequence, durable revision, and server timestamps are assigned. */
export interface CanonicalAgentEventDraft {
  eventId: string;
  routing: CanonicalAgentEventEnvelope["routing"];
  sourceProviderId: string;
  sourceIdentities: readonly ProviderIdentity[];
  sourceSequence?: number;
  rosterRevision?: number;
  providerTimestamp?: string;
  /** Volatile drafts can be truncated so structural and terminal drafts always retain capacity. */
  ingestClass?: "volatile";
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
  terminalOutcome: TurnOutcome | null;
  error: string | null;
  updatedAt: string;
}

/** Input for one atomic canonical semantic batch. */
export interface CanonicalAgentCommitInput {
  threadId: string;
  turnId: string;
  executionId: string;
  phase: string;
  terminalOutcome?: TurnOutcome;
  error?: string;
  nativeCursor?: unknown;
  events: readonly CanonicalAgentEventDraft[] | (() => readonly CanonicalAgentEventDraft[]);
  /** Compatibility writes execute inside the canonical transaction. */
  projectCompatibility?: () => void;
  /** Prevents replay from repeating compatibility writes for an accepted semantic phase. */
  replayGuard?: "execution-started" | "terminal-confirmed";
  /** Stops the exact provider execution after a durable overflow record commits. */
  onOverflow?: () => void;
  /** Skips a checkpoint when a state-only event uses an existing source turn. */
  persistCheckpoint?: boolean;
}

/** Observable result after one canonical batch commits. */
export interface CanonicalAgentCommitResult {
  outcome: "committed" | "duplicate" | "terminal-outcome-confirmed" | "ingest-overflow";
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

/** Canonical terminal result plus the physical transaction work used to commit it. */
export type CanonicalAgentBatchedCommitResult = Omit<CanonicalAgentCommitResult, "outcome"> & {
  outcome: Exclude<CanonicalAgentCommitResult["outcome"], "ingest-overflow">;
  writeBatches: WriteBatchResult;
};

/** Inputs for terminal parent-turn projection and canonical persistence. */
export interface CanonicalParentTurnFinishInput {
  threadId: string;
  turnId: string;
  executionId: string;
  providerId: string;
  providerIdentities: readonly ProviderIdentity[];
  outcome: TurnOutcome;
  error?: string;
  projectTurn: () => CanonicalParentTurnProjection;
  finalizeCompatibility?: () => void;
}

/** One checked structured narrative snapshot accepted before its visible event. */
export interface ParentNarrativeRecoveryCommitInput {
  executionId: string;
  items: readonly ParentNarrativeRecoveryItem[];
  discardedItemIds?: readonly string[];
}

/** Input used to provision one Codex provider-native child thread. */
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

/** Durable canonical records created for one Codex child delegation. */
export interface CodexChildDelegation {
  childThread: AgentThread;
  parentItem: AgentItem;
  collaborationAction: CollaborationAction;
}

/** Canonical identity resolution used by the child interruption action. */
export interface CanonicalChildStopTarget {
  childThread: AgentThread;
  latestTurn: AgentTurn | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
}

/** Input used to attach exact Codex receiver and child-native identities. */
export interface CodexChildIdentityInput {
  parentThreadId: string;
  parentTurnId: string;
  parentExecutionId: string;
  parentItemId: string;
  nativeThreadId: string;
}

/** Input used to persist one exact Codex child turn start. */
export interface CodexChildTurnStartInput extends CodexChildIdentityInput {
  nativeTurnId: string;
  prompt?: string;
  triggerActionId?: string;
}

/** Input used to persist one directional action without creating a Provider turn. */
export interface CollaborationActionInput {
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

/** Input used to start a parent turn only after explicit provider continuation evidence. */
export interface CanonicalProviderContinuationInput {
  parentThreadId: string;
  turnId: string;
  executionId: string;
  permissionMode: "supervised" | "full";
  providerIdentities: readonly ProviderIdentity[];
  triggerActionId: string;
}

/** Input used to persist one child semantic item under its canonical turn. */
export interface CodexChildItemInput {
  childThreadId: string;
  nativeTurnId: string;
  nativeItemId: string;
  eventKey: string;
  kind: AgentItem["kind"];
  payload: Record<string, unknown>;
  parentItemId?: string;
}

/** Input used to persist one exact Codex child terminal outcome. */
export interface CodexChildTurnFinishInput {
  childThreadId: string;
  nativeTurnId: string;
  outcome: TurnOutcome;
  error?: string;
}

/** Input used to terminalize the latest running canonical child turn by thread identity. */
export interface CanonicalChildTurnFinishInput {
  childThreadId: string;
  outcome: TurnOutcome;
  error?: string;
}

/** Input used to classify a child delegation whose delivery was rejected or uncertain. */
export interface CodexChildDeliveryInput extends CodexChildIdentityInput {
}

/** Input used to create a linked replacement for a failed or uncertain child delivery. */
export interface CodexChildRetryInput extends Omit<CodexChildDelegationInput, "replacementForActionId"> {
  previousActionId: string;
}

/** Durable canonical context included with one bounded diagnostic export. */
export interface CanonicalTurnDiagnosticContext {
  thread: AgentThread;
  turn: AgentTurn;
  checkpoint: CanonicalAgentCheckpoint;
  events: CanonicalAgentEventEnvelope[];
  eventTruncation: { droppedEvents: number };
  truncationMarkers: CanonicalAgentEventEnvelope[];
}

/** Redacted diagnostic entries plus durable records and stopping-point provenance. */
export interface CanonicalTurnDiagnosticExport extends CanonicalDiagnosticExport {
  canonical: CanonicalTurnDiagnosticContext;
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

function hashCodexKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function deterministicUuid(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function isCodexSpawnRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const value = record as Record<string, unknown>;
  const input = value.tool_input;
  if (!input || typeof input !== "object") return false;
  const toolInput = input as Record<string, unknown>;
  return toolInput.codexCollabKind === "spawnAgent";
}

function codexChildOwnedToolCallIds(
  narrative: readonly NarrativeEntry[],
): ReadonlySet<string> {
  const childrenByParent = new Map<string, string[]>();
  const owned = new Set<string>();
  for (const entry of narrative) {
    if (entry.kind !== "toolCall") continue;
    const record = entry.record as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    if (isCodexSpawnRecord(record)) owned.add(record.id);
    if (typeof record.parent_tool_call_id !== "string") continue;
    const children = childrenByParent.get(record.parent_tool_call_id) ?? [];
    children.push(record.id);
    childrenByParent.set(record.parent_tool_call_id, children);
  }

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
  return owned;
}

class StructuralIngestOverflow extends Error {
  constructor(
    readonly input: CanonicalAgentCommitInput,
    readonly acceptedStoppingSequence: number,
    readonly durableStoppingSequence: number,
  ) {
    super("Canonical structural ingestion capacity saturated");
  }
}

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
  private readonly persistThreadStatement: Database.Statement;
  private readonly persistTurnStatement: Database.Statement;
  private readonly persistItemStatement: Database.Statement;
  private readonly insertEventStatement: Database.Statement;
  private readonly persistCheckpointStatement: Database.Statement;
  private readonly diagnostics = new CanonicalAgentDiagnostics();
  private readonly turnIdByExecution = new Map<string, string>();

  constructor(
    @inject("Database") private readonly db: Database.Database,
    @inject("CanonicalAgentEventPublisher")
    private readonly publish: CanonicalAgentEventPublisher = publishCanonicalAgentEvents,
  ) {
    this.persistThreadStatement = db.prepare(`
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
    `);
    this.persistTurnStatement = db.prepare(`
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
    `);
    this.persistItemStatement = db.prepare(`
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
    `);
    this.insertEventStatement = db.prepare(`
      INSERT INTO canonical_agent_events (
        event_id, thread_id, turn_id, execution_id, accepted_sequence,
        durable_revision, roster_revision, envelope_json, accepted_at, persisted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.persistCheckpointStatement = db.prepare(`
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
    `);
  }

  /** Commit one semantic batch and publish only the applied events after SQLite commits. */
  commit(input: CanonicalAgentCommitInput): CanonicalAgentCommitResult {
    const transaction = this.db.transaction(() => this.commitInsideTransaction(input));
    let result: CanonicalAgentCommitResult;
    try {
      result = transaction();
    } catch (error) {
      if (!(error instanceof StructuralIngestOverflow)) throw error;
      return this.commitStructuralOverflow(error);
    }
    this.recordCanonicalDiagnostics(result.events);
    if (result.events.length > 0) this.publish(result.events);
    return result;
  }

  /** Start raw capture for one turn after explicit consent. */
  startRawTurnCapture(input: { turnId: string; consent: boolean; expiresInMs: number }): void {
    this.diagnostics.startRawCapture(input);
  }

  /** Record one provider event in the bounded diagnostic service. */
  recordProviderDiagnostic(input: {
    executionId: string;
    event: unknown;
    terminal?: boolean;
  }): void {
    const turnId = this.turnIdByExecution.get(input.executionId)
      ?? this.loadTurnByExecution(input.executionId)?.id;
    if (!turnId) return;
    this.diagnostics.record({ ...input, turnId, source: "provider" });
    if (input.terminal) this.turnIdByExecution.delete(input.executionId);
  }

  /** Record a bounded diagnostic when structurally attributed Codex child routing fails. */
  recordCodexChildRoutingDiagnostic(input: {
    threadId: string;
    parentItemId?: string;
    executionId?: string;
    event: unknown;
    reason: string;
  }): boolean {
    const turnByExecution = input.executionId
      ? this.loadTurnByExecution(input.executionId)
      : null;
    const turnByItem = input.parentItemId
      ? (() => {
          const item = this.loadItem(input.parentItemId!);
          return item ? this.loadTurn(item.turnId) : null;
        })()
      : null;
    const turn = turnByExecution ?? turnByItem;
    if (!turn || turn.threadId !== input.threadId) return false;
    this.diagnostics.record({
      turnId: turn.id,
      executionId: input.executionId ?? this.executionIdForTurn(turn.id),
      source: "provider",
      event: {
        type: "codex-child-routing-failure",
        reason: input.reason,
        event: input.event,
      },
    });
    const executionId = turnByExecution && input.executionId
      ? input.executionId
      : this.executionIdForTurn(turn.id);
    const thread = this.loadThread(turn.threadId);
    if (!thread) return false;
    const failureItemId = `item:codex-child-routing-failure:${hashCodexKey(
      `${turn.id}:${input.parentItemId ?? ""}:${input.reason}`,
    )}`;
    if (this.loadItem(failureItemId)) return true;
    const now = new Date().toISOString();
    const failureItem: AgentItem = {
      id: failureItemId,
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
    this.commit({
      threadId: thread.id,
      turnId: turn.id,
      executionId,
      phase: "running",
      events: [this.itemDraft(executionId, thread, turn, failureItem)],
    });
    return true;
  }

  /** Export bounded diagnostics, with separate confirmation for raw content. */
  exportTurnDiagnostics(
    turnId: string,
    options: { includeRaw?: boolean; confirmRaw?: boolean } = {},
  ): CanonicalTurnDiagnosticExport {
    const row = this.db.prepare(`
      SELECT thread_id, execution_id
      FROM canonical_agent_turns
      WHERE id = ?
    `).get(turnId) as { thread_id: string; execution_id: string } | undefined;
    if (!row) throw new Error(`Canonical diagnostic turn not found: ${turnId}`);
    const thread = this.loadThread(row.thread_id);
    const turn = this.loadTurn(turnId);
    const checkpoint = this.loadCheckpoint(row.execution_id);
    if (!thread || !turn || !checkpoint) {
      throw new Error(`Canonical diagnostic context is incomplete: ${turnId}`);
    }
    const eventRows = this.db.prepare(`
      SELECT envelope_json
      FROM canonical_agent_events
      WHERE execution_id = ?
      ORDER BY accepted_sequence DESC
      LIMIT ?
    `).all(
      row.execution_id,
      CANONICAL_DIAGNOSTIC_EXPORT_EVENT_CAPACITY,
    ) as Array<{ envelope_json: string }>;
    const eventCount = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_events
      WHERE execution_id = ?
    `).get(row.execution_id) as { count: number };
    const droppedEvents = Math.max(0, eventCount.count - eventRows.length);
    const events = eventRows.reverse().map((event) => (
      CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(event.envelope_json))
    ));
    return {
      ...this.diagnostics.exportTurn(turnId, options),
      canonical: {
        thread,
        turn,
        checkpoint,
        events,
        eventTruncation: { droppedEvents },
        truncationMarkers: events.filter((event) => (
          event.payload.type === "ingest.volatile-truncated"
          || event.payload.type === "ingest.overflow"
        )),
      },
    };
  }

  /** Load one canonical thread record. */
  loadThread(threadId: string): AgentThread | null {
    const row = this.db.prepare("SELECT * FROM canonical_agent_threads WHERE id = ?").get(threadId);
    return row ? this.threadFromRow(row as Record<string, unknown>) : null;
  }

  /** Load the unique canonical thread carrying one exact provider identity. */
  loadThreadByProviderIdentity(identity: ProviderIdentity): AgentThread | null {
    const parsed = ProviderIdentitySchema.parse(identity);
    const rows = this.db.prepare(`
      SELECT thread.*
      FROM canonical_agent_threads thread
      JOIN json_each(thread.provider_identities_json) provider_identity
        ON json_extract(provider_identity.value, '$.providerId') = ?
       AND json_extract(provider_identity.value, '$.scope') = ?
       AND json_extract(provider_identity.value, '$.value') = ?
      LIMIT 2
    `).all(parsed.providerId, parsed.scope, parsed.value) as Record<string, unknown>[];
    if (rows.length > 1) {
      throw new Error(`Provider identity is ambiguous: ${parsed.providerId}/${parsed.scope}/${parsed.value}`);
    }
    return rows[0] ? this.threadFromRow(rows[0]) : null;
  }

  /** Restore one renderer replica from contiguous durable events or a canonical snapshot. */
  recoverThread(
    threadId: string,
    known: CanonicalAgentRevision,
  ): CanonicalAgentReconnectRecovery {
    const thread = this.loadThread(threadId);
    const through = {
      conversationRevision: thread?.conversationRevision ?? 0,
      rosterRevision: thread?.rosterRevision ?? 0,
    };
    const snapshot = (): CanonicalAgentReconnectRecovery => ({
      mode: "snapshot",
      threadId,
      snapshot: {
        revision: through,
        state: this.loadState(threadId),
      },
    });

    if (
      known.conversationRevision > through.conversationRevision
      || known.rosterRevision > through.rosterRevision
    ) {
      return snapshot();
    }

    if (
      known.conversationRevision === through.conversationRevision
      && known.rosterRevision === through.rosterRevision
    ) {
      return { mode: "delta", threadId, from: known, through, events: [] };
    }

    const rows = this.db.prepare(`
      SELECT envelope_json
      FROM canonical_agent_events
      WHERE thread_id = ?
        AND (durable_revision > ? OR COALESCE(roster_revision, 0) > ?)
      ORDER BY durable_revision ASC, persisted_at ASC, event_id ASC
      LIMIT ?
    `).all(
      threadId,
      known.conversationRevision,
      known.rosterRevision,
      CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS + 1,
    ) as Array<{ envelope_json: string }>;
    if (rows.length > CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS) return snapshot();

    const events = rows.map((row) =>
      CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelope_json))
    );
    const conversationContiguous = this.hasContiguousRevisions(
      events.map((event) => event.durableRevision),
      known.conversationRevision,
      through.conversationRevision,
    );
    const rosterContiguous = this.hasContiguousRevisions(
      events.flatMap((event) => event.rosterRevision === undefined ? [] : [event.rosterRevision]),
      known.rosterRevision,
      through.rosterRevision,
    );
    if (!conversationContiguous || !rosterContiguous || this.hasInboundCollaboration(threadId)) return snapshot();

    return { mode: "delta", threadId, from: known, through, events };
  }

  private hasInboundCollaboration(threadId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS present
      FROM canonical_collaboration_actions
      WHERE target_thread_id = ?
      LIMIT 1
    `).get(threadId) as { present: number } | undefined;
    return row?.present === 1;
  }

  /** Load one canonical turn record. */
  loadTurn(turnId: string): AgentTurn | null {
    const row = this.db.prepare("SELECT * FROM canonical_agent_turns WHERE id = ?").get(turnId);
    return row ? this.turnFromRow(row as Record<string, unknown>) : null;
  }

  /** Load the canonical turn bound to one Mcode execution identity. */
  loadTurnByExecution(executionId: string): AgentTurn | null {
    const cachedTurnId = this.turnIdByExecution.get(executionId);
    if (cachedTurnId) return this.loadTurn(cachedTurnId);
    const row = this.db
      .prepare("SELECT * FROM canonical_agent_turns WHERE execution_id = ?")
      .get(executionId);
    if (!row) return null;
    const turn = this.turnFromRow(row as Record<string, unknown>);
    this.cacheTurnExecution(executionId, turn.id);
    return turn;
  }

  /** Load the unique canonical turn carrying one exact provider identity. */
  loadTurnByProviderIdentity(
    threadId: string,
    identity: ProviderIdentity,
  ): AgentTurn | null {
    const parsed = ProviderIdentitySchema.parse(identity);
    const rows = this.db.prepare(`
      SELECT turn.*
      FROM canonical_agent_turns turn
      JOIN json_each(turn.provider_identities_json) provider_identity
        ON json_extract(provider_identity.value, '$.providerId') = ?
       AND json_extract(provider_identity.value, '$.scope') = ?
       AND json_extract(provider_identity.value, '$.value') = ?
      WHERE turn.thread_id = ?
      ORDER BY turn.created_at ASC, turn.id ASC
      LIMIT 2
    `).all(parsed.providerId, parsed.scope, parsed.value, threadId) as Record<string, unknown>[];
    if (rows.length > 1) {
      throw new Error(`Provider turn identity is ambiguous: ${parsed.providerId}/${parsed.scope}/${parsed.value}`);
    }
    return rows[0] ? this.turnFromRow(rows[0]) : null;
  }

  /** Load one durable ingest checkpoint. */
  loadCheckpoint(executionId: string): CanonicalAgentCheckpoint | null {
    const row = this.db
      .prepare("SELECT * FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(executionId) as Record<string, unknown> | undefined;
    return row ? this.checkpointFromRow(row) : null;
  }

  /** Load checkpoints whose canonical turn has no terminal outcome. */
  listUnfinishedCheckpoints(): CanonicalAgentCheckpoint[] {
    const rows = this.db.prepare(`
      SELECT checkpoint.*
      FROM canonical_agent_ingest_checkpoints checkpoint
      JOIN canonical_agent_turns turn ON turn.id = checkpoint.turn_id
      WHERE checkpoint.terminal_outcome IS NULL
        AND turn.status IN ('Pending', 'Running')
      ORDER BY checkpoint.updated_at ASC, checkpoint.execution_id ASC
      LIMIT ?
    `).all(MAX_TURN_RECOVERIES + 1) as Record<string, unknown>[];
    return this.boundedCheckpointRows(rows, "unfinished");
  }

  /** List terminal checkpoints that can be reopened because their terminal commit lacks a projection. */
  listUnmaterializedTerminalCheckpoints(): CanonicalAgentCheckpoint[] {
    const rows = this.db.prepare(`
      SELECT checkpoint.*
      FROM canonical_agent_ingest_checkpoints checkpoint
      JOIN canonical_agent_turns turn ON turn.id = checkpoint.turn_id
      WHERE checkpoint.terminal_outcome IS NOT NULL
        AND turn.status IN ('Completed', 'Cancelled', 'Interrupted', 'Errored')
        AND NOT EXISTS (
          SELECT 1
          FROM canonical_agent_items item
          WHERE item.turn_id = checkpoint.turn_id
            AND item.kind = 'message'
            AND json_extract(item.payload_json, '$.projection') = 'message'
            AND json_extract(item.payload_json, '$.message.role') = 'assistant'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM canonical_agent_events event
          WHERE event.execution_id = checkpoint.execution_id
            AND json_extract(event.envelope_json, '$.payload.type') IN (
              'turn.completed', 'turn.cancelled', 'turn.interrupted', 'turn.errored'
            )
        )
      ORDER BY checkpoint.updated_at ASC, checkpoint.execution_id ASC
      LIMIT ?
    `).all(MAX_TURN_RECOVERIES + 1) as Record<string, unknown>[];
    return this.boundedCheckpointRows(rows, "unmaterialized terminal");
  }

  /** Reopen an unmaterialized terminal checkpoint so ordinary interruption recovery can finish it. */
  reopenUnmaterializedTerminalCheckpoint(executionId: string): boolean {
    return this.db.transaction(() => {
      const checkpoint = this.loadCheckpoint(executionId);
      const turn = this.loadTurnByExecution(executionId);
      if (!checkpoint || !turn || !checkpoint.terminalOutcome) return false;
      const assistantProjection = this.loadTerminalProjection(turn.id).message;
      if (assistantProjection) return false;
      const terminalEvent = this.db.prepare(`
        SELECT 1
        FROM canonical_agent_events
        WHERE execution_id = ?
          AND json_extract(envelope_json, '$.payload.type') IN (
            'turn.completed', 'turn.cancelled', 'turn.interrupted', 'turn.errored'
          )
        LIMIT 1
      `).get(executionId);
      if (terminalEvent) return false;
      const now = new Date().toISOString();
      const reopenedTurn = this.db.prepare(`
        UPDATE canonical_agent_turns
        SET status = 'Running', ended_at = NULL, updated_at = ?
        WHERE id = ?
          AND status IN ('Completed', 'Cancelled', 'Interrupted', 'Errored')
      `).run(now, turn.id);
      if (reopenedTurn.changes !== 1) return false;
      const reopenedCheckpoint = this.db.prepare(`
        UPDATE canonical_agent_ingest_checkpoints
        SET phase = 'running', terminal_outcome = NULL, error = NULL, updated_at = ?
        WHERE execution_id = ?
          AND terminal_outcome IS NOT NULL
      `).run(now, executionId);
      if (reopenedCheckpoint.changes !== 1) {
        throw new Error(`Unmaterialized terminal checkpoint was not reopened: ${executionId}`);
      }
      return true;
    })();
  }

  /** Load interrupted checkpoints that permit an explicit recovery action. */
  listInterruptedCheckpoints(): CanonicalAgentCheckpoint[] {
    const rows = this.db.prepare(`
      SELECT checkpoint.*
      FROM canonical_agent_ingest_checkpoints checkpoint
      JOIN canonical_agent_turns turn ON turn.id = checkpoint.turn_id
      WHERE checkpoint.terminal_outcome IN ('interrupted', 'errored')
        AND checkpoint.phase IN ('interrupted', 'errored')
        AND turn.status IN ('Interrupted', 'Errored')
      ORDER BY checkpoint.updated_at ASC, checkpoint.execution_id ASC
      LIMIT ?
    `).all(MAX_TURN_RECOVERIES + 1) as Record<string, unknown>[];
    return this.boundedCheckpointRows(rows, "interrupted");
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
    retryOfExecutionId?: string;
    projectUserMessage: () => Message;
  }): CanonicalAgentCommitResult {
    let userMessage: Message | null = null;
    const now = new Date().toISOString();
    const result = this.commit({
      threadId: input.thread.id,
      turnId: input.turnId,
      executionId: input.executionId,
      phase: "running",
      nativeCursor: input.providerIdentities.find((identity) => identity.provenance === "native"),
      replayGuard: "execution-started",
      projectCompatibility: () => {
        if (input.retryOfExecutionId) {
          const consumed = this.db.prepare(`
            UPDATE canonical_agent_ingest_checkpoints
            SET phase = 'retried', updated_at = ?
            WHERE execution_id = ?
              AND phase IN ('interrupted', 'errored')
              AND terminal_outcome IN ('interrupted', 'errored')
          `).run(now, input.retryOfExecutionId);
          if (consumed.changes !== 1) {
            throw new Error(`Interrupted execution not found: ${input.retryOfExecutionId}`);
          }
        }
        userMessage = input.projectUserMessage();
      },
      events: () => {
        if (!userMessage) throw new Error("Canonical user-message projection did not produce a row");
        return this.parentTurnStartEvents(input, userMessage, now);
      },
    });
    this.cacheTurnExecution(input.executionId, input.turnId);
    return result;
  }

  /** Start an ordinary parent turn from a provider-proven child action. */
  startProviderContinuation(input: CanonicalProviderContinuationInput): AgentTurn {
    const parentThread = this.loadThread(input.parentThreadId);
    if (!parentThread) throw new Error(`Canonical parent thread not found: ${input.parentThreadId}`);
    const triggerAction = this.loadCollaborationAction(input.triggerActionId);
    if (!triggerAction || triggerAction.target.threadId !== parentThread.id) {
      throw new Error(`Provider continuation action does not target parent: ${input.triggerActionId}`);
    }
    const sourceTurn = this.loadTurn(triggerAction.source.turnId);
    if (!sourceTurn || sourceTurn.threadId !== triggerAction.source.threadId) {
      throw new Error(`Provider continuation source turn is not canonical: ${triggerAction.source.turnId}`);
    }
    const existing = this.loadTurnByExecution(input.executionId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const sourceIdentities = input.providerIdentities.length > 0
      ? this.uniqueProviderIdentities(input.providerIdentities)
      : parentThread.providerIdentities;
    const turn: AgentTurn = {
      id: input.turnId,
      threadId: parentThread.id,
      status: "Pending",
      trigger: {
        kind: "child",
        sourceThreadId: triggerAction.source.threadId,
        sourceTurnId: triggerAction.source.turnId,
        sourceItemId: triggerAction.source.itemId,
      },
      permissionMode: input.permissionMode,
      providerIdentities: sourceIdentities,
      startedAt: null,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const acknowledgedAction: CollaborationAction = {
      ...triggerAction,
      target: { threadId: parentThread.id, turnId: turn.id },
      status: "Acknowledged",
      updatedAt: now,
    };
    const updatedParent: AgentThread = {
      ...parentThread,
      activityState: "Active",
      providerIdentities: sourceIdentities,
      updatedAt: now,
    };
    const sourceThread = this.loadThread(triggerAction.source.threadId);
    if (!sourceThread) throw new Error(`Provider continuation source thread not found: ${triggerAction.source.threadId}`);
    const sourceExecutionId = this.executionIdForTurn(triggerAction.source.turnId);
    const routing = { threadId: parentThread.id, turnId: turn.id, executionId: input.executionId };
    const committed = this.commitProviderContinuation({
      source: {
        threadId: sourceThread.id,
        turnId: triggerAction.source.turnId,
        executionId: sourceExecutionId,
        phase: "running",
        events: [this.actionDraft(
          sourceExecutionId,
          sourceThread,
          acknowledgedAction,
          `${sourceExecutionId}:collaboration:${hashCodexKey(input.triggerActionId)}:acknowledge`,
        )],
      },
      parent: {
        threadId: parentThread.id,
        turnId: turn.id,
        executionId: input.executionId,
        phase: "running",
        replayGuard: "execution-started",
        events: [
          {
            eventId: `${input.executionId}:thread`,
            routing: { threadId: parentThread.id, executionId: input.executionId },
            sourceProviderId: parentThread.providerId,
            sourceIdentities,
            payload: { type: "thread.recorded", thread: updatedParent },
          },
          {
            eventId: `${input.executionId}:turn-created`,
            routing,
            sourceProviderId: parentThread.providerId,
            sourceIdentities,
            payload: { type: "turn.created", turn },
          },
          {
            eventId: `${input.executionId}:turn-started`,
            routing,
            sourceProviderId: parentThread.providerId,
            sourceIdentities,
            payload: { type: "turn.started", startedAt: now },
          },
        ],
      },
    });
    if (committed.parent.outcome === "duplicate") {
      const duplicate = this.loadTurn(input.turnId);
      if (duplicate) return duplicate;
    }
    this.cacheTurnExecution(input.executionId, input.turnId);
    const started = this.loadTurn(input.turnId);
    if (!started) throw new Error(`Provider continuation turn was not persisted: ${input.turnId}`);
    return started;
  }

  /** Commit continuation acknowledgement and parent turn creation before publishing either side. */
  private commitProviderContinuation(input: {
    source: CanonicalAgentCommitInput;
    parent: CanonicalAgentCommitInput;
  }): { source: CanonicalAgentCommitResult; parent: CanonicalAgentCommitResult } {
    const transaction = this.db.transaction(() => ({
      source: this.commitInsideTransaction(input.source),
      parent: this.commitInsideTransaction(input.parent),
    }));
    const committed = transaction();
    const sourceEvents = committed.source.events;
    const parentEvents = committed.parent.events;
    this.recordCanonicalDiagnostics([...sourceEvents, ...parentEvents]);
    this.publishEventGroups([sourceEvents, parentEvents]);
    return committed;
  }

  /** Load one canonical semantic item. */
  loadItem(itemId: string): AgentItem | null {
    const row = this.db.prepare("SELECT * FROM canonical_agent_items WHERE id = ?").get(itemId);
    return row ? this.itemFromRow(row as Record<string, unknown>) : null;
  }

  /** Load the one Codex child delegation sourced by a canonical parent item. */
  loadCodexChildDelegation(
    parentThreadId: string,
    parentItemId: string,
  ): CodexChildDelegation | null {
    const actionRows = this.db.prepare(`
      SELECT *
      FROM canonical_collaboration_actions
      WHERE source_thread_id = ?
        AND source_item_id = ?
        AND kind = 'delegate'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).all(parentThreadId, parentItemId) as Record<string, unknown>[];
    const actionRow = actionRows[0];
    if (!actionRow) return null;
    const collaborationAction = this.actionFromRow(actionRow);
    const childThread = this.loadThread(collaborationAction.target.threadId);
    const parentItem = this.loadItem(collaborationAction.source.itemId);
    if (!childThread || !parentItem) {
      throw new Error(`Codex child delegation is incomplete: ${parentItemId}`);
    }
    return { childThread, parentItem, collaborationAction };
  }

  /** Load the one Codex child delegation registered for an exact native receiver thread. */
  loadCodexChildDelegationByReceiverThreadId(nativeThreadId: string): CodexChildDelegation | null {
    const receiver = this.codexReceiverIdentity(nativeThreadId);
    const actionRows = this.db.prepare(`
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
    if (actionRows.length > 1) {
      throw new Error(`Codex receiver identity is ambiguous: ${nativeThreadId}`);
    }
    const actionRow = actionRows[0];
    if (!actionRow) return null;
    const collaborationAction = this.actionFromRow(actionRow);
    const childThread = this.loadThread(collaborationAction.target.threadId);
    const parentItem = this.loadItem(collaborationAction.source.itemId);
    if (!childThread || !parentItem) {
      throw new Error(`Codex receiver delegation is incomplete: ${nativeThreadId}`);
    }
    return { childThread, parentItem, collaborationAction };
  }

  /** Load one canonical collaboration action. */
  loadCollaborationAction(actionId: string): CollaborationAction | null {
    const row = this.db.prepare("SELECT * FROM canonical_collaboration_actions WHERE id = ?")
      .get(actionId);
    return row ? this.actionFromRow(row as Record<string, unknown>) : null;
  }

  /** Load the unique collaboration action for one canonical source and native item identity. */
  loadCollaborationActionBySourceProviderIdentity(
    sourceThreadId: string,
    sourceTurnId: string,
    identity: ProviderIdentity,
  ): CollaborationAction | null {
    const parsedIdentity = ProviderIdentitySchema.parse(identity);
    if (parsedIdentity.scope !== "item") {
      throw new Error("Collaboration action lookup requires an item identity");
    }
    const rows = this.db.prepare(`
      SELECT action.*
      FROM canonical_collaboration_actions AS action
      JOIN json_each(action.provider_identities_json) AS provider_identity
        ON json_extract(provider_identity.value, '$.providerId') = ?
       AND json_extract(provider_identity.value, '$.scope') = ?
       AND json_extract(provider_identity.value, '$.value') = ?
      WHERE action.source_thread_id = ?
        AND action.source_turn_id = ?
      LIMIT 2
    `).all(
      parsedIdentity.providerId,
      parsedIdentity.scope,
      parsedIdentity.value,
      sourceThreadId,
      sourceTurnId,
    ) as Record<string, unknown>[];
    if (rows.length > 1) {
      throw new Error(
        `Collaboration action identity is ambiguous: ${sourceThreadId}:${sourceTurnId}:${parsedIdentity.value}`,
      );
    }
    return rows[0] ? this.actionFromRow(rows[0]) : null;
  }

  /** Persist one directional action and its source item without inventing a Provider turn. */
  recordCollaborationAction(input: CollaborationActionInput): CollaborationAction {
    const sourceThread = this.loadThread(input.sourceThreadId);
    const sourceTurn = this.loadTurn(input.sourceTurnId);
    const targetThread = this.loadThread(input.targetThreadId);
    if (!sourceThread || !sourceTurn || sourceTurn.threadId !== sourceThread.id) {
      throw new Error(`Collaboration source turn is not canonical: ${input.sourceTurnId}`);
    }
    if (this.executionIdForTurn(sourceTurn.id) !== input.sourceExecutionId) {
      throw new Error(`Collaboration source execution does not own turn: ${input.sourceTurnId}`);
    }
    if (!targetThread) {
      throw new Error(`Collaboration target thread is not canonical: ${input.targetThreadId}`);
    }

    const now = new Date().toISOString();
    const activeTargetTurn = this.loadActiveTurn(targetThread.id);
    const targetTurn = input.targetTurnId ? this.loadTurn(input.targetTurnId) : null;
    if (targetTurn && targetTurn.threadId !== targetThread.id) {
      throw new Error(`Collaboration target turn is not owned by target thread: ${input.targetTurnId}`);
    }
    if (input.targetTurnId && !targetTurn) {
      throw new Error(`Collaboration target turn is not canonical: ${input.targetTurnId}`);
    }
    const existing = this.loadCollaborationAction(input.actionId);
    const action: CollaborationAction = {
      id: input.actionId,
      kind: input.kind,
      source: {
        threadId: sourceThread.id,
        turnId: sourceTurn.id,
        itemId: input.sourceItemId,
      },
      target: {
        threadId: targetThread.id,
        ...(input.targetTurnId
          ? { turnId: input.targetTurnId }
          : activeTargetTurn ? { turnId: activeTargetTurn.id } : {}),
      },
      status: input.status,
      deliveryUnknown: false,
      providerIdentities: this.uniqueProviderIdentities(input.providerIdentities),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing && (
      existing.kind !== action.kind
      || existing.source.threadId !== action.source.threadId
      || existing.source.turnId !== action.source.turnId
      || existing.source.itemId !== action.source.itemId
      || existing.target.threadId !== action.target.threadId
    )) {
      throw new Error(`Collaboration action identity conflict: ${input.actionId}`);
    }
    const existingItem = this.loadItem(input.sourceItemId);
    if (existingItem && (
      existingItem.threadId !== sourceThread.id || existingItem.turnId !== sourceTurn.id
    )) {
      throw new Error(`Collaboration source item identity conflict: ${input.sourceItemId}`);
    }
    const sourceItem: AgentItem = existingItem ?? {
      id: input.sourceItemId,
      threadId: sourceThread.id,
      turnId: sourceTurn.id,
      kind: "tool-call",
      providerIdentities: [...input.providerIdentities],
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
    };
    const eventSuffix = hashCodexKey(`${input.actionId}:${input.status}:${action.target.turnId ?? "pending"}`);
    this.commit({
      threadId: sourceThread.id,
      turnId: sourceTurn.id,
      executionId: input.sourceExecutionId,
      phase: "running",
      events: [
        ...(existingItem ? [] : [this.itemDraft(input.sourceExecutionId, sourceThread, sourceTurn, sourceItem)]),
        this.actionDraft(
          input.sourceExecutionId,
          sourceThread,
          action,
          `${input.sourceExecutionId}:collaboration:${eventSuffix}`,
        ),
      ],
    });
    return action;
  }

  /** Read one owning parent's unique canonical descendant roster. */
  loadSubagentRoster(request: CanonicalSubagentRosterRequest): CanonicalSubagentRoster {
    const parsedRequest = CanonicalSubagentRosterRequestSchema().parse(request);
    const parent = this.loadThread(parsedRequest.owningParentThreadId);
    if (!parent) {
      return CanonicalSubagentRosterSchema().parse({
        owningParentThreadId: parsedRequest.owningParentThreadId,
        rosterRevision: 0,
        active: [],
        done: [],
      });
    }
    const rows = this.db.prepare(`
      WITH RECURSIVE descendants AS (
        SELECT child.*, 1 AS depth
        FROM canonical_agent_threads child
        WHERE child.parent_thread_id = ?
        UNION ALL
        SELECT child.*, descendants.depth + 1 AS depth
        FROM canonical_agent_threads child
        JOIN descendants ON descendants.id = child.parent_thread_id
        WHERE descendants.depth < ?
      ),
      unique_descendants AS (
        SELECT DISTINCT *
        FROM descendants
      ),
      latest_turns AS (
        SELECT turn.thread_id, turn.status, turn.ended_at, turn.updated_at
        FROM canonical_agent_turns turn
        JOIN unique_descendants descendant ON descendant.id = turn.thread_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM canonical_agent_turns newer
          WHERE newer.thread_id = turn.thread_id
            AND (
              newer.updated_at > turn.updated_at
              OR (newer.updated_at = turn.updated_at AND newer.id > turn.id)
            )
        )
      ),
      first_started_turns AS (
        SELECT thread_id, MIN(started_at) AS started_at
        FROM canonical_agent_turns
        WHERE started_at IS NOT NULL
          AND thread_id IN (SELECT id FROM unique_descendants)
        GROUP BY thread_id
      ),
      classified AS (
        SELECT descendant.*,
          CASE WHEN descendant.activity_state IN ('Starting', 'Active')
            OR latest.status IN ('Pending', 'Running')
            THEN 1 ELSE 0 END AS is_active,
          first_started.started_at AS first_started_at,
          latest.ended_at AS latest_ended_at,
          latest.updated_at AS latest_turn_updated_at
        FROM unique_descendants descendant
        LEFT JOIN latest_turns latest ON latest.thread_id = descendant.id
        LEFT JOIN first_started_turns first_started ON first_started.thread_id = descendant.id
      ),
      active_rows AS (
        SELECT *
        FROM classified
        WHERE is_active = 1
        ORDER BY COALESCE(first_started_at, created_at) ASC, id ASC
        LIMIT ?
      ),
      done_rows AS (
        SELECT *
        FROM classified
        WHERE is_active = 0
        ORDER BY COALESCE(latest_ended_at, latest_turn_updated_at, updated_at) DESC,
          COALESCE(latest_turn_updated_at, updated_at) DESC,
          updated_at DESC,
          id DESC
        LIMIT MAX(0, ? - (SELECT COUNT(*) FROM active_rows))
      )
      SELECT * FROM active_rows
      UNION ALL
      SELECT * FROM done_rows
    `).all(
      parsedRequest.owningParentThreadId,
      CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH - 1,
      parsedRequest.limit,
      parsedRequest.limit,
    ) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return CanonicalSubagentRosterSchema().parse({
        owningParentThreadId: parsedRequest.owningParentThreadId,
        rosterRevision: parent.rosterRevision,
        active: [],
        done: [],
      });
    }

    const threads = rows.map((row) => this.threadFromRow(row));
    const threadIds = threads.map((thread) => thread.id);
    const placeholders = threadIds.map(() => "?").join(", ");
    const turnsByThread = new Map<string, AgentTurn[]>();
    const turnRows = this.db.prepare(`
      SELECT *
      FROM canonical_agent_turns
      WHERE thread_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(...threadIds) as Array<Record<string, unknown>>;
    for (const row of turnRows) {
      const turn = this.turnFromRow(row);
      const turns = turnsByThread.get(turn.threadId) ?? [];
      turns.push(turn);
      turnsByThread.set(turn.threadId, turns);
    }
    const itemRows = this.db.prepare(`
      SELECT *
      FROM canonical_agent_items
      WHERE thread_id IN (${placeholders})
    `).all(...threadIds) as Array<Record<string, unknown>>;
    const actionsByThread = new Map<string, CollaborationAction>();
    const actionRows = this.db.prepare(`
      SELECT *
      FROM canonical_collaboration_actions
      WHERE target_thread_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(...threadIds) as Array<Record<string, unknown>>;
    for (const row of actionRows) {
      const action = this.actionFromRow(row);
      actionsByThread.set(action.target.threadId, action);
    }
    const sourceItemIds = [...new Set(actionRows
      .map((row) => row.source_item_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0))];
    const sourceItemsById = new Map<string, AgentItem>();
    if (sourceItemIds.length > 0) {
      const sourcePlaceholders = sourceItemIds.map(() => "?").join(", ");
      const sourceRows = this.db.prepare(`
        SELECT *
        FROM canonical_agent_items
        WHERE id IN (${sourcePlaceholders})
      `).all(...sourceItemIds) as Array<Record<string, unknown>>;
      for (const row of sourceRows) {
        const item = this.itemFromRow(row);
        sourceItemsById.set(item.id, item);
      }
    }

    const activeIds = new Set<string>();
    const latestTurns = new Map<string, AgentTurn | null>();
    for (const thread of threads) {
      const latest = [...(turnsByThread.get(thread.id) ?? [])]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0]
        ?? null;
      latestTurns.set(thread.id, latest);
      if (
        thread.activityState === "Starting"
        || thread.activityState === "Active"
        || latest?.status === "Pending"
        || latest?.status === "Running"
      ) activeIds.add(thread.id);
    }

    const ancestorChain = (thread: AgentThread): string[] => {
      const chain = [thread.id];
      const seen = new Set(chain);
      let current = thread.parentThreadId;
      while (current && !seen.has(current) && chain.length < CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH) {
        chain.push(current);
        seen.add(current);
        current = threads.find((candidate) => candidate.id === current)?.parentThreadId
          ?? (current === parsedRequest.owningParentThreadId ? undefined : undefined);
      }
      if (!chain.includes(parsedRequest.owningParentThreadId)) chain.push(parsedRequest.owningParentThreadId);
      const lineage = chain.reverse();
      return lineage.length <= CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH
        ? lineage
        : [lineage[0]!, ...lineage.slice(-(CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH - 1))];
    };
    const descendantHasActiveChild = (threadId: string): boolean => threads.some((candidate) => {
      if (!activeIds.has(candidate.id) || candidate.id === threadId) return false;
      let current = candidate.parentThreadId;
      const seen = new Set<string>();
      while (current && !seen.has(current)) {
        if (current === threadId) return true;
        seen.add(current);
        current = threads.find((thread) => thread.id === current)?.parentThreadId;
      }
      return false;
    });
    const maxTimestamp = (values: readonly (string | null | undefined)[], fallback: string): string =>
      values.filter((value): value is string => typeof value === "string")
        .sort((left, right) => right.localeCompare(left))[0] ?? fallback;

    const rosterRows: CanonicalSubagentRosterRow[] = threads.map((thread) => {
      const turns = turnsByThread.get(thread.id) ?? [];
      const latestTurn = latestTurns.get(thread.id) ?? null;
      const action = actionsByThread.get(thread.id);
      const sourceItem = action ? sourceItemsById.get(action.source.itemId) : undefined;
      const sourcePayload = sourceItem?.payload ?? {};
      const itemTimes = itemRows
        .filter((row) => row.thread_id === thread.id)
        .flatMap((row) => [String(row.created_at), String(row.updated_at)]);
      const startedAt = turns
        .map((turn) => turn.startedAt)
        .filter((value): value is string => value !== null)
        .sort()[0] ?? thread.createdAt;
      const updatedAt = maxTimestamp([
        thread.updatedAt,
        ...turns.map((turn) => turn.updatedAt),
        ...itemTimes,
        action?.updatedAt,
      ], thread.updatedAt);
      const endedAt = latestTurn?.endedAt ?? null;
      const providerIdentities = this.uniqueProviderIdentities([
        ...thread.providerIdentities,
        ...(action?.providerIdentities ?? []),
        ...(sourceItem?.providerIdentities ?? []),
      ]);
      const sourceProviderIdentities = this.uniqueProviderIdentities(sourceItem?.providerIdentities ?? []);
      const optionalText = (value: unknown): string | undefined =>
        typeof value === "string" && value.trim().length > 0 ? value : undefined;
      const active = activeIds.has(thread.id);
      return {
        id: thread.id,
        parentThreadId: thread.parentThreadId ?? parsedRequest.owningParentThreadId,
        rootThreadId: thread.rootThreadId,
        owningParentThreadId: thread.owningParentThreadId ?? parsedRequest.owningParentThreadId,
        lineage: ancestorChain(thread),
        activityState: thread.activityState,
        latestTurnStatus: latestTurn?.status ?? null,
        startedAt,
        updatedAt,
        endedAt,
        terminalOutcome: canonicalSubagentTerminalOutcome(latestTurn?.status ?? null),
        ...(action?.source.itemId ? { sourceItemId: action.source.itemId } : {}),
        ...(optionalText(sourcePayload.description) ? { task: sourcePayload.description as string } : {}),
        ...(optionalText(sourcePayload.identity) ? { identity: sourcePayload.identity as string } : {}),
        ...(optionalText(sourcePayload.model) ? { model: sourcePayload.model as string } : {}),
        ...(optionalText(sourcePayload.reasoningEffort)
          ? { reasoning: sourcePayload.reasoningEffort as string }
          : {}),
        providerIdentities,
        sourceProviderIdentities,
        hasActiveDescendant: !active && descendantHasActiveChild(thread.id),
        canStop: false,
      };
    });
    const active = rosterRows
      .filter((row) => activeIds.has(row.id))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
    const done = rosterRows
      .filter((row) => !activeIds.has(row.id))
      .sort((left, right) => (
        (right.endedAt ?? right.updatedAt).localeCompare(left.endedAt ?? left.updatedAt)
        || right.id.localeCompare(left.id)
      ));
    const retainedActive = active.slice(0, parsedRequest.limit);
    const retainedDone = done.slice(0, Math.max(0, parsedRequest.limit - retainedActive.length));
    return CanonicalSubagentRosterSchema().parse({
      owningParentThreadId: parsedRequest.owningParentThreadId,
      rosterRevision: parent.rosterRevision,
      active: retainedActive,
      done: retainedDone,
    });
  }

  /** Resolve one owned child and its latest native identities without mutating canonical state. */
  loadCanonicalChildStopTarget(request: CanonicalSubagentStopRequest): CanonicalChildStopTarget | null {
    const rows = this.db.prepare(`
      WITH RECURSIVE descendants(id, depth) AS (
        SELECT id, 1
        FROM canonical_agent_threads
        WHERE id = ?
        UNION ALL
        SELECT child.id, descendants.depth + 1
        FROM canonical_agent_threads child
        JOIN descendants ON descendants.id = child.parent_thread_id
        WHERE descendants.depth < ?
      )
      SELECT child.*
      FROM canonical_agent_threads child
      WHERE child.id = ?
        AND child.id IN (SELECT id FROM descendants)
        AND child.id <> ?
        AND child.owning_parent_thread_id = ?
      LIMIT 1
    `).all(
      request.owningParentThreadId,
      CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH - 1,
      request.childThreadId,
      request.owningParentThreadId,
      request.owningParentThreadId,
    ) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return null;
    const childThread = this.threadFromRow(row);
    const turnRows = this.db.prepare(`
      SELECT *
      FROM canonical_agent_turns
      WHERE thread_id = ?
      ORDER BY updated_at DESC, id DESC
    `).all(childThread.id) as Array<Record<string, unknown>>;
    const latestTurn = turnRows[0] ? this.turnFromRow(turnRows[0]) : null;
    const nativeThreadId = childThread.providerIdentities.find((identity) => (
      identity.providerId === childThread.providerId
      && identity.scope === "thread"
      && identity.provenance === "native"
    ))?.value ?? null;
    const nativeTurnId = latestTurn?.providerIdentities.find((identity) => (
      identity.providerId === childThread.providerId
      && identity.scope === "turn"
      && identity.provenance === "native"
    ))?.value ?? null;
    return { childThread, latestTurn, nativeThreadId, nativeTurnId };
  }

  /** Load bounded active descendants so parent stop can evaluate each target independently. */
  loadCanonicalChildStopTargets(owningParentThreadId: string): CanonicalChildStopTarget[] {
    const rows = this.db.prepare(`
      WITH RECURSIVE descendants(id, depth) AS (
        SELECT id, 1
        FROM canonical_agent_threads
        WHERE parent_thread_id = ?
        UNION ALL
        SELECT child.id, descendants.depth + 1
        FROM canonical_agent_threads child
        JOIN descendants ON descendants.id = child.parent_thread_id
        WHERE descendants.depth < ?
      ), latest_turns AS (
        SELECT turns.thread_id, turns.status,
          ROW_NUMBER() OVER (PARTITION BY turns.thread_id ORDER BY turns.updated_at DESC, turns.id DESC) AS row_number
        FROM canonical_agent_turns turns
        JOIN descendants ON descendants.id = turns.thread_id
      )
      SELECT descendants.id
      FROM descendants
      JOIN latest_turns ON latest_turns.thread_id = descendants.id AND latest_turns.row_number = 1
      WHERE latest_turns.status = 'Running'
      ORDER BY depth DESC, id ASC
      LIMIT ?
    `).all(
      owningParentThreadId,
      CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH - 1,
      CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
    ) as Array<{ id: string }>;
    return rows.flatMap(({ id }) => {
      const target = this.loadCanonicalChildStopTarget({
        owningParentThreadId,
        childThreadId: id,
      });
      return target ? [target] : [];
    });
  }

  /** Provision one Starting child and one directional Dispatched action exactly once. */
  startCodexChildDelegation(input: CodexChildDelegationInput): CodexChildDelegation {
    const normalizedDescription = typeof input.description === "string"
      ? input.description.trim().slice(0, CANONICAL_SUBAGENT_TASK_MAX_LENGTH) || undefined
      : undefined;
    const normalizedIdentity = resolveSubagentDisplayName({ agentName: input.identity });
    const normalizedModel = resolveSubagentMetadata(input.model);
    const normalizedReasoningEffort = resolveSubagentMetadata(input.reasoningEffort);
    const normalizedPrompt = typeof input.prompt === "string"
      ? input.prompt.trim().slice(0, CANONICAL_SUBAGENT_TASK_MAX_LENGTH) || undefined
      : undefined;
    const existing = this.loadCodexChildDelegation(input.parentThreadId, input.parentItemId);
    if (existing) {
      const updatedPayload = {
        ...existing.parentItem.payload,
        ...(normalizedDescription !== undefined ? { description: normalizedDescription } : {}),
        ...(normalizedIdentity !== undefined ? { identity: normalizedIdentity } : {}),
        ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
        ...(normalizedReasoningEffort !== undefined
          ? { reasoningEffort: normalizedReasoningEffort }
          : {}),
      };
      const providerIdentities = this.uniqueProviderIdentities([
        ...existing.parentItem.providerIdentities,
        ...input.providerIdentities,
      ]);
      if (
        JSON.stringify(updatedPayload) === JSON.stringify(existing.parentItem.payload)
        && JSON.stringify(providerIdentities) === JSON.stringify(existing.parentItem.providerIdentities)
      ) {
        this.recordLateCodexChildPrompt(existing, normalizedPrompt);
        return existing;
      }

      const parentThread = this.loadThread(input.parentThreadId);
      const parentTurn = this.loadTurn(input.parentTurnId);
      if (!parentThread || !parentTurn || parentTurn.threadId !== parentThread.id) {
        throw new Error(`Codex parent turn is not canonical: ${input.parentTurnId}`);
      }
      const updatedParentItem: AgentItem = {
        ...existing.parentItem,
        providerIdentities,
        payload: updatedPayload,
        updatedAt: new Date().toISOString(),
      };
      const metadataKey = hashCodexKey(JSON.stringify({
        previousUpdatedAt: existing.parentItem.updatedAt,
        description: normalizedDescription,
        identity: normalizedIdentity,
        model: normalizedModel,
        reasoningEffort: normalizedReasoningEffort,
        providerIdentities,
      }));
      this.commit({
        threadId: parentThread.id,
        turnId: parentTurn.id,
        executionId: input.parentExecutionId,
        phase: "running",
        events: [this.itemDraft(
          input.parentExecutionId,
          parentThread,
          parentTurn,
          updatedParentItem,
          `${input.parentExecutionId}:codex-child:${hashCodexKey(input.parentItemId)}:metadata:${metadataKey}`,
        )],
      });
      const updated = { ...existing, parentItem: updatedParentItem };
      this.recordLateCodexChildPrompt(updated, normalizedPrompt);
      return updated;
    }
    const parentThread = this.loadThread(input.parentThreadId);
    const parentTurn = this.loadTurn(input.parentTurnId);
    if (!parentThread || !parentTurn || parentTurn.threadId !== parentThread.id) {
      throw new Error(`Codex parent turn is not canonical: ${input.parentTurnId}`);
    }
    const now = new Date().toISOString();
    const childThread: AgentThread = {
      id: `thread:codex-child:${randomUUID()}`,
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
    const receiverThreadIds = [...new Set(input.receiverThreadIds ?? [])].filter(Boolean);
    const receiverIdentities = receiverThreadIds.map((value) => this.codexReceiverIdentity(value));
    const parentItem: AgentItem = {
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
        ...(input.replacementForActionId
          ? { replacementForActionId: input.replacementForActionId }
          : {}),
        ...(normalizedDescription !== undefined ? { description: normalizedDescription } : {}),
        ...(normalizedIdentity !== undefined ? { identity: normalizedIdentity } : {}),
        ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
        ...(normalizedReasoningEffort !== undefined
          ? { reasoningEffort: normalizedReasoningEffort }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
    const collaborationAction: CollaborationAction = {
      id: `collaboration:codex:${hashCodexKey(`${parentThread.id}:${input.parentItemId}`)}`,
      kind: "delegate",
      source: { threadId: parentThread.id, turnId: parentTurn.id, itemId: parentItem.id },
      target: { threadId: childThread.id },
      status: "Dispatched",
      deliveryUnknown: false,
      providerIdentities: this.uniqueProviderIdentities([
        ...input.providerIdentities,
        ...receiverIdentities,
      ]),
      createdAt: now,
      updatedAt: now,
    };
    this.commit({
      threadId: parentThread.id,
      turnId: parentTurn.id,
      executionId: input.parentExecutionId,
      phase: "running",
      projectCompatibility: () => this.ensureCodexCompatibilityThread(childThread),
      events: [
        {
          eventId: `${input.parentExecutionId}:codex-child:${hashCodexKey(input.parentItemId)}:thread`,
          routing: { threadId: parentThread.id, executionId: input.parentExecutionId },
          sourceProviderId: parentThread.providerId,
          sourceIdentities: [...input.providerIdentities],
          rosterRevision: parentThread.rosterRevision + 1,
          payload: { type: "child-thread.recorded", parentThreadId: parentThread.id, childThread },
        },
        this.itemDraft(input.parentExecutionId, parentThread, parentTurn, parentItem),
        this.actionDraft(input.parentExecutionId, parentThread, collaborationAction),
      ],
    });
    return { childThread, parentItem, collaborationAction };
  }

  private recordLateCodexChildPrompt(
    delegation: CodexChildDelegation,
    prompt: string | undefined,
  ): void {
    const turnId = delegation.collaborationAction.target.turnId;
    if (!prompt || !turnId) return;
    const childTurn = this.loadTurn(turnId);
    if (!childTurn || childTurn.threadId !== delegation.childThread.id) return;
    const promptItemId = `item:codex-child-prompt:${hashCodexKey(turnId)}`;
    if (this.loadItem(promptItemId)) return;

    const now = new Date().toISOString();
    const action = delegation.collaborationAction;
    const executionId = this.executionIdForTurn(turnId);
    const item: AgentItem = {
      id: promptItemId,
      threadId: delegation.childThread.id,
      turnId,
      kind: "message",
      providerIdentities: childTurn.providerIdentities,
      payload: {
        projection: "message",
        message: {
          id: `codex-child-prompt:${hashCodexKey(turnId)}`,
          role: "user",
          content: prompt,
          thread_id: delegation.childThread.id,
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: null,
          timestamp: now,
          sequence: this.nextChildMessageSequence(delegation.childThread.id),
          attachments: null,
          parentAgentProvenance: {
            parentThreadId: action.source.threadId,
            parentTurnId: action.source.turnId,
            parentItemId: action.source.itemId,
            providerIdentities: action.providerIdentities,
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    this.commit({
      threadId: delegation.childThread.id,
      turnId,
      executionId,
      phase: "running",
      events: [this.itemDraft(executionId, delegation.childThread, childTurn, item)],
    });
  }

  /** Mark a child delivery as unknown without making the uncertain child reusable. */
  markCodexChildDeliveryUnknown(input: CodexChildDeliveryInput): CodexChildDelegation {
    return this.updateCodexChildDelivery(input, "unknown");
  }

  /** Mark a provider-confirmed child rejection as failed and unavailable. */
  markCodexChildDeliveryRejected(input: CodexChildDeliveryInput): CodexChildDelegation {
    return this.updateCodexChildDelivery(input, "rejected");
  }

  /** Mark dispatched child deliveries as uncertain when their owning execution cannot be resumed. */
  markUnresolvedCodexChildDeliveriesUnknown(executionId: string): string[] {
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
    `).all(executionId, MAX_TURN_RECOVERIES + 1) as Record<string, unknown>[];
    if (rows.length > MAX_TURN_RECOVERIES) {
      throw new Error(`Canonical unresolved child delivery count exceeds ${MAX_TURN_RECOVERIES}`);
    }
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const actionIds: string[] = [];
    for (const row of rows) {
      const action = this.actionFromRow(row);
      const sourceThread = this.loadThread(action.source.threadId);
      const childThread = this.loadThread(action.target.threadId);
      if (!sourceThread || !childThread) {
        throw new Error(`Canonical unresolved child delivery is incomplete: ${action.id}`);
      }
      const updatedAction: CollaborationAction = {
        ...action,
        status: "Dispatched",
        deliveryUnknown: true,
        updatedAt: now,
      };
      this.commitCodexChildDeliveryState({
        parentThread: sourceThread,
        childThread,
        action: updatedAction,
        sourceExecutionId: executionId,
        now,
        outcome: "unknown",
      });
      actionIds.push(action.id);
    }
    return actionIds;
  }

  /** Create a linked replacement child for a failed or uncertain delivery. */
  retryCodexChildDelegation(input: CodexChildRetryInput): CodexChildDelegation {
    const previous = this.loadCollaborationAction(input.previousActionId);
    if (!previous) throw new Error(`Codex child action not found: ${input.previousActionId}`);
    if (previous.source.threadId !== input.parentThreadId) {
      throw new Error(`Codex child retry source thread conflict: ${input.previousActionId}`);
    }
    if (previous.status !== "Failed" && !previous.deliveryUnknown) {
      throw new Error(`Codex child action is not retryable: ${input.previousActionId}`);
    }
    return this.startCodexChildDelegation({
      ...input,
      replacementForActionId: input.previousActionId,
    });
  }

  private updateCodexChildDelivery(
    input: CodexChildDeliveryInput,
    outcome: "unknown" | "rejected",
  ): CodexChildDelegation {
    const delegation = this.loadCodexChildDelegation(input.parentThreadId, input.parentItemId);
    if (!delegation) throw new Error(`Codex child delegation not found: ${input.parentItemId}`);
    const action = delegation.collaborationAction;
    if (outcome === "unknown" && action.status === "Failed" && !action.deliveryUnknown) {
      throw new Error(`Cannot replace confirmed Codex child rejection: ${action.id}`);
    }
    if (outcome === "rejected" && action.status === "Acknowledged" && !action.deliveryUnknown) {
      throw new Error(`Cannot reject acknowledged Codex child delivery: ${action.id}`);
    }
    if ((outcome === "unknown" && action.deliveryUnknown)
      || (outcome === "rejected" && action.status === "Failed" && !action.deliveryUnknown)) {
      return delegation;
    }
    const now = new Date().toISOString();
    const updatedAction: CollaborationAction = {
      ...action,
      status: outcome === "rejected" ? "Failed" : "Dispatched",
      deliveryUnknown: outcome === "unknown",
      updatedAt: now,
    };
    const parentThread = this.loadThread(input.parentThreadId);
    if (!parentThread) throw new Error(`Codex parent thread not found: ${input.parentThreadId}`);
    if (action.source.turnId !== input.parentTurnId) {
      throw new Error(`Codex child delivery source turn conflict: ${input.parentItemId}`);
    }
    const sourceExecutionId = this.executionIdForTurn(action.source.turnId);
    this.commitCodexChildDeliveryState({
      parentThread,
      childThread: delegation.childThread,
      action: updatedAction,
      sourceExecutionId,
      now,
      outcome,
    });
    return {
      ...delegation,
      childThread: {
        ...delegation.childThread,
        activityState: "Unavailable",
        updatedAt: now,
      },
      collaborationAction: updatedAction,
    };
  }

  private commitCodexChildDeliveryState(input: {
    parentThread: AgentThread;
    childThread: AgentThread;
    action: CollaborationAction;
    sourceExecutionId: string;
    now: string;
    outcome: "unknown" | "rejected";
  }): { parent: CanonicalAgentCommitResult; child: CanonicalAgentCommitResult } {
    const updatedParent: AgentThread = {
      ...input.parentThread,
      rosterRevision: input.parentThread.rosterRevision + 1,
      updatedAt: input.now,
    };
    const updatedChild: AgentThread = {
      ...input.childThread,
      activityState: "Unavailable",
      updatedAt: input.now,
    };
    const childExecutionId = deterministicUuid(
      `${input.sourceExecutionId}:codex-child:${input.action.id}:${input.outcome}`,
    );
    const committed = this.db.transaction(() => {
      const parent = this.commitInsideTransaction({
        threadId: input.parentThread.id,
        turnId: input.action.source.turnId,
        executionId: input.sourceExecutionId,
        phase: "running",
        events: [
          {
            eventId: `${childExecutionId}:parent-thread`,
            routing: { threadId: input.parentThread.id, executionId: input.sourceExecutionId },
            sourceProviderId: input.parentThread.providerId,
            sourceIdentities: input.parentThread.providerIdentities,
            payload: { type: "thread.recorded", thread: updatedParent },
          },
          this.actionDraft(
            input.sourceExecutionId,
            input.parentThread,
            input.action,
            `${childExecutionId}:action`,
          ),
        ],
      });
      const child = this.commitInsideTransaction({
        threadId: input.childThread.id,
        turnId: input.action.source.turnId,
        executionId: childExecutionId,
        phase: "delivery",
        persistCheckpoint: false,
        events: [{
          eventId: `${childExecutionId}:child-thread`,
          routing: { threadId: input.childThread.id, executionId: childExecutionId },
          sourceProviderId: input.childThread.providerId,
          sourceIdentities: input.childThread.providerIdentities,
          payload: { type: "thread.recorded", thread: updatedChild },
        }],
      });
      return { parent, child };
    })();
    this.recordCanonicalDiagnostics([...committed.parent.events, ...committed.child.events]);
    this.publishEventGroups([committed.parent.events, committed.child.events]);
    return committed;
  }

  private assertCodexChildDeliveryCanBeAcknowledged(action: CollaborationAction): void {
    if (action.status === "Failed" && !action.deliveryUnknown) {
      throw new Error(`Cannot acknowledge confirmed Codex child rejection: ${action.id}`);
    }
  }

  /** Add exact Codex receiver-thread identities to a provisional delegation. */
  registerCodexReceiverThreadIds(
    input: CodexChildIdentityInput & { receiverThreadIds: readonly string[] },
  ): CodexChildDelegation {
    const delegation = this.loadCodexChildDelegation(input.parentThreadId, input.parentItemId);
    if (!delegation) throw new Error(`Codex child delegation not found: ${input.parentItemId}`);
    this.assertCodexChildDeliveryCanBeAcknowledged(delegation.collaborationAction);
    const existingNativeThread = delegation.childThread.providerIdentities.find((identity) => (
      identity.providerId === "codex" && identity.scope === "thread"
    ));
    if (existingNativeThread && existingNativeThread.value !== input.nativeThreadId) {
      throw new Error(`Codex child native thread identity conflict: ${input.parentItemId}`);
    }
    const identities = this.uniqueProviderIdentities([
      ...delegation.collaborationAction.providerIdentities,
      ...input.receiverThreadIds.filter(Boolean).map((value) => this.codexReceiverIdentity(value)),
    ]);
    const updatedAction: CollaborationAction = {
      ...delegation.collaborationAction,
      providerIdentities: identities,
      updatedAt: new Date().toISOString(),
    };
    if (JSON.stringify(updatedAction.providerIdentities)
      === JSON.stringify(delegation.collaborationAction.providerIdentities)) return delegation;
    const receiverKey = identities
      .filter((identity) => identity.scope === "parentItem")
      .map((identity) => identity.value)
      .sort()
      .join("|");
    this.commitParentCodexAction(input, updatedAction, `receivers:${hashCodexKey(receiverKey)}`);
    return { ...delegation, collaborationAction: updatedAction };
  }

  /** Bind a child only when its native thread identity is an exact registered receiver. */
  bindCodexChildIdentity(input: CodexChildIdentityInput): CodexChildDelegation {
    const delegation = this.loadCodexChildDelegation(input.parentThreadId, input.parentItemId);
    if (!delegation) throw new Error(`Codex child delegation not found: ${input.parentItemId}`);
    this.assertCodexChildDeliveryCanBeAcknowledged(delegation.collaborationAction);
    const receiver = this.codexReceiverIdentity(input.nativeThreadId);
    const hasReceiver = delegation.collaborationAction.providerIdentities.some((identity) => (
      identity.providerId === receiver.providerId
      && identity.scope === receiver.scope
      && identity.value === receiver.value
    ));
    if (!hasReceiver) {
      throw new Error(`Codex child identity is not a registered receiver: ${input.nativeThreadId}`);
    }
    const existing = delegation.childThread.providerIdentities.find((identity) => (
      identity.providerId === "codex" && identity.scope === "thread"
    ));
    if (existing && existing.value !== input.nativeThreadId) {
      throw new Error(`Codex child native thread identity conflict: ${input.parentItemId}`);
    }
    if (existing) {
      if (delegation.collaborationAction.status === "Acknowledged") return delegation;
      const acknowledged: CollaborationAction = {
        ...delegation.collaborationAction,
        status: "Acknowledged",
        deliveryUnknown: false,
        updatedAt: new Date().toISOString(),
      };
      this.commitParentCodexAction(input, acknowledged, "acknowledge");
      return { ...delegation, collaborationAction: acknowledged };
    }
    const boundThread: AgentThread = {
      ...delegation.childThread,
      providerIdentities: [...delegation.childThread.providerIdentities, {
        providerId: "codex",
        scope: "thread",
        value: input.nativeThreadId,
        provenance: "native",
      }],
      updatedAt: new Date().toISOString(),
    };
    const acknowledged: CollaborationAction = {
      ...delegation.collaborationAction,
      status: "Acknowledged",
      deliveryUnknown: false,
      updatedAt: boundThread.updatedAt,
    };
    this.commitParentCodexBinding(input, boundThread, acknowledged);
    return {
      childThread: boundThread,
      parentItem: delegation.parentItem,
      collaborationAction: acknowledged,
    };
  }

  /** Create and start the canonical child turn after exact native turn evidence. */
  startCodexChildTurn(input: CodexChildTurnStartInput): AgentTurn {
    const delegation = this.bindCodexChildIdentity(input);
    const childThread = delegation.childThread.providerIdentities.some((identity) => (
      identity.providerId === "codex" && identity.scope === "thread" && identity.value === input.nativeThreadId
    ))
      ? delegation.childThread
      : this.loadCodexChildDelegation(input.parentThreadId, input.parentItemId)?.childThread;
    if (!childThread) throw new Error(`Codex child thread not found: ${input.parentItemId}`);
    const existing = this.loadCodexChildTurn(childThread.id, input.nativeTurnId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const turnId = `turn:codex-child:${randomUUID()}`;
    const executionId = randomUUID();
    const sourceIdentities = [
      ...childThread.providerIdentities,
      {
        providerId: "codex",
        scope: "turn" as const,
        value: input.nativeTurnId,
        provenance: "native" as const,
      },
    ];
    const triggerAction = input.triggerActionId
      ? this.loadCollaborationAction(input.triggerActionId)
      : delegation.collaborationAction;
    if (!triggerAction || triggerAction.target.threadId !== childThread.id) {
      throw new Error(`Codex child trigger action does not target child: ${input.triggerActionId}`);
    }
    this.assertCodexChildDeliveryCanBeAcknowledged(triggerAction);
    const updatedAction: CollaborationAction = {
      ...triggerAction,
      target: { threadId: childThread.id, turnId },
      status: "Acknowledged",
      deliveryUnknown: false,
      updatedAt: now,
    };
    const parentThread = this.loadThread(input.parentThreadId);
    if (!parentThread) throw new Error(`Codex parent thread not found: ${input.parentThreadId}`);
    const childTurn: AgentTurn = {
      id: turnId,
      threadId: childThread.id,
      status: "Pending",
      trigger: {
        kind: "child",
        sourceThreadId: triggerAction.source.threadId,
        sourceTurnId: triggerAction.source.turnId,
        sourceItemId: triggerAction.source.itemId,
      },
      permissionMode: "full",
      providerIdentities: sourceIdentities,
      startedAt: null,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const promptItem: AgentItem | undefined = input.prompt !== undefined
      ? {
          id: `item:codex-child-prompt:${hashCodexKey(turnId)}`,
          threadId: childThread.id,
          turnId,
          kind: "message",
          providerIdentities: sourceIdentities,
          payload: {
            projection: "message",
            message: {
              id: `codex-child-prompt:${hashCodexKey(turnId)}`,
              role: "user",
              content: input.prompt,
              thread_id: childThread.id,
              tool_calls: null,
              files_changed: null,
              cost_usd: null,
              tokens_used: null,
              timestamp: now,
              sequence: this.nextChildMessageSequence(childThread.id),
              attachments: null,
              parentAgentProvenance: {
                parentThreadId: triggerAction.source.threadId,
                parentTurnId: triggerAction.source.turnId,
                parentItemId: triggerAction.source.itemId,
                providerIdentities: triggerAction.providerIdentities,
              },
            },
          },
          createdAt: now,
          updatedAt: now,
        }
      : undefined;
    const childEvents: CanonicalAgentEventDraft[] = [
      {
        eventId: `${executionId}:thread-active`,
        routing: { threadId: childThread.id, executionId },
        sourceProviderId: "codex",
        sourceIdentities,
        payload: {
          type: "thread.recorded",
          thread: { ...childThread, activityState: "Active", updatedAt: now },
        },
      },
      {
        eventId: `${executionId}:turn-created`,
        routing: { threadId: childThread.id, turnId, executionId },
        sourceProviderId: "codex",
        sourceIdentities,
        payload: { type: "turn.created", turn: childTurn },
      },
      {
        eventId: `${executionId}:turn-started`,
        routing: { threadId: childThread.id, turnId, executionId },
        sourceProviderId: "codex",
        sourceIdentities,
        payload: { type: "turn.started", startedAt: now },
      },
      ...(promptItem ? [this.itemDraft(executionId, childThread, childTurn, promptItem)] : []),
    ];
    const actionSourceThread = this.loadThread(triggerAction.source.threadId);
    if (!actionSourceThread) {
      throw new Error(`Codex child action source thread not found: ${triggerAction.source.threadId}`);
    }
    const actionExecutionId = this.executionIdForTurn(triggerAction.source.turnId);
    const transaction = this.db.transaction(() => {
      const childResult = this.commitInsideTransaction({
        threadId: childThread.id,
        turnId,
        executionId,
        phase: "running",
        events: childEvents,
      });
      const parentResult = this.commitInsideTransaction({
        threadId: actionSourceThread.id,
        turnId: triggerAction.source.turnId,
        executionId: actionExecutionId,
        phase: "running",
        events: [this.actionDraft(
          actionExecutionId,
          actionSourceThread,
          updatedAction,
          `${actionExecutionId}:codex-child:${hashCodexKey(input.nativeTurnId)}:turn`,
        )],
      });
      return { childResult, parentResult };
    });
    const committed = transaction();
    const published = [...committed.childResult.events, ...committed.parentResult.events];
    this.recordCanonicalDiagnostics(published);
    this.publishEventGroups([committed.childResult.events, committed.parentResult.events]);
    const turn = this.loadTurn(turnId);
    if (!turn) throw new Error(`Codex child turn was not persisted: ${turnId}`);
    this.cacheTurnExecution(executionId, turn.id);
    return turn;
  }

  /** Persist one child message, reasoning item, tool call, or tool result exactly once. */
  recordCodexChildItem(input: CodexChildItemInput): AgentItem {
    const turn = this.loadCodexChildTurn(input.childThreadId, input.nativeTurnId);
    if (!turn) throw new Error(`Codex child turn not found: ${input.nativeTurnId}`);
    const itemId = `item:codex-child:${hashCodexKey(`${turn.id}:${input.nativeItemId}:${input.eventKey}:${input.kind}`)}`;
    const existing = this.loadItem(itemId);
    if (existing) {
      const existingMessage = existing.payload.message;
      const inputMessage = input.payload.message;
      const inputMessageSource = inputMessage && typeof inputMessage === "object"
        ? inputMessage as Record<string, unknown>
        : input.payload;
      const sameMessage = input.kind === "message"
        && existing.payload.projection === "message"
        && input.payload.projection === "message"
        && existingMessage && typeof existingMessage === "object"
        && (existingMessage as Record<string, unknown>).content
          === inputMessageSource.content
        && (inputMessageSource.role ?? "assistant")
          === ((existingMessage as Record<string, unknown>).role ?? "assistant");
      if (input.kind !== "message" && JSON.stringify(existing.payload)
        !== JSON.stringify({ ...input.payload, nativeItemId: input.nativeItemId, eventKey: input.eventKey })) {
        throw new Error(`Codex child item identity conflict: ${itemId}`);
      }
      if (input.kind === "message" && !sameMessage) {
        throw new Error(`Codex child item identity conflict: ${itemId}`);
      }
      return existing;
    }
    const thread = this.loadThread(input.childThreadId);
    if (!thread) throw new Error(`Codex child thread not found: ${input.childThreadId}`);
    const now = new Date().toISOString();
    const payload = input.kind === "message"
      ? this.normalizeCodexChildMessagePayload(thread, input.payload)
      : input.payload;
    const item: AgentItem = {
      id: itemId,
      threadId: thread.id,
      turnId: turn.id,
      ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}),
      kind: input.kind,
      providerIdentities: turn.providerIdentities,
      payload: {
        ...payload,
        nativeItemId: input.nativeItemId,
        eventKey: input.eventKey,
      },
      createdAt: now,
      updatedAt: now,
    };
    this.commit({
      threadId: thread.id,
      turnId: turn.id,
      executionId: this.executionIdForTurn(turn.id),
      phase: "running",
      events: [this.itemDraft(this.executionIdForTurn(turn.id), thread, turn, item)],
    });
    return item;
  }

  /**
   * Upsert the current structured parent narrative recovery projection before
   * its corresponding provider event reaches the renderer.
   */
  recordParentNarrativeRecovery(
    input: ParentNarrativeRecoveryCommitInput,
  ): boolean {
    const turn = this.loadTurnByExecution(input.executionId);
    if (!turn) return false;
    const thread = this.loadThread(turn.threadId);
    if (!thread) throw new Error(`Canonical parent thread not found: ${turn.threadId}`);
    const items = input.items;
    if (items.length === 0 && (input.discardedItemIds?.length ?? 0) === 0) return true;
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const checkpoint = this.loadCheckpoint(input.executionId);
      if (!checkpoint) throw new Error(`Canonical parent checkpoint was not found: ${input.executionId}`);
      if (checkpoint.terminalOutcome) return;
      for (const item of items) {
        const itemId = item.kind === "toolCall"
          ? `toolCall:${item.record.id}`
          : `${item.kind}:${item.record.id}`;
        const parentItemId = item.kind === "toolCall" && item.record.parent_tool_call_id
          ? `toolCall:${item.record.parent_tool_call_id}`
          : undefined;
        const existingPayload = this.loadItem(itemId)?.payload ?? {};
        const subagentMetadata = item.kind === "toolCall" ? {
          ...(typeof existingPayload.description === "string"
            ? { description: existingPayload.description }
            : {}),
          ...(typeof existingPayload.identity === "string"
            ? { identity: existingPayload.identity }
            : {}),
          ...(typeof existingPayload.model === "string"
            ? { model: existingPayload.model }
            : {}),
          ...(typeof existingPayload.reasoningEffort === "string"
            ? { reasoningEffort: existingPayload.reasoningEffort }
            : {}),
        } : {};
        const itemPayload = {
          projection: "narrativeRecovery",
          narrative: item,
          ...subagentMetadata,
        };
        this.persistItem({
          id: itemId,
          threadId: thread.id,
          turnId: turn.id,
          ...(parentItemId ? { parentItemId } : {}),
          kind: item.kind === "toolCall"
            ? "tool-call"
            : item.kind === "narrationSegment"
              ? "reasoning"
              : "system",
          providerIdentities: turn.providerIdentities,
          payload: itemPayload,
          createdAt: item.record.started_at,
          updatedAt: now,
        });
      }
      for (const itemId of input.discardedItemIds ?? []) {
        const existing = this.loadItem(itemId);
        if (!existing || existing.threadId !== thread.id || existing.turnId !== turn.id) {
          throw new Error(`Canonical narrative recovery item was not found: ${itemId}`);
        }
        const projection = typeof existing.payload.projection === "string"
          ? existing.payload.projection
          : null;
        if (projection === "narrativeRecovery" || projection === "narrativeRecoveryDiscarded") {
          this.db.prepare("DELETE FROM canonical_agent_items WHERE id = ?").run(itemId);
        }
      }
    });
    transaction();
    return true;
  }

  /** Load the newest durable structured narrative snapshot for an unfinished parent turn. */
  loadParentNarrativeRecovery(turnId: string): ParentNarrativeRecoveryItem[] {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM canonical_agent_items
      WHERE turn_id = ?
        AND json_extract(payload_json, '$.projection') = 'narrativeRecovery'
      ORDER BY created_at ASC, id ASC
    `).all(turnId) as Array<{ payload_json: string }>;
    return rows.map((row) => (
      ParentNarrativeRecoveryItemSchema().parse(
        (JSON.parse(row.payload_json) as { narrative: unknown }).narrative,
      )
    )).sort((left, right) => (
      left.record.sort_order - right.record.sort_order || left.record.id.localeCompare(right.record.id)
    ));
  }

  /** Persist one child terminal outcome while preserving the first terminal state. */
  finishCodexChildTurn(input: CodexChildTurnFinishInput): AgentTurn {
    const turn = this.loadCodexChildTurn(input.childThreadId, input.nativeTurnId);
    if (!turn) throw new Error(`Codex child turn not found: ${input.nativeTurnId}`);
    if (["Completed", "Cancelled", "Interrupted", "Errored"].includes(turn.status)) return turn;
    return this.finishCanonicalChildTurnRecord(turn, input.outcome, input.error);
  }

  /** Terminalize the latest running canonical child turn by its durable thread identity. */
  finishCanonicalChildTurn(input: CanonicalChildTurnFinishInput): AgentTurn | null {
    const row = this.db.prepare(`
      SELECT *
      FROM canonical_agent_turns
      WHERE thread_id = ? AND status = 'Running'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(input.childThreadId);
    if (!row) return null;
    return this.finishCanonicalChildTurnRecord(
      this.turnFromRow(row as Record<string, unknown>),
      input.outcome,
      input.error,
    );
  }

  private finishCanonicalChildTurnRecord(
    turn: AgentTurn,
    outcome: CodexChildTurnFinishInput["outcome"],
    error: string | undefined,
  ): AgentTurn {
    const thread = this.loadThread(turn.threadId);
    if (!thread) throw new Error(`Codex child thread not found: ${turn.threadId}`);
    const executionId = this.executionIdForTurn(turn.id);
    const endedAt = new Date().toISOString();
    const payload: CanonicalAgentEvent = outcome === "completed"
      ? { type: "turn.completed", endedAt }
      : outcome === "cancelled"
        ? { type: "turn.cancelled", endedAt, reason: error ?? "Child turn cancelled" }
        : outcome === "interrupted"
          ? { type: "turn.interrupted", endedAt, reason: error ?? "Child turn interrupted" }
          : { type: "turn.errored", endedAt, error: error ?? "Child turn failed" };
    this.commit({
      threadId: thread.id,
      turnId: turn.id,
      executionId,
      phase: outcome,
      terminalOutcome: outcome,
      error,
      replayGuard: "terminal-confirmed",
      events: [
        {
          eventId: `${executionId}:thread-idle`,
          routing: { threadId: thread.id, executionId },
          sourceProviderId: "codex",
          sourceIdentities: thread.providerIdentities,
          payload: {
            type: "thread.recorded",
            thread: { ...thread, activityState: "Idle", updatedAt: endedAt },
          },
        },
        {
          eventId: `${executionId}:turn-terminal`,
          routing: { threadId: thread.id, turnId: turn.id, executionId },
          sourceProviderId: "codex",
          sourceIdentities: thread.providerIdentities,
          payload,
        },
      ],
    });
    const finished = this.loadTurn(turn.id);
    if (!finished) throw new Error(`Codex child terminal state was not persisted: ${turn.id}`);
    return finished;
  }

  /** Commit the first terminal result and its message and narrative projection. */
  finishParentTurn(input: CanonicalParentTurnFinishInput): CanonicalAgentCommitResult {
    let projection: CanonicalParentTurnProjection | null = null;
    const endedAt = new Date().toISOString();
    return this.commit({
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
      events: () => this.parentTurnTerminalEvents(input, projection, endedAt),
    });
  }

  /** Load the accepted user input for one canonical turn. */
  loadUserMessage(turnId: string): Message | null {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM canonical_agent_items
      WHERE turn_id = ?
        AND kind = 'message'
        AND json_extract(payload_json, '$.projection') = 'message'
        AND json_extract(payload_json, '$.message.role') = 'user'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(turnId) as { payload_json: string } | undefined;
    return row
      ? (JSON.parse(row.payload_json) as { message: Message }).message
      : null;
  }

  /** Persist a native provider cursor for an unfinished execution. */
  recordNativeCursor(executionId: string, nativeCursor: ProviderIdentity): boolean {
    const cursor = ProviderIdentitySchema.parse(nativeCursor);
    const result = this.db.prepare(`
      UPDATE canonical_agent_ingest_checkpoints
      SET native_cursor_json = ?, updated_at = ?
      WHERE execution_id = ?
        AND terminal_outcome IS NULL
    `).run(JSON.stringify(cursor), new Date().toISOString(), executionId);
    return result.changes === 1;
  }

  /** Record that one unfinished execution cannot be proved safe after restart. */
  interruptUnfinishedExecution(
    executionId: string,
    reason: string,
    stagedAssistant?: Message,
    finalizeCompatibility?: (
      assistant: Message,
      narrative: readonly ParentNarrativeRecoveryItem[],
    ) => void,
    recoveredNarrative: readonly ParentNarrativeRecoveryItem[] = [],
  ): CanonicalAgentCommitResult {
    const checkpoint = this.loadCheckpoint(executionId);
    const turn = this.loadTurnByExecution(executionId);
    if (!checkpoint || !turn) {
      throw new Error(`Canonical execution not found: ${executionId}`);
    }
    if (checkpoint.terminalOutcome || !["Pending", "Running"].includes(turn.status)) {
      throw new Error(`Canonical execution is not unfinished: ${executionId}`);
    }
    const thread = this.loadThread(checkpoint.threadId);
    if (!thread) throw new Error(`Canonical thread not found: ${checkpoint.threadId}`);
    if (
      stagedAssistant
      && (stagedAssistant.thread_id !== checkpoint.threadId || stagedAssistant.role !== "assistant")
    ) {
      throw new Error(`Recovered assistant projection does not belong to execution: ${executionId}`);
    }
    const endedAt = new Date().toISOString();
    const projectedAssistant = stagedAssistant ?? this.loadTerminalProjection(checkpoint.turnId).message;
    const recoveryProjection = projectedAssistant
      ? {
          ...projectedAssistant,
          is_internal: false,
          outcome: "interrupted" as const,
          outcomeExecutionId: executionId,
        }
      : null;
    const interruptedNarrative = recoveryProjection
      ? this.reconcileInterruptedNarrative(
          recoveredNarrative,
          recoveryProjection.id,
          endedAt,
        )
      : [];
    if (recoveredNarrative.length > 0 && !recoveryProjection) {
      throw new Error(`Recovered narrative has no assistant projection: ${executionId}`);
    }
    return this.commit({
      threadId: checkpoint.threadId,
      turnId: checkpoint.turnId,
      executionId,
      phase: "interrupted",
      terminalOutcome: "interrupted",
      error: reason,
      nativeCursor: checkpoint.nativeCursor ?? undefined,
      projectCompatibility: () => {
        if (!projectedAssistant) return;
        const updated = this.db.prepare(`
          UPDATE messages
          SET is_internal = 0, outcome = ?, outcome_execution_id = ?
          WHERE id = ? AND role = 'assistant'
        `).run("interrupted", executionId, projectedAssistant.id);
        if (stagedAssistant && updated.changes !== 1) {
          throw new Error(`Recovered assistant message was not staged: ${stagedAssistant.id}`);
        }
        finalizeCompatibility?.(recoveryProjection!, interruptedNarrative);
      },
      events: () => [
        {
          eventId: `${executionId}:recovery-thread-idle`,
          routing: { threadId: checkpoint.threadId, executionId },
          sourceProviderId: thread.providerId,
          sourceIdentities: thread.providerIdentities,
          payload: {
            type: "thread.recorded",
            thread: {
              ...thread,
              activityState: "Idle",
              updatedAt: endedAt,
            },
          },
        },
        ...(recoveryProjection ? [{
          eventId: `${executionId}:recovery-assistant-outcome:${recoveryProjection.id}`,
          routing: {
            threadId: checkpoint.threadId,
            turnId: checkpoint.turnId,
            executionId,
            itemId: `message:${recoveryProjection.id}`,
          },
          sourceProviderId: thread.providerId,
          sourceIdentities: thread.providerIdentities,
          payload: {
            type: "item.recorded" as const,
            item: {
              id: `message:${recoveryProjection.id}`,
              threadId: checkpoint.threadId,
              turnId: checkpoint.turnId,
              kind: "message" as const,
              providerIdentities: thread.providerIdentities,
              payload: { projection: "message", message: recoveryProjection },
              createdAt: recoveryProjection.timestamp,
              updatedAt: endedAt,
            },
          },
        }] : []),
        ...this.interruptedNarrativeProjectionEvents({
          checkpoint,
          thread,
          executionId,
          narrative: interruptedNarrative,
          endedAt,
        }),
        {
          eventId: `${executionId}:recovery-interrupted`,
          routing: {
            threadId: checkpoint.threadId,
            turnId: checkpoint.turnId,
            executionId,
          },
          sourceProviderId: thread.providerId,
          sourceIdentities: thread.providerIdentities,
          payload: { type: "turn.interrupted", endedAt, reason },
        },
      ],
    });
  }

  /** Convert unfinished recovery records into their durable interrupted projections. */
  private reconcileInterruptedNarrative(
    items: readonly ParentNarrativeRecoveryItem[],
    messageId: string,
    endedAt: string,
  ): ParentNarrativeRecoveryItem[] {
    return items.map((item) => {
      const recovered = item;
      if (recovered.kind === "toolCall") {
        return {
          kind: "toolCall" as const,
          record: {
            ...recovered.record,
            message_id: messageId,
            ...(recovered.record.status === "running"
              ? { status: "failed" as const, completed_at: endedAt }
              : {}),
          },
        };
      }
      if (recovered.kind === "hook") {
        const durationMs = recovered.record.ended_at
          ? recovered.record.duration_ms
          : Math.max(0, Date.parse(endedAt) - Date.parse(recovered.record.started_at));
        return {
          kind: "hook" as const,
          record: {
            ...recovered.record,
            message_id: messageId,
            duration_ms: durationMs,
            ended_at: recovered.record.ended_at ?? endedAt,
          },
        };
      }
      return {
        kind: "narrationSegment" as const,
        record: { ...recovered.record, message_id: messageId },
      };
    });
  }

  /** Replace recovery items with canonical terminal narrative records in the interruption transaction. */
  private interruptedNarrativeProjectionEvents(input: {
    checkpoint: CanonicalAgentCheckpoint;
    thread: AgentThread;
    executionId: string;
    narrative: readonly ParentNarrativeRecoveryItem[];
    endedAt: string;
  }): CanonicalAgentEventDraft[] {
    const turn = this.loadTurn(input.checkpoint.turnId);
    if (!turn) throw new Error(`Canonical turn not found: ${input.checkpoint.turnId}`);
    return input.narrative.map((item) => {
      const itemId = item.kind === "toolCall"
        ? `toolCall:${item.record.id}`
        : `${item.kind}:${item.record.id}`;
      const parentItemId = item.kind === "toolCall" && item.record.parent_tool_call_id
        ? `toolCall:${item.record.parent_tool_call_id}`
        : undefined;
      const projection = item.kind === "toolCall"
        ? "toolCall"
        : item.kind === "narrationSegment"
          ? "narrationSegment"
          : "hook";
      return this.itemDraft(input.executionId, input.thread, turn, {
        id: itemId,
        threadId: input.thread.id,
        turnId: turn.id,
        ...(parentItemId ? { parentItemId } : {}),
        kind: item.kind === "toolCall"
          ? "tool-call"
          : item.kind === "narrationSegment"
            ? "reasoning"
            : "system",
        providerIdentities: turn.providerIdentities,
        payload: { projection, record: item.record },
        createdAt: item.record.started_at,
        updatedAt: input.endedAt,
      }, `${input.executionId}:recovery-narrative:${itemId}`);
    });
  }

  /** Persist a terminal parent turn in bounded transactions and confirm it only in the final batch. */
  async finishParentTurnBatched(
    input: CanonicalParentTurnFinishInput,
  ): Promise<CanonicalAgentBatchedCommitResult> {
    const checkpoint = this.loadCheckpoint(input.executionId);
    if (checkpoint?.terminalOutcome) {
      const retire = this.db.transaction(() => this.retireParentNarrativeRecovery(checkpoint.turnId));
      retire();
      const thread = this.loadThread(input.threadId);
      return {
        outcome: "terminal-outcome-confirmed",
        conversationRevision: thread?.conversationRevision ?? 0,
        rosterRevision: thread?.rosterRevision ?? 0,
        acceptedThrough: checkpoint.lastAcceptedSequence,
        durableThrough: checkpoint.lastDurableSequence,
        events: [],
        writeBatches: { batches: 0, rows: 0, bytes: 0 },
      };
    }

    const projection = input.projectTurn();
    const endedAt = new Date().toISOString();
    const drafts = this.parentTurnTerminalEvents(input, projection, endedAt);
    const partialRevision = this.db
      .prepare("SELECT durable_revision FROM canonical_agent_events WHERE event_id = ?")
      .get(drafts[0]!.eventId) as { durable_revision: number } | undefined;
    const terminalRevision = partialRevision?.durable_revision
      ?? (this.loadThread(input.threadId)?.conversationRevision ?? 0) + 1;
    const batchOverheadBytes = Buffer.byteLength(JSON.stringify({
      thread: this.loadThread(input.threadId),
      turn: this.loadTurn(input.turnId),
      checkpoint,
    }), "utf8");
    const terminalEventId = `${input.executionId}:turn.${input.outcome}`;
    let latest: Omit<CanonicalAgentBatchedCommitResult, "writeBatches"> | null = null;
    const published: CanonicalAgentEventEnvelope[] = [];
    const pendingPublication: CanonicalAgentEventEnvelope[] = [];
    let batchState: AgentModelState | null = null;
    let batchCheckpoint: CanonicalAgentCheckpoint | null = null;
    let batchAcceptedAt = "";
    let batchAcceptedSequence = 0;
    let batchChanged = false;
    let batchWrote = false;
    let batchTerminal = false;
    let batchIgnoredTerminal = false;

    const writeBatches = await runBoundedWriteBatches({
      db: this.db,
      items: drafts,
      limits: ACTIVE_TURN_WRITE_BATCH_LIMITS,
      batchOverheadRows: 3,
      batchOverheadBytes,
      rowCount: (draft) => draft.payload.type === "item.recorded"
        || draft.payload.type === "collaboration-action.recorded"
        ? 2
        : 1,
      byteLength: (draft) => Buffer.byteLength(JSON.stringify(draft), "utf8"),
      onBatchStarted: () => {
        batchState = this.loadState(input.threadId, input.executionId);
        batchCheckpoint = this.loadCheckpoint(input.executionId);
        batchAcceptedAt = new Date().toISOString();
        batchAcceptedSequence = batchCheckpoint?.lastAcceptedSequence ?? 0;
        batchChanged = false;
        batchWrote = false;
        batchTerminal = false;
        batchIgnoredTerminal = false;
      },
      write: (draft) => {
        const terminal = draft.eventId === terminalEventId;
        if (terminal) input.finalizeCompatibility?.();
        const existingRow = this.db
          .prepare("SELECT envelope_json FROM canonical_agent_events WHERE event_id = ?")
          .get(draft.eventId) as { envelope_json: string } | undefined;
        if (existingRow) {
          this.assertDuplicateMatches(
            draft,
            CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(existingRow.envelope_json)),
          );
          return;
        }
        if (!batchState) throw new Error("Canonical batch state was not initialized");
        batchAcceptedSequence += 1;
        const event = this.createEnvelope(
          draft,
          batchAcceptedSequence,
          terminalRevision,
          batchAcceptedAt,
        );
        const reduction = reduceAgentEventBatch(batchState, [event]);
        if (reduction.outcome === "rejected") {
          throw new Error(`Canonical event ${reduction.eventId} rejected: ${reduction.reason}`);
        }
        const [application] = this.applyIndividually(batchState, [event]);
        batchIgnoredTerminal ||= application?.outcome === "terminal-outcome-confirmed";
        batchState = reduction.state;
        if (reduction.appliedCount > 0) {
          const thread = batchState.threads[input.threadId];
          if (thread) {
            batchState = {
              ...batchState,
              threads: {
                ...batchState.threads,
                [thread.id]: {
                  ...thread,
                  conversationRevision: terminalRevision,
                  updatedAt: batchAcceptedAt,
                },
              },
            };
          }
          batchChanged = true;
        }
        if (event.payload.type === "item.recorded") {
          const item = batchState.items[event.payload.item.id];
          if (item) this.persistItem(item);
        } else if (event.payload.type === "collaboration-action.recorded") {
          const action = batchState.collaborationActions[event.payload.collaborationAction.id];
          if (action) this.persistAction(action);
        }
        this.insertEvent(event);
        if (application?.outcome === "applied") {
          pendingPublication.push(event);
          published.push(event);
        }
        batchWrote = true;
        batchTerminal ||= terminal;
      },
      onBatchFinishing: () => {
        if (!batchState) throw new Error("Canonical batch state was not initialized");
        if (!batchWrote) {
          const thread = batchState.threads[input.threadId];
          latest = {
            outcome: "duplicate",
            conversationRevision: thread?.conversationRevision ?? 0,
            rosterRevision: thread?.rosterRevision ?? 0,
            acceptedThrough: batchAcceptedSequence,
            durableThrough: batchAcceptedSequence,
            events: [],
          };
          return;
        }
        if (batchChanged) {
          const thread = batchState.threads[input.threadId];
          if (thread) this.persistThread(thread);
          const turn = batchState.turns[input.turnId];
          if (turn?.threadId === input.threadId) this.persistTurn(turn, input.executionId);
        }
        this.persistCheckpoint({
          executionId: input.executionId,
          threadId: input.threadId,
          turnId: input.turnId,
          lastAcceptedSequence: batchAcceptedSequence,
          lastDurableSequence: batchAcceptedSequence,
          nativeCursor: batchCheckpoint?.nativeCursor ?? null,
          phase: batchTerminal ? input.outcome : "running",
          terminalOutcome: batchTerminal ? input.outcome : null,
          error: batchTerminal ? input.error ?? null : null,
          updatedAt: batchAcceptedAt,
        });
        if (batchTerminal) this.retireParentNarrativeRecovery(input.turnId);
        const thread = batchState.threads[input.threadId];
        latest = {
          outcome: !batchChanged && batchIgnoredTerminal
            ? "terminal-outcome-confirmed"
            : "committed",
          conversationRevision: thread?.conversationRevision ?? terminalRevision,
          rosterRevision: thread?.rosterRevision ?? 0,
          acceptedThrough: batchAcceptedSequence,
          durableThrough: batchAcceptedSequence,
          events: [],
        };
      },
      onBatchCommitted: () => {
        if (pendingPublication.length === 0) return;
        const events = pendingPublication.splice(0);
        this.recordCanonicalDiagnostics(events);
        this.publish(events);
      },
    });

    const committed = latest as Omit<CanonicalAgentBatchedCommitResult, "writeBatches"> | null;
    if (!committed) throw new Error("Canonical terminal batch did not contain an event");
    return {
      outcome: committed.outcome,
      conversationRevision: committed.conversationRevision,
      rosterRevision: committed.rosterRevision,
      acceptedThrough: committed.acceptedThrough,
      durableThrough: committed.durableThrough,
      events: published,
      writeBatches,
    };
  }

  /** Remove the unfinished-turn recovery representation once a terminal projection is durable. */
  private retireParentNarrativeRecovery(turnId: string): void {
    this.db.prepare(`
      DELETE FROM canonical_agent_items
      WHERE turn_id = ?
        AND json_extract(payload_json, '$.projection') IN ('narrativeRecovery', 'narrativeRecoveryDiscarded')
    `).run(turnId);
  }

  /** Load canonical message and narrative items for one paginated conversation page. */
  loadConversationProjection(
    threadId: string,
    limit: number,
    before?: number,
    after?: number,
  ): CanonicalConversationProjection {
    const clampedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const direction = after === undefined ? "DESC" : "ASC";
    const cursor = after ?? before ?? Number.MAX_SAFE_INTEGER;
    const cursorOperator = after === undefined ? "<" : ">";
    const rows = this.db.prepare(`
      SELECT turn_id, payload_json
      FROM canonical_agent_items
      WHERE thread_id = ?
        AND kind = 'message'
        AND json_extract(payload_json, '$.projection') = 'message'
        AND json_extract(payload_json, '$.message.sequence') ${cursorOperator} ?
        AND COALESCE(json_extract(payload_json, '$.message.is_internal'), 0) = 0
        AND (
          json_extract(payload_json, '$.message.role') <> 'assistant'
          OR EXISTS (
            SELECT 1
            FROM canonical_agent_ingest_checkpoints checkpoint
            WHERE checkpoint.turn_id = canonical_agent_items.turn_id
              AND checkpoint.terminal_outcome IS NOT NULL
          )
        )
      ORDER BY json_extract(payload_json, '$.message.sequence') ${direction},
        json_extract(payload_json, '$.message.id') ${direction}
      LIMIT ?
    `).all(threadId, cursor, clampedLimit + 1) as Array<{
      turn_id: string;
      payload_json: string;
    }>;
    const hasMore = rows.length > clampedLimit;
    const messageRows = rows
      .slice(0, clampedLimit)
      .map((row) => ({
        turnId: row.turn_id,
        message: (JSON.parse(row.payload_json) as { message: Message }).message,
      }))
      .sort((left, right) => left.message.sequence - right.message.sequence
        || left.message.id.localeCompare(right.message.id));
    const messages = messageRows.map(({ message }) => message);
    const narrativeByMessage: Record<string, ConversationNarrativeBatch> = {};
    for (const message of messages) {
      narrativeByMessage[message.id] = { tools: [], thoughts: [], hooks: [] };
    }
    if (messages.length === 0) return { messages, narrativeByMessage, hasMore };

    const pageTurnIds = [...new Set(messageRows.map(({ turnId }) => turnId))];
    const narrativeRows = this.db.prepare(`
      SELECT id, kind, payload_json, created_at, updated_at, turn_id
      FROM canonical_agent_items
      WHERE thread_id = ?
        AND kind <> 'message'
        AND turn_id IN (${pageTurnIds.map(() => "?").join(", ")})
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(
      threadId,
      ...pageTurnIds,
      CONVERSATION_HISTORY_PAGE_MAX_MESSAGES,
    ) as Array<{
      id: string;
      kind: string;
      payload_json: string;
      created_at: string;
      updated_at: string;
      turn_id: string;
    }>;
    const childTurnIds = [...new Set(narrativeRows.flatMap((row) => {
      const payload = JSON.parse(row.payload_json) as { projection?: string };
      return payload.projection === "codexChildReasoning"
        || payload.projection === "codexChildToolCall"
        || payload.projection === "codexChildToolResult"
        ? [row.turn_id]
        : [];
    }))];
    const allChildMessageRows = childTurnIds.length === 0
      ? []
      : this.db.prepare(`
        WITH candidate_messages AS (
          SELECT turn_id, payload_json,
            ROW_NUMBER() OVER (
              PARTITION BY turn_id
              ORDER BY CASE
                WHEN json_extract(payload_json, '$.message.role') = 'assistant' THEN 0
                ELSE 1
              END,
              json_extract(payload_json, '$.message.sequence') ASC,
              json_extract(payload_json, '$.message.id') ASC
            ) AS candidate_rank
          FROM canonical_agent_items
          WHERE thread_id = ?
            AND kind = 'message'
            AND json_extract(payload_json, '$.projection') = 'message'
            AND COALESCE(json_extract(payload_json, '$.message.is_internal'), 0) = 0
            AND (
              json_extract(payload_json, '$.message.role') <> 'assistant'
              OR EXISTS (
                SELECT 1
                FROM canonical_agent_ingest_checkpoints checkpoint
                WHERE checkpoint.turn_id = canonical_agent_items.turn_id
                  AND checkpoint.terminal_outcome IS NOT NULL
              )
            )
            AND turn_id IN (${childTurnIds.map(() => "?").join(", ")})
        )
        SELECT turn_id, payload_json
        FROM candidate_messages
        WHERE candidate_rank <= 2
        ORDER BY turn_id ASC, candidate_rank ASC
        LIMIT ?
      `).all(
        threadId,
        ...childTurnIds,
        childTurnIds.length * 2,
      ) as Array<{
        turn_id: string;
        payload_json: string;
      }>;
    const childMessageByTurn = new Map<string, string>();
    const candidateMessageRows = [
      ...messageRows,
      ...allChildMessageRows.map((row) => ({
        turnId: row.turn_id,
        message: (JSON.parse(row.payload_json) as { message: Message }).message,
      })),
    ];
    const candidateMessageById = new Map(
      candidateMessageRows.map(({ message }) => [message.id, message]),
    );
    for (const { turnId, message } of candidateMessageRows) {
      const current = childMessageByTurn.get(turnId);
      if (!current || (message.role === "assistant"
        && candidateMessageById.get(current)?.role !== "assistant")) {
        childMessageByTurn.set(turnId, message.id);
      }
    }
    const childToolsByMessage = new Map<
      string,
      Map<string, ConversationNarrativeBatch["tools"][number]>
    >();
    const childThoughtOrderByMessage = new Map<string, number>();
    for (const row of narrativeRows) {
      const payload = JSON.parse(row.payload_json) as {
        projection?: string;
        record?: Record<string, unknown>;
        nativeItemId?: string;
        toolName?: string;
        toolInput?: unknown;
        output?: string;
        isError?: boolean;
        content?: string;
      };
      const childAnchor = childMessageByTurn.get(row.turn_id);
      if (
        childAnchor
        && narrativeByMessage[childAnchor]
        && (payload.projection === "codexChildReasoning"
          || payload.projection === "codexChildToolCall"
          || payload.projection === "codexChildToolResult")
      ) {
        const nativeItemId = payload.nativeItemId ?? row.payload_json;
        if (payload.projection === "codexChildReasoning") {
          const sortOrder = childThoughtOrderByMessage.get(childAnchor) ?? 0;
          narrativeByMessage[childAnchor]!.thoughts.push(ThoughtSegmentRecordSchema.parse({
            id: `codex-child-reasoning:${hashCodexKey(`${nativeItemId}:${row.id}`)}`,
            message_id: childAnchor,
            text: typeof payload.content === "string" ? payload.content : "",
            started_at: row.created_at,
            ended_at: row.updated_at,
            sort_order: sortOrder,
          }));
          childThoughtOrderByMessage.set(childAnchor, sortOrder + 1);
        } else if (payload.projection === "codexChildToolCall") {
          const childTools = childToolsByMessage.get(childAnchor) ?? new Map();
          const existing = childTools.get(nativeItemId);
          childTools.set(nativeItemId, ToolCallRecordSchema.parse({
            id: existing?.id ?? `codex-child-tool:${hashCodexKey(nativeItemId)}`,
            message_id: childAnchor,
            parent_tool_call_id: null,
            tool_name: typeof payload.toolName === "string" ? payload.toolName : "Tool",
            input_summary: payload.toolInput == null
              ? ""
              : typeof payload.toolInput === "string"
                ? payload.toolInput
                : JSON.stringify(payload.toolInput),
            output_summary: existing?.output_summary ?? "",
            status: existing?.status ?? "running",
            started_at: existing?.started_at ?? row.created_at,
            completed_at: existing?.completed_at ?? null,
            sort_order: existing?.sort_order ?? childTools.size,
          }));
          childToolsByMessage.set(childAnchor, childTools);
        } else {
          const childTools = childToolsByMessage.get(childAnchor) ?? new Map();
          const existing = childTools.get(nativeItemId);
          const isError = payload.isError === true;
          childTools.set(nativeItemId, ToolCallRecordSchema.parse({
            id: existing?.id ?? `codex-child-tool:${hashCodexKey(nativeItemId)}`,
            message_id: childAnchor,
            parent_tool_call_id: null,
            tool_name: existing?.tool_name ?? "Tool",
            input_summary: existing?.input_summary ?? "",
            output_summary: typeof payload.output === "string" ? payload.output : "",
            status: isError ? "failed" : "completed",
            started_at: existing?.started_at ?? row.created_at,
            completed_at: row.updated_at,
            sort_order: existing?.sort_order ?? childTools.size,
          }));
          childToolsByMessage.set(childAnchor, childTools);
        }
        continue;
      }
      const record = payload.record;
      if (!record || typeof record.message_id !== "string") continue;
      const messageId = record.message_id;
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
    for (const [messageId, childTools] of childToolsByMessage) {
      narrativeByMessage[messageId]!.tools.push(...childTools.values());
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
      outcome: TurnOutcome;
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
        ? { type: "turn.cancelled", endedAt, reason: input.error ?? "Turn cancelled" }
        : input.outcome === "interrupted"
          ? { type: "turn.interrupted", endedAt, reason: input.error ?? "Turn interrupted" }
          : { type: "turn.errored", endedAt, error: input.error ?? "Provider turn failed" };
    const events: CanonicalAgentEventDraft[] = [];
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
    const codexChildOwnedIds = codexChildOwnedToolCallIds(projection?.narrative ?? []);
    for (const entry of projection?.narrative ?? []) {
      if (entry.kind === "assistantMessage") continue;
      const record = entry.record;
      if (entry.kind === "toolCall" && (
        codexChildOwnedIds.has(record.id)
      )) continue;
      const itemKind = entry.kind === "toolCall"
        ? "tool-call" as const
        : entry.kind === "narrationSegment"
          ? "reasoning" as const
          : "system" as const;
      const recordId = record.id;
      const projectedItemId = `${entry.kind}:${recordId}`;
      const createdAt = entry.kind === "toolCall"
        ? record.started_at
        : entry.kind === "narrationSegment"
          ? record.started_at
          : record.started_at;
      events.push(this.projectionItemEvent(input, {
        id: projectedItemId,
        kind: itemKind,
        payload: { projection: entry.kind, record },
        createdAt,
        ...(entry.kind === "toolCall" && "parent_tool_call_id" in record && record.parent_tool_call_id
          ? { parentItemId: `toolCall:${record.parent_tool_call_id}` }
          : {}),
      }));
    }
    events.push({
      eventId: `${input.executionId}:${terminalPayload.type}`,
      routing,
      sourceProviderId: input.providerId,
      sourceIdentities,
      payload: terminalPayload,
    });
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
      eventId: `${input.executionId}:terminal-item:${item.id}:${hashCodexKey(JSON.stringify(item))}`,
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

  private commitInsideTransaction(
    input: CanonicalAgentCommitInput,
    durableRevisionOverride?: number,
  ): CanonicalAgentCommitResult {
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
    const boundedEvents = this.boundIngestBatch(input, events, currentCheckpoint);
    if (boundedEvents.some((event) => event.routing.executionId !== input.executionId)) {
      throw new Error("Canonical semantic batch contains another execution identity");
    }
    if (boundedEvents.some((event) => event.routing.threadId !== input.threadId)) {
      throw new Error("Canonical semantic batch contains another thread identity");
    }
    const existingById = new Map<string, CanonicalAgentEventEnvelope>();
    for (const draft of boundedEvents) {
      const row = this.db
        .prepare("SELECT envelope_json FROM canonical_agent_events WHERE event_id = ?")
        .get(draft.eventId) as { envelope_json: string } | undefined;
      if (!row) continue;
      const stored = CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelope_json));
      this.assertDuplicateMatches(draft, stored);
      existingById.set(draft.eventId, stored);
    }

    const newDrafts = boundedEvents.filter((draft) => !existingById.has(draft.eventId));
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
    const candidateRevision = durableRevisionOverride
      ?? (currentThread?.conversationRevision ?? 0) + 1;
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
    const durableRevision = conversationChanged ? candidateRevision : conversationRevision;
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
      candidateEvents,
    );
    for (const event of candidateEvents) this.insertEvent(event);

    const durableThrough = acceptedSequence;
    if (input.persistCheckpoint !== false) {
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
    }

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
    const { ingestClass: _ingestClass, ...envelopeDraft } = draft;
    return CanonicalAgentEventEnvelopeSchema.parse({
      ...envelopeDraft,
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
    const { ingestClass: _ingestClass, ...comparableDraft } = draft;
    const normalizedDraft = JSON.parse(JSON.stringify({
      ...comparableDraft,
      sourceIdentities: [...draft.sourceIdentities],
    }));
    if (JSON.stringify(normalizedDraft) !== JSON.stringify(JSON.parse(JSON.stringify(comparable)))) {
      throw new Error(`Canonical event identity conflict: ${draft.eventId}`);
    }
  }

  private boundIngestBatch(
    input: CanonicalAgentCommitInput,
    events: readonly CanonicalAgentEventDraft[],
    checkpoint: CanonicalAgentCheckpoint | null,
  ): readonly CanonicalAgentEventDraft[] {
    const structural = events.filter((event) => event.ingestClass !== "volatile");
    const volatile = events.filter((event) => event.ingestClass === "volatile");
    if (structural.length > CANONICAL_AGENT_EVENT_BATCH_MAX
      || (structural.length === CANONICAL_AGENT_EVENT_BATCH_MAX && volatile.length > 0)) {
      throw new StructuralIngestOverflow(
        input,
        checkpoint?.lastAcceptedSequence ?? 0,
        checkpoint?.lastDurableSequence ?? 0,
      );
    }

    const volatileCapacity = Math.min(
      CANONICAL_AGENT_EVENT_BATCH_MAX - CANONICAL_AGENT_CONTROL_EVENT_RESERVE,
      CANONICAL_AGENT_EVENT_BATCH_MAX - structural.length,
    );
    if (volatile.length <= volatileCapacity) return events;

    const markerCapacity = CANONICAL_AGENT_EVENT_BATCH_MAX - structural.length - 1;
    const retainedVolatile = new Set(volatile.slice(
      0,
      Math.max(0, Math.min(volatileCapacity, markerCapacity)),
    ));
    const retained = events.filter(
      (event) => event.ingestClass !== "volatile" || retainedVolatile.has(event),
    );
    const droppedEventCount = volatile.length - retainedVolatile.size;
    const source = volatile[0];
    if (!source) return retained;
    const marker: CanonicalAgentEventDraft = {
      eventId: `${input.executionId}:volatile-truncated:${source.eventId.slice(-96)}`,
      routing: {
        threadId: input.threadId,
        turnId: input.turnId,
        executionId: input.executionId,
      },
      sourceProviderId: source.sourceProviderId,
      sourceIdentities: source.sourceIdentities,
      payload: { type: "ingest.volatile-truncated", droppedEventCount },
    };
    const terminalIndex = retained.findIndex((event) => this.isTerminalDraft(event));
    if (terminalIndex < 0) return [...retained, marker];
    return [
      ...retained.slice(0, terminalIndex),
      marker,
      ...retained.slice(terminalIndex),
    ];
  }

  private isTerminalDraft(event: CanonicalAgentEventDraft): boolean {
    return this.isTerminalPayload(event.payload);
  }

  private isTerminalPayload(payload: CanonicalAgentEvent): boolean {
    return payload.type === "turn.completed"
      || payload.type === "turn.cancelled"
      || payload.type === "turn.interrupted"
      || payload.type === "turn.errored"
      || payload.type === "ingest.overflow";
  }

  private recordIngestOverflow(
    input: CanonicalAgentCommitInput,
    acceptedStoppingSequence: number,
    durableStoppingSequence: number,
  ): CanonicalAgentCommitResult {
    const checkpoint = this.loadCheckpoint(input.executionId);
    if (!checkpoint) {
      throw new Error(
        `Canonical semantic batch exceeds ${CANONICAL_AGENT_EVENT_BATCH_MAX} events`,
      );
    }
    const turn = this.loadTurn(input.turnId);
    const thread = this.loadThread(input.threadId);
    if (!turn || !thread) throw new Error("Canonical overflow target is not durable");
    const endedAt = new Date().toISOString();
    const result = this.commit({
      threadId: input.threadId,
      turnId: input.turnId,
      executionId: input.executionId,
      phase: "ingest_overflow",
      terminalOutcome: "errored",
      error: "ingest_overflow",
      events: [{
        eventId: `${input.executionId}:ingest-overflow`,
        routing: {
          threadId: input.threadId,
          turnId: input.turnId,
          executionId: input.executionId,
        },
        sourceProviderId: thread.providerId,
        sourceIdentities: thread.providerIdentities,
        payload: {
          type: "ingest.overflow",
          endedAt,
          acceptedStoppingSequence,
          durableStoppingSequence,
        },
      }],
    });
    return result;
  }

  private commitStructuralOverflow(error: StructuralIngestOverflow): CanonicalAgentCommitResult {
    const overflow = this.recordIngestOverflow(
      error.input,
      error.acceptedStoppingSequence,
      error.durableStoppingSequence,
    );
    error.input.onOverflow?.();
    return { ...overflow, outcome: "ingest-overflow" };
  }

  private recordCanonicalDiagnostics(events: readonly CanonicalAgentEventEnvelope[]): void {
    for (const event of events) {
      const turnId = event.routing.turnId;
      if (!turnId) continue;
      const terminal = this.isTerminalPayload(event.payload);
      this.diagnostics.record({
        turnId,
        executionId: event.routing.executionId,
        source: "canonical",
        event,
        terminal,
      });
      if (terminal) {
        this.turnIdByExecution.delete(event.routing.executionId);
      }
    }
  }

  private publishEventGroups(
    groups: readonly (readonly CanonicalAgentEventEnvelope[])[],
  ): void {
    for (const group of groups) {
      if (group.length === 0) continue;
      const threadId = group[0]?.routing.threadId;
      if (!threadId || group.some((event) => event.routing.threadId !== threadId)) {
        throw new Error("Canonical publication group must contain one thread");
      }
      this.publish(group);
    }
  }

  private cacheTurnExecution(executionId: string, turnId: string): void {
    this.turnIdByExecution.delete(executionId);
    this.turnIdByExecution.set(executionId, turnId);
    if (this.turnIdByExecution.size <= CANONICAL_EXECUTION_DIAGNOSTIC_INDEX_CAPACITY) return;
    const oldestExecutionId = this.turnIdByExecution.keys().next().value as string | undefined;
    if (oldestExecutionId) this.turnIdByExecution.delete(oldestExecutionId);
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

  private loadState(threadId: string, executionId?: string): AgentModelState {
    const state = createAgentModelState();
    const thread = this.loadThread(threadId);
    if (thread) state.threads[thread.id] = thread;
    const childThreads = this.db.prepare(
      "SELECT * FROM canonical_agent_threads WHERE parent_thread_id = ?",
    ).all(threadId) as Record<string, unknown>[];
    for (const row of childThreads) {
      const childThread = this.threadFromRow(row);
      state.threads[childThread.id] = childThread;
    }

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
      .prepare(`
        SELECT *
        FROM canonical_collaboration_actions
        WHERE source_thread_id = ? OR target_thread_id = ?
      `)
      .all(threadId, threadId) as Record<string, unknown>[];
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
    const checkpoint = executionId ? this.loadCheckpoint(executionId) : null;
    if (executionId && checkpoint) {
      state.lastAcceptedSequenceByExecution[executionId] = checkpoint.lastAcceptedSequence;
    }
    return state;
  }

  private hasContiguousRevisions(
    revisions: readonly number[],
    from: number,
    through: number,
  ): boolean {
    if (from === through) return true;
    let expected = from + 1;
    for (const revision of [...new Set(revisions)].sort((left, right) => left - right)) {
      if (revision < expected) continue;
      if (revision !== expected) return false;
      expected += 1;
    }
    return expected === through + 1;
  }

  private persistState(
    state: AgentModelState,
    threadId: string,
    turnId: string,
    executionId: string,
    conversationChanged: boolean,
    events: readonly CanonicalAgentEventEnvelope[],
  ): void {
    if (!conversationChanged) return;
    const thread = state.threads[threadId];
    if (thread) this.persistThread(thread);
    const turn = state.turns[turnId];
    if (turn?.threadId === threadId) this.persistTurn(turn, executionId);
    const changedItemIds = new Set(
      events
        .filter((event) => event.payload.type === "item.recorded")
        .map((event) => event.payload.type === "item.recorded" ? event.payload.item.id : ""),
    );
    for (const itemId of changedItemIds) {
      const item = state.items[itemId];
      if (item?.threadId === threadId) this.persistItem(item);
    }
    const changedActionIds = new Set(
      events
        .filter((event) => event.payload.type === "collaboration-action.recorded")
        .map((event) => event.payload.type === "collaboration-action.recorded"
          ? event.payload.collaborationAction.id
          : ""),
    );
    for (const actionId of changedActionIds) {
      const action = state.collaborationActions[actionId];
      if (action && (action.source.threadId === threadId || action.target.threadId === threadId)) {
        this.persistAction(action);
      }
    }
    const changedChildThreadIds = new Set(
      events
        .filter((event) => event.payload.type === "child-thread.recorded")
        .map((event) => event.payload.type === "child-thread.recorded" ? event.payload.childThread.id : ""),
    );
    for (const childThreadId of changedChildThreadIds) {
      const childThread = state.threads[childThreadId];
      if (childThread?.parentThreadId === threadId) this.persistThread(childThread);
    }
    const boundChildThreadIds = new Set(
      events
        .filter((event) => event.payload.type === "child-thread.bound")
        .map((event) => event.payload.type === "child-thread.bound" ? event.payload.childThreadId : ""),
    );
    for (const childThreadId of boundChildThreadIds) {
      const childThread = state.threads[childThreadId];
      if (childThread?.parentThreadId === threadId) this.persistThread(childThread);
    }
  }

  private itemDraft(
    executionId: string,
    thread: AgentThread,
    turn: AgentTurn,
    item: AgentItem,
    eventId = `${executionId}:item:${item.id}`,
  ): CanonicalAgentEventDraft {
    return {
      eventId,
      routing: {
        threadId: thread.id,
        turnId: turn.id,
        executionId,
        itemId: item.id,
      },
      sourceProviderId: thread.providerId,
      sourceIdentities: item.providerIdentities,
      payload: { type: "item.recorded", item },
    };
  }

  private actionDraft(
    executionId: string,
    thread: AgentThread,
    action: CollaborationAction,
    eventId = `${executionId}:action:${action.id}`,
  ): CanonicalAgentEventDraft {
    return {
      eventId,
      routing: {
        threadId: thread.id,
        turnId: action.source.turnId,
        executionId,
        collaborationActionId: action.id,
      },
      sourceProviderId: thread.providerId,
      sourceIdentities: action.providerIdentities,
      payload: { type: "collaboration-action.recorded", collaborationAction: action },
    };
  }

  private commitParentCodexAction(
    input: CodexChildIdentityInput,
    action: CollaborationAction,
    suffix: string,
  ): void {
    const thread = this.loadThread(input.parentThreadId);
    if (!thread) throw new Error(`Codex parent thread not found: ${input.parentThreadId}`);
    this.commit({
      threadId: input.parentThreadId,
      turnId: input.parentTurnId,
      executionId: input.parentExecutionId,
      phase: "running",
      events: [this.actionDraft(
        input.parentExecutionId,
        thread,
        action,
        `${input.parentExecutionId}:codex-child:${hashCodexKey(input.parentItemId)}:${suffix}`,
      )],
    });
  }

  private commitParentCodexBinding(
    input: CodexChildIdentityInput,
    childThread: AgentThread,
    action: CollaborationAction,
  ): void {
    const thread = this.loadThread(input.parentThreadId);
    if (!thread) throw new Error(`Codex parent thread not found: ${input.parentThreadId}`);
    const executionId = `${input.parentExecutionId}:codex-child:${hashCodexKey(input.nativeThreadId)}`;
    this.commit({
      threadId: thread.id,
      turnId: input.parentTurnId,
      executionId: input.parentExecutionId,
      phase: "running",
      events: [
        {
          eventId: `${executionId}:bound`,
          routing: { threadId: thread.id, executionId: input.parentExecutionId },
          sourceProviderId: thread.providerId,
          sourceIdentities: action.providerIdentities,
          payload: {
            type: "child-thread.bound",
            parentThreadId: thread.id,
            childThreadId: childThread.id,
            providerIdentity: {
              providerId: "codex",
              scope: "thread",
              value: input.nativeThreadId,
              provenance: "native",
            },
          },
        },
        this.actionDraft(
          input.parentExecutionId,
          thread,
          action,
          `${input.parentExecutionId}:codex-child:${hashCodexKey(input.nativeThreadId)}:action`,
        ),
      ],
    });
  }

  private ensureCodexCompatibilityThread(thread: AgentThread): void {
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

  private codexReceiverIdentity(nativeThreadId: string): ProviderIdentity {
    return {
      providerId: "codex",
      scope: "parentItem",
      value: `receiverThreadId:${nativeThreadId}`,
      provenance: "native",
    };
  }

  private uniqueProviderIdentities(identities: readonly ProviderIdentity[]): ProviderIdentity[] {
    const result: ProviderIdentity[] = [];
    for (const identity of identities) {
      if (!result.some((candidate) => (
        candidate.providerId === identity.providerId
        && candidate.scope === identity.scope
        && candidate.value === identity.value
      ))) result.push(identity);
    }
    return result;
  }

  private loadCodexChildTurn(childThreadId: string, nativeTurnId: string): AgentTurn | null {
    const rows = this.db.prepare(`
      SELECT *
      FROM canonical_agent_turns
      WHERE thread_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(childThreadId) as Record<string, unknown>[];
    for (const row of rows) {
      const turn = this.turnFromRow(row);
      if (turn.providerIdentities.some((identity) => (
        identity.providerId === "codex"
        && identity.scope === "turn"
        && identity.value === nativeTurnId
      ))) return turn;
    }
    return null;
  }

  private loadActiveTurn(threadId: string): AgentTurn | null {
    const row = this.db.prepare(`
      SELECT *
      FROM canonical_agent_turns
      WHERE thread_id = ? AND status IN ('Pending', 'Running')
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(threadId);
    return row ? this.turnFromRow(row as Record<string, unknown>) : null;
  }

  /** Return the next stable sequence for a canonical child message. */
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

  /** Complete a child message at the canonical boundary without inventing source metadata. */
  private normalizeCodexChildMessagePayload(
    thread: AgentThread,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const source = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? payload.message as Record<string, unknown>
      : payload;
    const role = source.role === "user" || source.role === "assistant" || source.role === "system"
      ? source.role
      : "assistant";
    const content = typeof source.content === "string" ? source.content : "";
    const sequence = typeof source.sequence === "number" && Number.isInteger(source.sequence)
      && source.sequence >= 0 && source.sequence >= this.nextChildMessageSequence(thread.id)
      ? source.sequence
      : this.nextChildMessageSequence(thread.id);
    const message = {
      id: typeof source.id === "string" && source.id.length > 0
        ? source.id
        : `codex-child-message:${hashCodexKey(`${thread.id}:${sequence}:${content}`)}`,
      thread_id: thread.id,
      role,
      content,
      tool_calls: source.tool_calls ?? null,
      files_changed: source.files_changed ?? null,
      cost_usd: typeof source.cost_usd === "number" ? source.cost_usd : null,
      tokens_used: typeof source.tokens_used === "number" ? source.tokens_used : null,
      timestamp: typeof source.timestamp === "string" ? source.timestamp : new Date().toISOString(),
      sequence,
      attachments: source.attachments ?? null,
    };
    return { ...payload, projection: "message", message };
  }

  private executionIdForTurn(turnId: string): string {
    const row = this.db.prepare(
      "SELECT execution_id FROM canonical_agent_turns WHERE id = ?",
    ).get(turnId) as { execution_id: string } | undefined;
    if (!row) throw new Error(`Canonical turn execution not found: ${turnId}`);
    return row.execution_id;
  }

  /** Load the provider execution identity that owns one canonical turn. */
  loadExecutionIdForTurn(turnId: string): string {
    return this.executionIdForTurn(turnId);
  }

  private persistThread(thread: AgentThread): void {
    const parsed = AgentThreadSchema.parse(thread);
    this.persistThreadStatement.run(
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
    this.persistTurnStatement.run(
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
    this.persistItemStatement.run(
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
        target_thread_id = excluded.target_thread_id,
        target_turn_id = excluded.target_turn_id,
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
    this.insertEventStatement.run(
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
    this.persistCheckpointStatement.run(
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

  private checkpointFromRow(row: Record<string, unknown>): CanonicalAgentCheckpoint {
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

  private boundedCheckpointRows(
    rows: Record<string, unknown>[],
    phase: "unfinished" | "interrupted" | "unmaterialized terminal",
  ): CanonicalAgentCheckpoint[] {
    if (rows.length > MAX_TURN_RECOVERIES) {
      throw new Error(
        `Canonical ${phase} checkpoint count exceeds ${MAX_TURN_RECOVERIES}`,
      );
    }
    return rows.map((row) => this.checkpointFromRow(row));
  }
}
