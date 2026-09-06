import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { ThreadService } from "../../../thread-control/index.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { ThreadCreationCoordinator } from "../thread-creation-coordinator.js";

const directStartupId = "00000000-0000-4000-8000-000000000001";
const managedStartupId = "00000000-0000-4000-8000-000000000002";
const cancelledStartupId = "00000000-0000-4000-8000-000000000003";

function harness() {
  const db = openMemoryDatabase();
  const workspaces = new WorkspaceRepo(db);
  const threads = new ThreadRepo(db);
  const workspace = workspaces.create("Project", "/project");
  const startups = new ThreadStartupService(new ThreadStartupRepo(db));
  const threadService = {
    create: vi.fn(),
    delete: vi.fn(async () => true),
  } as unknown as ThreadService;
  const admissions = {
    admitInitialAutomaticTurn: vi.fn(async () => ({ kind: "not-managed" as const })),
  };
  const gitRepository = { fetchBranch: vi.fn() };
  const coordinator = new ThreadCreationCoordinator(
    threads,
    () => threadService,
    admissions as never,
    gitRepository,
    undefined,
    undefined,
    () => startups,
  );
  return { db, workspace, threads, startups, threadService, admissions, gitRepository, coordinator };
}

describe("ThreadCreationCoordinator startup lifecycle", () => {
  it("completes Direct startup only after first runtime admission and records a first-dispatch failure", async () => {
    const { db, workspace, startups, coordinator } = harness();

    await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Start directly",
      startupId: directStartupId,
    });
    coordinator.startInitialAgent(directStartupId);
    coordinator.completeInitialAgent(directStartupId);

    expect(startups.get(directStartupId)).toMatchObject({
      state: "completed",
      phase: "agent",
      steps: [{ phase: "thread", state: "completed" }, { phase: "agent", state: "completed" }],
    });

    const failedStartupId = "00000000-0000-4000-8000-000000000004";
    await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Fail dispatch",
      startupId: failedStartupId,
    });
    coordinator.startInitialAgent(failedStartupId);
    coordinator.failInitialAgent(failedStartupId);

    expect(startups.get(failedStartupId)).toMatchObject({
      state: "failed",
      phase: "agent",
      error: { code: "AGENT_START_FAILED", retryable: true },
    });
    db.close();
  });

  it("orders managed checkout and Setup before the queued agent phase", async () => {
    const { db, workspace, threads, startups, threadService, admissions, coordinator } = harness();
    const managed = threads.create(
      workspace.id,
      "Managed",
      "worktree",
      "feature/managed",
      true,
      "claude",
    );
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      options.lifecycle?.onThreadPersisted(managed);
      return managed;
    });
    admissions.admitInitialAutomaticTurn.mockResolvedValue({ kind: "queued" });

    const created = await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Queue managed work",
      mode: "worktree",
      branch: "feature/managed",
      startupId: managedStartupId,
    });

    expect(created).toMatchObject({ kind: "queued", startupId: managedStartupId, thread: { id: managed.id } });
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "running",
      phase: "setup",
      threadId: managed.id,
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "running" },
        { phase: "agent", state: "pending" },
      ],
    });
    db.close();
  });

  it("fetches a selected pull request before creating its managed worktree", async () => {
    const { db, workspace, threads, threadService, gitRepository, coordinator } = harness();
    const order: string[] = [];
    const thread = threads.create(workspace.id, "Review", "worktree", "contributor/review", true, "claude");
    vi.mocked(gitRepository.fetchBranch).mockImplementation(async () => {
      order.push("fetch");
    });
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      order.push("create");
      options.lifecycle?.onThreadPersisted(thread);
      return thread;
    });

    await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Review this PR",
      mode: "worktree",
      branch: "contributor/review",
      pullRequestNumber: 42,
    });

    expect(gitRepository.fetchBranch).toHaveBeenCalledWith(workspace.id, "contributor/review", 42);
    expect(order).toEqual(["fetch", "create"]);
    db.close();
  });

  it("keeps the startup retryable when the selected pull request cannot be fetched", async () => {
    const { db, workspace, startups, threadService, gitRepository, coordinator } = harness();
    vi.mocked(gitRepository.fetchBranch).mockRejectedValue(new Error("pull request is unavailable"));

    await expect(coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Review this PR",
      mode: "worktree",
      branch: "contributor/review",
      pullRequestNumber: 42,
      startupId: managedStartupId,
    })).rejects.toThrow("pull request is unavailable");

    expect(threadService.create).not.toHaveBeenCalled();
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "failed",
      phase: "thread",
      error: { code: "THREAD_CREATE_FAILED", retryable: true },
    });
    db.close();
  });

  it("does not create a worktree when cancellation arrives while fetching a pull request", async () => {
    const { db, workspace, startups, threadService, gitRepository, coordinator } = harness();
    let finishFetch: (() => void) | undefined;
    vi.mocked(gitRepository.fetchBranch).mockImplementation(() => new Promise<void>((resolve) => {
      finishFetch = resolve;
    }));

    const creating = coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Cancel PR checkout",
      mode: "worktree",
      branch: "contributor/review",
      pullRequestNumber: 42,
      startupId: managedStartupId,
    });
    await vi.waitFor(() => expect(finishFetch).toBeDefined());
    startups.cancel(managedStartupId);
    finishFetch?.();

    await expect(creating).rejects.toThrow("Thread startup was cancelled");
    expect(threadService.create).not.toHaveBeenCalled();
    expect(startups.get(managedStartupId)).toMatchObject({ state: "cancelled", phase: "thread" });
    db.close();
  });

  it("does not admit a queued agent after startup cancellation wins", () => {
    const { db, workspace, threads, startups, coordinator } = harness();
    const thread = threads.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    startups.start({
      startupId: managedStartupId,
      workspaceId: workspace.id,
      kind: "managed-worktree",
    });
    startups.advance(managedStartupId, "thread");
    startups.bindThread(managedStartupId, thread.id);
    startups.advance(managedStartupId, "worktree");
    startups.advance(managedStartupId, "setup");
    startups.cancel(managedStartupId);

    expect(coordinator.startQueuedAgent(thread.id)).toBeNull();
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "cancelled",
      phase: "setup",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "cancelled" },
        { phase: "agent", state: "pending" },
      ],
    });
    expect(coordinator.startQueuedAgent(thread.id)).toBeNull();
    db.close();
  });

  it("does not admit a queued agent when cancellation wins after Setup advances to agent", () => {
    const { db, workspace, threads, startups, coordinator } = harness();
    const thread = threads.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    startups.start({
      startupId: managedStartupId,
      workspaceId: workspace.id,
      kind: "managed-worktree",
    });
    startups.advance(managedStartupId, "thread");
    startups.bindThread(managedStartupId, thread.id);
    startups.advance(managedStartupId, "worktree");
    startups.advance(managedStartupId, "setup");
    startups.advance(managedStartupId, "agent");
    startups.cancel(managedStartupId);

    expect(coordinator.startQueuedAgent(thread.id)).toBeNull();
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "cancelled",
      phase: "agent",
      steps: expect.arrayContaining([{ phase: "agent", state: "cancelled" }]),
    });
    db.close();
  });

  it("honors cancellation before Git mutation and cleans up after checkout returns", async () => {
    const { db, workspace, threads, startups, threadService, coordinator } = harness();
    const beforeCheckout = threads.create(workspace.id, "Cancelled", "worktree", "feature/cancelled", true, "claude");
    let gitMutationReached = false;
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      startups.cancel(cancelledStartupId);
      options.lifecycle?.onThreadPersisted(beforeCheckout);
      gitMutationReached = true;
      return beforeCheckout;
    });

    await expect(coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Cancel before checkout",
      mode: "worktree",
      branch: "feature/cancelled",
      startupId: cancelledStartupId,
    })).rejects.toThrow("Thread startup was cancelled");
    expect(gitMutationReached).toBe(false);
    expect(startups.get(cancelledStartupId)).toMatchObject({ state: "cancelled", phase: "worktree" });

    const afterCheckoutId = "00000000-0000-4000-8000-000000000005";
    const afterCheckout = threads.create(workspace.id, "Cleanup", "worktree", "feature/cleanup", true, "claude");
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      options.lifecycle?.onThreadPersisted(afterCheckout);
      startups.cancel(afterCheckoutId);
      return afterCheckout;
    });

    await expect(coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Cancel after checkout",
      mode: "worktree",
      branch: "feature/cleanup",
      startupId: afterCheckoutId,
    })).rejects.toThrow("Thread startup was cancelled");
    expect(threadService.delete).toHaveBeenCalledWith(afterCheckout.id, true);
    expect(startups.get(afterCheckoutId)).toMatchObject({ state: "cancelled", phase: "worktree" });
    db.close();
  });
});
