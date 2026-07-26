import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { ThreadControlApprovalRepo } from "../repositories/thread-control-approval-repo.js";
import { ThreadRepo } from "../repositories/thread-repo.js";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { openMemoryDatabase } from "../store/database.js";

describe("ThreadControlApprovalRepo", () => {
  let db: Database.Database;
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
});
