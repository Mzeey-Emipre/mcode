import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../../persistence/workspace-repo.js";

const { mockRemove, mockRmdir, mockExistsSync, mockLogger } = vi.hoisted(() => ({
  mockRemove: vi.fn(),
  mockRmdir: vi.fn(),
  mockExistsSync: vi.fn(),
  mockLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  rmdir: mockRmdir,
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  validateBranchName: vi.fn(),
  validateWorktreeName: vi.fn(),
  logger: mockLogger,
}));

import { GitService } from "../git-service.js";
import type { WorktreeDirectoryRemover } from "../../worktrees/worktree-directory-remover.js";
import { createMockGitExecutor } from "../execution/__tests__/mock-git-executor.js";

describe("GitService.reviewComparison", () => {
  it("returns one batched status result for changed, renamed, copied, and binary files", async () => {
    const mock = createMockGitExecutor();
    mock.execFn.mockImplementation(async (args) => {
      if (args.includes("--name-status")) {
        return {
          stdout: "A\0src/added.ts\0M\0assets/logo.png\0D\0src/gone.ts\0R100\0src/old.ts\0src/new.ts\0C100\0src/base.ts\0src/copy.ts\0",
          stderr: "",
        };
      }
      return {
        stdout: "2\t0\tsrc/added.ts\0-\t-\tassets/logo.png\x000\t3\tsrc/gone.ts\x000\t0\t\0src/old.ts\0src/new.ts\x000\t0\t\0src/base.ts\0src/copy.ts\0",
        stderr: "",
      };
    });
    const service = new GitService({} as WorkspaceRepo, mock.executor);

    const result = await service.reviewComparison("ws-1", "unstaged", {}, "/repo");

    expect(result).toEqual({
      files: [
        { path: "assets/logo.png", previousPath: null, changeType: "modified", binary: true },
        { path: "src/added.ts", previousPath: null, changeType: "added", binary: false },
        { path: "src/copy.ts", previousPath: "src/base.ts", changeType: "copied", binary: false },
        { path: "src/gone.ts", previousPath: null, changeType: "deleted", binary: false },
        { path: "src/new.ts", previousPath: "src/old.ts", changeType: "renamed", binary: false },
      ],
      additions: 2,
      deletions: 3,
    });
    expect(mock.execFn).toHaveBeenCalledTimes(2);
  });

  it("keeps tab-containing numstat paths attached to their binary metadata", async () => {
    const mock = createMockGitExecutor();
    mock.execFn.mockImplementation(async (args) => args.includes("--name-status")
      ? { stdout: "M\0src/name\twith-tab.bin\0", stderr: "" }
      : { stdout: "-\t-\tsrc/name\twith-tab.bin\0", stderr: "" });
    const service = new GitService({} as WorkspaceRepo, mock.executor);

    await expect(service.reviewComparison("ws-1", "unstaged", {}, "/repo")).resolves.toMatchObject({
      files: [{ path: "src/name\twith-tab.bin", binary: true }],
    });
  });

  it("rejects comparison results above the production file bound", async () => {
    const mock = createMockGitExecutor();
    const names = Array.from({ length: 10_001 }, (_, index) => `M\0file-${index}.ts\0`).join("");
    mock.execFn.mockImplementation(async (args) => args.includes("--name-status")
      ? { stdout: names, stderr: "" }
      : { stdout: "", stderr: "" });
    const service = new GitService({} as WorkspaceRepo, mock.executor);

    await expect(service.reviewComparison("ws-1", "unstaged", {}, "/repo")).rejects.toThrow(
      "Review comparison is limited to 10000 files",
    );
  });

  it("propagates mutable comparison failures", async () => {
    const mock = createMockGitExecutor();
    mock.execFn.mockRejectedValue(new Error("git unavailable"));
    const service = new GitService({} as WorkspaceRepo, mock.executor);

    await expect(service.reviewComparison("ws-1", "unstaged", {}, "/repo")).rejects.toThrow(
      "git unavailable",
    );
  });

  it("retries a root commit against the empty tree", async () => {
    const mock = createMockGitExecutor();
    mock.execFn.mockImplementation(async (args) => {
      if (!args.includes("4b825dc642cb6eb9a060e54bf899d69f82049264")) {
        throw new Error("unknown revision sha~1");
      }
      return args.includes("--name-status")
        ? { stdout: "A\0root.ts\0", stderr: "" }
        : { stdout: "3\t0\troot.ts\0", stderr: "" };
    });
    const service = new GitService({} as WorkspaceRepo, mock.executor);

    await expect(service.reviewComparison("ws-1", "commit", { sha: "abc1234" }, "/repo")).resolves.toMatchObject({
      files: [{ path: "root.ts", changeType: "added" }],
      additions: 3,
      deletions: 0,
    });
  });

  it("propagates a root commit fallback failure", async () => {
    const mock = createMockGitExecutor();
    mock.execFn.mockRejectedValue(new Error("git unavailable"));
    const service = new GitService({} as WorkspaceRepo, mock.executor);

    await expect(service.reviewComparison("ws-1", "commit", { sha: "abc1234" }, "/repo")).rejects.toThrow(
      "git unavailable",
    );
    expect(mock.execFn).toHaveBeenCalledTimes(4);
  });
});

