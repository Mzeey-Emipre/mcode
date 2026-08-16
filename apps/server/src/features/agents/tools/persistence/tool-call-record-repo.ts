/**
 * Tool call record data access layer.
 * Provides creation and retrieval operations for tool call records in SQLite.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { ToolCallRecord, ToolCallStatus } from "@mcode/contracts";
import {
  ACTIVE_TURN_WRITE_BATCH_LIMITS,
  runBoundedWriteBatches,
  type WriteBatchLimits,
  type WriteBatchResult,
} from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";

/** Row shape returned by SQLite for the tool_call_records table. */
interface ToolCallRecordRow {
  id: string;
  message_id: string;
  parent_tool_call_id: string | null;
  tool_name: string;
  display_name: string | null;
  provider_agent_key: string | null;
  model: string | null;
  reasoning_effort: string | null;
  input_summary: string;
  output_summary: string;
  output_truncated: number;
  output_total_bytes: number | null;
  output_artifact_path: string | null;
  exit_code: number | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  sort_order: number;
}

/** Input for creating a new tool call record. */
export interface CreateToolCallRecordInput {
  /** Original tool call ID from the provider SDK. Preserves parent-child linkage. */
  toolCallId?: string;
  messageId: string;
  toolName: string;
  displayName?: string;
  providerAgentKey?: string;
  model?: string;
  reasoningEffort?: string;
  inputSummary: string;
  outputSummary: string;
  outputTruncated?: boolean;
  outputTotalBytes?: number;
  outputArtifactPath?: string;
  exitCode?: number;
  status: ToolCallStatus;
  /** ISO timestamp captured when the provider started the tool call. */
  startedAt?: string;
  /** ISO timestamp captured when the tool call reached a terminal status. */
  completedAt?: string;
  sortOrder: number;
  parentToolCallId?: string;
}

function rowToToolCallRecord(row: ToolCallRecordRow): ToolCallRecord {
  return {
    id: row.id,
    message_id: row.message_id,
    parent_tool_call_id: row.parent_tool_call_id,
    tool_name: row.tool_name,
    display_name: row.display_name,
    provider_agent_key: row.provider_agent_key,
    model: row.model,
    reasoning_effort: row.reasoning_effort,
    input_summary: row.input_summary,
    output_summary: row.output_summary,
    output_truncated: row.output_truncated,
    output_total_bytes: row.output_total_bytes,
    output_artifact_path: row.output_artifact_path,
    exit_code: row.exit_code,
    status: row.status as ToolCallStatus,
    started_at: row.started_at,
    completed_at: row.completed_at,
    sort_order: row.sort_order,
  };
}

const TOOL_CALL_RECORD_COLUMNS =
  "id, message_id, parent_tool_call_id, tool_name, display_name, provider_agent_key, model, reasoning_effort, input_summary, output_summary, output_truncated, output_total_bytes, output_artifact_path, exit_code, status, started_at, completed_at, sort_order";

/** Repository for tool call record creation and retrieval against SQLite. */
@injectable()
export class ToolCallRecordRepo {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtListByMessage: Database.Statement;
  private readonly stmtListByParent: Database.Statement;
  private readonly stmtCountByMessage: Database.Statement;

