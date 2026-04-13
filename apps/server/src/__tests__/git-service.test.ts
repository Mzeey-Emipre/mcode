import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../repositories/workspace-repo";

const { mockExecFile, mockRm, mockRename, mockRmdir, mockExistsSync, mockLogger } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockRm: vi.fn(),
  mockRename: vi.fn(),
  mockRmdir: vi.fn(),
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
  rename: mockRename,
  rmdir: mockRmdir,
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
    vi.resetAllMocks();
    gitService = new GitService({} as WorkspaceRepo);
  });

  it("removes worktree and branch when git succeeds", async () => {
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    const result = await gitService.removeWorktree(
      "/repo",
      "my-worktree",
      { branchName: "feat/test" },
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
      expect.objectContaining({ maxRetries: 5, retryDelay: 200 }),
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
      { branchName: "feat/test" },
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
      expect.objectContaining({ maxRetries: 5, retryDelay: 200 }),
    );
  });

  it("uses double --force for git worktree remove", async () => {
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    await gitService.removeWorktree("/repo", "my-worktree", { branchName: "feat/test" });

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "worktree", "remove", expect.stringContaining("my-worktree"), "--force", "--force"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("skips branch deletion when deleteBranch is false", async () => {
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    const result = await gitService.removeWorktree("/repo", "my-worktree", {
      deleteBranch: false,
    });

    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["branch", "-d"]),
      expect.anything(),
    );
  });

  it("renames directory then deletes when fs.rm fails on first path", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("git failed")); // worktree remove
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" }); // prune
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" }); // branch -d
    // fs.rm fails on original path
    mockRm.mockRejectedValueOnce(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
    mockRename.mockResolvedValue(undefined);
    // existsSync: true (before rm attempt), true (after rm failure, before rename), false (final verification)
    mockExistsSync
      .mockReturnValueOnce(true)  // check before fallback rm
      .mockReturnValueOnce(true)  // check after rm failure -> try rename
      .mockReturnValueOnce(false); // final verification

    const result = await gitService.removeWorktree("/repo", "my-worktree");

    expect(mockRename).toHaveBeenCalledWith(
      expect.stringContaining("my-worktree"),
      expect.stringMatching(/my-worktree\.deleting-\d+$/),
    );
    expect(result).toBe(true);
  });

  it("returns false when both fs.rm and rename-then-delete fail", async () => {
    mockExecFile.mockRejectedValue(new Error("git failed"));
    mockRm.mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
    mockRename.mockRejectedValue(new Error("rename failed"));
    mockExistsSync.mockReturnValue(true);

    const result = await gitService.removeWorktree("/repo", "my-worktree");

    expect(result).toBe(false);
  });

  it("prunes stale metadata after manual fallback before deleting the branch", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("git failed")) // worktree remove
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // prune
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // branch -d
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockRm.mockResolvedValue(undefined);

    await gitService.removeWorktree("/repo", "my-worktree", {
      branchName: "mcode/my-worktree",
    });

    const pruneIndex = 1;
    const branchIndex = 2;
    expect(mockExecFile.mock.calls[pruneIndex]?.[1]).toEqual(["-C", "/repo", "worktree", "prune"]);
    expect(mockExecFile.mock.calls[branchIndex]?.[1]).toEqual([
      "-C",
      "/repo",
      "branch",
      "-d",
      "mcode/my-worktree",
    ]);
    expect(mockRm.mock.invocationCallOrder[0]).toBeLessThan(
      mockExecFile.mock.invocationCallOrder[pruneIndex],
    );
    expect(mockExecFile.mock.invocationCallOrder[pruneIndex]).toBeLessThan(
      mockExecFile.mock.invocationCallOrder[branchIndex],
    );
  });

  it("removes an empty managed parent directory after worktree cleanup", async () => {
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);
    mockRmdir.mockResolvedValue(undefined);

    await gitService.removeWorktree("/repo", "my-worktree");

    expect(mockRmdir).toHaveBeenCalledWith(expect.stringContaining("worktrees"));
    expect(mockRmdir).toHaveBeenCalledWith(expect.stringContaining("repo"));
  });

  it("does not remove parent directories for external worktrees", async () => {
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    await gitService.removeWorktree("/repo", "my-worktree", {
      worktreePath: "/external/worktrees/my-worktree",
      deleteBranch: false,
    });

    expect(mockRmdir).not.toHaveBeenCalled();
  });
});
