import { randomUUID } from "node:crypto";
import { inject, injectable } from "tsyringe";
import type Database from "better-sqlite3";

/** Writes bounded, content-free thread-control audit events. */
@injectable()
export class ThreadControlAuditRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Persist one operation outcome without prompt, credential, or path data. */
  write(input: { callerId: string; sourceThreadId?: string; workspaceId?: string; threadId?: string; operation: string; outcome: string }): void {
    this.db.prepare("INSERT INTO thread_control_audit (id, caller_id, source_thread_id, workspace_id, thread_id, operation, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), input.callerId, input.sourceThreadId ?? null, input.workspaceId ?? null, input.threadId ?? null, input.operation, input.outcome);
  }
}
