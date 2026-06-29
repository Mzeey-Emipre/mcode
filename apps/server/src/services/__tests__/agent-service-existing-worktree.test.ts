import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../store/database";
import { ThreadRepo } from "../../repositories/thread-repo";
import { WorkspaceRepo } from "../../repositories/workspace-repo";
import { MessageRepo } from "../../repositories/message-repo";
import { AgentService } from "../agent-service";
import type { GitService } from "../git-service";
import type { ThreadService } from "../thread-service";

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
  );
  vi.spyOn(service, "sendMessage").mockResolvedValue(undefined);

  return { db, threadRepo, workspaceRepo, gitService, threadService, service };
}

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

    const thread = await service.createAndSend(
      workspace.id,
      "Work from feature base",
      "claude-sonnet-4-6",
      "default",
      "worktree",
      "feature/base",
    );

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

    const thread = await service.createAndSend(
      workspace.id,
      "Work in detached worktree",
      "claude-sonnet-4-6",
      "default",
      "worktree",
      "main",
      "/repo/.worktrees/branchless-existing/",
      "main",
      [],
      undefined,
      "claude",
      undefined,
      undefined,
      undefined,
      undefined,
    );

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

    const thread = await service.createAndSend(
      workspace.id,
      "Work in named worktree",
      "claude-sonnet-4-6",
      "default",
      "worktree",
      "main",
      "/repo/.worktrees/feature-existing",
      undefined,
      [],
      undefined,
      "claude",
    );

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
      service.createAndSend(
        workspace.id,
        "Work in detached worktree",
        "claude-sonnet-4-6",
        "default",
        "worktree",
        "main",
        "/repo/.worktrees/branchless-existing",
        "HEAD",
        [],
        undefined,
        "claude",
      ),
    ).rejects.toThrow("Base branch cannot be HEAD");
  });
});
