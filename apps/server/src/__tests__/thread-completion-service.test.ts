import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { MessageRepo } from "../repositories/message-repo";
import type { AgentService } from "../services/agent-service";
import type { ThreadTeardownService } from "../services/thread-teardown-service";
import { ThreadControlMutationReservationService } from "../services/thread-control-mutation-reservation-service";
import { ThreadCompletionService } from "../services/thread-completion-service";

describe("ThreadCompletionService", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let agentService: AgentService;
  let teardownService: ThreadTeardownService;
  let service: ThreadCompletionService;
  let threadId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    const workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
    threadId = threadRepo.create(
      workspaceRepo.create("Test", "/tmp/test", true).id,
      "Complete me",
      "direct",
      "main",
    ).id;
    agentService = {
      activeThreadIds: vi.fn(() => []),
      listPendingPermissions: vi.fn(() => []),
    } as unknown as AgentService;
    teardownService = {
      teardownThread: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadTeardownService;
    service = new ThreadCompletionService(
      threadRepo,
      agentService,
      teardownService,
      new ThreadControlMutationReservationService(),
      () => new Date("2026-08-12T08:00:00.000Z"),
    );
  });

  it("persists completion separately from runtime status and releases resources", async () => {
    const completed = await service.complete(threadId);

    expect(completed.status).toBe("active");
    expect(completed.user_completed_at).toBe("2026-08-12T08:00:00.000Z");
    expect(completed.scheduled_deletion_at).toBe("2026-08-15T08:00:00.000Z");
    expect(threadRepo.findById(threadId)).toEqual(completed);
    expect(teardownService.teardownThread).toHaveBeenCalledWith(threadId);
  });

  it("keeps the first completion deadline when completion repeats", async () => {
    const first = await service.complete(threadId);
    const second = await service.complete(threadId);

    expect(second.user_completed_at).toBe(first.user_completed_at);
    expect(second.scheduled_deletion_at).toBe(first.scheduled_deletion_at);
    expect(teardownService.teardownThread).toHaveBeenCalledTimes(1);
  });

  it("keeps the thread active when runtime resource release fails", async () => {
    vi.mocked(teardownService.teardownThread).mockRejectedValueOnce(
      new Error("terminal teardown failed"),
    );

    await expect(service.complete(threadId)).rejects.toThrow("terminal teardown failed");

    expect(threadRepo.findById(threadId)).toMatchObject({
      user_completed_at: null,
      scheduled_deletion_at: null,
    });
  });

  it("releases every registered server-side resource owner", async () => {
    const releaseCiWatcher = vi.fn().mockResolvedValue(undefined);
    service.registerResourceOwner("ci-watcher", releaseCiWatcher);

    await service.complete(threadId);

    expect(releaseCiWatcher).toHaveBeenCalledOnce();
    expect(releaseCiWatcher).toHaveBeenCalledWith(threadId);
  });

  it("rejects completion while the thread is running", async () => {
    vi.mocked(agentService.activeThreadIds).mockReturnValue([threadId]);

    await expect(service.complete(threadId)).rejects.toThrow(
      "Thread cannot be completed while it is running",
    );
    expect(threadRepo.findById(threadId)?.user_completed_at).toBeNull();
    expect(teardownService.teardownThread).not.toHaveBeenCalled();
  });

  it("rejects completion while permission is pending", async () => {
    vi.mocked(agentService.listPendingPermissions).mockReturnValue([
      { requestId: "permission-1" },
    ] as never);

    await expect(service.complete(threadId)).rejects.toThrow(
      "Thread cannot be completed while permission is pending",
    );
    expect(threadRepo.findById(threadId)?.user_completed_at).toBeNull();
  });

  it("reopens the thread and cancels its pending deletion", async () => {
    await service.complete(threadId);

    const reopened = service.reopen(threadId);

    expect(reopened.user_completed_at).toBeNull();
    expect(reopened.scheduled_deletion_at).toBeNull();
    expect(threadRepo.findById(threadId)).toEqual(reopened);
  });

  it("preserves conversation, attachments, and repository identity", async () => {
    const messageRepo = new MessageRepo(db);
    messageRepo.create(threadId, "user", "Keep this context", 1, [{
      id: "attachment-1",
      name: "context.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    }]);
    threadRepo.updateWorktreePath(threadId, "C:/repo/worktree");

    await service.complete(threadId);

    expect(messageRepo.listByThread(threadId, 10).messages).toEqual([
      expect.objectContaining({
        content: "Keep this context",
        attachments: [expect.objectContaining({ id: "attachment-1" })],
      }),
    ]);
    expect(threadRepo.findById(threadId)).toMatchObject({
      branch: "main",
      worktree_path: "C:/repo/worktree",
    });
  });

  it("serializes competing lifecycle requests", async () => {
    const [first, second] = await Promise.allSettled([
      service.complete(threadId),
      service.complete(threadId),
    ]);

    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(threadRepo.findById(threadId)?.user_completed_at).not.toBeNull();
  });
});
