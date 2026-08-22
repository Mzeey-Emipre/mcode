import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { CleanupJobRepo } from "../../cleanup/persistence/cleanup-job-repo.js";
import { WorkspaceEnvironmentService } from "../../../projects/environment/workspace-environment-service.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("ThreadCompletionService", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let agentService: AgentService;
  let teardownService: ThreadTeardownService;
  let settingsService: SettingsService;
  let service: ThreadCompletionService;
  let threadId: string;
  let cleanupJobRepo: CleanupJobRepo;
  let now: Date;
  let settings: Settings;
  let settingsListener: ((settings: Settings) => void) | null;

  beforeEach(() => {
    db = openMemoryDatabase();
    const workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
    cleanupJobRepo = new CleanupJobRepo(db);
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
      cleanupJobRepo,
    );
    service.start();
  });

  function applyRetention(retentionDays: CompletedThreadRetentionDays): void {
    settings = {
      ...settings,
      thread: {
        completion: {
          ...settings.thread.completion,
          retentionDays,
        },
      },
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

  it("preserves blocked cleanup state while recalculating its deadline", () => {
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked', cleanup_reason = 'dirty'
        WHERE id = ?`,
    ).run(now.toISOString(), "2026-08-13T08:00:00.000Z", threadId);

    applyRetention(10);

    expect(threadRepo.findById(threadId)).toMatchObject({
      scheduled_deletion_at: "2026-08-22T08:00:00.000Z",
      cleanup_state: "blocked",
      cleanup_reason: "dirty",
    });
    expect(cleanupJobRepo.findByThreadId(threadId)).toBeNull();
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
      cleanupJobRepo,
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

  it("retains a resource-owner barrier through completion and releases it when persistence fails", async () => {
    const releaseBarrier = vi.fn();
    const releaseOwner = vi.fn().mockResolvedValue(releaseBarrier);
    service.registerResourceOwner("workspace-environment", releaseOwner);
    vi.spyOn(threadRepo, "complete").mockReturnValueOnce(null);

    await expect(service.complete(threadId)).rejects.toThrow(`Thread not found: ${threadId}`);

    expect(releaseOwner).toHaveBeenCalledWith(threadId);
    expect(releaseBarrier).toHaveBeenCalledOnce();
    expect(threadRepo.findById(threadId)?.user_completed_at).toBeNull();
  });

  it("releases a completed resource-owner barrier when another resource fails", async () => {
    const releaseBarrier = vi.fn();
    service.registerResourceOwner("workspace-environment", vi.fn().mockResolvedValue(releaseBarrier));
    service.registerResourceOwner("broken-owner", vi.fn().mockRejectedValue(new Error("release failed")));

    await expect(service.complete(threadId)).rejects.toThrow("release failed");

    expect(releaseBarrier).toHaveBeenCalledOnce();
    expect(threadRepo.findById(threadId)?.user_completed_at).toBeNull();
  });

  it("releases registered thread resources before completion becomes visible", async () => {
    const cancelSetup = vi.fn().mockResolvedValue(undefined);
    service.registerResourceOwner("workspace-environment", cancelSetup);

    await service.complete(threadId);

    expect(cancelSetup).toHaveBeenCalledWith(threadId);
    expect(threadRepo.findById(threadId)?.user_completed_at).toBe(now.toISOString());
  });

  it("cancels running Setup and blocks a new attempt while completion is in progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-completion-setup-"));
    const teardownEntered = deferred();
    const releaseTeardown = deferred();
    const closeEntered = deferred();
    const closeSetup = vi.fn(async () => {
      closeEntered.resolve();
      return { kind: "contained" as const };
    });
    vi.mocked(teardownService.teardownThread).mockImplementationOnce(async () => {
      teardownEntered.resolve();
      await releaseTeardown.promise;
    });
    const environment = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => threadRepo.findById(id) },
      terminalCommands: {
        prepare: async () => ({
          kind: "ready",
          command: {
            snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
            start: async () => await new Promise<never>(() => undefined),
            close: closeSetup,
            waitForRelease: async () => await new Promise<never>(() => undefined),
          },
        }),
      },
      platform: "windows",
    });
    await environment.save({
      workspaceId: threadRepo.findById(threadId)!.workspace_id,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] },
    });
    await environment.startSetup({ threadId });
    service.registerResourceOwner("workspace-environment", async (id) => {
      const release = environment.beginThreadDeletion(id);
      try {
        await environment.cancelSetupForThread(id);
        return release;
      } catch (error) {
        release();
        throw error;
      }
    });

    try {
      const completion = service.complete(threadId);
      await teardownEntered.promise;
      await closeEntered.promise;
      expect(closeSetup).toHaveBeenCalledOnce();

      await expect(environment.startSetup({ threadId })).rejects.toMatchObject({
        code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
      });

      releaseTeardown.resolve();
      await completion;
      await expect(environment.startSetup({ threadId })).resolves.toMatchObject({ status: "running" });
      await environment.cancelSetupForThread(threadId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose completion while releasing runtime resources", async () => {
    let observedCompletion: string | null | undefined;
    service.registerResourceOwner("completion-observer", async (id) => {
      observedCompletion = threadRepo.findById(id)?.user_completed_at;
    });

    await service.complete(threadId);

    expect(observedCompletion).toBeNull();
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

  it("allows reopening after retry exhaustion has removed the cleanup job", async () => {
    await service.complete(threadId);
    db.prepare(
      "UPDATE threads SET cleanup_state = 'blocked', cleanup_reason = ? WHERE id = ?",
    ).run("Cleanup failed after 5 attempts.", threadId);

    expect(service.reopen(threadId)).toMatchObject({
      cleanup_state: null,
      user_completed_at: null,
    });
    expect(cleanupJobRepo.findByThreadId(threadId)).toBeNull();
    expect(threadRepo.findById(threadId)).toMatchObject({
      cleanup_state: null,
      user_completed_at: null,
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

  it("counts blocked completed retention candidates", () => {
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), threadId);
    const second = threadRepo.create(
      threadRepo.findById(threadId)!.workspace_id,
      "Second blocked",
      "direct",
      "main",
    );
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), second.id);

    expect(service.cleanupBlockedCount()).toEqual({ count: 2 });
  });

  it("requeues one blocked thread and rebuilds its retention job atomically", () => {
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), threadId);
    const oldJob = cleanupJobRepo.insert({
      thread_id: threadId,
      workspace_path: "/tmp/test",
      worktree_path: null,
      branch: "main",
      kind: "retention",
    });
    cleanupJobRepo.recordFailure(oldJob.id, "old failure");

    const queued = service.retryCleanup(threadId);
    const rebuilt = cleanupJobRepo.findByThreadId(threadId);
    expect(queued.cleanup_state).toBe("queued");
    expect(rebuilt).toMatchObject({ kind: "retention", attempts: 0, next_retry_at: 0 });
    expect(rebuilt?.id).not.toBe(oldJob.id);
  });

  it("rejects retry for a thread that is not blocked", () => {
    const initial = threadRepo.findById(threadId);
    expect(() => service.retryCleanup(threadId)).toThrow();
    expect(threadRepo.findById(threadId)).toEqual(initial);
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'queued'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), threadId);
    const queued = threadRepo.findById(threadId);
    expect(() => service.retryCleanup(threadId)).toThrow();
    expect(threadRepo.findById(threadId)).toEqual(queued);
    expect(cleanupJobRepo.findByThreadId(threadId)).toBeNull();
  });

  it("requeues every blocked candidate when policy changes from block to delete", () => {
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), threadId);
    const second = threadRepo.create(
      threadRepo.findById(threadId)!.workspace_id,
      "Second blocked",
      "direct",
      "main",
    );
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), second.id);
    const changedIds: string[] = [];
    service.onDeadlineChanges((threads) => changedIds.push(...threads.map((thread) => thread.id)));

    settings = {
      ...settings,
      thread: {
        completion: {
          ...settings.thread.completion,
          unsafeWorktreePolicy: "delete",
        },
      },
    };
    settingsListener?.(settings);

    expect(threadRepo.findById(threadId)?.cleanup_state).toBe("queued");
    expect(threadRepo.findById(second.id)?.cleanup_state).toBe("queued");
    expect(cleanupJobRepo.findByThreadId(threadId)?.kind).toBe("retention");
    expect(cleanupJobRepo.findByThreadId(second.id)?.kind).toBe("retention");
    expect(changedIds).toEqual(expect.arrayContaining([threadId, second.id]));
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
