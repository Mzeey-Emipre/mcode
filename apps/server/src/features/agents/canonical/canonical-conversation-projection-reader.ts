import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  CONVERSATION_HISTORY_PAGE_MAX_MESSAGES,
  ThoughtSegmentRecordSchema,
  ToolCallRecordSchema,
  type ConversationNarrativeBatch,
  type Message,
} from "@mcode/contracts";

/** Canonical conversation rows used by the staged compatibility read. */
export interface CanonicalConversationProjection {
  messages: Message[];
  narrativeByMessage: Record<string, ConversationNarrativeBatch>;
  hasMore: boolean;
}

interface MessageProjectionRow {
  turnId: string;
  message: Message;
}

interface NarrativeRow {
  id: string;
  kind: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
  turn_id: string;
}

interface NarrativePayload {
  projection?: string;
  record?: Record<string, unknown>;
  nativeItemId?: string;
  toolName?: string;
  toolInput?: unknown;
  output?: string;
  isError?: boolean;
  content?: string;
}

interface ProjectionState {
  narrativeByMessage: Record<string, ConversationNarrativeBatch>;
  childToolsByMessage: Map<string, Map<string, ConversationNarrativeBatch["tools"][number]>>;
  childThoughtOrderByMessage: Map<string, number>;
}

/** Reads canonical conversation rows and projects narrative records for compatibility consumers. */
export class CanonicalConversationProjectionReader {
  constructor(private readonly db: Database.Database) {}

  /** Loads one canonical conversation page in ascending message order. */
  load(
    threadId: string,
    limit: number,
    before?: number,
    after?: number,
  ): CanonicalConversationProjection {
    const page = this.loadMessagePage(threadId, limit, before, after);
    const messages = page.rows.map(({ message }) => message);
    const narrativeByMessage = this.createNarrativeBuckets(messages);
    if (messages.length === 0) return { messages, narrativeByMessage, hasMore: page.hasMore };

    const narrativeRows = this.loadNarrativeRows(threadId, page.rows);
    const childTurnIds = this.findChildTurnIds(narrativeRows);
    const childRows = this.loadChildMessageRows(threadId, childTurnIds);
    const childMessageByTurn = this.selectChildAnchorByTurn(page.rows, childRows);
    const state: ProjectionState = {
      narrativeByMessage,
      childToolsByMessage: new Map(),
      childThoughtOrderByMessage: new Map(),
    };
    this.projectNarrativeRows(narrativeRows, childMessageByTurn, state);
    this.appendChildTools(state);
    return { messages, narrativeByMessage, hasMore: page.hasMore };
  }

  private loadMessagePage(
    threadId: string,
    limit: number,
    before?: number,
    after?: number,
  ): { rows: MessageProjectionRow[]; hasMore: boolean } {
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
    `).all(threadId, cursor, clampedLimit + 1) as Array<{ turn_id: string; payload_json: string }>;
    const hasMore = rows.length > clampedLimit;
    const pageRows = rows.slice(0, clampedLimit).map(toMessageProjectionRow);
    pageRows.sort(compareMessageProjectionRows);
    return { rows: pageRows, hasMore };
  }

  private createNarrativeBuckets(messages: readonly Message[]): Record<string, ConversationNarrativeBatch> {
    const narrativeByMessage: Record<string, ConversationNarrativeBatch> = {};
    for (const message of messages) {
      narrativeByMessage[message.id] = { tools: [], thoughts: [], hooks: [] };
    }
    return narrativeByMessage;
  }

  private loadNarrativeRows(threadId: string, messageRows: readonly MessageProjectionRow[]): NarrativeRow[] {
    const turnIds = [...new Set(messageRows.map(({ turnId }) => turnId))];
    return this.db.prepare(`
      SELECT id, kind, payload_json, created_at, updated_at, turn_id
      FROM canonical_agent_items
      WHERE thread_id = ?
        AND kind <> 'message'
        AND turn_id IN (${turnIds.map(() => "?").join(", ")})
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(
      threadId,
      ...turnIds,
      CONVERSATION_HISTORY_PAGE_MAX_MESSAGES,
    ) as NarrativeRow[];
  }

