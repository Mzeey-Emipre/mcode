import type Database from "better-sqlite3";
import * as NodeCrypto from "node:crypto";
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
  MAX_TURN_RECOVERIES,
  ProviderIdentitySchema,
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
  type CanonicalAgentReconnectRecovery,
  type CanonicalAgentRevision,
  type CollaborationAction,
  type Message,
  type NarrativeEntry,
  ParentNarrativeRecoveryItemSchema,
  type ProviderIdentity,
  type ParentNarrativeRecoveryItem,
  type TurnOutcome,
} from "@mcode/contracts";
import { broadcast } from "../../../application/transport/push.js";
import {
  ACTIVE_TURN_WRITE_BATCH_LIMITS,
  runBoundedWriteBatches,
  runBoundedWriteBatchesSync,
  type WriteBatchResult,
} from "../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { assertActiveTurnRecoveryRetention } from "../turns/active-turn-recovery-retention-policy.js";
import {
  CanonicalAgentDiagnostics,
  type CanonicalDiagnosticExport,
} from "../observability/canonical-agent-diagnostics.js";
import type {
  CanonicalChildTurnFinishInput,
  CodexChildDeliveryInput,
  CodexChildDelegation,
  CodexChildDelegationInput,
  CodexChildIdentityInput,
  CodexChildItemInput,
  CodexChildRetryInput,
  CodexChildRoutingDiagnosticInput,
  CodexChildTurnFinishInput,
  CodexChildTurnStartInput,
  CodexCollaborationActionInput,
  CodexCollaborationDurability,
  CodexProviderContinuationInput,
} from "../collaboration/codex-collaboration-durability.js";
import type {
  ParentNarrativeRecoveryCommit,
  ParentTurnCommitResult,
  ParentTurnDurability,
  ParentTurnFinishInput,
  ParentTurnInterruptionInput,
  ParentTurnProjection,
} from "../turns/parent-turn-durability.js";
import type {
  SubagentLifecycleDurability,
  SubagentStopTarget,
} from "../collaboration/subagent-lifecycle-durability.js";
import {
  CanonicalAgentEventStore,
  type CanonicalAgentEventStoreCheckpoint,
  type CanonicalAgentEventStoreInput,
} from "./canonical-agent-event-store.js";
import {
  CanonicalParentTurnLifecycle,
  type CanonicalParentTurnStartInput,
} from "./canonical-parent-turn-lifecycle.js";
import {
  CanonicalAgentReadRepository,
  type CanonicalConversationProjection,
} from "./canonical-agent-read-repository.js";
import { CanonicalCodexCollaborationCoordinator } from "./canonical-codex-collaboration-coordinator.js";

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

/** One visible entry in a restart-scoped recovery incident. */
export interface CanonicalRecoveryIncidentEntry {
  workspaceId: string;
  workspaceName: string;
  threadId: string;
  threadTitle: string;
  executionId: string;
  startedAt: string;
  interruptedAt: string;
}

/** Observable result after one canonical batch commits. */
export interface CanonicalAgentCommitResult extends ParentTurnCommitResult {
  outcome: "committed" | "duplicate" | "conflict" | "terminal-outcome-confirmed" | "ingest-overflow";
  /** Canonical publication runs after the durable transaction and can be retried through reconnect. */
  canonicalDelivery?: "published" | "deferred" | "not-required";
  conversationRevision: number;
  rosterRevision: number;
  acceptedThrough: number;
  durableThrough: number;
  events: readonly CanonicalAgentEventEnvelope[];
}

/** Canonical terminal result plus the physical transaction work used to commit it. */
export type CanonicalAgentBatchedCommitResult = Omit<CanonicalAgentCommitResult, "outcome"> & {
  outcome: Exclude<CanonicalAgentCommitResult["outcome"], "ingest-overflow">;
  writeBatches: WriteBatchResult;
};

/** Canonical alias for the parent-turn terminal projection contract. */
export type CanonicalParentTurnProjection = ParentTurnProjection;

/** Canonical alias for the parent-turn terminal durability input. */
export type CanonicalParentTurnFinishInput = ParentTurnFinishInput;

/** Canonical alias for the structured parent recovery durability input. */
export type ParentNarrativeRecoveryCommitInput = ParentNarrativeRecoveryCommit;

export type {
  CanonicalChildTurnFinishInput,
  CodexChildDeliveryInput,
  CodexChildDelegation,
  CodexChildDelegationInput,
  CodexChildIdentityInput,
  CodexChildItemInput,
  CodexChildRetryInput,
  CodexChildRoutingDiagnosticInput,
  CodexChildTurnFinishInput,
  CodexChildTurnStartInput,
} from "../collaboration/codex-collaboration-durability.js";

/** Canonical identity resolution used by the child interruption action. */
export interface CanonicalChildStopTarget {
  childThread: AgentThread;
  latestTurn: AgentTurn | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
}

/** Input used to persist one directional action without creating a Provider turn. */
/** Canonical alias for the Codex collaboration action durability input. */
export type CollaborationActionInput = CodexCollaborationActionInput;

/** Input used to start a parent turn only after explicit provider continuation evidence. */
/** Canonical alias for the Codex provider continuation durability input. */
export type CanonicalProviderContinuationInput = CodexProviderContinuationInput;

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
export type { CanonicalConversationProjection } from "./canonical-agent-read-repository.js";

type EventApplication = {
  event: CanonicalAgentEventEnvelope;
  outcome: ReturnType<typeof reduceAgentEvent>["outcome"];
};

type CanonicalParentTerminalEventInput = {
  threadId: string;
  turnId: string;
  executionId: string;
  providerId: string;
  providerIdentities: readonly ProviderIdentity[];
  outcome: TurnOutcome;
  error?: string;
};

interface SubagentRosterActivity {
  latestTurns: Map<string, AgentTurn | null>;
  activeIds: Set<string>;
}

interface SubagentRosterLookup extends SubagentRosterActivity {
  threads: AgentThread[];
  turnsByThread: Map<string, AgentTurn[]>;
  itemRows: Array<Record<string, unknown>>;
  actionsByThread: Map<string, CollaborationAction>;
  sourceItemsById: Map<string, AgentItem>;
}

type SubagentRosterMetadata = Pick<
  CanonicalSubagentRosterRow,
  "task" | "identity" | "model" | "reasoning"
>;

interface ParentTerminalBatchState {
  latest: Omit<CanonicalAgentBatchedCommitResult, "writeBatches"> | null;
  published: CanonicalAgentEventEnvelope[];
  pendingPublication: CanonicalAgentEventEnvelope[];
  modelState: AgentModelState | null;
  checkpoint: CanonicalAgentCheckpoint | null;
  acceptedAt: string;
  acceptedSequence: number;
  changed: boolean;
  wrote: boolean;
  terminal: boolean;
  ignoredTerminal: boolean;
}

interface ParentTerminalBatchEvent {
  event: CanonicalAgentEventEnvelope;
  application: EventApplication | undefined;
}

interface RetainedVolatileIngestEvents {
  events: readonly CanonicalAgentEventDraft[];
  droppedEventCount: number;
}

