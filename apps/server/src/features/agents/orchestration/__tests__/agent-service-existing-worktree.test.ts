import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../store/database";
import { ThreadRepo } from "../../../../repositories/thread-repo";
import { WorkspaceRepo } from "../../../../repositories/workspace-repo";
import { MessageRepo } from "../../../../repositories/message-repo";
import { AgentService } from "../agent-service";
import { createCanonicalAgentEventSinkStub } from "../../../../test-utils/canonical-agent-event-sink-stub";
import type { GitService } from "../../../../services/git-service";
import type { ThreadService } from "../../../../services/thread-service";
import type { TurnRuntimeSnapshot } from "@mcode/contracts";

function createAgentServiceHarness() {
  const db: Database.Database = openMemoryDatabase();
  const threadRepo = new ThreadRepo(db);
  const workspaceRepo = new WorkspaceRepo(db);
  const messageRepo = new MessageRepo(db);
  const gitService = {
    listWorktrees: vi.fn(),
  } as unknown as GitService;
  const threadService = {
    create: vi.fn(),
  } as unknown as ThreadService;
  const service = new AgentService(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    {} as never,
    {} as never,
    threadService,
    {} as never,
    {} as never,
    {} as never,
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    createCanonicalAgentEventSinkStub(db),
  );
  vi.spyOn(service, "sendMessage").mockResolvedValue(undefined);

  return { db, threadRepo, workspaceRepo, gitService, threadService, service };
}

describe("AgentService.createAndSend defaults", () => {
  it("returns the authoritative running runtime snapshot after startup", async () => {
    const { workspaceRepo, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(service.sendMessage).mockImplementation(async ({ threadId, onTurnStarted }) => {
      const snapshot = (service as unknown as {
        turnRuntime: { start: (id: string) => TurnRuntimeSnapshot };
      }).turnRuntime.start(threadId);
      onTurnStarted?.(snapshot);
    });

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start the first turn",
    });

    expect(result.runtimeSnapshot).toMatchObject({
      threadId: result.id,
      phase: "running",
    });
    expect(result.runtimeSnapshot.turnExecutionId).toEqual(expect.any(String));
  });

  it("returns an idle snapshot when startup fails before runtime ownership", async () => {
    const { workspaceRepo, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(service.sendMessage).mockRejectedValue(new Error("startup failed"));

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start the first turn",
    });

    expect(result.runtimeSnapshot).toEqual({
      threadId: result.id,
      turnExecutionId: null,
      phase: "idle",
    });
  });

  it("returns after runtime startup without waiting for provider completion", async () => {
    const { workspaceRepo, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    let finishProvider!: () => void;
    const providerDone = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    vi.mocked(service.sendMessage).mockImplementation(async ({ threadId, onTurnStarted }) => {
      const snapshot = (service as unknown as {
        turnRuntime: { start: (id: string) => TurnRuntimeSnapshot };
      }).turnRuntime.start(threadId);
      onTurnStarted?.(snapshot);
      await providerDone;
    });

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start without waiting",
    });

    expect(result.runtimeSnapshot.phase).toBe("running");
    finishProvider();
  });

  it("uses the default model when the command omits it", async () => {
    const { threadRepo, workspaceRepo, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Use the default model",
    });

    expect(thread.model).toBe("claude-sonnet-4-6");
    expect(threadRepo.findById(thread.id)?.model).toBe("claude-sonnet-4-6");
    expect(service.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: thread.id,
        content: "Use the default model",
        model: "claude-sonnet-4-6",
      }),
    );
  });
});

describe("AgentService.createAndSend existing worktree attach", () => {
  it("creates a new worktree as branchless from the selected base branch", async () => {
    const { threadRepo, workspaceRepo, threadService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    const createdThread = {
      ...threadRepo.create(
        workspace.id,
        "Work from feature base",
        "worktree",
        "feature/base",
        true,
        "claude",
        undefined,
        "branchless",
        "feature/base",
      ),
      worktree_path: "/repo/.worktrees/feature-base",
    };
    vi.mocked(threadService.create).mockResolvedValue(createdThread);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Work from feature base",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "feature/base",
    });

    expect(threadService.create).toHaveBeenCalledWith(
      workspace.id,
      "Work from feature base",
      "worktree",
      "feature/base",
      { branchless: true },
    );
    expect(thread).toMatchObject({
      mode: "worktree",
      branch: "feature/base",
      checkout_state: "branchless",
      base_branch: "feature/base",
    });
  });

  it("creates a new worktree on a PR branch as a named checkout", async () => {
    const { threadRepo, workspaceRepo, threadService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    const createdThread = {
      ...threadRepo.create(
        workspace.id,
        "Review PR",
        "worktree",
        "contributor/pr-branch",
        true,
        "claude",
        undefined,
        "named",
        null,
      ),
      worktree_path: "/repo/.worktrees/contributor-pr-branch",
    };
    vi.mocked(threadService.create).mockResolvedValue(createdThread);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Review PR",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "contributor/pr-branch",
      worktreeBranchMode: "named",
    });

    expect(threadService.create).toHaveBeenCalledWith(
      workspace.id,
      "Review PR",
      "worktree",
      "contributor/pr-branch",
      { branchless: false },
    );
    expect(thread).toMatchObject({
      mode: "worktree",
      branch: "contributor/pr-branch",
      checkout_state: "named",
      base_branch: null,
    });
  });

  it("attaches a detached existing worktree as branchless with the selected base branch", async () => {
    const { workspaceRepo, gitService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      {
        name: "branchless-existing",
        path: "/repo/.worktrees/branchless-existing",
        branch: "(detached)",
        managed: true,
      },
    ]);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Work in detached worktree",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "main",
      existingWorktreePath: "/repo/.worktrees/branchless-existing/",
      existingWorktreeBaseBranch: "main",
      attachments: [],
      provider: "claude",
    });

    expect(thread).toMatchObject({
      mode: "worktree",
      worktree_path: "/repo/.worktrees/branchless-existing",
      branch: "main",
      checkout_state: "branchless",
      base_branch: "main",
      worktree_managed: false,
    });
  });

  it("keeps named existing worktree attach behavior unchanged", async () => {
    const { workspaceRepo, gitService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      {
        name: "feature-existing",
        path: "/repo/.worktrees/feature-existing",
        branch: "feat/existing",
        managed: true,
      },
    ]);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Work in named worktree",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "main",
      existingWorktreePath: "/repo/.worktrees/feature-existing",
      attachments: [],
      provider: "claude",
    });

    expect(thread).toMatchObject({
      mode: "worktree",
      worktree_path: "/repo/.worktrees/feature-existing",
      branch: "feat/existing",
      checkout_state: "named",
      base_branch: null,
      worktree_managed: false,
    });
  });

  it("rejects HEAD as the base branch for detached existing worktrees", async () => {
    const { workspaceRepo, gitService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      {
        name: "branchless-existing",
        path: "/repo/.worktrees/branchless-existing",
        branch: "(detached)",
        managed: true,
      },
    ]);

    await expect(
      service.createAndSend({
        workspaceId: workspace.id,
        content: "Work in detached worktree",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        mode: "worktree",
        branch: "main",
        existingWorktreePath: "/repo/.worktrees/branchless-existing",
        existingWorktreeBaseBranch: "HEAD",
        attachments: [],
        provider: "claude",
      }),
    ).rejects.toThrow("Base branch cannot be HEAD");
  });
});
