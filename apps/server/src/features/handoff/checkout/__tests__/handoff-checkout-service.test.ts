import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import type { GitService } from "../../../projects/index.js";
import { HandoffCheckoutService } from "../handoff-checkout-service.js";

describe("HandoffCheckoutService", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let gitService: GitService;
  let service: HandoffCheckoutService;

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);
    gitService = {
      resolveWorkingDir: vi.fn(),
      createBranch: vi.fn(),
      getCurrentBranchAt: vi.fn(),
    } as unknown as GitService;
    service = new HandoffCheckoutService(threadRepo, workspaceRepo, gitService);
  });

  it("creates a branch for a thread and marks its checkout state named", async () => {
    const workspace = workspaceRepo.create("test", "/tmp/test");
    const thread = threadRepo.create(
      workspace.id,
      "Branchless Thread",
      "worktree",
      "release",
      true,
      "claude",
      undefined,
      "branchless",
      "release",
    );
    threadRepo.updateWorktreePath(thread.id, "/tmp/wt/main");
    (gitService.resolveWorkingDir as ReturnType<typeof vi.fn>).mockReturnValue("/tmp/wt/main");
    (gitService.createBranch as ReturnType<typeof vi.fn>).mockResolvedValue("feat/from-thread");

    const branch = await service.createBranchForThread(
      workspace.id,
      thread.id,
      "feat/from-thread",
    );

    expect(branch).toBe("feat/from-thread");
    expect(gitService.resolveWorkingDir).toHaveBeenCalledWith(
      "/tmp/test",
      "worktree",
      "/tmp/wt/main",
    );
    expect(gitService.createBranch).toHaveBeenCalledWith(
      "/tmp/wt/main",
      "feat/from-thread",
    );
    expect(threadRepo.findById(thread.id)).toMatchObject({
      branch: "feat/from-thread",
      checkout_state: "named",
      base_branch: "release",
    });
  });

  it("syncs a branchless thread worktree to a named external branch", async () => {
    const workspace = workspaceRepo.create("test", "/tmp/test");
    const thread = threadRepo.create(workspace.id, "Branchless", "worktree", "release", true, "claude", undefined, "branchless", "release");
    threadRepo.updateWorktreePath(thread.id, "/tmp/wt/main");
    (gitService.getCurrentBranchAt as ReturnType<typeof vi.fn>).mockResolvedValue("feat/external");

    const result = await service.syncCheckoutFromHead(thread.id);

    expect(result?.changed).toBe(true);
    expect(result?.thread).toMatchObject({
      branch: "feat/external",
      checkout_state: "named",
      base_branch: "release",
    });
  });

  it("syncs a named thread worktree to detached HEAD", async () => {
    const workspace = workspaceRepo.create("test", "/tmp/test");
    const thread = threadRepo.create(workspace.id, "Named", "worktree", "feat/base");
    threadRepo.updateWorktreePath(thread.id, "/tmp/wt/base");
    (gitService.getCurrentBranchAt as ReturnType<typeof vi.fn>).mockResolvedValue("HEAD");

    const result = await service.syncCheckoutFromHead(thread.id);

    expect(result?.changed).toBe(true);
    expect(result?.thread).toMatchObject({
      branch: "HEAD",
      checkout_state: "branchless",
      base_branch: "feat/base",
    });
  });
});
