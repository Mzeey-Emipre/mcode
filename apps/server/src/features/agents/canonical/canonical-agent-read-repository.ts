import type Database from "better-sqlite3";
import {
  CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS,
  CanonicalAgentEventEnvelopeSchema,
  type AgentModelState,
  type AgentThread,
  type AgentTurn,
  type CanonicalAgentEventEnvelope,
  type CanonicalAgentReconnectRecovery,
  type CanonicalAgentRevision,
  type Message,
} from "@mcode/contracts";
import type { CanonicalAgentCheckpoint } from "./canonical-agent-event-sink.js";
import {
  CanonicalConversationProjectionReader,
  type CanonicalConversationProjection,
} from "./canonical-conversation-projection-reader.js";

export type { CanonicalConversationProjection } from "./canonical-conversation-projection-reader.js";

/** State reconstruction required by canonical reconnect reads. */
export interface CanonicalAgentReadRepositoryOperations {
  loadState(threadId: string): AgentModelState;
  mapThread(row: Record<string, unknown>): AgentThread;
  mapTurn(row: Record<string, unknown>): AgentTurn;
  mapCheckpoint(row: Record<string, unknown>): CanonicalAgentCheckpoint;
}

/** Reads canonical reconnect state without changing durable data. */
export class CanonicalAgentReadRepository {
  private readonly conversationProjection: CanonicalConversationProjectionReader;

  constructor(
    private readonly db: Database.Database,
    private readonly operations: CanonicalAgentReadRepositoryOperations,
  ) {
    this.conversationProjection = new CanonicalConversationProjectionReader(db);
  }

  /** Loads canonical conversation messages and narrative rows for a compatibility page. */
  loadConversationProjection(
    threadId: string,
    limit: number,
    before?: number,
    after?: number,
  ): CanonicalConversationProjection {
    return this.conversationProjection.load(threadId, limit, before, after);
  }

  /** Restores a replica with a contiguous delta or a replacement snapshot. */
  recoverThread(threadId: string, known: CanonicalAgentRevision): CanonicalAgentReconnectRecovery {
    const thread = this.loadThread(threadId);
    const through = {
      conversationRevision: thread?.conversationRevision ?? 0,
      rosterRevision: thread?.rosterRevision ?? 0,
    };
    if (this.requiresSnapshot(known, through)) return this.snapshot(threadId, through);
    if (this.isCurrent(known, through)) return { mode: "delta", threadId, from: known, through, events: [] };
    const events = this.eventsSince(threadId, known);
    if (!events || this.hasInboundCollaboration(threadId)) return this.snapshot(threadId, through);
    if (!this.isContiguous(events, known, through)) return this.snapshot(threadId, through);
    return { mode: "delta", threadId, from: known, through, events };
  }

  /** Loads one canonical thread. */
  loadThread(threadId: string): AgentThread | null {
    const row = this.db.prepare("SELECT * FROM canonical_agent_threads WHERE id = ?").get(threadId);
    return row ? this.operations.mapThread(row as Record<string, unknown>) : null;
  }

  /** Loads one canonical turn. */
  loadTurn(turnId: string): AgentTurn | null {
    const row = this.db.prepare("SELECT * FROM canonical_agent_turns WHERE id = ?").get(turnId);
    return row ? this.operations.mapTurn(row as Record<string, unknown>) : null;
  }

  /** Loads one canonical turn by its execution identity. */
  loadTurnByExecution(executionId: string): AgentTurn | null {
    const row = this.db.prepare("SELECT * FROM canonical_agent_turns WHERE execution_id = ?").get(executionId);
    return row ? this.operations.mapTurn(row as Record<string, unknown>) : null;
  }

  /** Loads one canonical checkpoint. */
  loadCheckpoint(executionId: string): CanonicalAgentCheckpoint | null {
    const row = this.db.prepare("SELECT * FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(executionId) as Record<string, unknown> | undefined;
    return row ? this.operations.mapCheckpoint(row) : null;
  }

  /** Loads the durable assistant projection and tool count for one terminal turn. */
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

  /** Loads the accepted user message for one canonical turn. */
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
    return row ? (JSON.parse(row.payload_json) as { message: Message }).message : null;
  }


  private snapshot(
    threadId: string,
    revision: CanonicalAgentRevision,
  ): CanonicalAgentReconnectRecovery {
    return { mode: "snapshot", threadId, snapshot: { revision, state: this.operations.loadState(threadId) } };
  }

  private requiresSnapshot(known: CanonicalAgentRevision, through: CanonicalAgentRevision): boolean {
    return known.conversationRevision > through.conversationRevision
      || known.rosterRevision > through.rosterRevision;
  }

  private isCurrent(known: CanonicalAgentRevision, through: CanonicalAgentRevision): boolean {
    return known.conversationRevision === through.conversationRevision
      && known.rosterRevision === through.rosterRevision;
  }

  private eventsSince(
    threadId: string,
    known: CanonicalAgentRevision,
  ): CanonicalAgentEventEnvelope[] | null {
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
    if (rows.length > CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS) return null;
    return rows.map((row) => CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelope_json)));
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

  private isContiguous(
    events: readonly CanonicalAgentEventEnvelope[],
    known: CanonicalAgentRevision,
    through: CanonicalAgentRevision,
  ): boolean {
    return this.hasContiguousRevisions(
      events.map((event) => event.durableRevision),
      known.conversationRevision,
      through.conversationRevision,
    ) && this.hasContiguousRevisions(
      events.flatMap((event) => event.rosterRevision === undefined ? [] : [event.rosterRevision]),
      known.rosterRevision,
      through.rosterRevision,
    );
  }

  private hasContiguousRevisions(values: readonly number[], from: number, through: number): boolean {
    if (from === through) return true;
    const revisions = [...new Set(values)].sort((left, right) => left - right);
    if (revisions.length === 0 || revisions[0] !== from + 1) return false;
    return revisions[revisions.length - 1] === through;
  }
}