  constructor(@inject("Database") private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      "INSERT OR IGNORE INTO tool_call_records (id, message_id, parent_tool_call_id, tool_name, display_name, provider_agent_key, model, reasoning_effort, input_summary, output_summary, output_truncated, output_total_bytes, output_artifact_path, exit_code, status, started_at, completed_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.stmtListByMessage = db.prepare(
      `SELECT ${TOOL_CALL_RECORD_COLUMNS} FROM tool_call_records WHERE message_id = ? ORDER BY sort_order ASC`,
    );
    this.stmtListByParent = db.prepare(
      `SELECT ${TOOL_CALL_RECORD_COLUMNS} FROM tool_call_records WHERE parent_tool_call_id = ? ORDER BY sort_order ASC`,
    );
    this.stmtCountByMessage = db.prepare(
      "SELECT COUNT(*) as count FROM tool_call_records WHERE message_id = ?",
    );
  }

  /** Create a new tool call record and return the fully-populated record. */
  create(input: CreateToolCallRecordInput): ToolCallRecord {
    const id = input.toolCallId ?? randomUUID();
    const now = new Date().toISOString();
    const startedAt = input.startedAt ?? now;
    const completedAt = input.status !== "running" ? input.completedAt ?? now : null;

    this.stmtInsert.run(
      id,
      input.messageId,
      input.parentToolCallId ?? null,
      input.toolName,
      input.displayName ?? null,
      input.providerAgentKey ?? null,
      input.model ?? null,
      input.reasoningEffort ?? null,
      input.inputSummary,
      input.outputSummary,
      input.outputTruncated === true ? 1 : 0,
      input.outputTotalBytes ?? null,
      input.outputArtifactPath ?? null,
      input.exitCode ?? null,
      input.status,
      startedAt,
      completedAt,
      input.sortOrder,
    );

    return {
      id,
      message_id: input.messageId,
      parent_tool_call_id: input.parentToolCallId ?? null,
      tool_name: input.toolName,
      display_name: input.displayName ?? null,
      provider_agent_key: input.providerAgentKey ?? null,
      model: input.model ?? null,
      reasoning_effort: input.reasoningEffort ?? null,
      input_summary: input.inputSummary,
      output_summary: input.outputSummary,
      output_truncated: input.outputTruncated === true ? 1 : 0,
      output_total_bytes: input.outputTotalBytes ?? null,
      output_artifact_path: input.outputArtifactPath ?? null,
      exit_code: input.exitCode ?? null,
      status: input.status,
      started_at: startedAt,
      completed_at: completedAt,
      sort_order: input.sortOrder,
    };
  }

  /** Create multiple tool call records in a single transaction. */
  bulkCreate(inputs: CreateToolCallRecordInput[]): void {
    const tx = this.db.transaction((items: CreateToolCallRecordInput[]) => {
      const now = new Date().toISOString();
      for (const item of items) {
        const startedAt = item.startedAt ?? now;
        const completedAt = item.status !== "running" ? item.completedAt ?? now : null;
        this.stmtInsert.run(
          item.toolCallId ?? randomUUID(),
          item.messageId,
          item.parentToolCallId ?? null,
          item.toolName,
          item.displayName ?? null,
          item.providerAgentKey ?? null,
          item.model ?? null,
          item.reasoningEffort ?? null,
          item.inputSummary,
          item.outputSummary,
          item.outputTruncated === true ? 1 : 0,
          item.outputTotalBytes ?? null,
          item.outputArtifactPath ?? null,
          item.exitCode ?? null,
          item.status,
          startedAt,
          completedAt,
          item.sortOrder,
        );
      }
    });

    tx(inputs);
  }

  /** Insert tool-call rows in bounded transactions with an event-loop yield between commits. */
  async bulkCreateBatched(
    inputs: readonly CreateToolCallRecordInput[],
    limits: WriteBatchLimits = ACTIVE_TURN_WRITE_BATCH_LIMITS,
  ): Promise<WriteBatchResult> {
    const now = new Date().toISOString();
    return runBoundedWriteBatches({
      db: this.db,
      items: inputs,
      limits,
      byteLength: (item) => Buffer.byteLength(JSON.stringify(item), "utf8"),
      write: (item) => {
        const startedAt = item.startedAt ?? now;
        const completedAt = item.status !== "running" ? item.completedAt ?? now : null;
        this.stmtInsert.run(
          item.toolCallId ?? randomUUID(),
          item.messageId,
          item.parentToolCallId ?? null,
          item.toolName,
          item.displayName ?? null,
          item.providerAgentKey ?? null,
          item.model ?? null,
          item.reasoningEffort ?? null,
          item.inputSummary,
          item.outputSummary,
          item.outputTruncated === true ? 1 : 0,
          item.outputTotalBytes ?? null,
          item.outputArtifactPath ?? null,
          item.exitCode ?? null,
          item.status,
          startedAt,
          completedAt,
          item.sortOrder,
        );
      },
    });
  }

  /** List all tool call records for a message, ordered by sort_order ascending. */
  listByMessage(messageId: string): ToolCallRecord[] {
    const rows = this.stmtListByMessage.all(messageId) as ToolCallRecordRow[];
    return rows.map(rowToToolCallRecord);
  }

  /** List tool call records for many messages in one indexed query, grouped by message id. */
  listByMessages(messageIds: readonly string[]): Map<string, ToolCallRecord[]> {
    const grouped = new Map<string, ToolCallRecord[]>();
    if (messageIds.length === 0) return grouped;

    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${TOOL_CALL_RECORD_COLUMNS} FROM tool_call_records WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, sort_order ASC`,
      )
      .all(...messageIds) as ToolCallRecordRow[];

    for (const row of rows) {
      const record = rowToToolCallRecord(row);
      const list = grouped.get(record.message_id) ?? [];
      list.push(record);
      grouped.set(record.message_id, list);
    }
    return grouped;
  }

  /** List child tool call records for a parent, ordered by sort_order ascending. */
  listByParent(parentToolCallId: string): ToolCallRecord[] {
    const rows = this.stmtListByParent.all(parentToolCallId) as ToolCallRecordRow[];
    return rows.map(rowToToolCallRecord);
  }

  /** Count the number of tool call records for a message. */
  countByMessage(messageId: string): number {
    const row = this.stmtCountByMessage.get(messageId) as { count: number };
    return row.count;
  }
}