  private findChildTurnIds(rows: readonly NarrativeRow[]): string[] {
    const childTurnIds = new Set<string>();
    for (const row of rows) {
      if (isCodexChildProjection(parseNarrativePayload(row))) childTurnIds.add(row.turn_id);
    }
    return [...childTurnIds];
  }

  private loadChildMessageRows(threadId: string, childTurnIds: readonly string[]): MessageProjectionRow[] {
    if (childTurnIds.length === 0) return [];
    const rows = this.db.prepare(`
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
    `).all(threadId, ...childTurnIds, childTurnIds.length * 2) as Array<{
      turn_id: string;
      payload_json: string;
    }>;
    return rows.map(toMessageProjectionRow);
  }

  private selectChildAnchorByTurn(
    pageRows: readonly MessageProjectionRow[],
    childRows: readonly MessageProjectionRow[],
  ): Map<string, string> {
    const messagesById = new Map<string, Message>();
    const childMessageByTurn = new Map<string, string>();
    for (const row of [...pageRows, ...childRows]) messagesById.set(row.message.id, row.message);
    for (const row of [...pageRows, ...childRows]) {
      const current = childMessageByTurn.get(row.turnId);
      if (!current || (row.message.role === "assistant" && messagesById.get(current)?.role !== "assistant")) {
        childMessageByTurn.set(row.turnId, row.message.id);
      }
    }
    return childMessageByTurn;
  }

  private projectNarrativeRows(
    rows: readonly NarrativeRow[],
    childMessageByTurn: ReadonlyMap<string, string>,
    state: ProjectionState,
  ): void {
    for (const row of rows) {
      const payload = parseNarrativePayload(row);
      if (this.projectCodexChildRow(row, payload, childMessageByTurn, state)) continue;
      this.projectOrdinaryNarrative(payload, state.narrativeByMessage);
    }
  }

  private projectCodexChildRow(
    row: NarrativeRow,
    payload: NarrativePayload,
    childMessageByTurn: ReadonlyMap<string, string>,
    state: ProjectionState,
  ): boolean {
    const childAnchor = childMessageByTurn.get(row.turn_id);
    if (!childAnchor || !state.narrativeByMessage[childAnchor] || !isCodexChildProjection(payload)) return false;
    switch (payload.projection) {
      case "codexChildReasoning":
        this.projectChildReasoning(row, payload, childAnchor, state);
        break;
      case "codexChildToolCall":
        this.projectChildToolCall(row, payload, childAnchor, state);
        break;
      case "codexChildToolResult":
        this.projectChildToolResult(row, payload, childAnchor, state);
        break;
    }
    return true;
  }

  private projectChildReasoning(
    row: NarrativeRow,
    payload: NarrativePayload,
    childAnchor: string,
    state: ProjectionState,
  ): void {
    const nativeItemId = payload.nativeItemId ?? row.payload_json;
    const sortOrder = state.childThoughtOrderByMessage.get(childAnchor) ?? 0;
    state.narrativeByMessage[childAnchor]!.thoughts.push(ThoughtSegmentRecordSchema.parse({
      id: `codex-child-reasoning:${hashCodexKey(`${nativeItemId}:${row.id}`)}`,
      message_id: childAnchor,
      text: typeof payload.content === "string" ? payload.content : "",
      started_at: row.created_at,
      ended_at: row.updated_at,
      sort_order: sortOrder,
    }));
    state.childThoughtOrderByMessage.set(childAnchor, sortOrder + 1);
  }

