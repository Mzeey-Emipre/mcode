import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../repositories/workspace-repo";
import { GitService } from "../services/git-service";
import { createMockGitExecutor } from "../services/git-executor/__tests__/mock-git-executor.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  rm: vi.fn(),
  rename: vi.fn(),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  validateBranchName: vi.fn(),
  validateWorktreeName: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

describe("GitService.push", () => {
  let gitService: GitService;
  let execFn: ReturnType<typeof createMockGitExecutor>["execFn"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    const mockWorkspaceRepo = {
      findById: vi.fn().mockReturnValue({ path: "/repo" }),
    } as unknown as WorkspaceRepo;
    gitService = new GitService(mockWorkspaceRepo, mock.executor);
  });

  it("pushes branch to origin with --set-upstream", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });

    await gitService.push("/repo", "feat/my-branch");

    expect(execFn).toHaveBeenCalledWith(
      ["-C", "/repo", "push", "--set-upstream", "origin", "feat/my-branch"],
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it("throws when push fails", async () => {
    execFn.mockRejectedValue(new Error("rejected"));

    await expect(gitService.push("/repo", "feat/my-branch")).rejects.toThrow(
      "rejected",
    );
  });

  it("rejects branch names that look like git flags", async () => {
    const { validateBranchName } = await import("@mcode/shared");
    vi.mocked(validateBranchName).mockImplementation(() => {
      throw new Error("Branch name cannot start with '-'");
    });

    await expect(gitService.push("/repo", "--force")).rejects.toThrow(
      "Branch name cannot start with '-'",
    );
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe("GitService.diffStat", () => {
  let gitService: GitService;
  let execFn: ReturnType<typeof createMockGitExecutor>["execFn"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    gitService = new GitService({} as WorkspaceRepo, mock.executor);
  });

  it("returns diff stat between two refs", async () => {
    execFn.mockResolvedValue({
      stdout: " 3 files changed, 42 insertions(+), 5 deletions(-)\n",
      stderr: "",
    });

    const result = await gitService.diffStat("/repo", "main", "feat/x");

    expect(result).toBe("3 files changed, 42 insertions(+), 5 deletions(-)");
    expect(execFn).toHaveBeenCalledWith(
      ["-C", "/repo", "diff", "--stat", "main...feat/x"],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });
});
