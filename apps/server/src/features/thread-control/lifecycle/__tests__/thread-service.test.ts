import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { HandoffStorage } from "../../../handoff/index.js";
import {
  GitWorktreeService,
  ProjectWorktreeService,
  SandboxWorktreeCleanupPolicy,
} from "../../../projects/index.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { CleanupJobRepo } from "../../cleanup/persistence/cleanup-job-repo.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import type { ThreadDeletionTeardownService } from "../thread-deletion-teardown-service.js";
import { ThreadService } from "../thread-service.js";

describe("ThreadService.delete", () => {
  let database: Database.Database;
  let threads: ThreadRepo;
  let workspaces: WorkspaceRepo;
  let cleanupJobs: CleanupJobRepo;
  let cleanupPolicy: SandboxWorktreeCleanupPolicy;
  let threadService: ThreadService;
  let teardownThread: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = openMemoryDatabase();
    threads = new ThreadRepo(database);
    workspaces = new WorkspaceRepo(database);
    cleanupJobs = new CleanupJobRepo(database);
    cleanupPolicy = {
      decide: vi.fn(async ({ worktreePath }) => ({
        action: "remove",
        worktreePath,
        branch: "feature/delete",
      })),
    } as unknown as SandboxWorktreeCleanupPolicy;
    const worktrees = {
      createWorktree: vi.fn(),
      removeWorktree: vi.fn().mockResolvedValue(true),
    } as unknown as GitWorktreeService;
    teardownThread = vi.fn().mockResolvedValue(undefined);
    threadService = new ThreadService(
      threads,
      new ProjectWorktreeService(threads, workspaces, cleanupJobs, worktrees, cleanupPolicy),
      { removeForThread: vi.fn() } as unknown as AttachmentService,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage,
      { teardownThread } as unknown as ThreadDeletionTeardownService,
    );
  });

  function addWorktreeThread(
    workspaceId: string,
    id: string,
    path: string,
    branch: string,
    managed = true,
  ): void {
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO threads (
        id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'worktree', 'active', ?, ?, ?, ?)`,
    ).run(id, workspaceId, id, branch, path, managed ? 1 : 0, now, now);
  }

  it("queues every sandbox worktree, even when legacy metadata says it is unmanaged", async () => {
    const workspace = workspaces.create("Project", "/repo");
    addWorktreeThread(
      workspace.id,
      "thread-1",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\feature",
      "feature/delete",
      false,
    );

    await threadService.delete("thread-1", true);

    expect(cleanupJobs.findByThreadId("thread-1")).toMatchObject({
      workspace_path: "/repo",
      worktree_path: "C:\\Users\\user\\.mcode\\worktrees\\repo\\feature",
      branch: "feature/delete",
    });
    expect(threads.findById("thread-1")?.status).toBe("deleted");
  });

  it.each([
    ["outside-sandbox" as const, "C:\\source\\shared-worktree"],
    ["primary-branch" as const, "C:\\Users\\user\\.mcode\\worktrees\\repo\\main"],
  ])("keeps a %s checkout and deletes only its thread", async (reason, path) => {
    const workspace = workspaces.create("Project", "/repo");
    addWorktreeThread(workspace.id, "thread-2", path, "main");
    vi.mocked(cleanupPolicy.decide).mockResolvedValue({ action: "retain", reason });

    await threadService.delete("thread-2", true);

    expect(cleanupJobs.count()).toBe(0);
    expect(threads.findById("thread-2")).toBeNull();
  });

  it("hard-deletes directly when worktree cleanup is not requested", async () => {
    const workspace = workspaces.create("Project", "/repo");
    addWorktreeThread(workspace.id, "thread-3", "C:\\Users\\user\\.mcode\\worktrees\\repo\\feature", "feature/delete");

    await threadService.delete("thread-3", false);

    expect(cleanupJobs.count()).toBe(0);
    expect(threads.findById("thread-3")).toBeNull();
    expect(teardownThread).toHaveBeenCalledExactlyOnceWith("thread-3");
  });

  it("detaches an active handoff descendant when deleting its parent directly", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const parent = threads.create(workspace.id, "Parent", "direct", "main");
    const descendant = threads.create(
      workspace.id,
      "Active handoff",
      "direct",
      "main",
      true,
      "claude",
      { parentThreadId: parent.id, forkedFromMessageId: "message-1" },
    );

    await threadService.delete(parent.id, false);

    expect(threads.findById(parent.id)).toBeNull();
    expect(threads.findById(descendant.id)).toMatchObject({
      parent_thread_id: null,
      forked_from_message_id: null,
    });
    expect(teardownThread).toHaveBeenCalledExactlyOnceWith(parent.id);
  });
});