  private projectChildToolCall(
    row: NarrativeRow,
    payload: NarrativePayload,
    childAnchor: string,
    state: ProjectionState,
  ): void {
    const nativeItemId = payload.nativeItemId ?? row.payload_json;
    const childTools = state.childToolsByMessage.get(childAnchor) ?? new Map();
    const existing = childTools.get(nativeItemId);
    childTools.set(nativeItemId, ToolCallRecordSchema.parse({
      id: existing?.id ?? `codex-child-tool:${hashCodexKey(nativeItemId)}`,
      message_id: childAnchor,
      parent_tool_call_id: null,
      tool_name: typeof payload.toolName === "string" ? payload.toolName : "Tool",
      input_summary: formatToolInput(payload.toolInput),
      output_summary: existing?.output_summary ?? "",
      status: existing?.status ?? "running",
      started_at: existing?.started_at ?? row.created_at,
      completed_at: existing?.completed_at ?? null,
      sort_order: existing?.sort_order ?? childTools.size,
    }));
    state.childToolsByMessage.set(childAnchor, childTools);
  }

  private projectChildToolResult(
    row: NarrativeRow,
    payload: NarrativePayload,
    childAnchor: string,
    state: ProjectionState,
  ): void {
    const nativeItemId = payload.nativeItemId ?? row.payload_json;
    const childTools = state.childToolsByMessage.get(childAnchor) ?? new Map();
    const existing = childTools.get(nativeItemId);
    childTools.set(nativeItemId, ToolCallRecordSchema.parse({
      id: existing?.id ?? `codex-child-tool:${hashCodexKey(nativeItemId)}`,
      message_id: childAnchor,
      parent_tool_call_id: null,
      tool_name: existing?.tool_name ?? "Tool",
      input_summary: existing?.input_summary ?? "",
      output_summary: typeof payload.output === "string" ? payload.output : "",
      status: payload.isError === true ? "failed" : "completed",
      started_at: existing?.started_at ?? row.created_at,
      completed_at: row.updated_at,
      sort_order: existing?.sort_order ?? childTools.size,
    }));
    state.childToolsByMessage.set(childAnchor, childTools);
  }

  private projectOrdinaryNarrative(
    payload: NarrativePayload,
    narrativeByMessage: Record<string, ConversationNarrativeBatch>,
  ): void {
    const record = payload.record;
    if (!record || typeof record.message_id !== "string") return;
    const bucket = narrativeByMessage[record.message_id];
    if (!bucket) return;
    switch (payload.projection) {
      case "toolCall":
        bucket.tools.push(record as unknown as ConversationNarrativeBatch["tools"][number]);
        break;
      case "narrationSegment":
        bucket.thoughts.push(record as unknown as ConversationNarrativeBatch["thoughts"][number]);
        break;
      case "hook":
        bucket.hooks.push(record as unknown as ConversationNarrativeBatch["hooks"][number]);
        break;
    }
  }

  private appendChildTools(state: ProjectionState): void {
    for (const [messageId, childTools] of state.childToolsByMessage) {
      state.narrativeByMessage[messageId]!.tools.push(...childTools.values());
    }
  }
}

function toMessageProjectionRow(row: { turn_id: string; payload_json: string }): MessageProjectionRow {
  return { turnId: row.turn_id, message: (JSON.parse(row.payload_json) as { message: Message }).message };
}

function compareMessageProjectionRows(left: MessageProjectionRow, right: MessageProjectionRow): number {
  return left.message.sequence - right.message.sequence || left.message.id.localeCompare(right.message.id);
}

function parseNarrativePayload(row: Pick<NarrativeRow, "payload_json">): NarrativePayload {
  return JSON.parse(row.payload_json) as NarrativePayload;
}

function isCodexChildProjection(payload: NarrativePayload): boolean {
  return payload.projection === "codexChildReasoning"
    || payload.projection === "codexChildToolCall"
    || payload.projection === "codexChildToolResult";
}

function formatToolInput(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function hashCodexKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
