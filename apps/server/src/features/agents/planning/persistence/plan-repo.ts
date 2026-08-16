/**
 * Data access for the `plans` table.
 *
 * Each plan is tied to a thread + message and carries a monotonically
 * increasing version number within that thread.
 */

import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { PlanRecord, PlanStatus } from "@mcode/contracts";

@injectable()
export class PlanRepo {
  private readonly stmtInsert;
  private readonly stmtNextVersion;
  private readonly stmtSupersedeDrafts;
  private readonly stmtListByThread;
  private readonly stmtGetById;
  private readonly stmtUpdateStatus;
  private readonly stmtGetLatest;

  constructor(@inject("Database") db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO plans (id, thread_id, message_id, version, title, content_md, sections_json, change_summary, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtNextVersion = db.prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM plans WHERE thread_id = ?",
    );

    this.stmtSupersedeDrafts = db.prepare(
      "UPDATE plans SET status = 'superseded' WHERE thread_id = ? AND status = 'draft'",
    );

    this.stmtListByThread = db.prepare(
      "SELECT * FROM plans WHERE thread_id = ? ORDER BY version ASC",
    );

    this.stmtGetById = db.prepare("SELECT * FROM plans WHERE id = ?");

    this.stmtUpdateStatus = db.prepare(
      "UPDATE plans SET status = ? WHERE id = ?",
    );

    this.stmtGetLatest = db.prepare(
      "SELECT * FROM plans WHERE thread_id = ? AND status != 'superseded' ORDER BY version DESC LIMIT 1",
    );
  }

  /** Insert a new plan, auto-assigning the next version number. */
  create(
    threadId: string,
    messageId: string,
    title: string,
    contentMd: string,
    sectionsJson: string | null,
    changeSummary: string | null,
  ): PlanRecord {
    const id = randomUUID();
    const version = (this.stmtNextVersion.get(threadId) as { next: number })
      .next;

    this.stmtSupersedeDrafts.run(threadId);

    this.stmtInsert.run(
      id,
      threadId,
      messageId,
      version,
      title,
      contentMd,
      sectionsJson,
      changeSummary,
      "draft",
    );

    return this.toRecord(this.stmtGetById.get(id) as Row);
  }

  /** Update a plan's status (draft -> accepted, etc.). */
  updateStatus(planId: string, status: PlanStatus): void {
    this.stmtUpdateStatus.run(status, planId);
  }

  /** All plan versions for a thread, oldest first. */
  listByThread(threadId: string): PlanRecord[] {
    const rows = this.stmtListByThread.all(threadId) as Row[];
    return rows.map(this.toRecord);
  }

  /** Most recent non-superseded plan for a thread, or null. */
  getLatestForThread(threadId: string): PlanRecord | null {
    const row = this.stmtGetLatest.get(threadId) as Row | undefined;
    return row ? this.toRecord(row) : null;
  }

  /** Single plan by ID. */
  getById(planId: string): PlanRecord | null {
    const row = this.stmtGetById.get(planId) as Row | undefined;
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: Row): PlanRecord {
    return {
      id: row.id,
      threadId: row.thread_id,
      messageId: row.message_id,
      version: row.version,
      title: row.title,
      contentMd: row.content_md,
      sectionsJson: row.sections_json ? JSON.parse(row.sections_json) : null,
      changeSummary: row.change_summary,
      status: row.status as PlanRecord["status"],
      createdAt: row.created_at,
    };
  }
}

interface Row {
  id: string;
  thread_id: string;
  message_id: string;
  version: number;
  title: string;
  content_md: string;
  sections_json: string | null;
  change_summary: string | null;
  status: string;
  created_at: string;
}
