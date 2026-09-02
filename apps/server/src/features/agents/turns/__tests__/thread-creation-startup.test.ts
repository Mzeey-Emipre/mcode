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
  const coordinator = new ThreadCreationCoordinator(
    threads,
    () => threadService,
    admissions as never,
    undefined,
    undefined,
    () => startups,
  );
  return { db, workspace, threads, startups, threadService, admissions, coordinator };
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
