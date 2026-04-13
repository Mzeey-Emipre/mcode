import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../repositories/workspace-repo";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFile,
}));

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

import { GitService } from "../services/git-service";

describe("GitService.push", () => {
  let gitService: GitService;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockWorkspaceRepo = {
      findById: vi.fn().mockReturnValue({ path: "/repo" }),
    } as unknown as WorkspaceRepo;
    gitService = new GitService(mockWorkspaceRepo);
  });

  it("pushes branch to origin with --set-upstream", async () => {
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

    await gitService.push("/repo", "feat/my-branch");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "push", "--set-upstream", "origin", "feat/my-branch"],
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it("throws when push fails", async () => {
    mockExecFile.mockRejectedValue(new Error("rejected"));

    await expect(gitService.push("/repo", "feat/my-branch")).rejects.toThrow(
      "rejected",
    );
  });
});

describe("GitService.diffStat", () => {
  let gitService: GitService;

  beforeEach(() => {
    vi.clearAllMocks();
    gitService = new GitService({} as WorkspaceRepo);
  });

  it("returns diff stat between two refs", async () => {
    mockExecFile.mockResolvedValue({
      stdout: " 3 files changed, 42 insertions(+), 5 deletions(-)\n",
      stderr: "",
    });

    const result = await gitService.diffStat("/repo", "main", "feat/x");

    expect(result).toBe("3 files changed, 42 insertions(+), 5 deletions(-)");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "diff", "--stat", "main...feat/x"],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });
});
