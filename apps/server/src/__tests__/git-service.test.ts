import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../repositories/workspace-repo";

const { mockRm, mockRename, mockRmdir, mockExistsSync, mockLogger } = vi.hoisted(() => ({
  mockRm: vi.fn(),
  mockRename: vi.fn(),
  mockRmdir: vi.fn(),
  mockExistsSync: vi.fn(),
  mockLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
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
import { createMockGitExecutor } from "../services/git-executor/__tests__/mock-git-executor.js";

describe("GitService.removeWorktree", () => {
  let gitService: GitService;
  let execFn: ReturnType<typeof createMockGitExecutor>["execFn"];

  beforeEach(() => {
    vi.resetAllMocks();
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    gitService = new GitService({} as WorkspaceRepo, mock.executor);
  });

  it("removes worktree and branch when git succeeds", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    const result = await gitService.removeWorktree(
      "/repo",
      "my-worktree",
      { branchName: "feat/test" },
    );

    expect(result).toBe(true);
    expect(execFn).toHaveBeenCalledWith(
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
    expect(execFn).toHaveBeenCalledWith(
      ["-C", "/repo", "branch", "-d", "feat/test"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(mockRm).not.toHaveBeenCalled();
  });

  it("falls back to fs.rm when git remove fails", async () => {
    execFn
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
    execFn.mockRejectedValue(new Error("git failed"));
    mockExistsSync.mockReturnValue(true);
    mockRm.mockRejectedValue(new Error("permission denied"));

    const result = await gitService.removeWorktree("/repo", "my-worktree");

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("succeeds even when branch deletion fails", async () => {
    execFn
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
    execFn.mockRejectedValueOnce(new Error("git failed")); // worktree remove
    execFn.mockResolvedValueOnce({ stdout: "", stderr: "" }); // prune
    execFn.mockResolvedValueOnce({ stdout: "", stderr: "" }); // branch -d
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockRm.mockResolvedValue(undefined);

    await gitService.removeWorktree("/repo", "my-worktree");

    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining("my-worktree"),
      expect.objectContaining({ maxRetries: 5, retryDelay: 200 }),
    );
  });

  it("uses double --force for git worktree remove", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    await gitService.removeWorktree("/repo", "my-worktree", { branchName: "feat/test" });

    expect(execFn).toHaveBeenCalledWith(
      ["-C", "/repo", "worktree", "remove", expect.stringContaining("my-worktree"), "--force", "--force"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("skips branch deletion when deleteBranch is false", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    const result = await gitService.removeWorktree("/repo", "my-worktree", {
      deleteBranch: false,
    });

    expect(result).toBe(true);
    expect(execFn).toHaveBeenCalledTimes(2);
    expect(execFn).not.toHaveBeenCalledWith(
      expect.arrayContaining(["branch", "-d"]),
      expect.anything(),
    );
  });

  it("renames directory then deletes when fs.rm fails on first path", async () => {
    execFn.mockRejectedValueOnce(new Error("git failed")); // worktree remove
    execFn.mockResolvedValueOnce({ stdout: "", stderr: "" }); // prune
    execFn.mockResolvedValueOnce({ stdout: "", stderr: "" }); // branch -d
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
    execFn.mockRejectedValue(new Error("git failed"));
    mockRm.mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
    mockRename.mockRejectedValue(new Error("rename failed"));
    mockExistsSync.mockReturnValue(true);

    const result = await gitService.removeWorktree("/repo", "my-worktree");

    expect(result).toBe(false);
  });

  it("prunes stale metadata after manual fallback before deleting the branch", async () => {
    execFn
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
    expect(execFn.mock.calls[pruneIndex]?.[0]).toEqual(["-C", "/repo", "worktree", "prune"]);
    expect(execFn.mock.calls[branchIndex]?.[0]).toEqual([
      "-C",
      "/repo",
      "branch",
      "-d",
      "mcode/my-worktree",
    ]);
    expect(mockRm.mock.invocationCallOrder[0]).toBeLessThan(
      execFn.mock.invocationCallOrder[pruneIndex],
    );
    expect(execFn.mock.invocationCallOrder[pruneIndex]).toBeLessThan(
      execFn.mock.invocationCallOrder[branchIndex],
    );
  });

  it("removes an empty managed parent directory after worktree cleanup", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);
    mockRmdir.mockResolvedValue(undefined);

    await gitService.removeWorktree("/repo", "my-worktree");

    expect(mockRmdir).toHaveBeenCalledWith(expect.stringContaining("worktrees"));
    expect(mockRmdir).toHaveBeenCalledWith(expect.stringContaining("repo"));
  });

  it("does not remove parent directories for external worktrees", async () => {
    execFn.mockImplementation(async (args: string[]) => {
      if (args.includes("list") && args.includes("--porcelain")) {
        return {
          stdout: "worktree /external/worktrees/my-worktree\nbranch refs/heads/main\n\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    mockExistsSync.mockReturnValue(false);

    await gitService.removeWorktree("/repo", "my-worktree", {
      worktreePath: "/external/worktrees/my-worktree",
      deleteBranch: false,
    });

    expect(mockRmdir).not.toHaveBeenCalled();
  });

  it("rejects unregistered external worktree paths before filesystem cleanup", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    await expect(
      gitService.removeWorktree("/repo", "my-worktree", {
        worktreePath: "/external/worktrees/my-worktree",
        deleteBranch: false,
      }),
    ).rejects.toThrow("worktreePath is not a managed or registered worktree");
    expect(mockRm).not.toHaveBeenCalled();
  });

  it("retries EBUSY on parent dir rmdir and succeeds on later attempt", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    const ebusyErr = Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    mockRmdir
      .mockRejectedValueOnce(ebusyErr)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(undefined);

    const result = await gitService.removeWorktree("/repo", "my-worktree", { deleteBranch: false });

    expect(result).toBe(true);
    expect(mockRmdir.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Removed empty managed worktree parent dir",
      expect.objectContaining({ path: expect.any(String) }),
    );
  });

  it("gives up parent dir cleanup after exhausting EBUSY retries", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    const ebusyErr = Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    mockRmdir.mockRejectedValue(ebusyErr);

    const result = await gitService.removeWorktree("/repo", "my-worktree", { deleteBranch: false });

    // Parent cleanup failed with transient lock; returns false so cleanup worker retries
    expect(result).toBe(false);
    expect(mockRmdir).toHaveBeenCalledTimes(5);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to remove empty managed worktree parent dir",
      expect.objectContaining({ error: expect.stringContaining("EBUSY") }),
    );
  });

  it("retries EPERM on parent dir rmdir the same as EBUSY", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);

    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    mockRmdir
      .mockRejectedValueOnce(epermErr)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(undefined);

    const result = await gitService.removeWorktree("/repo", "my-worktree", { deleteBranch: false });

    expect(result).toBe(true);
    expect(mockRmdir.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("GitService.log", () => {
  let gitService: GitService;
  let execFn: ReturnType<typeof createMockGitExecutor>["execFn"];

  beforeEach(() => {
    vi.resetAllMocks();
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    gitService = new GitService(
      {
        findById: vi.fn().mockReturnValue({ id: "ws-1", path: "/repo", is_git_repo: true }),
      } as unknown as WorkspaceRepo,
      mock.executor,
    );
  });

  it("compares against origin HEAD instead of requiring a local default branch", async () => {
    execFn
      .mockResolvedValueOnce({ stdout: "origin/main\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: [
          "MCODE_SEPabc123456789|||abc1234|||feat: add picker|||Dev|||2026-06-11T12:00:00.000Z",
          "1\t0\tapps/web/src/components/diff/CommitPicker.tsx",
        ].join("\n"),
        stderr: "",
      });

    const commits = await gitService.log("ws-1", "feat/-commit-picker", 100);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.shortSha).toBe("abc1234");
    expect(execFn).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(["origin/main..feat/-commit-picker"]),
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("supports paged lightweight logs without numstat", async () => {
    execFn
      .mockResolvedValueOnce({ stdout: "origin/main\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "MCODE_SEPdef123456789|||def1234|||fix: older commit|||Dev|||2026-06-10T12:00:00.000Z",
        stderr: "",
      });

    const commits = await gitService.log(
      "ws-1",
      "feat/-commit-picker",
      100,
      undefined,
      undefined,
      100,
      false,
    );

    expect(commits).toHaveLength(1);
    expect(commits[0]?.filesChanged).toBe(0);
    const args = execFn.mock.calls[1]?.[0] as string[];
    expect(args).toContain("--skip=100");
    expect(args).not.toContain("--numstat");
  });
});
