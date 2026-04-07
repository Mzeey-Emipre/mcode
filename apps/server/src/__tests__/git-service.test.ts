import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../repositories/workspace-repo";

const { mockExecFile, mockRm, mockExistsSync, mockLogger } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockRm: vi.fn(),
  mockExistsSync: vi.fn(),
  mockLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFile,
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  rm: mockRm,
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  validateBranchName: vi.fn(),
  validateWorktreeName: vi.fn(),
  logger: mockLogger,
}));

import { GitService } from "../services/git-service";

describe("GitService.removeWorktree", () => {
  let gitService: GitService;

  beforeEach(() => {
    vi.clearAllMocks();
    gitService = new GitService({} as WorkspaceRepo);
  });

  it("removes worktree and branch when git succeeds", async () => {
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    const result = await gitService.removeWorktree(
      "/repo",
      "my-worktree",
      "feat/test",
    );

    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        "/repo",
        "worktree",
        "remove",
        expect.stringContaining("my-worktree"),
        "--force",
        "--force",
      ],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "branch", "-d", "feat/test"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(mockRm).not.toHaveBeenCalled();
  });

  it("falls back to fs.rm when git remove fails", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("git worktree remove failed"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // prune
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // branch -d
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockRm.mockResolvedValue(undefined);

    const result = await gitService.removeWorktree("/repo", "my-worktree");

    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining("my-worktree"),
      { recursive: true, force: true, maxRetries: 5, retryDelay: 200 },
    );
    expect(result).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("returns false when directory cannot be removed", async () => {
    mockExecFile.mockRejectedValue(new Error("git failed"));
    mockExistsSync.mockReturnValue(true);
    mockRm.mockRejectedValue(new Error("permission denied"));

    const result = await gitService.removeWorktree("/repo", "my-worktree");

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("succeeds even when branch deletion fails", async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // worktree remove
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // prune
      .mockRejectedValueOnce(new Error("branch not found")); // branch -d
    mockExistsSync.mockReturnValue(false);

    const result = await gitService.removeWorktree(
      "/repo",
      "my-worktree",
      "feat/test",
    );

    expect(result).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("passes maxRetries and retryDelay to fs.rm", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git failed")); // worktree remove
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" }); // prune
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" }); // branch -d
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockRm.mockResolvedValue(undefined);

    await gitService.removeWorktree("/repo", "my-worktree");

    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining("my-worktree"),
      { recursive: true, force: true, maxRetries: 5, retryDelay: 200 },
    );
  });

  it("uses double --force for git worktree remove", async () => {
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    await gitService.removeWorktree("/repo", "my-worktree", "feat/test");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "worktree", "remove", expect.stringContaining("my-worktree"), "--force", "--force"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });
});
