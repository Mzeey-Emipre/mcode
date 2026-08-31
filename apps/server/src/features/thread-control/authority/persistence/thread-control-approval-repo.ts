import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import type Database from "better-sqlite3";
import {
  ResolvedExecutionSchema,
  ThreadPlacementSchema,
  type ResolvedExecution,
  type ThreadPlacement,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";

/** Persisted input needed to resume a protected delegated-thread creation. */
export interface PendingThreadCreateApproval {
  operation: "thread_create_batch";
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

/** Persisted cross-thread send approval. */
export interface PendingThreadSendApproval {
  operation: "thread_send";
  approvalId: string;
  threadId: string;
  workspaceId: string;
  message: string;
  execution: ResolvedExecution;
  turnId: string;
  operationPhase: "pre_dispatch" | "dispatching" | "dispatched";
  callerId: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  sourceProviderId?: string;
}

/** Persisted cross-thread stop approval. */
export interface PendingThreadStopApproval {
  operation: "thread_stop";
  approvalId: string;
  threadId: string;
  workspaceId: string;
  execution: ResolvedExecution;
  turnId: string;
  operationPhase: "pre_dispatch" | "dispatching" | "dispatched";
  callerId: string;
  sourceThreadId?: string;
}

/** Safe persisted identity for a processing approval whose payload cannot be rehydrated. */
export interface MalformedThreadCreateApproval {
  invalid: true;
  operation?: ThreadControlApprovalOperation;
  approvalId: string;
  threadId: string;
  workspaceId: string;
  callerId: string;
  sourceThreadId?: string;
}

/** Processing approval that can either resume safely or must fail closed. */
export type PendingThreadControlApproval = PendingThreadCreateApproval | PendingThreadSendApproval | PendingThreadStopApproval;
export type RecoverableThreadCreateApproval = PendingThreadControlApproval | MalformedThreadCreateApproval;
/** Durable operation identifiers stored with thread-control approvals. */
export type ThreadControlApprovalOperation = "thread_create_batch" | "thread_send" | "thread_stop";

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
  source_turn_id: string | null;
  source_provider_id: string | null;
  operation: string | null;
}

function parseOperation(value: string | null | undefined): ThreadControlApprovalOperation | undefined {
  return value === "thread_create_batch" || value === "thread_send" || value === "thread_stop" ? value : undefined;
}

/** Durable repository for protected thread-control creation approvals. */
@injectable()
export class ThreadControlApprovalRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Persist one pending approval and return its opaque identity. */
  create(input: Omit<PendingThreadCreateApproval, "approvalId" | "operation" | "operationPhase">): string {
    const approvalId = NodeCrypto.randomUUID();
    this.db.prepare(
      "INSERT INTO thread_control_approvals (id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, caller_id, source_thread_id, operation, operation_phase, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'thread_create_batch', 'pre_provision', 'pending')",
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

  /** Persist a supervised cross-thread send before a human decision. */
  createSend(input: Omit<PendingThreadSendApproval, "approvalId" | "operation" | "operationPhase"> & { approvalId?: string }): string {
    return this.createMutation({
      operation: "thread_send",
      prompt: input.message,
      placement: { type: "direct" },
      ...input,
    });
  }

  /** Persist a supervised cross-thread stop before a human decision. */
  createStop(input: Omit<PendingThreadStopApproval, "approvalId" | "operation" | "operationPhase"> & { approvalId?: string }): string {
    return this.createMutation({
      operation: "thread_stop",
      prompt: "",
      placement: { type: "direct" },
      ...input,
    });
  }

  private createMutation(input: {
    operation: "thread_send" | "thread_stop";
    threadId: string;
    workspaceId: string;
    prompt: string;
    execution: ResolvedExecution;
    placement: ThreadPlacement;
    turnId: string;
    callerId: string;
    sourceThreadId?: string;
    sourceTurnId?: string;
    sourceProviderId?: string;
    approvalId?: string;
  }): string {
    const approvalId = input.approvalId ?? NodeCrypto.randomUUID();
    this.db.prepare(
      "INSERT INTO thread_control_approvals (id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, caller_id, source_thread_id, source_turn_id, source_provider_id, operation, operation_phase, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pre_dispatch', 'pending')",
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
      input.sourceTurnId ?? null,
      input.sourceProviderId ?? null,
      input.operation,
    );
    return approvalId;
  }

  /** Atomically claim one pending approval so repeated decisions cannot resume it twice. */
  claim(approvalId: string): PendingThreadControlApproval | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, operation_phase, caller_id, source_thread_id, source_turn_id, source_provider_id, operation FROM thread_control_approvals WHERE id = ? AND status = 'pending'",
      ).get(approvalId) as ApprovalRow | undefined;
      if (!row) return null;
      const updated = this.db.prepare(
        "UPDATE thread_control_approvals SET status = 'processing', processing_started_at = ? WHERE id = ? AND status = 'pending'",
      ).run(new Date().toISOString(), approvalId);
      return updated.changes === 1 ? row : null;
    });
    const row = claim();
    if (!row) return null;
    try {
      return this.parse(row);
    } catch (error) {
      logger.error("Failed to parse claimed thread-control approval", {
        approvalId: row.id,
        threadId: row.thread_id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.settle(row.id, "failed");
      return null;
    }
  }

  /** Persist a completed side-effect boundary before the next operation begins. */
  setOperationPhase(approvalId: string, phase: PendingThreadCreateApproval["operationPhase"] | "pre_dispatch"): boolean {
    return this.db.prepare("UPDATE thread_control_approvals SET operation_phase = ? WHERE id = ? AND status = 'processing'").run(phase, approvalId).changes === 1;
  }

  /** Return approvals stranded by a process exit without letting one malformed payload block recovery. */
  listProcessing(): RecoverableThreadCreateApproval[] {
    const rows = this.db.prepare("SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, operation_phase, caller_id, source_thread_id, source_turn_id, source_provider_id, operation FROM thread_control_approvals WHERE status = 'processing' ORDER BY processing_started_at, id").all() as ApprovalRow[];
    return rows.map((row) => {
      try {
        return this.parse(row);
      } catch {
        const operation = parseOperation(row.operation);
        return {
          invalid: true,
          ...(operation ? { operation } : {}),
          approvalId: row.id,
          threadId: row.thread_id,
          workspaceId: row.workspace_id,
          callerId: row.caller_id ?? "unknown",
          ...(row.source_thread_id ? { sourceThreadId: row.source_thread_id } : {}),
        };
      }
    });
  }

  /** Return a pre-side-effect accepted operation to the visible pending state. */
  requeue(approvalId: string): boolean {
    return this.db.prepare("UPDATE thread_control_approvals SET status = 'pending', processing_started_at = NULL WHERE id = ? AND status = 'processing' AND operation_phase = 'pre_provision'").run(approvalId).changes === 1;
  }

  /** Return a recovered provisioning approval to the pre-provision pending state. */
  requeueRecoveredProvisioning(approvalId: string): boolean {
    return this.db.prepare("UPDATE thread_control_approvals SET status = 'pending', processing_started_at = NULL, operation_phase = 'pre_provision' WHERE id = ? AND status = 'processing' AND operation_phase = 'provisioning'").run(approvalId).changes === 1;
  }

  /** Mark a processing approval with its terminal outcome, or fail malformed pending data. */
  settle(approvalId: string, status: "approved" | "rejected" | "failed"): boolean {
    const query = status === "failed"
      ? "UPDATE thread_control_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status IN ('pending', 'processing')"
      : "UPDATE thread_control_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'processing'";
    return this.db.prepare(query).run(status, new Date().toISOString(), approvalId).changes === 1;
  }

  /** Return pending approval cards for one visible thread, skipping malformed payloads. */
  listPendingByThread(threadId: string): PendingThreadControlApproval[] {
    const rows = this.db.prepare(
      "SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, operation_phase, caller_id, source_thread_id, source_turn_id, source_provider_id, operation FROM thread_control_approvals WHERE thread_id = ? AND status = 'pending' ORDER BY created_at, id",
    ).all(threadId) as ApprovalRow[];
    const parsed: PendingThreadControlApproval[] = [];
    for (const row of rows) {
      try {
        parsed.push(this.parse(row));
      } catch (error) {
        logger.error("Skipping malformed pending thread-control approval", {
          approvalId: row.id,
          threadId: row.thread_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return parsed;
  }

  /** Return pending mutation approvals created by one source thread. */
  listPendingBySourceThread(sourceThreadId: string): PendingThreadControlApproval[] {
    const rows = this.db.prepare(
      "SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, operation_phase, caller_id, source_thread_id, source_turn_id, source_provider_id, operation FROM thread_control_approvals WHERE source_thread_id = ? AND status = 'pending' ORDER BY created_at, id",
    ).all(sourceThreadId) as ApprovalRow[];
    const parsed: PendingThreadControlApproval[] = [];
    for (const row of rows) {
      try {
        parsed.push(this.parse(row));
      } catch (error) {
        logger.error("Skipping malformed pending source-thread approval", {
          approvalId: row.id,
          threadId: row.thread_id,
          sourceThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return parsed;
  }

  private parse(row: ApprovalRow): PendingThreadControlApproval {
    const operation = parseOperation(row.operation);
    if (!operation) throw new Error("Stored thread-control approval has invalid operation");
    const execution = ResolvedExecutionSchema().parse(JSON.parse(row.execution_json));
    return parseApprovalByOperation(operation, row, execution);
  }

  /** Return all durable pending approvals so mutation reservations can rehydrate before ingress. */
  listPending(): RecoverableThreadCreateApproval[] {
    const rows = this.db.prepare(
      "SELECT id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, operation_phase, caller_id, source_thread_id, source_turn_id, source_provider_id, operation FROM thread_control_approvals WHERE status = 'pending' ORDER BY created_at, id",
    ).all() as ApprovalRow[];
    return rows.map((row) => {
      try {
        return this.parse(row);
      } catch {
        const operation = parseOperation(row.operation);
        return {
          invalid: true,
          ...(operation ? { operation } : {}),
          approvalId: row.id,
          threadId: row.thread_id,
          workspaceId: row.workspace_id,
          callerId: row.caller_id ?? "unknown",
          ...(row.source_thread_id ? { sourceThreadId: row.source_thread_id } : {}),
        };
      }
    });
  }

  /** Requeue a mutation that had not crossed its external dispatch boundary. */
  requeueDispatch(approvalId: string): boolean {
    return this.db.prepare("UPDATE thread_control_approvals SET status = 'pending', processing_started_at = NULL, operation_phase = 'pre_dispatch' WHERE id = ? AND status = 'processing' AND operation_phase = 'pre_dispatch'").run(approvalId).changes === 1;
  }
}

function approvalIdentity(row: ApprovalRow): {
  approvalId: string;
  threadId: string;
  workspaceId: string;
  turnId: string;
  callerId: string;
} {
  return {
    approvalId: row.id,
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    turnId: row.turn_id,
    callerId: row.caller_id ?? "unknown",
  };
}

function sourceThreadFields(row: ApprovalRow): Pick<PendingThreadCreateApproval, "sourceThreadId"> {
  return row.source_thread_id ? { sourceThreadId: row.source_thread_id } : {};
}

function sourceSendFields(row: ApprovalRow): Pick<
  PendingThreadSendApproval,
  "sourceThreadId" | "sourceTurnId" | "sourceProviderId"
> {
  return {
    ...sourceThreadFields(row),
    ...(row.source_turn_id ? { sourceTurnId: row.source_turn_id } : {}),
    ...(row.source_provider_id ? { sourceProviderId: row.source_provider_id } : {}),
  };
}

function parseApprovalByOperation(
  operation: ThreadControlApprovalOperation,
  row: ApprovalRow,
  execution: ResolvedExecution,
): PendingThreadControlApproval {
  const parsers: Record<ThreadControlApprovalOperation, () => PendingThreadControlApproval> = {
    thread_create_batch: () => parseCreateApproval(row, execution),
    thread_send: () => parseSendApproval(row, execution),
    thread_stop: () => parseStopApproval(row, execution),
  };
  return parsers[operation]();
}

function parseCreateApproval(row: ApprovalRow, execution: ResolvedExecution): PendingThreadCreateApproval {
  const placement = ThreadPlacementSchema().parse(JSON.parse(row.placement_json));
  if (placement.type !== "new_worktree") throw new Error("Stored thread-control approval has invalid placement");
  return {
    operation: "thread_create_batch",
    ...approvalIdentity(row),
    prompt: row.prompt,
    execution,
    placement,
    operationPhase: row.operation_phase as PendingThreadCreateApproval["operationPhase"],
    ...sourceThreadFields(row),
  };
}

function parseSendApproval(row: ApprovalRow, execution: ResolvedExecution): PendingThreadSendApproval {
  return {
    operation: "thread_send",
    ...approvalIdentity(row),
    message: row.prompt,
    execution,
    operationPhase: row.operation_phase as PendingThreadSendApproval["operationPhase"],
    ...sourceSendFields(row),
  };
}

function parseStopApproval(row: ApprovalRow, execution: ResolvedExecution): PendingThreadStopApproval {
  return {
    operation: "thread_stop",
    ...approvalIdentity(row),
    execution,
    operationPhase: row.operation_phase as PendingThreadStopApproval["operationPhase"],
    ...sourceThreadFields(row),
  };
}
