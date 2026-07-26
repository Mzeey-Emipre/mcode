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
  turnId: string;
  operationPhase: "pre_provision" | "provisioning" | "provisioned" | "dispatching" | "dispatched";
  callerId: string;
  sourceThreadId?: string;
}

interface ApprovalRow {
  id: string;
  thread_id: string;
  workspace_id: string;
  prompt: string;
  execution_json: string;
  placement_json: string;
  turn_id: string;
  operation_phase: PendingThreadCreateApproval["operationPhase"];
  caller_id: string | null;
  source_thread_id: string | null;
}

/** Durable repository for protected thread-control creation approvals. */
@injectable()
export class ThreadControlApprovalRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Persist one pending approval and return its opaque identity. */
  create(input: Omit<PendingThreadCreateApproval, "approvalId" | "operationPhase">): string {
    const approvalId = randomUUID();
    this.db.prepare(
      "INSERT INTO thread_control_approvals (id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, caller_id, source_thread_id, operation_phase, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pre_provision', 'pending')",
    ).run(
      approvalId,
      input.threadId,
      input.workspaceId,
      input.prompt,
      JSON.stringify(input.execution),
      JSON.stringify(input.placement),
      input.turnId,
      input.callerId,
      input.sourceThreadId ?? null,
    );
    return approvalId;
  }

  /** Atomically claim one pending approval so repeated decisions cannot resume it twice. */
  claim(approvalId: string): PendingThreadCreateApproval | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, operation_phase, caller_id, source_thread_id FROM thread_control_approvals WHERE id = ? AND status = 'pending'",
      ).get(approvalId) as ApprovalRow | undefined;
      if (!row) return null;
      const updated = this.db.prepare(
        "UPDATE thread_control_approvals SET status = 'processing', processing_started_at = ? WHERE id = ? AND status = 'pending'",
      ).run(new Date().toISOString(), approvalId);
      return updated.changes === 1 ? row : null;
    });
    const row = claim();
    return row ? this.parse(row) : null;
  }

  /** Persist a completed side-effect boundary before the next operation begins. */
  setOperationPhase(approvalId: string, phase: PendingThreadCreateApproval["operationPhase"]): boolean {
    return this.db.prepare("UPDATE thread_control_approvals SET operation_phase = ? WHERE id = ? AND status = 'processing'").run(phase, approvalId).changes === 1;
  }

  /** Return approvals stranded by a process exit. */
  listProcessing(): PendingThreadCreateApproval[] {
    const rows = this.db.prepare("SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, operation_phase, caller_id, source_thread_id FROM thread_control_approvals WHERE status = 'processing' ORDER BY processing_started_at, id").all() as ApprovalRow[];
    return rows.map((row) => this.parse(row));
  }

  /** Return a pre-side-effect accepted operation to the visible pending state. */
  requeue(approvalId: string): boolean {
    return this.db.prepare("UPDATE thread_control_approvals SET status = 'pending', processing_started_at = NULL WHERE id = ? AND status = 'processing' AND operation_phase = 'pre_provision'").run(approvalId).changes === 1;
  }

  /** Return a recovered provisioning approval to the pre-provision pending state. */
  requeueRecoveredProvisioning(approvalId: string): boolean {
    return this.db.prepare("UPDATE thread_control_approvals SET status = 'pending', processing_started_at = NULL, operation_phase = 'pre_provision' WHERE id = ? AND status = 'processing' AND operation_phase = 'provisioning'").run(approvalId).changes === 1;
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
      "SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, operation_phase, caller_id, source_thread_id FROM thread_control_approvals WHERE thread_id = ? AND status = 'pending' ORDER BY created_at, id",
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
      turnId: row.turn_id,
      operationPhase: row.operation_phase,
      callerId: row.caller_id ?? "unknown",
      ...(row.source_thread_id ? { sourceThreadId: row.source_thread_id } : {}),
    };
  }
}
