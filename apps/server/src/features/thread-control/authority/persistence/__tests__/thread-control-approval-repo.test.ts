import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import { ThreadControlApprovalRepo } from "../thread-control-approval-repo.js";
import { ThreadRepo } from "../../../persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../../projects/persistence/workspace-repo.js";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";

describe("ThreadControlApprovalRepo", () => {
  let db: Database;
  let approvals: ThreadControlApprovalRepo;
  let threadId: string;
  let workspaceId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    approvals = new ThreadControlApprovalRepo(db);
    const workspace = new WorkspaceRepo(db).create("Workspace", "C:/workspace");
    const thread = new ThreadRepo(db).create(
      workspace.id,
      "Pending delegated thread",
      "worktree",
      "main",
      true,
      "codex",
      undefined,
      "branchless",
      "main",
    );
    workspaceId = workspace.id;
    threadId = thread.id;
  });

  it("persists, rehydrates, claims, and settles a pending creation approval", () => {
    const approvalId = approvals.create({
      threadId,
      workspaceId,
      prompt: "Implement issue #960.",
      execution: {
        providerId: "codex",
        modelId: "gpt-5.6-sol",
        permissionMode: "full",
        interactionMode: "build",
      },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-960",
      callerId: "local-user",
      sourceThreadId: "thread-source",
    });

    expect(approvals.listPendingByThread(threadId)).toEqual([{
      operation: "thread_create_batch",
      approvalId,
      threadId,
      workspaceId,
      prompt: "Implement issue #960.",
      execution: {
        providerId: "codex",
        modelId: "gpt-5.6-sol",
        permissionMode: "full",
        interactionMode: "build",
      },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-960",
      operationPhase: "pre_provision",
      callerId: "local-user",
      sourceThreadId: "thread-source",
    }]);
    expect(approvals.claim(approvalId)?.approvalId).toBe(approvalId);
    expect(approvals.claim(approvalId)).toBeNull();
    expect(approvals.settle(approvalId, "approved")).toBe(true);
    expect(approvals.listPendingByThread(threadId)).toEqual([]);
  });

  it("returns only pre-side-effect processing approvals to pending after restart", () => {
    const approvalId = approvals.create({
      threadId,
      workspaceId,
      prompt: "Recover safely.",
      execution: { providerId: "codex", modelId: "gpt-5.6-sol", permissionMode: "full", interactionMode: "build" },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-recovery",
      callerId: "local-user",
    });

    expect(approvals.claim(approvalId)?.operationPhase).toBe("pre_provision");
    expect(approvals.listProcessing()).toHaveLength(1);
    expect(approvals.requeue(approvalId)).toBe(true);
    expect(approvals.listPendingByThread(threadId)).toHaveLength(1);
  });

  it("does not requeue an approval after provisioning has started", () => {
    const approvalId = approvals.create({
      threadId,
      workspaceId,
      prompt: "Provision once.",
      execution: { providerId: "codex", modelId: "gpt-5.6-sol", permissionMode: "full", interactionMode: "build" },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-provisioning",
      callerId: "local-user",
    });

    expect(approvals.claim(approvalId)).not.toBeNull();
    expect(approvals.setOperationPhase(approvalId, "provisioning")).toBe(true);
    expect(approvals.requeue(approvalId)).toBe(false);
  });

  it("returns a fail-closed recovery item for malformed persisted payloads", () => {
    const approvalId = approvals.create({
      threadId,
      workspaceId,
      prompt: "Never expose this prompt.",
      execution: { providerId: "codex", modelId: "gpt-5.6-sol", permissionMode: "full", interactionMode: "build" },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-malformed",
      callerId: "local-user",
    });
    expect(approvals.claim(approvalId)).not.toBeNull();
    db.prepare("UPDATE thread_control_approvals SET execution_json = ? WHERE id = ?").run("{", approvalId);

    expect(approvals.listProcessing()).toEqual([{
      invalid: true,
      operation: "thread_create_batch",
      approvalId,
      threadId,
      workspaceId,
      callerId: "local-user",
    }]);
  });

  it("isolates malformed pending payloads while preserving valid approvals", () => {
    const malformedApprovalId = approvals.create({
      threadId,
      workspaceId,
      prompt: "Malformed pending approval.",
      execution: { providerId: "codex", modelId: "gpt-5.6-sol", permissionMode: "full", interactionMode: "build" },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-malformed-pending",
      callerId: "local-user",
    });
    const validApprovalId = approvals.create({
      threadId,
      workspaceId,
      prompt: "Valid pending approval.",
      execution: { providerId: "codex", modelId: "gpt-5.6-sol", permissionMode: "full", interactionMode: "build" },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-valid-pending",
      callerId: "local-user",
    });
    db.prepare("UPDATE thread_control_approvals SET execution_json = ? WHERE id = ?").run("{", malformedApprovalId);

    const pending = approvals.listPending();

    expect(pending).toHaveLength(2);
    expect(pending).toEqual(expect.arrayContaining([
      {
        invalid: true,
        operation: "thread_create_batch",
        approvalId: malformedApprovalId,
        threadId,
        workspaceId,
        callerId: "local-user",
      },
      expect.objectContaining({ approvalId: validApprovalId, prompt: "Valid pending approval." }),
    ]));
    expect(approvals.listPendingByThread(threadId)).toEqual([
      expect.objectContaining({ approvalId: validApprovalId, prompt: "Valid pending approval." }),
    ]);
    expect(approvals.settle(malformedApprovalId, "failed")).toBe(true);
    expect(db.prepare("SELECT status FROM thread_control_approvals WHERE id = ?").get(malformedApprovalId)).toEqual({ status: "failed" });
  });

  it.each([
    ["thread_send", () => approvals.createSend({
      threadId,
      workspaceId,
      message: "Malformed send.",
      execution: { providerId: "codex", modelId: "gpt-5.6-sol", permissionMode: "supervised", interactionMode: "build" },
      turnId: "turn-malformed-send",
      callerId: "local-user",
    })],
    ["thread_stop", () => approvals.createStop({
      threadId,
      workspaceId,
      execution: { providerId: "codex", modelId: "gpt-5.6-sol", permissionMode: "supervised", interactionMode: "build" },
      turnId: "turn-malformed-stop",
      callerId: "local-user",
    })],
  ])("preserves malformed %s operation for recovery", (operation, createApproval) => {
    const approvalId = createApproval();
    db.prepare("UPDATE thread_control_approvals SET execution_json = ? WHERE id = ?").run("{", approvalId);

    expect(approvals.listPending()).toEqual([{
      invalid: true,
      operation,
      approvalId,
      threadId,
      workspaceId,
      callerId: "local-user",
    }]);
  });

  it("drops an invalid durable operation from malformed recovery identity", () => {
    const approvalId = approvals.create({
      threadId,
      workspaceId,
      prompt: "Malformed operation.",
      execution: { providerId: "codex", modelId: "gpt-5.6-sol", permissionMode: "supervised", interactionMode: "build" },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-malformed-operation",
      callerId: "local-user",
    });
    db.prepare("UPDATE thread_control_approvals SET operation = ?, execution_json = ? WHERE id = ?").run("legacy_operation", "{", approvalId);

    expect(approvals.listPending()).toEqual([{
      invalid: true,
      approvalId,
      threadId,
      workspaceId,
      callerId: "local-user",
    }]);
  });

  it("fails a claimed approval whose payload cannot be parsed", () => {
    const approvalId = approvals.createSend({
      threadId,
      workspaceId,
      message: "Malformed claim.",
      execution: { providerId: "codex", modelId: "gpt-5.6-sol", permissionMode: "supervised", interactionMode: "build" },
      turnId: "turn-malformed-claim",
      callerId: "local-user",
    });
    db.prepare("UPDATE thread_control_approvals SET execution_json = ? WHERE id = ?").run("{", approvalId);

    expect(approvals.claim(approvalId)).toBeNull();
    expect(db.prepare("SELECT status FROM thread_control_approvals WHERE id = ?").get(approvalId)).toEqual({ status: "failed" });
    expect(approvals.listProcessing()).toEqual([]);
  });
});
