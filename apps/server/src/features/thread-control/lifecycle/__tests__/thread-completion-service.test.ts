import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../../agents/conversation/persistence/message-repo.js";
import { getDefaultSettings, type CompletedThreadRetentionDays, type Settings } from "@mcode/contracts";
import type { AgentService } from "../../../agents/index.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadTeardownService } from "../thread-teardown-service.js";
import { ThreadControlMutationReservationService } from "../../authority/thread-control-mutation-reservation-service.js";
import { ThreadCompletionService } from "../thread-completion-service.js";

describe("ThreadCompletionService", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let agentService: AgentService;
  let teardownService: ThreadTeardownService;
  let settingsService: SettingsService;
  let service: ThreadCompletionService;
  let threadId: string;
  let now: Date;
  let settings: Settings;
  let settingsListener: ((settings: Settings) => void) | null;

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
    now = new Date("2026-08-12T08:00:00.000Z");
    settings = getDefaultSettings();
    settingsListener = null;
    settingsService = {
      get: vi.fn(() => settings),
      on: vi.fn((_event, listener) => {
        settingsListener = listener;
        return () => {
          settingsListener = null;
        };
      }),
    } as unknown as SettingsService;
    service = new ThreadCompletionService(
      threadRepo,
      agentService,
      teardownService,
      new ThreadControlMutationReservationService(),
      settingsService,
      () => now,
    );
    service.start();
  });

  function applyRetention(retentionDays: CompletedThreadRetentionDays): void {
    settings = {
      ...settings,
      thread: { completion: { retentionDays } },
    };
    settingsListener?.(settings);
  }

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

  it("disables automatic deletion when the setting is Never", async () => {
    applyRetention(null);

    const completed = await service.complete(threadId);

    expect(completed.scheduled_deletion_at).toBeNull();
  });

  it("recalculates existing deadlines from their original completion timestamps", async () => {
    const changed = vi.fn();
    service.onDeadlineChanges(changed);
    await service.complete(threadId);

    applyRetention(10);

    const recalculated = threadRepo.findById(threadId);
    expect(recalculated?.user_completed_at).toBe("2026-08-12T08:00:00.000Z");
    expect(recalculated?.scheduled_deletion_at).toBe("2026-08-22T08:00:00.000Z");
    expect(changed).toHaveBeenCalledWith([recalculated]);
  });

  it("recalculates large histories in bounded batches", async () => {
    const updateSpy = vi.spyOn(threadRepo, "updateCompletedThreadDeadlines");
    const workspaceId = threadRepo.findById(threadId)!.workspace_id;
    for (let index = 0; index < 101; index += 1) {
      const id = threadRepo.create(workspaceId, `Completed ${index}`, "direct", "main").id;
      threadRepo.complete(id, now.toISOString(), "2026-08-15T08:00:00.000Z");
    }

    applyRetention(10);

    await vi.waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(2);
    });
    expect(updateSpy.mock.calls.every(([updates]) => updates.length <= 100)).toBe(true);
  });

  it("shortens a future deadline from its original completion timestamp", async () => {
    await service.complete(threadId);

    applyRetention(2);

    expect(threadRepo.findById(threadId)?.scheduled_deletion_at).toBe(
      "2026-08-14T08:00:00.000Z",
    );
  });

  it("cancels every pending deadline without reopening completed threads", async () => {
    const secondThreadId = threadRepo.create(
      threadRepo.findById(threadId)!.workspace_id,
      "Also complete",
      "direct",
      "main",
    ).id;
    await service.complete(threadId);
    await service.complete(secondThreadId);
    db.prepare("UPDATE threads SET cleanup_state = 'queued' WHERE id = ?").run(threadId);
    db.prepare(
      `INSERT INTO cleanup_jobs
        (id, thread_id, workspace_path, worktree_path, branch, kind, attempts, next_retry_at, created_at)
       VALUES ('retention-cancel', ?, '/repo', NULL, 'main', 'retention', 0, 0, 1)`,
    ).run(threadId);

    applyRetention(null);

    expect(threadRepo.findById(threadId)).toMatchObject({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: null,
      cleanup_state: null,
      cleanup_reason: null,
    });
    expect(threadRepo.findById(secondThreadId)).toMatchObject({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: null,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM cleanup_jobs WHERE thread_id = ?").get(threadId),
    ).toEqual({ count: 0 });
  });

  it("gives a newly overdue thread 24 hours after retention becomes shorter", async () => {
    applyRetention(10);
    now = new Date("2026-08-05T08:00:00.000Z");
    await service.complete(threadId);
    now = new Date("2026-08-12T08:00:00.000Z");

    applyRetention(3);

    expect(threadRepo.findById(threadId)?.scheduled_deletion_at).toBe(
      "2026-08-13T08:00:00.000Z",
    );
  });

  it("does not move deadlines when the same setting is applied again", async () => {
    const changed = vi.fn();
    service.onDeadlineChanges(changed);
    await service.complete(threadId);

    applyRetention(3);

    expect(threadRepo.findById(threadId)?.scheduled_deletion_at).toBe(
      "2026-08-15T08:00:00.000Z",
    );
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps recalculated deadlines after the service restarts", async () => {
    await service.complete(threadId);
    applyRetention(10);
    service.stop();
    const persistedDeadline = threadRepo.findById(threadId)?.scheduled_deletion_at;
    const restarted = new ThreadCompletionService(
      threadRepo,
      agentService,
      teardownService,
      new ThreadControlMutationReservationService(),
      settingsService,
      () => new Date("2026-08-20T08:00:00.000Z"),
    );

    restarted.start();

    expect(threadRepo.findById(threadId)?.scheduled_deletion_at).toBe(persistedDeadline);
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

  it("atomically cancels queued retention cleanup when the user reopens", async () => {
    await service.complete(threadId);
    db.prepare("UPDATE threads SET cleanup_state = 'queued' WHERE id = ?").run(threadId);
    db.prepare(
      `INSERT INTO cleanup_jobs
        (id, thread_id, workspace_path, worktree_path, branch, kind, attempts, next_retry_at, created_at)
       VALUES ('cleanup-1', ?, '/repo', NULL, 'main', 'retention', 0, 0, 1)`,
    ).run(threadId);

    const reopened = service.reopen(threadId);

    expect(reopened).toMatchObject({
      user_completed_at: null,
      scheduled_deletion_at: null,
      cleanup_state: null,
      cleanup_reason: null,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM cleanup_jobs WHERE thread_id = ?").get(threadId),
    ).toEqual({ count: 0 });
  });

  it("returns one conflict after destructive cleanup starts", async () => {
    await service.complete(threadId);
    db.prepare("UPDATE threads SET cleanup_state = 'running' WHERE id = ?").run(threadId);

    expect(() => service.reopen(threadId)).toThrow("Thread cleanup has already started");
    expect(threadRepo.findById(threadId)).toMatchObject({
      cleanup_state: "running",
      user_completed_at: expect.any(String),
    });
  });

  it("keeps a retry-exhausted destructive cleanup closed", async () => {
    await service.complete(threadId);
    db.prepare("UPDATE threads SET cleanup_state = 'blocked' WHERE id = ?").run(threadId);
    db.prepare(
      `INSERT INTO cleanup_jobs
        (id, thread_id, workspace_path, worktree_path, branch, kind, attempts, next_retry_at, created_at)
       VALUES ('cleanup-blocked', ?, '/repo', NULL, 'main', 'retention', 5, 0, 1)`,
    ).run(threadId);

    expect(() => service.reopen(threadId)).toThrow("Thread cleanup has already started");
    expect(threadRepo.findById(threadId)).toMatchObject({
      cleanup_state: "blocked",
      user_completed_at: expect.any(String),
    });
  });

  it("allows reopen when cleanup is blocked before destructive work starts", async () => {
    await service.complete(threadId);
    db.prepare("UPDATE threads SET cleanup_state = 'blocked' WHERE id = ?").run(threadId);

    expect(service.reopen(threadId)).toMatchObject({
      cleanup_state: null,
      user_completed_at: null,
    });
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