describe("GitService.removeWorktree", () => {
  let gitService: GitService;
  let execFn: ReturnType<typeof createMockGitExecutor>["execFn"];

  beforeEach(() => {
    vi.resetAllMocks();
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    gitService = new GitService(
      {} as WorkspaceRepo,
      mock.executor,
      { remove: mockRemove } as unknown as WorktreeDirectoryRemover,
    );
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
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("falls back to bounded child removal when git remove fails", async () => {
    execFn
      .mockRejectedValueOnce(new Error("git worktree remove failed"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // prune
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // branch -d
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockRemove.mockResolvedValue(undefined);

    const result = await gitService.removeWorktree("/repo", "my-worktree");

    expect(mockRemove).toHaveBeenCalledWith(expect.stringContaining("my-worktree"));
    expect(result).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("returns false when directory cannot be removed", async () => {
    execFn.mockRejectedValue(new Error("git failed"));
    mockExistsSync.mockReturnValue(true);
    mockRemove.mockRejectedValue(new Error("permission denied"));

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

  it("uses bounded child removal for the fallback", async () => {
    execFn.mockRejectedValueOnce(new Error("git failed")); // worktree remove
    execFn.mockResolvedValueOnce({ stdout: "", stderr: "" }); // prune
    execFn.mockResolvedValueOnce({ stdout: "", stderr: "" }); // branch -d
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockRemove.mockResolvedValue(undefined);

    await gitService.removeWorktree("/repo", "my-worktree");

    expect(mockRemove).toHaveBeenCalledWith(expect.stringContaining("my-worktree"));
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

  it("treats an already-absent managed worktree as successful cleanup", async () => {
    execFn
      .mockRejectedValueOnce(new Error("not a working tree"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExistsSync.mockReturnValue(false);
    mockRmdir.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    await expect(
      gitService.removeWorktree("/repo", "my-worktree", { deleteBranch: false }),
    ).resolves.toBe(true);

    expect(mockRemove).not.toHaveBeenCalled();
    expect(execFn).toHaveBeenCalledWith(
      ["-C", "/repo", "worktree", "prune"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("leaves a worktree in place for retry when another application locks it", async () => {
    execFn.mockRejectedValueOnce(new Error("git failed")); // worktree remove
    mockRemove.mockRejectedValueOnce(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
    mockExistsSync.mockReturnValue(true);

    const result = await gitService.removeWorktree("/repo", "my-worktree");

    expect(result).toBe(false);
    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it("prunes stale metadata after manual fallback before deleting the branch", async () => {
    execFn
      .mockRejectedValueOnce(new Error("git failed")) // worktree remove
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // prune
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // branch -d
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockRemove.mockResolvedValue(undefined);

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
    expect(mockRemove.mock.invocationCallOrder[0]).toBeLessThan(
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
    expect(mockRemove).not.toHaveBeenCalled();
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

describe("GitService.listWorktrees", () => {
  it("includes detached worktrees instead of dropping entries without a branch line", async () => {
    const mock = createMockGitExecutor();
    const workspaceRepo = {
      findById: vi.fn().mockReturnValue({ path: "/repo" }),
    } as unknown as WorkspaceRepo;
    const gitService = new GitService(workspaceRepo, mock.executor);
    mock.execFn.mockResolvedValue({
      stdout: [
        "worktree /repo",
        "HEAD 1111111",
        "branch refs/heads/main",
        "",
        "worktree /mock/mcode/worktrees/repo/branchless-existing",
        "HEAD 2222222",
        "detached",
        "",
      ].join("\n"),
      stderr: "",
    });

    await expect(gitService.listWorktrees("ws-1")).resolves.toContainEqual({
      name: "branchless-existing",
      path: "/mock/mcode/worktrees/repo/branchless-existing",
      branch: "(detached)",
      managed: true,
    });
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
