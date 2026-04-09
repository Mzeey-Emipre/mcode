/**
 * Tool call record data access layer.
 * Provides creation and retrieval operations for tool call records in SQLite.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { ToolCallRecord, ToolCallStatus } from "@mcode/contracts";

/** Row shape returned by SQLite for the tool_call_records table. */
interface ToolCallRecordRow {
  id: string;
  message_id: string;
  parent_tool_call_id: string | null;
  tool_name: string;
  input_summary: string;
  output_summary: string;
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
  inputSummary: string;
  outputSummary: string;
  status: ToolCallStatus;
  sortOrder: number;
  parentToolCallId?: string;
}

function rowToToolCallRecord(row: ToolCallRecordRow): ToolCallRecord {
  return {
    id: row.id,
    message_id: row.message_id,
    parent_tool_call_id: row.parent_tool_call_id,
    tool_name: row.tool_name,
    input_summary: row.input_summary,
    output_summary: row.output_summary,
    status: row.status as ToolCallStatus,
    started_at: row.started_at,
    completed_at: row.completed_at,
    sort_order: row.sort_order,
  };
}

const TOOL_CALL_RECORD_COLUMNS =
  "id, message_id, parent_tool_call_id, tool_name, input_summary, output_summary, status, started_at, completed_at, sort_order";

/** Repository for tool call record creation and retrieval against SQLite. */
@injectable()
export class ToolCallRecordRepo {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtListByMessage: Database.Statement;
  private readonly stmtListByParent: Database.Statement;
  private readonly stmtCountByMessage: Database.Statement;

  constructor(@inject("Database") private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      "INSERT OR IGNORE INTO tool_call_records (id, message_id, parent_tool_call_id, tool_name, input_summary, output_summary, status, started_at, completed_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    const completedAt = input.status !== "running" ? now : null;

    this.stmtInsert.run(
      id,
      input.messageId,
      input.parentToolCallId ?? null,
      input.toolName,
      input.inputSummary,
      input.outputSummary,
      input.status,
      now,
      completedAt,
      input.sortOrder,
    );

    return {
      id,
      message_id: input.messageId,
      parent_tool_call_id: input.parentToolCallId ?? null,
      tool_name: input.toolName,
      input_summary: input.inputSummary,
      output_summary: input.outputSummary,
      status: input.status,
      started_at: now,
      completed_at: completedAt,
      sort_order: input.sortOrder,
    };
  }

  /** Create multiple tool call records in a single transaction. */
  bulkCreate(inputs: CreateToolCallRecordInput[]): void {
    const tx = this.db.transaction((items: CreateToolCallRecordInput[]) => {
      const now = new Date().toISOString();
      for (const item of items) {
        const completedAt = item.status !== "running" ? now : null;
        this.stmtInsert.run(
          item.toolCallId ?? randomUUID(),
          item.messageId,
          item.parentToolCallId ?? null,
          item.toolName,
          item.inputSummary,
          item.outputSummary,
          item.status,
          now,
          completedAt,
          item.sortOrder,
        );
      }
    });

    tx(inputs);
  }

  /** List all tool call records for a message, ordered by sort_order ascending. */
  listByMessage(messageId: string): ToolCallRecord[] {
    const rows = this.stmtListByMessage.all(messageId) as ToolCallRecordRow[];
    return rows.map(rowToToolCallRecord);
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
