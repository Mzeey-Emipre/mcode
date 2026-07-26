import { randomUUID } from "node:crypto";
import { inject, injectable } from "tsyringe";
import type Database from "better-sqlite3";
import {
  ResolvedExecutionSchema,
  ThreadPlacementSchema,
  type ResolvedExecution,
  type ThreadPlacement,
} from "@mcode/contracts";

/** Persisted input needed to resume a protected delegated-thread creation. */
export interface PendingThreadCreateApproval {
  approvalId: string;
  threadId: string;
  workspaceId: string;
  prompt: string;
  execution: ResolvedExecution;
  placement: Extract<ThreadPlacement, { type: "new_worktree" }>;
}

interface ApprovalRow {
  id: string;
  thread_id: string;
  workspace_id: string;
  prompt: string;
  execution_json: string;
  placement_json: string;
}

/** Durable repository for protected thread-control creation approvals. */
@injectable()
export class ThreadControlApprovalRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Persist one pending approval and return its opaque identity. */
  create(input: Omit<PendingThreadCreateApproval, "approvalId">): string {
    const approvalId = randomUUID();
    this.db.prepare(
      "INSERT INTO thread_control_approvals (id, thread_id, workspace_id, prompt, execution_json, placement_json, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
    ).run(
      approvalId,
      input.threadId,
      input.workspaceId,
      input.prompt,
      JSON.stringify(input.execution),
      JSON.stringify(input.placement),
    );
    return approvalId;
  }

  /** Atomically claim one pending approval so repeated decisions cannot resume it twice. */
  claim(approvalId: string): PendingThreadCreateApproval | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json FROM thread_control_approvals WHERE id = ? AND status = 'pending'",
      ).get(approvalId) as ApprovalRow | undefined;
      if (!row) return null;
      const updated = this.db.prepare(
        "UPDATE thread_control_approvals SET status = 'processing', resolved_at = ? WHERE id = ? AND status = 'pending'",
      ).run(new Date().toISOString(), approvalId);
      return updated.changes === 1 ? row : null;
    });
    const row = claim();
    return row ? this.parse(row) : null;
  }

  /** Mark a claimed approval with its terminal outcome. */
  settle(approvalId: string, status: "approved" | "rejected" | "failed"): boolean {
    return this.db.prepare(
      "UPDATE thread_control_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'processing'",
    ).run(status, new Date().toISOString(), approvalId).changes === 1;
  }

  /** Return pending approval cards for one visible thread. */
  listPendingByThread(threadId: string): PendingThreadCreateApproval[] {
    const rows = this.db.prepare(
      "SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json FROM thread_control_approvals WHERE thread_id = ? AND status = 'pending' ORDER BY created_at, id",
    ).all(threadId) as ApprovalRow[];
    return rows.map((row) => this.parse(row));
  }

  private parse(row: ApprovalRow): PendingThreadCreateApproval {
    const placement = ThreadPlacementSchema().parse(JSON.parse(row.placement_json));
    if (placement.type !== "new_worktree") {
      throw new Error("Stored thread-control approval has invalid placement");
    }
    return {
      approvalId: row.id,
      threadId: row.thread_id,
      workspaceId: row.workspace_id,
      prompt: row.prompt,
      execution: ResolvedExecutionSchema().parse(JSON.parse(row.execution_json)),
      placement,
    };
  }
}