function hashCodexKey(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function narrativeItemKind(entryKind: Exclude<NarrativeEntry["kind"], "assistantMessage">): AgentItem["kind"] {
  if (entryKind === "toolCall") return "tool-call";
  return entryKind === "narrationSegment" ? "reasoning" : "system";
}

function narrativeParentItem(entry: NarrativeEntry): { parentItemId?: string } {
  if (entry.kind !== "toolCall" || !("parent_tool_call_id" in entry.record)) return {};
  return entry.record.parent_tool_call_id ? { parentItemId: `toolCall:${entry.record.parent_tool_call_id}` } : {};
}

function parentTerminalPayload(
  outcome: TurnOutcome,
  error: string | undefined,
  endedAt: string,
): CanonicalAgentEvent {
  switch (outcome) {
    case "completed":
      return { type: "turn.completed", endedAt };
    case "cancelled":
      return { type: "turn.cancelled", endedAt, reason: error ?? "Turn cancelled" };
    case "interrupted":
      return { type: "turn.interrupted", endedAt, reason: error ?? "Turn interrupted" };
    case "errored":
      return { type: "turn.errored", endedAt, error: error ?? "Provider turn failed" };
  }
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
export class CanonicalAgentBoundary implements ParentTurnDurability, CodexCollaborationDurability, SubagentLifecycleDurability {
  private readonly persistThreadStatement: Database.Statement;
  private readonly persistTurnStatement: Database.Statement;
  private readonly persistItemStatement: Database.Statement;
  private readonly insertEventStatement: Database.Statement;
  private readonly persistCheckpointStatement: Database.Statement;
  private readonly diagnostics = new CanonicalAgentDiagnostics();
  private readonly turnIdByExecution = new Map<string, string>();
  private readonly eventStore: CanonicalAgentEventStore;
  private readonly parentLifecycle: CanonicalParentTurnLifecycle;
  private readonly reads: CanonicalAgentReadRepository;
  private readonly codexCollaboration: CanonicalCodexCollaborationCoordinator;

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
        approval_review_mode, approval_review_reason, provider_identities_json, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        approval_review_mode = excluded.approval_review_mode,
        approval_review_reason = excluded.approval_review_reason,
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
    this.eventStore = new CanonicalAgentEventStore(db, {
      loadThread: (threadId) => this.loadThread(threadId),
      loadCheckpoint: (executionId) => this.toEventStoreCheckpoint(this.loadCheckpoint(executionId)),
      loadState: (threadId, executionId) => this.loadState(threadId, executionId),
      boundEvents: (input, events, checkpoint) => this.boundIngestBatch(
        this.toCanonicalCommitInput(input),
        events,
        this.toCanonicalCheckpoint(checkpoint),
      ),
      createEnvelope: (draft, acceptedSequence, durableRevision, timestamp) =>
        this.createEnvelope(draft, acceptedSequence, durableRevision, timestamp),
      assertDuplicate: (draft, stored) => this.assertDuplicateMatches(draft, stored),
      applyEvents: (state, events) => this.applyIndividually(state, events),
      persistState: (state, threadId, turnId, executionId, conversationChanged, events) =>
        this.persistState(state, threadId, turnId, executionId, conversationChanged, events),
      insertEvent: (event) => this.insertEvent(event),
      persistCheckpoint: (checkpoint) => this.persistCheckpoint(this.toCanonicalCheckpoint(checkpoint)!),
      recover: (input, error) => this.recoverCommit(this.toCanonicalCommitInput(input), error),
      record: (events) => this.recordCanonicalDiagnostics(events),
      publish: (result) => this.publishCommitted(result),
    });
    this.parentLifecycle = new CanonicalParentTurnLifecycle(db, {
      commit: (input) => this.commit(input),
      parentTurnStartEvents: (input, userMessage, startedAt) =>
        this.parentTurnStartEvents(input, userMessage, startedAt),
      parentTurnTerminalEvents: (input, projection, endedAt) =>
        this.parentTurnTerminalEvents(input, projection, endedAt),
      cacheExecution: (executionId, turnId) => this.cacheTurnExecution(executionId, turnId),
      loadTurn: (turnId) => this.loadTurn(turnId),
      loadCollaborationAction: (actionId) => this.loadCollaborationAction(actionId),
      uniqueProviderIdentities: (identities) => this.uniqueProviderIdentities(identities),
      executionIdForTurn: (turnId) => this.executionIdForTurn(turnId),
      actionAcknowledgementDraft: (executionId, thread, action) => this.actionDraft(
        executionId,
        thread,
        action,
        `${executionId}:collaboration:${hashCodexKey(action.id)}:acknowledge`,
      ),
      commitContinuation: (input) => this.commitProviderContinuation(input),
      loadCheckpoint: (executionId) => this.loadCheckpoint(executionId),
      loadTurnByExecution: (executionId) => this.loadTurnByExecution(executionId),
      loadThread: (threadId) => this.loadThread(threadId),
      loadTerminalProjection: (turnId) => this.loadTerminalProjection(turnId),
      interruptedNarrativeEvents: (input) => this.interruptedNarrativeProjectionEvents(input),
      stampRecoveryIncident: (executionId, recoveryIncidentId) =>
        this.stampRecoveryIncident(executionId, recoveryIncidentId),
    });
    this.reads = new CanonicalAgentReadRepository(db, {
      loadState: (threadId) => this.loadState(threadId),
      mapThread: (row) => this.threadFromRow(row),
      mapTurn: (row) => this.turnFromRow(row),
      mapCheckpoint: (row) => this.checkpointFromRow(row),
    });
    this.codexCollaboration = new CanonicalCodexCollaborationCoordinator(db, {
      loadThread: (threadId) => this.loadThread(threadId),
      loadTurn: (turnId) => this.loadTurn(turnId),
      loadTurnByExecution: (executionId) => this.loadTurnByExecution(executionId),
      loadItem: (itemId) => this.loadItem(itemId),
      actionFromRow: (row) => this.actionFromRow(row),
      turnFromRow: (row) => this.turnFromRow(row),
      executionIdForTurn: (turnId) => this.executionIdForTurn(turnId),
      commit: (input) => this.commit(input),
      commitInsideTransaction: (input) => this.commitInsideTransaction(input),
      publishCommitted: (results) => {
        this.recordCanonicalDiagnostics(results.flatMap((result) => result.events));
        this.publishEventGroups(results.map((result) => result.events));
      },
      itemDraft: (executionId, thread, turn, item, eventId) => this.itemDraft(
        executionId,
        thread,
        turn,
        item,
        eventId,
      ),
      actionDraft: (executionId, thread, action, eventId) => this.actionDraft(
        executionId,
        thread,
        action,
        eventId,
      ),
      loadAction: (actionId) => this.loadCollaborationAction(actionId),
      cacheTurnExecution: (executionId, turnId) => this.cacheTurnExecution(executionId, turnId),
      recordProviderDiagnostic: (input) => this.diagnostics.record({ ...input, source: "provider" }),
    });
  }

  /** Commit one semantic batch and publish only the applied events after SQLite commits. */
  commit(input: CanonicalAgentCommitInput): CanonicalAgentCommitResult {
    return this.eventStore.commit(this.toEventStoreCommitInput(input));
  }

  private commitInsideTransaction(input: CanonicalAgentCommitInput): CanonicalAgentCommitResult {
    return this.eventStore.applyWithinTransaction(this.toEventStoreCommitInput(input));
  }

  private toEventStoreCommitInput(input: CanonicalAgentCommitInput): CanonicalAgentEventStoreInput {
    const { nativeCursor, ...storeInput } = input;
    return { ...storeInput, recoveryCursor: nativeCursor };
  }

  private toCanonicalCommitInput(input: CanonicalAgentEventStoreInput): CanonicalAgentCommitInput {
    const { recoveryCursor, ...commitInput } = input;
    return { ...commitInput, nativeCursor: recoveryCursor };
  }

  private toEventStoreCheckpoint(
    checkpoint: CanonicalAgentCheckpoint | null,
  ): CanonicalAgentEventStoreCheckpoint | null {
    if (!checkpoint) return null;
    const { nativeCursor, ...storeCheckpoint } = checkpoint;
    return { ...storeCheckpoint, recoveryCursor: nativeCursor };
  }

  private toCanonicalCheckpoint(
    checkpoint: CanonicalAgentEventStoreCheckpoint | null,
  ): CanonicalAgentCheckpoint | null {
    if (!checkpoint) return null;
    const { recoveryCursor, ...canonicalCheckpoint } = checkpoint;
    return { ...canonicalCheckpoint, nativeCursor: recoveryCursor };
  }

  private recoverCommit(
    _input: CanonicalAgentCommitInput,
    error: unknown,
  ): CanonicalAgentCommitResult | null {
    return error instanceof StructuralIngestOverflow
      ? this.commitStructuralOverflow(error)
      : null;
  }

  private publishCommitted(result: CanonicalAgentCommitResult): CanonicalAgentCommitResult {
    if (result.events.length === 0) return { ...result, canonicalDelivery: "not-required" };
    try {
      this.publish(result.events);
      return { ...result, canonicalDelivery: "published" };
    } catch {
      return { ...result, canonicalDelivery: "deferred" };
    }
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
  recordCodexChildRoutingDiagnostic(input: CodexChildRoutingDiagnosticInput): boolean {
    return this.codexCollaboration.recordRoutingDiagnostic(input);
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
    return this.reads.loadThread(threadId);
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
    return this.reads.recoverThread(threadId, known);
  }

  /** Load one canonical turn record. */
  loadTurn(turnId: string): AgentTurn | null {
    return this.reads.loadTurn(turnId);
  }

  /** Load the canonical turn bound to one Mcode execution identity. */
  loadTurnByExecution(executionId: string): AgentTurn | null {
    const cachedTurnId = this.turnIdByExecution.get(executionId);
    if (cachedTurnId) return this.loadTurn(cachedTurnId);
    const turn = this.reads.loadTurnByExecution(executionId);
    if (!turn) return null;
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

  /** Load the newest canonical turn for one thread. */
  loadLatestTurn(threadId: string): AgentTurn | null {
    const row = this.db.prepare(`
      SELECT *
      FROM canonical_agent_turns
      WHERE thread_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(threadId) as Record<string, unknown> | undefined;
    return row ? this.turnFromRow(row) : null;
  }

  /** Load the latest canonical permission mode retained for a thread. */
  loadLatestPermissionMode(threadId: string): AgentTurn["permissionMode"] | null {
    const row = this.db.prepare(`
      SELECT permission_mode
      FROM canonical_agent_turns
      WHERE thread_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(threadId) as { permission_mode: AgentTurn["permissionMode"] } | undefined;
    return row?.permission_mode ?? null;
  }

  /** Load one durable ingest checkpoint. */
  loadCheckpoint(executionId: string): CanonicalAgentCheckpoint | null {
    return this.reads.loadCheckpoint(executionId);
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

  /** Load the visible entries for one restart-scoped recovery incident. */
  listRecoveryIncidentEntries(recoveryIncidentId: string): CanonicalRecoveryIncidentEntry[] {
    const rows = this.db.prepare(`
      SELECT
        workspace.id AS workspace_id,
        workspace.name AS workspace_name,
        thread.id AS thread_id,
        thread.title AS thread_title,
        checkpoint.execution_id,
        turn.started_at,
        turn.ended_at
      FROM canonical_agent_ingest_checkpoints checkpoint
      JOIN canonical_agent_turns turn ON turn.id = checkpoint.turn_id
      JOIN threads thread ON thread.id = checkpoint.thread_id
      JOIN workspaces workspace ON workspace.id = thread.workspace_id
      WHERE checkpoint.recovery_incident_id = ?
        AND checkpoint.terminal_outcome = 'interrupted'
        AND checkpoint.phase = 'interrupted'
        AND turn.status = 'Interrupted'
        AND thread.user_completed_at IS NULL
        AND turn.started_at IS NOT NULL
        AND turn.ended_at IS NOT NULL
      ORDER BY turn.ended_at ASC, checkpoint.execution_id ASC
      LIMIT ?
    `).all(recoveryIncidentId, MAX_TURN_RECOVERIES + 1) as Array<{
      workspace_id: string;
      workspace_name: string;
      thread_id: string;
      thread_title: string;
      execution_id: string;
      started_at: string;
      ended_at: string;
    }>;
    if (rows.length > MAX_TURN_RECOVERIES) {
      throw new Error(`Recovery incident exceeds ${MAX_TURN_RECOVERIES} entries`);
    }
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      executionId: row.execution_id,
      startedAt: row.started_at,
      interruptedAt: row.ended_at,
    }));
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
    return this.reads.loadTerminalProjection(turnId);
  }

  /** Commit the canonical start of one ordinary user-triggered parent turn. */
  startParentTurn(input: CanonicalParentTurnStartInput): CanonicalAgentCommitResult {
    return this.parentLifecycle.start(input);
  }

  /** Start an ordinary parent turn from a provider-proven child action. */
  startProviderContinuation(input: CanonicalProviderContinuationInput): AgentTurn {
    return this.parentLifecycle.continue(input);
  }

  /** Mark the legacy thread projection active when a provider resumes its parent turn. */
  activateProviderContinuation(threadId: string): void {
    this.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?").run(
      "active",
      new Date().toISOString(),
      threadId,
    );
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
    return this.codexCollaboration.loadDelegation(parentThreadId, parentItemId);
  }

  /** Load the one Codex child delegation registered for an exact native receiver thread. */
  loadCodexChildDelegationByReceiverThreadId(nativeThreadId: string): CodexChildDelegation | null {
    return this.codexCollaboration.loadDelegationByReceiverThreadId(nativeThreadId);
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
    const source = this.collaborationSource(input);
    const target = this.collaborationTarget(input);
    const now = new Date().toISOString();
    const existing = this.loadCollaborationAction(input.actionId);
    const action = this.collaborationAction(input, source, target, existing, now);
    this.assertCollaborationActionIdentity(existing, action);
    const existingItem = this.collaborationSourceItem(input, source);
    const sourceItem = existingItem ?? this.newCollaborationSourceItem(input, source, now);
    this.commitCollaborationAction(input, source, action, sourceItem, existingItem);
    return action;
  }

  private collaborationSource(
    input: CollaborationActionInput,
  ): { sourceThread: AgentThread; sourceTurn: AgentTurn } {
    const sourceThread = this.loadThread(input.sourceThreadId);
    const sourceTurn = this.loadTurn(input.sourceTurnId);
    if (!sourceThread || !sourceTurn || sourceTurn.threadId !== sourceThread.id) {
      throw new Error(`Collaboration source turn is not canonical: ${input.sourceTurnId}`);
    }
    if (this.executionIdForTurn(sourceTurn.id) !== input.sourceExecutionId) {
      throw new Error(`Collaboration source execution does not own turn: ${input.sourceTurnId}`);
    }
    return { sourceThread, sourceTurn };
  }

  private collaborationTarget(
    input: CollaborationActionInput,
  ): { targetThread: AgentThread; targetTurnId?: string } {
    const targetThread = this.loadThread(input.targetThreadId);
    if (!targetThread) {
      throw new Error(`Collaboration target thread is not canonical: ${input.targetThreadId}`);
    }
    const activeTargetTurn = this.loadActiveTurn(targetThread.id);
    const targetTurn = input.targetTurnId ? this.loadTurn(input.targetTurnId) : null;
    this.assertCollaborationTargetTurn(input, targetThread, targetTurn);
    return {
      targetThread,
      ...(input.targetTurnId
        ? { targetTurnId: input.targetTurnId }
        : activeTargetTurn ? { targetTurnId: activeTargetTurn.id } : {}),
    };
  }

  private assertCollaborationTargetTurn(
    input: CollaborationActionInput,
    targetThread: AgentThread,
    targetTurn: AgentTurn | null,
  ): void {
    if (targetTurn && targetTurn.threadId !== targetThread.id) {
      throw new Error(`Collaboration target turn is not owned by target thread: ${input.targetTurnId}`);
    }
    if (input.targetTurnId && !targetTurn) {
      throw new Error(`Collaboration target turn is not canonical: ${input.targetTurnId}`);
    }
  }

  private collaborationAction(
    input: CollaborationActionInput,
    source: { sourceThread: AgentThread; sourceTurn: AgentTurn },
    target: { targetThread: AgentThread; targetTurnId?: string },
    existing: CollaborationAction | null,
    now: string,
  ): CollaborationAction {
    return {
      id: input.actionId,
      kind: input.kind,
      source: {
        threadId: source.sourceThread.id,
        turnId: source.sourceTurn.id,
        itemId: input.sourceItemId,
      },
      target: {
        threadId: target.targetThread.id,
        ...(target.targetTurnId ? { turnId: target.targetTurnId } : {}),
      },
      status: input.status,
      deliveryUnknown: false,
      providerIdentities: this.uniqueProviderIdentities(input.providerIdentities),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private assertCollaborationActionIdentity(
    existing: CollaborationAction | null,
    action: CollaborationAction,
  ): void {
    if (!existing) return;
    if (
      existing.kind !== action.kind
      || existing.source.threadId !== action.source.threadId
      || existing.source.turnId !== action.source.turnId
      || existing.source.itemId !== action.source.itemId
      || existing.target.threadId !== action.target.threadId
    ) {
      throw new Error(`Collaboration action identity conflict: ${action.id}`);
    }
  }

  private collaborationSourceItem(
    input: CollaborationActionInput,
    source: { sourceThread: AgentThread; sourceTurn: AgentTurn },
  ): AgentItem | null {
    const existingItem = this.loadItem(input.sourceItemId);
    if (existingItem && (
      existingItem.threadId !== source.sourceThread.id || existingItem.turnId !== source.sourceTurn.id
    )) {
      throw new Error(`Collaboration source item identity conflict: ${input.sourceItemId}`);
    }
    return existingItem;
  }

  private newCollaborationSourceItem(
    input: CollaborationActionInput,
    source: { sourceThread: AgentThread; sourceTurn: AgentTurn },
    now: string,
  ): AgentItem {
    return {
      id: input.sourceItemId,
      threadId: source.sourceThread.id,
      turnId: source.sourceTurn.id,
      kind: "tool-call",
      providerIdentities: [...input.providerIdentities],
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
    };
  }

  private commitCollaborationAction(
    input: CollaborationActionInput,
    source: { sourceThread: AgentThread; sourceTurn: AgentTurn },
    action: CollaborationAction,
    sourceItem: AgentItem,
    existingItem: AgentItem | null,
  ): void {
    const eventSuffix = hashCodexKey(`${input.actionId}:${input.status}:${action.target.turnId ?? "pending"}`);
    this.commit({
      threadId: source.sourceThread.id,
      turnId: source.sourceTurn.id,
      executionId: input.sourceExecutionId,
      phase: "running",
      events: [
        ...(existingItem ? [] : [this.itemDraft(
          input.sourceExecutionId,
          source.sourceThread,
          source.sourceTurn,
          sourceItem,
        )]),
        this.actionDraft(
          input.sourceExecutionId,
          source.sourceThread,
          action,
          `${input.sourceExecutionId}:collaboration:${eventSuffix}`,
        ),
      ],
    });
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
      return this.emptySubagentRoster(parsedRequest.owningParentThreadId, parent.rosterRevision);
    }
    return this.projectSubagentRoster(parsedRequest, parent, rows);
  }

  private emptySubagentRoster(owningParentThreadId: string, rosterRevision: number): CanonicalSubagentRoster {
    return CanonicalSubagentRosterSchema().parse({
      owningParentThreadId,
      rosterRevision,
      active: [],
      done: [],
    });
  }

  private projectSubagentRoster(
    request: CanonicalSubagentRosterRequest,
    parent: AgentThread,
    rows: Array<Record<string, unknown>>,
  ): CanonicalSubagentRoster {
    const lookup = this.loadSubagentRosterLookup(rows);
    const rosterRows = lookup.threads.map((thread) => this.projectSubagentRosterRow(
      request,
      thread,
      lookup,
    ));
    const { active, done } = this.partitionSubagentRosterRows(rosterRows, lookup.activeIds);
    const retainedActive = active.slice(0, request.limit);
    const retainedDone = done.slice(0, Math.max(0, request.limit - retainedActive.length));
    return CanonicalSubagentRosterSchema().parse({
      owningParentThreadId: request.owningParentThreadId,
      rosterRevision: parent.rosterRevision,
      active: retainedActive,
      done: retainedDone,
    });
  }

  private loadSubagentRosterLookup(rows: Array<Record<string, unknown>>): SubagentRosterLookup {
    const threads = rows.map((row) => this.threadFromRow(row));
    const turnsByThread = this.loadSubagentRosterTurns(threads);
    const itemRows = this.loadSubagentRosterItemRows(threads);
    const { actionsByThread, actionRows } = this.loadSubagentRosterActions(threads);
    const sourceItemsById = this.loadSubagentRosterSourceItems(actionRows);
    return {
      threads,
      turnsByThread,
      itemRows,
      actionsByThread,
      sourceItemsById,
      ...this.classifySubagentRosterThreads(threads, turnsByThread),
    };
  }

  private loadSubagentRosterTurns(threads: readonly AgentThread[]): Map<string, AgentTurn[]> {
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
    return turnsByThread;
  }

  private loadSubagentRosterItemRows(threads: readonly AgentThread[]): Array<Record<string, unknown>> {
    const threadIds = threads.map((thread) => thread.id);
    const placeholders = threadIds.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT *
      FROM canonical_agent_items
      WHERE thread_id IN (${placeholders})
    `).all(...threadIds) as Array<Record<string, unknown>>;
  }

  private loadSubagentRosterActions(threads: readonly AgentThread[]): {
    actionsByThread: Map<string, CollaborationAction>;
    actionRows: Array<Record<string, unknown>>;
  } {
    const threadIds = threads.map((thread) => thread.id);
    const placeholders = threadIds.map(() => "?").join(", ");
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
    return { actionsByThread, actionRows };
  }

  private loadSubagentRosterSourceItems(
    actionRows: readonly Record<string, unknown>[],
  ): Map<string, AgentItem> {
    const sourceItemIds = [...new Set(actionRows
      .map((row) => row.source_item_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0))];
    const sourceItemsById = new Map<string, AgentItem>();
    if (sourceItemIds.length === 0) return sourceItemsById;
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
    return sourceItemsById;
  }

  private classifySubagentRosterThreads(
    threads: readonly AgentThread[],
    turnsByThread: ReadonlyMap<string, readonly AgentTurn[]>,
  ): SubagentRosterActivity {
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
    return { latestTurns, activeIds };
  }

  private projectSubagentRosterRow(
    request: CanonicalSubagentRosterRequest,
    thread: AgentThread,
    lookup: SubagentRosterLookup,
  ): CanonicalSubagentRosterRow {
    const turns = lookup.turnsByThread.get(thread.id) ?? [];
    const latestTurn = lookup.latestTurns.get(thread.id) ?? null;
    const source = this.subagentRosterSource(thread.id, lookup);
    const timestamps = this.subagentRosterTimestamps(thread, turns, source.action, lookup.itemRows);
    const sourceFields = this.subagentRosterSourceFields(source.action, source.sourceItem?.payload ?? {});
    return {
      ...this.subagentRosterRowBase(
        request,
        thread,
        latestTurn,
        timestamps.startedAt,
        timestamps.updatedAt,
        lookup.threads,
      ),
      ...sourceFields,
      ...this.subagentRosterIdentities(thread, source),
      ...this.subagentRosterActivityFields(thread.id, lookup),
    };
  }

  private subagentRosterTimestamps(
    thread: AgentThread,
    turns: readonly AgentTurn[],
    action: CollaborationAction | undefined,
    itemRows: readonly Record<string, unknown>[],
  ): { startedAt: string; updatedAt: string } {
    return {
      startedAt: this.subagentRosterStartedAt(turns, thread.createdAt),
      updatedAt: this.maxSubagentTimestamp([
        thread.updatedAt,
        ...turns.map((turn) => turn.updatedAt),
        ...this.subagentRosterItemTimes(thread.id, itemRows),
        action?.updatedAt,
      ], thread.updatedAt),
    };
  }

  private subagentRosterIdentities(
    thread: AgentThread,
    source: { action: CollaborationAction | undefined; sourceItem: AgentItem | undefined },
  ): Pick<CanonicalSubagentRosterRow, "providerIdentities" | "sourceProviderIdentities"> {
    return {
      providerIdentities: this.uniqueProviderIdentities([
        ...thread.providerIdentities,
        ...(source.action?.providerIdentities ?? []),
        ...(source.sourceItem?.providerIdentities ?? []),
      ]),
      sourceProviderIdentities: this.uniqueProviderIdentities(source.sourceItem?.providerIdentities ?? []),
    };
  }

  private subagentRosterActivityFields(
    threadId: string,
    lookup: SubagentRosterLookup,
  ): Pick<CanonicalSubagentRosterRow, "hasActiveDescendant" | "canStop"> {
    const active = lookup.activeIds.has(threadId);
    return {
      hasActiveDescendant: !active && this.subagentHasActiveDescendant(threadId, lookup),
      canStop: false,
    };
  }

  private subagentRosterSource(
    threadId: string,
    lookup: SubagentRosterLookup,
  ): { action: CollaborationAction | undefined; sourceItem: AgentItem | undefined } {
    const action = lookup.actionsByThread.get(threadId);
    return {
      action,
      sourceItem: action ? lookup.sourceItemsById.get(action.source.itemId) : undefined,
    };
  }

  private subagentRosterStartedAt(turns: readonly AgentTurn[], fallback: string): string {
    return turns
      .map((turn) => turn.startedAt)
      .filter((value): value is string => value !== null)
      .sort()[0] ?? fallback;
  }

  private subagentRosterItemTimes(
    threadId: string,
    itemRows: readonly Record<string, unknown>[],
  ): string[] {
    return itemRows
      .filter((row) => row.thread_id === threadId)
      .flatMap((row) => [String(row.created_at), String(row.updated_at)]);
  }

  private maxSubagentTimestamp(
    values: readonly (string | null | undefined)[],
    fallback: string,
  ): string {
    return values.filter((value): value is string => typeof value === "string")
      .sort((left, right) => right.localeCompare(left))[0] ?? fallback;
  }

  private subagentRosterRowBase(
    request: CanonicalSubagentRosterRequest,
    thread: AgentThread,
    latestTurn: AgentTurn | null,
    startedAt: string,
    updatedAt: string,
    threads: readonly AgentThread[],
  ): Omit<CanonicalSubagentRosterRow, "sourceItemId" | "task" | "identity" | "model" | "reasoning" | "providerIdentities" | "sourceProviderIdentities" | "hasActiveDescendant" | "canStop"> {
    const latestTurnStatus = latestTurn?.status ?? null;
    return {
      id: thread.id,
      parentThreadId: thread.parentThreadId ?? request.owningParentThreadId,
      rootThreadId: thread.rootThreadId,
      owningParentThreadId: thread.owningParentThreadId ?? request.owningParentThreadId,
      lineage: this.subagentLineage(request.owningParentThreadId, thread, threads),
      activityState: thread.activityState,
      latestTurnStatus,
      startedAt,
      updatedAt,
      endedAt: latestTurn?.endedAt ?? null,
      terminalOutcome: canonicalSubagentTerminalOutcome(latestTurnStatus),
    };
  }

  private subagentRosterSourceFields(
    action: CollaborationAction | undefined,
    payload: Record<string, unknown>,
  ): Pick<CanonicalSubagentRosterRow, "sourceItemId"> & SubagentRosterMetadata {
    const sourceItemId = action?.source.itemId;
    return {
      ...(sourceItemId ? { sourceItemId } : {}),
      ...this.subagentRosterMetadata(payload),
    };
  }

  private subagentRosterMetadata(payload: Record<string, unknown>): SubagentRosterMetadata {
    const record = this.subagentRosterToolRecord(payload);
    const metadata: SubagentRosterMetadata = {};
    this.setSubagentRosterText(
      metadata,
      "task",
      this.firstSubagentRosterValue(payload.description, record?.subagent_prompt, record?.input_summary),
    );
    this.setSubagentRosterText(metadata, "identity", this.firstSubagentRosterValue(payload.identity, record?.display_name));
    this.setSubagentRosterText(metadata, "model", this.firstSubagentRosterValue(payload.model, record?.model));
    this.setSubagentRosterText(
      metadata,
      "reasoning",
      this.firstSubagentRosterValue(payload.reasoningEffort, record?.reasoning_effort),
    );
    return metadata;
  }

  private firstSubagentRosterValue(...values: unknown[]): unknown {
    return values.find((value) => typeof value === "string" && value.trim().length > 0);
  }

  private subagentRosterToolRecord(payload: Record<string, unknown>): Record<string, unknown> | undefined {
    return payload.projection === "toolCall"
      && payload.record !== null
      && typeof payload.record === "object"
      && !Array.isArray(payload.record)
      ? payload.record as Record<string, unknown>
      : undefined;
  }

  private setSubagentRosterText(
    metadata: SubagentRosterMetadata,
    key: keyof SubagentRosterMetadata,
    value: unknown,
  ): void {
    const text = this.subagentRosterText(value);
    if (text) metadata[key] = text;
  }

  private subagentRosterText(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  }

  private subagentLineage(
    owningParentThreadId: string,
    thread: AgentThread,
    threads: readonly AgentThread[],
  ): string[] {
    const chain = [thread.id];
    const seen = new Set(chain);
    let current = thread.parentThreadId;
    while (current && !seen.has(current) && chain.length < CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH) {
      chain.push(current);
      seen.add(current);
      current = threads.find((candidate) => candidate.id === current)?.parentThreadId;
    }
    if (!chain.includes(owningParentThreadId)) chain.push(owningParentThreadId);
    const lineage = chain.reverse();
    return lineage.length <= CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH
      ? lineage
      : [lineage[0]!, ...lineage.slice(-(CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH - 1))];
  }

  private subagentHasActiveDescendant(threadId: string, lookup: SubagentRosterLookup): boolean {
    return lookup.threads.some((candidate) => this.isActiveSubagentDescendant(threadId, candidate, lookup));
  }

  private isActiveSubagentDescendant(
    threadId: string,
    candidate: AgentThread,
    lookup: SubagentRosterLookup,
  ): boolean {
    if (!lookup.activeIds.has(candidate.id) || candidate.id === threadId) return false;
    let current = candidate.parentThreadId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === threadId) return true;
      seen.add(current);
      current = lookup.threads.find((thread) => thread.id === current)?.parentThreadId;
    }
    return false;
  }

  private partitionSubagentRosterRows(
    rosterRows: readonly CanonicalSubagentRosterRow[],
    activeIds: ReadonlySet<string>,
  ): { active: CanonicalSubagentRosterRow[]; done: CanonicalSubagentRosterRow[] } {
    const active = rosterRows
      .filter((row) => activeIds.has(row.id))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
    const done = rosterRows
      .filter((row) => !activeIds.has(row.id))
      .sort((left, right) => (
        (right.endedAt ?? right.updatedAt).localeCompare(left.endedAt ?? left.updatedAt)
        || right.id.localeCompare(left.id)
      ));
    return { active, done };
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

  /** Load one sub-agent stop target through the generic lifecycle durability port. */
  loadSubagentStopTarget(request: CanonicalSubagentStopRequest): SubagentStopTarget | null {
    return this.loadCanonicalChildStopTarget(request);
  }

  /** Load active sub-agent stop targets through the generic lifecycle durability port. */
  loadActiveSubagentStopTargets(owningParentThreadId: string): SubagentStopTarget[] {
    return this.loadCanonicalChildStopTargets(owningParentThreadId);
  }

  /** Record interrupted state for every still-running sub-agent after a parent stop. */
  interruptSubagentTurns(childThreadIds: readonly string[], reason: string): void {
    for (const childThreadId of childThreadIds) {
      this.finishCanonicalChildTurn({ childThreadId, outcome: "interrupted", error: reason });
    }
  }

  /** Persist a generic sub-agent interruption through the durable child-turn owner. */
  finishSubagentTurn(input: {
    childThreadId: string;
    nativeTurnId: string;
    outcome: "interrupted";
    error: string;
  }): AgentTurn {
    return this.finishCodexChildTurn(input);
  }

  /** Provision one Starting child and one directional Dispatched action exactly once. */
  startCodexChildDelegation(input: CodexChildDelegationInput): CodexChildDelegation {
    return this.codexCollaboration.startDelegation(input);
  }

  /** Mark a child delivery as unknown without making the uncertain child reusable. */
  markCodexChildDeliveryUnknown(input: CodexChildDeliveryInput): CodexChildDelegation {
    return this.codexCollaboration.markDeliveryUnknown(input);
  }

  /** Mark a provider-confirmed child rejection as failed and unavailable. */
  markCodexChildDeliveryRejected(input: CodexChildDeliveryInput): CodexChildDelegation {
    return this.codexCollaboration.markDeliveryRejected(input);
  }

  /** Mark dispatched child deliveries as uncertain when their owning execution cannot be resumed. */
  markUnresolvedCodexChildDeliveriesUnknown(executionId: string): string[] {
    return this.codexCollaboration.markUnresolvedDeliveriesUnknown(executionId, MAX_TURN_RECOVERIES);
  }

  /** Create a linked replacement child for a failed or uncertain delivery. */
  retryCodexChildDelegation(input: CodexChildRetryInput): CodexChildDelegation {
    return this.codexCollaboration.retryDelegation(input);
  }

  /** Add exact Codex receiver-thread identities to a provisional delegation. */
  registerCodexReceiverThreadIds(
    input: CodexChildIdentityInput & { receiverThreadIds: readonly string[] },
  ): CodexChildDelegation {
    return this.codexCollaboration.registerReceiverThreadIds(input);
  }

  /** Bind a child only when its native thread identity is an exact registered receiver. */
  bindCodexChildIdentity(input: CodexChildIdentityInput): CodexChildDelegation {
    return this.codexCollaboration.bindChildIdentity(input);
  }

  /** Create and start the canonical child turn after exact native turn evidence. */
  startCodexChildTurn(input: CodexChildTurnStartInput): AgentTurn {
    return this.codexCollaboration.startChildTurn(input);
  }

  /** Persist one child message, reasoning item, tool call, or tool result exactly once. */
  recordCodexChildItem(input: CodexChildItemInput): AgentItem {
    return this.codexCollaboration.recordChildItem(input);
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
    if (input.items.length === 0 && (input.discardedItemIds?.length ?? 0) === 0) return true;
    const now = new Date().toISOString();
    this.persistParentNarrativeRecoveryBatched(input, thread, turn, now);
    return true;
  }

  private persistParentNarrativeRecoveryBatched(
    input: ParentNarrativeRecoveryCommitInput,
    thread: AgentThread,
    turn: AgentTurn,
    now: string,
  ): void {
    const checkpoint = this.loadCheckpoint(input.executionId);
    if (!checkpoint) throw new Error(`Canonical parent checkpoint was not found: ${input.executionId}`);
    if (checkpoint.terminalOutcome) return;
    const operations = [
      ...input.items.map((item) => ({ kind: "persist" as const, item })),
      ...(input.discardedItemIds ?? []).map((itemId) => ({ kind: "discard" as const, itemId })),
    ];
    const byteLength = (operation: (typeof operations)[number]) => operation.kind === "persist"
      ? Buffer.byteLength(JSON.stringify(operation.item), "utf8")
      : Buffer.byteLength(operation.itemId, "utf8");
    assertActiveTurnRecoveryRetention(
      operations.length,
      operations.reduce((total, operation) => total + byteLength(operation), 0),
    );
    runBoundedWriteBatchesSync({
      db: this.db,
      items: operations,
      limits: ACTIVE_TURN_WRITE_BATCH_LIMITS,
      byteLength,
      write: (operation) => {
        if (operation.kind === "persist") {
          this.persistParentNarrativeRecoveryItem(operation.item, thread, turn, now);
          return;
        }
        this.discardParentNarrativeRecoveryItem(operation.itemId, thread, turn);
      },
    });
  }

  private persistParentNarrativeRecoveryItem(
    item: ParentNarrativeRecoveryItem,
    thread: AgentThread,
    turn: AgentTurn,
    now: string,
  ): void {
    const itemId = this.parentNarrativeRecoveryItemId(item);
    this.persistItem({
      id: itemId,
      threadId: thread.id,
      turnId: turn.id,
      ...this.parentNarrativeRecoveryParent(item),
      kind: this.parentNarrativeRecoveryItemKind(item),
      providerIdentities: turn.providerIdentities,
      payload: this.parentNarrativeRecoveryPayload(item, itemId),
      createdAt: item.record.started_at,
      updatedAt: now,
    });
  }

  private parentNarrativeRecoveryItemId(item: ParentNarrativeRecoveryItem): string {
    return item.kind === "toolCall"
      ? `toolCall:${item.record.id}`
      : `${item.kind}:${item.record.id}`;
  }

  private parentNarrativeRecoveryParent(
    item: ParentNarrativeRecoveryItem,
  ): { parentItemId?: string } {
    if (item.kind !== "toolCall") return {};
    const parentToolCallId = item.record.parent_tool_call_id;
    return parentToolCallId ? { parentItemId: `toolCall:${parentToolCallId}` } : {};
  }

  private parentNarrativeRecoveryItemKind(item: ParentNarrativeRecoveryItem): AgentItem["kind"] {
    if (item.kind === "toolCall") return "tool-call";
    return item.kind === "narrationSegment" ? "reasoning" : "system";
  }

  private parentNarrativeRecoveryPayload(
    item: ParentNarrativeRecoveryItem,
    itemId: string,
  ): Record<string, unknown> {
    const existingPayload = this.loadItem(itemId)?.payload ?? {};
    return {
      projection: "narrativeRecovery",
      narrative: item,
      ...this.parentNarrativeRecoveryMetadata(item, existingPayload),
    };
  }

  private parentNarrativeRecoveryMetadata(
    item: ParentNarrativeRecoveryItem,
    existingPayload: Record<string, unknown>,
  ): Record<string, string> {
    if (item.kind !== "toolCall") return {};
    const metadata: Record<string, string> = {};
    this.copyRecoveryMetadata(metadata, "identity", existingPayload.identity);
    this.copyRecoveryMetadata(metadata, "model", existingPayload.model);
    this.copyRecoveryMetadata(metadata, "reasoningEffort", existingPayload.reasoningEffort);
    return metadata;
  }

  private copyRecoveryMetadata(
    metadata: Record<string, string>,
    key: string,
    value: unknown,
  ): void {
    if (typeof value === "string") metadata[key] = value;
  }

  private discardParentNarrativeRecoveryItem(
    itemId: string,
    thread: AgentThread,
    turn: AgentTurn,
  ): void {
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
    return this.codexCollaboration.finishChildTurn(input);
  }

  /** Terminalize the latest running canonical child turn by its durable thread identity. */
  finishCanonicalChildTurn(input: CanonicalChildTurnFinishInput): AgentTurn | null {
    return this.codexCollaboration.finishLatestChildTurn(input);
  }

  /** Commit the first terminal result and its message and narrative projection. */
  finishParentTurn(input: CanonicalParentTurnFinishInput): CanonicalAgentCommitResult {
    return this.parentLifecycle.finish(input);
  }

  /** Load the accepted user input for one canonical turn. */
  loadUserMessage(turnId: string): Message | null {
    return this.reads.loadUserMessage(turnId);
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
    recoveryIncidentId?: string,
  ): CanonicalAgentCommitResult {
    return this.parentLifecycle.interrupt({
      executionId,
      reason,
      stagedAssistant,
      finalizeCompatibility,
      recoveredNarrative,
      recoveryIncidentId,
    } satisfies ParentTurnInterruptionInput);
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
      return this.confirmedParentTerminalBatch(checkpoint, input.threadId);
    }
    return this.writeParentTerminalBatches(input, checkpoint);
  }

  private confirmedParentTerminalBatch(
    checkpoint: CanonicalAgentCheckpoint,
    threadId: string,
  ): CanonicalAgentBatchedCommitResult {
    this.db.transaction(() => this.retireParentNarrativeRecovery(checkpoint.turnId))();
    const thread = this.loadThread(threadId);
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

  private async writeParentTerminalBatches(
    input: CanonicalParentTurnFinishInput,
    checkpoint: CanonicalAgentCheckpoint | null,
  ): Promise<CanonicalAgentBatchedCommitResult> {
    const projection = input.projectTurn();
    const endedAt = new Date().toISOString();
    const drafts = this.parentTurnTerminalEvents(input, projection, endedAt);
    const terminalRevision = this.parentTerminalRevision(input.threadId, drafts);
    const batchOverheadBytes = this.parentTerminalBatchOverhead(input, checkpoint);
    const terminalEventId = `${input.executionId}:turn.${input.outcome}`;
    const state = this.newParentTerminalBatchState();
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
      onBatchStarted: () => this.startParentTerminalBatch(state, input),
      write: (draft) => this.writeParentTerminalBatchDraft(
        state,
        input,
        draft,
        terminalRevision,
        terminalEventId,
      ),
      onBatchFinishing: () => this.finishParentTerminalBatch(state, input, terminalRevision),
      onBatchCommitted: () => this.publishParentTerminalBatch(state),
    });
    return this.parentTerminalBatchResult(state, writeBatches);
  }

  private parentTerminalRevision(
    threadId: string,
    drafts: readonly CanonicalAgentEventDraft[],
  ): number {
    const partialRevision = this.db
      .prepare("SELECT durable_revision FROM canonical_agent_events WHERE event_id = ?")
      .get(drafts[0]!.eventId) as { durable_revision: number } | undefined;
    return partialRevision?.durable_revision ?? (this.loadThread(threadId)?.conversationRevision ?? 0) + 1;
  }

  private parentTerminalBatchOverhead(
    input: CanonicalParentTurnFinishInput,
    checkpoint: CanonicalAgentCheckpoint | null,
  ): number {
    return Buffer.byteLength(JSON.stringify({
      thread: this.loadThread(input.threadId),
      turn: this.loadTurn(input.turnId),
      checkpoint,
    }), "utf8");
  }

  private newParentTerminalBatchState(): ParentTerminalBatchState {
    return {
      latest: null,
      published: [],
      pendingPublication: [],
      modelState: null,
      checkpoint: null,
      acceptedAt: "",
      acceptedSequence: 0,
      changed: false,
      wrote: false,
      terminal: false,
      ignoredTerminal: false,
    };
  }

  private startParentTerminalBatch(
    state: ParentTerminalBatchState,
    input: CanonicalParentTurnFinishInput,
  ): void {
    state.modelState = this.loadState(input.threadId, input.executionId);
    state.checkpoint = this.loadCheckpoint(input.executionId);
    state.acceptedAt = new Date().toISOString();
    state.acceptedSequence = state.checkpoint?.lastAcceptedSequence ?? 0;
    state.changed = false;
    state.wrote = false;
    state.terminal = false;
    state.ignoredTerminal = false;
  }

  private writeParentTerminalBatchDraft(
    state: ParentTerminalBatchState,
    input: CanonicalParentTurnFinishInput,
    draft: CanonicalAgentEventDraft,
    terminalRevision: number,
    terminalEventId: string,
  ): void {
    const terminal = draft.eventId === terminalEventId;
    if (terminal) input.finalizeCompatibility?.();
    if (this.parentTerminalBatchContains(draft)) return;
    const accepted = this.acceptParentTerminalBatchEvent(state, draft, terminalRevision);
    this.persistParentTerminalBatchEvent(state, accepted.event);
    this.trackParentTerminalBatchEvent(state, accepted, terminal);
  }

  private parentTerminalBatchContains(draft: CanonicalAgentEventDraft): boolean {
    const existingRow = this.db
      .prepare("SELECT envelope_json FROM canonical_agent_events WHERE event_id = ?")
      .get(draft.eventId) as { envelope_json: string } | undefined;
    if (!existingRow) return false;
    this.assertDuplicateMatches(
      draft,
      CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(existingRow.envelope_json)),
    );
    return true;
  }

  private acceptParentTerminalBatchEvent(
    state: ParentTerminalBatchState,
    draft: CanonicalAgentEventDraft,
    terminalRevision: number,
  ): ParentTerminalBatchEvent {
    const modelState = state.modelState;
    if (!modelState) throw new Error("Canonical batch state was not initialized");
    state.acceptedSequence += 1;
    const event = this.createEnvelope(draft, state.acceptedSequence, terminalRevision, state.acceptedAt);
    const reduction = reduceAgentEventBatch(modelState, [event]);
    if (reduction.outcome === "rejected") {
      throw new Error(`Canonical event ${reduction.eventId} rejected: ${reduction.reason}`);
    }
    const [application] = this.applyIndividually(modelState, [event]);
    state.ignoredTerminal ||= application?.outcome === "terminal-outcome-confirmed";
    state.modelState = reduction.state;
    this.updateParentTerminalBatchRevision(
      state,
      reduction.appliedCount,
      terminalRevision,
      draft.routing.threadId,
    );
    return { event, application };
  }

  private updateParentTerminalBatchRevision(
    state: ParentTerminalBatchState,
    appliedCount: number,
    terminalRevision: number,
    threadId: string,
  ): void {
    if (appliedCount === 0) return;
    const modelState = this.parentTerminalBatchModelState(state);
    const thread = modelState.threads[threadId];
    if (thread) {
      state.modelState = {
        ...modelState,
        threads: {
          ...modelState.threads,
          [thread.id]: {
            ...thread,
            conversationRevision: terminalRevision,
            updatedAt: state.acceptedAt,
          },
        },
      };
    }
    state.changed = true;
  }

  private persistParentTerminalBatchEvent(
    state: ParentTerminalBatchState,
    event: CanonicalAgentEventEnvelope,
  ): void {
    const modelState = this.parentTerminalBatchModelState(state);
    if (event.payload.type === "item.recorded") {
      const item = modelState.items[event.payload.item.id];
      if (item) this.persistItem(item);
    } else if (event.payload.type === "collaboration-action.recorded") {
      const action = modelState.collaborationActions[event.payload.collaborationAction.id];
      if (action) this.persistAction(action);
    }
    this.insertEvent(event);
  }

  private trackParentTerminalBatchEvent(
    state: ParentTerminalBatchState,
    accepted: ParentTerminalBatchEvent,
    terminal: boolean,
  ): void {
    if (accepted.application?.outcome === "applied") {
      state.pendingPublication.push(accepted.event);
      state.published.push(accepted.event);
    }
    state.wrote = true;
    state.terminal ||= terminal;
  }

  private finishParentTerminalBatch(
    state: ParentTerminalBatchState,
    input: CanonicalParentTurnFinishInput,
    terminalRevision: number,
  ): void {
    const modelState = this.parentTerminalBatchModelState(state);
    if (!state.wrote) {
      state.latest = this.duplicateParentTerminalBatchResult(modelState, input.threadId, state.acceptedSequence);
      return;
    }
    this.persistParentTerminalBatchState(state, input);
    this.persistParentTerminalBatchCheckpoint(state, input);
    if (state.terminal) this.retireParentNarrativeRecovery(input.turnId);
    state.latest = this.committedParentTerminalBatchResult(state, input.threadId, terminalRevision);
  }

  private parentTerminalBatchModelState(state: ParentTerminalBatchState): AgentModelState {
    if (!state.modelState) throw new Error("Canonical batch state was not initialized");
    return state.modelState;
  }

  private duplicateParentTerminalBatchResult(
    modelState: AgentModelState,
    threadId: string,
    acceptedSequence: number,
  ): Omit<CanonicalAgentBatchedCommitResult, "writeBatches"> {
    const thread = modelState.threads[threadId];
    return {
      outcome: "duplicate",
      conversationRevision: thread?.conversationRevision ?? 0,
      rosterRevision: thread?.rosterRevision ?? 0,
      acceptedThrough: acceptedSequence,
      durableThrough: acceptedSequence,
      events: [],
    };
  }

  private persistParentTerminalBatchState(
    state: ParentTerminalBatchState,
    input: CanonicalParentTurnFinishInput,
  ): void {
    if (!state.changed) return;
    const modelState = this.parentTerminalBatchModelState(state);
    const thread = modelState.threads[input.threadId];
    if (thread) this.persistThread(thread);
    this.persistParentTerminalBatchTurn(modelState, input);
  }

  private persistParentTerminalBatchTurn(
    modelState: AgentModelState,
    input: CanonicalParentTurnFinishInput,
  ): void {
    const turn = modelState.turns[input.turnId];
    if (turn?.threadId === input.threadId) this.persistTurn(turn, input.executionId);
  }

  private persistParentTerminalBatchCheckpoint(
    state: ParentTerminalBatchState,
    input: CanonicalParentTurnFinishInput,
  ): void {
    this.persistCheckpoint({
      executionId: input.executionId,
      threadId: input.threadId,
      turnId: input.turnId,
      lastAcceptedSequence: state.acceptedSequence,
      lastDurableSequence: state.acceptedSequence,
      nativeCursor: state.checkpoint?.nativeCursor ?? null,
      phase: state.terminal ? input.outcome : "running",
      terminalOutcome: state.terminal ? input.outcome : null,
      error: state.terminal ? input.error ?? null : null,
      updatedAt: state.acceptedAt,
    });
  }

  private committedParentTerminalBatchResult(
    state: ParentTerminalBatchState,
    threadId: string,
    terminalRevision: number,
  ): Omit<CanonicalAgentBatchedCommitResult, "writeBatches"> {
    const thread = this.parentTerminalBatchModelState(state).threads[threadId];
    return {
      outcome: !state.changed && state.ignoredTerminal
        ? "terminal-outcome-confirmed"
        : "committed",
      conversationRevision: thread?.conversationRevision ?? terminalRevision,
      rosterRevision: thread?.rosterRevision ?? 0,
      acceptedThrough: state.acceptedSequence,
      durableThrough: state.acceptedSequence,
      events: [],
    };
  }

  private publishParentTerminalBatch(state: ParentTerminalBatchState): void {
    if (state.pendingPublication.length === 0) return;
    const events = state.pendingPublication.splice(0);
    this.recordCanonicalDiagnostics(events);
    this.publish(events);
  }

  private parentTerminalBatchResult(
    state: ParentTerminalBatchState,
    writeBatches: WriteBatchResult,
  ): CanonicalAgentBatchedCommitResult {
    const committed = state.latest;
    if (!committed) throw new Error("Canonical terminal batch did not contain an event");
    return { ...committed, events: state.published, writeBatches };
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
    return this.reads.loadConversationProjection(threadId, limit, before, after);
  }


  private parentTurnStartEvents(
    input: {
      thread: { id: string; workspaceId: string; providerId: string; createdAt: string };
      turnId: string;
      executionId: string;
      permissionMode: "supervised" | "full";
      approvalReviewMode?: "manual" | "automatic";
      approvalReviewReason?: string;
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
            approvalReviewMode: input.approvalReviewMode ?? "manual",
            approvalReviewReason: input.approvalReviewReason ?? "manual-requested",
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
    input: CanonicalParentTerminalEventInput,
    projection: CanonicalParentTurnProjection | null,
    endedAt: string,
  ): CanonicalAgentEventDraft[] {
    const sourceIdentities = [...input.providerIdentities];
    const events = this.parentIdentityRefreshEvents(input, sourceIdentities, endedAt);
    this.appendTerminalProjectionEvents(events, input, projection);
    events.push(this.parentTerminalEvent(input, sourceIdentities, endedAt));
    return events;
  }

  private parentIdentityRefreshEvents(
    input: CanonicalParentTerminalEventInput,
    sourceIdentities: ProviderIdentity[],
    endedAt: string,
  ): CanonicalAgentEventDraft[] {
    const currentThread = this.loadThread(input.threadId);
    if (!currentThread || JSON.stringify(currentThread.providerIdentities) === JSON.stringify(sourceIdentities)) {
      return [];
    }
    return [{
      eventId: `${input.executionId}:thread-identity`,
      routing: { threadId: input.threadId, executionId: input.executionId },
      sourceProviderId: input.providerId,
      sourceIdentities,
      payload: {
        type: "thread.recorded",
        thread: { ...currentThread, providerIdentities: sourceIdentities, updatedAt: endedAt },
      },
    }];
  }

  private appendTerminalProjectionEvents(
    events: CanonicalAgentEventDraft[],
    input: CanonicalParentTerminalEventInput,
    projection: CanonicalParentTurnProjection | null,
  ): void {
    if (!projection) return;
    if (projection.message) events.push(this.messageProjectionItemEvent(input, projection.message));
    const ownedToolCallIds = this.codexCollaboration.ownedToolCallIds(projection.narrative);
    for (const entry of projection.narrative) {
      const item = this.narrativeProjectionItem(entry, ownedToolCallIds);
      if (item) events.push(this.projectionItemEvent(input, item));
    }
  }

  private messageProjectionItemEvent(
    input: CanonicalParentTerminalEventInput,
    message: Message,
  ): CanonicalAgentEventDraft {
    return this.projectionItemEvent(input, {
      id: `message:${message.id}`,
      kind: "message",
      payload: { projection: "message", message },
      createdAt: message.timestamp,
    });
  }

  private narrativeProjectionItem(
    entry: NarrativeEntry,
    ownedToolCallIds: ReadonlySet<string>,
  ): {
    id: string;
    kind: AgentItem["kind"];
    payload: Record<string, unknown>;
    createdAt: string;
    parentItemId?: string;
  } | null {
    if (entry.kind === "assistantMessage") return null;
    if (entry.kind === "toolCall" && ownedToolCallIds.has(entry.record.id)) return null;
    return {
      id: `${entry.kind}:${entry.record.id}`,
      kind: narrativeItemKind(entry.kind),
      payload: { projection: entry.kind, record: entry.record },
      createdAt: entry.record.started_at,
      ...narrativeParentItem(entry),
    };
  }

  private parentTerminalEvent(
    input: CanonicalParentTerminalEventInput,
    sourceIdentities: ProviderIdentity[],
    endedAt: string,
  ): CanonicalAgentEventDraft {
    const payload = parentTerminalPayload(input.outcome, input.error, endedAt);
    return {
      eventId: `${input.executionId}:${payload.type}`,
      routing: { threadId: input.threadId, turnId: input.turnId, executionId: input.executionId },
      sourceProviderId: input.providerId,
      sourceIdentities,
      payload,
    };
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
    if (this.structuralIngestBatchOverflows(structural.length, volatile.length)) {
      throw new StructuralIngestOverflow(
        input,
        checkpoint?.lastAcceptedSequence ?? 0,
        checkpoint?.lastDurableSequence ?? 0,
      );
    }
    return this.boundVolatileIngestEvents(input, events, structural.length, volatile);
  }

  private structuralIngestBatchOverflows(structuralCount: number, volatileCount: number): boolean {
    return structuralCount > CANONICAL_AGENT_EVENT_BATCH_MAX
      || (structuralCount === CANONICAL_AGENT_EVENT_BATCH_MAX && volatileCount > 0);
  }

  private boundVolatileIngestEvents(
    input: CanonicalAgentCommitInput,
    events: readonly CanonicalAgentEventDraft[],
    structuralCount: number,
    volatile: readonly CanonicalAgentEventDraft[],
  ): readonly CanonicalAgentEventDraft[] {
    const volatileCapacity = Math.min(
      CANONICAL_AGENT_EVENT_BATCH_MAX - CANONICAL_AGENT_CONTROL_EVENT_RESERVE,
      CANONICAL_AGENT_EVENT_BATCH_MAX - structuralCount,
    );
    if (volatile.length <= volatileCapacity) return events;
    const retained = this.retainedVolatileIngestEvents(events, volatile, volatileCapacity, structuralCount);
    const source = volatile[0];
    if (!source) return retained.events;
    const marker = this.volatileTruncationMarker(input, source, retained.droppedEventCount);
    return this.insertVolatileTruncationMarker(retained.events, marker);
  }

  private retainedVolatileIngestEvents(
    events: readonly CanonicalAgentEventDraft[],
    volatile: readonly CanonicalAgentEventDraft[],
    volatileCapacity: number,
    structuralCount: number,
  ): RetainedVolatileIngestEvents {
    const markerCapacity = CANONICAL_AGENT_EVENT_BATCH_MAX - structuralCount - 1;
    const retainedVolatile = new Set(volatile.slice(
      0,
      Math.max(0, Math.min(volatileCapacity, markerCapacity)),
    ));
    const retained = events.filter(
      (event) => event.ingestClass !== "volatile" || retainedVolatile.has(event),
    );
    return {
      events: retained,
      droppedEventCount: volatile.length - retainedVolatile.size,
    };
  }

  private volatileTruncationMarker(
    input: CanonicalAgentCommitInput,
    source: CanonicalAgentEventDraft,
    droppedEventCount: number,
  ): CanonicalAgentEventDraft {
    return {
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
  }

  private insertVolatileTruncationMarker(
    retained: readonly CanonicalAgentEventDraft[],
    marker: CanonicalAgentEventDraft,
  ): readonly CanonicalAgentEventDraft[] {
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
    this.addThreadState(state, threadId);
    this.addTurnState(state, threadId);
    this.addItemState(state, threadId);
    this.addCollaborationActionState(state, threadId);
    this.addEventState(state, threadId);
    this.addCheckpointState(state, executionId);
    return state;
  }

  private addThreadState(state: AgentModelState, threadId: string): void {
    const thread = this.loadThread(threadId);
    if (thread) state.threads[thread.id] = thread;
    const rows = this.db.prepare(
      "SELECT * FROM canonical_agent_threads WHERE parent_thread_id = ?",
    ).all(threadId) as Record<string, unknown>[];
    for (const row of rows) {
      const childThread = this.threadFromRow(row);
      state.threads[childThread.id] = childThread;
    }
  }

  private addTurnState(state: AgentModelState, threadId: string): void {
    const rows = this.db.prepare("SELECT * FROM canonical_agent_turns WHERE thread_id = ?")
      .all(threadId) as Record<string, unknown>[];
    for (const row of rows) {
      const turn = this.turnFromRow(row);
      state.turns[turn.id] = turn;
    }
  }

  private addItemState(state: AgentModelState, threadId: string): void {
    const rows = this.db.prepare("SELECT * FROM canonical_agent_items WHERE thread_id = ?")
      .all(threadId) as Record<string, unknown>[];
    for (const row of rows) {
      const item = this.itemFromRow(row);
      state.items[item.id] = item;
    }
  }

  private addCollaborationActionState(state: AgentModelState, threadId: string): void {
    const rows = this.db.prepare(`
      SELECT * FROM canonical_collaboration_actions
      WHERE source_thread_id = ? OR target_thread_id = ?
    `).all(threadId, threadId) as Record<string, unknown>[];
    for (const row of rows) {
      const action = this.actionFromRow(row);
      state.collaborationActions[action.id] = action;
    }
  }

  private addEventState(state: AgentModelState, threadId: string): void {
    const rows = this.db.prepare(
      "SELECT event_id, execution_id, accepted_sequence FROM canonical_agent_events WHERE thread_id = ?",
    ).all(threadId) as Array<{ event_id: string; execution_id: string; accepted_sequence: number }>;
    for (const event of rows) {
      state.appliedEventIds[event.event_id] = true;
      state.acceptedInputEventIds[`${event.execution_id}:${event.accepted_sequence}`] = event.event_id;
      const current = state.lastAcceptedSequenceByExecution[event.execution_id] ?? 0;
      state.lastAcceptedSequenceByExecution[event.execution_id] = Math.max(current, event.accepted_sequence);
    }
  }

  private addCheckpointState(state: AgentModelState, executionId?: string): void {
    if (!executionId) return;
    const checkpoint = this.loadCheckpoint(executionId);
    if (checkpoint) state.lastAcceptedSequenceByExecution[executionId] = checkpoint.lastAcceptedSequence;
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
    this.persistThreadState(state, threadId);
    this.persistTurnState(state, threadId, turnId, executionId);
    this.persistRecordedItems(state, threadId, events);
    this.persistRecordedActions(state, threadId, events);
    this.persistChangedChildThreads(state, threadId, events);
  }

  private persistThreadState(state: AgentModelState, threadId: string): void {
    const thread = state.threads[threadId];
    if (thread) this.persistThread(thread);
  }

  private persistTurnState(
    state: AgentModelState,
    threadId: string,
    turnId: string,
    executionId: string,
  ): void {
    const turn = state.turns[turnId];
    if (turn?.threadId === threadId) this.persistTurn(turn, executionId);
  }

  private persistRecordedItems(
    state: AgentModelState,
    threadId: string,
    events: readonly CanonicalAgentEventEnvelope[],
  ): void {
    for (const event of events) {
      if (event.payload.type !== "item.recorded") continue;
      const item = state.items[event.payload.item.id];
      if (item?.threadId === threadId) this.persistItem(item);
    }
  }

  private persistRecordedActions(
    state: AgentModelState,
    threadId: string,
    events: readonly CanonicalAgentEventEnvelope[],
  ): void {
    for (const event of events) {
      if (event.payload.type !== "collaboration-action.recorded") continue;
      const action = state.collaborationActions[event.payload.collaborationAction.id];
      if (action && (action.source.threadId === threadId || action.target.threadId === threadId)) {
        this.persistAction(action);
      }
    }
  }

  private persistChangedChildThreads(
    state: AgentModelState,
    threadId: string,
    events: readonly CanonicalAgentEventEnvelope[],
  ): void {
    const childThreadIds = this.changedChildThreadIds(events);
    for (const childThreadId of childThreadIds) {
      const childThread = state.threads[childThreadId];
      if (childThread?.parentThreadId === threadId) this.persistThread(childThread);
    }
  }

  private changedChildThreadIds(events: readonly CanonicalAgentEventEnvelope[]): Set<string> {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.payload.type === "child-thread.recorded") ids.add(event.payload.childThread.id);
      if (event.payload.type === "child-thread.bound") ids.add(event.payload.childThreadId);
    }
    return ids;
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
      parsed.approvalReviewMode,
      parsed.approvalReviewReason,
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
        target_turn_id, status, delivery_unknown, message, provider_identities_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target_thread_id = excluded.target_thread_id,
        target_turn_id = excluded.target_turn_id,
        status = excluded.status,
        delivery_unknown = excluded.delivery_unknown,
        message = COALESCE(excluded.message, canonical_collaboration_actions.message),
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
      parsed.message ?? null,
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

  private stampRecoveryIncident(executionId: string, recoveryIncidentId: string): void {
    const stamped = this.db.prepare(`
      UPDATE canonical_agent_ingest_checkpoints
      SET recovery_incident_id = ?
      WHERE execution_id = ?
        AND recovery_incident_id IS NULL
    `).run(recoveryIncidentId, executionId);
    if (stamped.changes !== 1) {
      throw new Error(`Recovery incident checkpoint was not stamped: ${executionId}`);
    }
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
      approvalReviewMode: row.approval_review_mode,
      approvalReviewReason: row.approval_review_reason,
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
      ...(typeof row.message === "string" ? { message: row.message } : {}),
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
