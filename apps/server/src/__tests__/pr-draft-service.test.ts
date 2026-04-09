import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockComplete, mockExistsSync, mockReadFileSync, mockStatSync } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockReadFileSync: vi.fn(),
  mockStatSync: vi.fn().mockReturnValue({ size: 1024 }),
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  statSync: mockStatSync,
  mkdirSync: vi.fn(),
}));

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { PrDraftService } from "../services/pr-draft-service";

describe("PrDraftService", () => {
  let service: PrDraftService;
  const mockGitService = {
    log: vi.fn(),
    diffStat: vi.fn(),
    getCurrentBranch: vi.fn(),
    getCurrentBranchAt: vi.fn(),
    resolveWorkingDir: vi.fn(),
  };
  const mockMessageRepo = {
    listByThread: vi.fn(),
  };
  const mockWorkspaceRepo = {
    findById: vi.fn(),
  };
  const mockThreadRepo = {
    findById: vi.fn(),
  };
  const mockSettingsService = {
    get: vi.fn().mockResolvedValue({
      model: { defaults: { provider: "claude" } },
      prDraft: { model: "" },
    }),
  };
  const mockProviderRegistry = {
    resolve: vi.fn().mockReturnValue({ complete: mockComplete, supportsCompletion: true }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsService.get.mockResolvedValue({
      model: { defaults: { provider: "claude" } },
      prDraft: { model: "" },
    });
    mockProviderRegistry.resolve.mockReturnValue({ complete: mockComplete, supportsCompletion: true });
    // Default: direct thread in workspace ws-1
    mockThreadRepo.findById.mockReturnValue({
      id: "thread-1",
      workspace_id: "ws-1",
      mode: "direct",
      worktree_path: null,
    });
    mockGitService.resolveWorkingDir.mockReturnValue("/repo");
    mockGitService.getCurrentBranchAt.mockReturnValue("feat/add-widget");
    service = new PrDraftService(
      mockGitService as any,
      mockMessageRepo as any,
      mockWorkspaceRepo as any,
      mockThreadRepo as any,
      mockSettingsService as any,
      mockProviderRegistry as any,
    );
  });

  it("generates draft from commit history and conversation", async () => {
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.log.mockResolvedValue([
      { message: "feat: add widget", sha: "abc123" },
    ]);
    mockGitService.diffStat.mockResolvedValue("2 files changed, 50 insertions(+)");
    mockMessageRepo.listByThread.mockReturnValue({
      messages: [
        { role: "user", content: "Add a widget to the dashboard" },
        { role: "assistant", content: "I will create a widget component." },
      ],
      hasMore: false,
    });
    mockComplete.mockResolvedValue(JSON.stringify({
      title: "feat: add dashboard widget",
      body: "## What\nAdded a widget\n\n## Why\nUser requested dashboard widget\n\n## Key Changes\n- Added widget component",
    }));

    const result = await service.generateDraft("ws-1", "thread-1", "main");

    expect(result.title).toBe("feat: add dashboard widget");
    expect(result.body).toContain("## What");
    expect(mockComplete).toHaveBeenCalledWith(
      expect.stringContaining("Generate a pull request title"),
      expect.stringContaining("claude-haiku"),
      "/repo",
    );
  });

  it("falls back to commit-only when AI fails", async () => {
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.log.mockResolvedValue([
      { message: "feat: add widget", sha: "abc123" },
      { message: "fix: widget sizing", sha: "def456" },
    ]);
    mockGitService.diffStat.mockResolvedValue("3 files changed");
    mockMessageRepo.listByThread.mockReturnValue({
      messages: [],
      hasMore: false,
    });
    mockComplete.mockRejectedValue(new Error("API key invalid"));

    const result = await service.generateDraft("ws-1", "thread-1", "main");

    expect(result.title).toBe("feat: add widget");
    expect(result.body).toContain("feat: add widget");
    expect(result.body).toContain("fix: widget sizing");
  });

  it("retries log without range when baseBranch does not exist in repo", async () => {
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.getCurrentBranchAt.mockReturnValue("master");
    mockGitService.log
      .mockRejectedValueOnce(
        new Error(
          "Command failed: git log main..master fatal: ambiguous argument 'main..master': unknown revision",
        ),
      )
      .mockResolvedValueOnce([{ message: "feat: add widget", sha: "abc123" }]);
    mockGitService.diffStat.mockResolvedValue("2 files changed");
    mockMessageRepo.listByThread.mockReturnValue({ messages: [], hasMore: false });
    mockComplete.mockResolvedValue(JSON.stringify({
      title: "feat: add widget",
      body: "## What\nAdded widget",
    }));

    const result = await service.generateDraft("ws-1", "thread-1", "main");

    expect(result.title).toBe("feat: add widget");
    expect(mockGitService.log).toHaveBeenCalledTimes(2);
    expect(mockGitService.log).toHaveBeenNthCalledWith(1, "ws-1", "master", 50, "main", "/repo");
    expect(mockGitService.log).toHaveBeenNthCalledWith(2, "ws-1", "master", 50, undefined, "/repo");
  });

  it("uses repo PR template when available", async () => {
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.log.mockResolvedValue([
      { message: "feat: thing", sha: "aaa" },
    ]);
    mockGitService.diffStat.mockResolvedValue("1 file changed");
    mockMessageRepo.listByThread.mockReturnValue({
      messages: [],
      hasMore: false,
    });
    mockExistsSync.mockImplementation((p: string) =>
      String(p).includes("PULL_REQUEST_TEMPLATE"),
    );
    mockReadFileSync.mockReturnValue(
      "## Summary\n\n## Testing\n\n## Screenshots\n",
    );
    mockComplete.mockResolvedValue(JSON.stringify({
      title: "feat: thing",
      body: "## Summary\nDid thing\n\n## Testing\nUnit tests\n\n## Screenshots\nN/A",
    }));

    const result = await service.generateDraft("ws-1", "thread-1", "main");

    const promptArg = mockComplete.mock.calls[0][0];
    expect(promptArg).toContain("## Summary");
  });

  it("uses worktree path for git operations when thread is in worktree mode", async () => {
    const worktreePath = "/worktrees/feat-my-feature";
    mockThreadRepo.findById.mockReturnValue({
      id: "thread-wt",
      workspace_id: "ws-1",
      mode: "worktree",
      worktree_path: worktreePath,
    });
    mockGitService.resolveWorkingDir.mockReturnValue(worktreePath);
    mockGitService.getCurrentBranchAt.mockReturnValue("feat/my-feature");
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.log.mockResolvedValue([{ message: "feat: my feature", sha: "aaa" }]);
    mockGitService.diffStat.mockResolvedValue("1 file changed");
    mockMessageRepo.listByThread.mockReturnValue({ messages: [], hasMore: false });
    mockComplete.mockResolvedValue(JSON.stringify({ title: "feat: my feature", body: "body" }));

    await service.generateDraft("ws-1", "thread-wt", "main");

    // resolveWorkingDir must be called with the worktree arguments
    expect(mockGitService.resolveWorkingDir).toHaveBeenCalledWith("/repo", "worktree", worktreePath);
    // Branch detection and diff must use the worktree path, not the workspace root
    expect(mockGitService.getCurrentBranchAt).toHaveBeenCalledWith(worktreePath);
    expect(mockGitService.diffStat).toHaveBeenCalledWith(worktreePath, "main", "feat/my-feature");
    // complete() must also receive the worktree path as cwd
    expect(mockComplete).toHaveBeenCalledWith(expect.any(String), expect.any(String), worktreePath);
  });

  it("uses workspace root for git operations when thread is in direct mode", async () => {
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.log.mockResolvedValue([{ message: "fix: thing", sha: "bbb" }]);
    mockGitService.diffStat.mockResolvedValue("1 file changed");
    mockMessageRepo.listByThread.mockReturnValue({ messages: [], hasMore: false });
    mockComplete.mockResolvedValue(JSON.stringify({ title: "fix: thing", body: "body" }));

    await service.generateDraft("ws-1", "thread-1", "main");

    expect(mockGitService.resolveWorkingDir).toHaveBeenCalledWith("/repo", "direct", null);
    expect(mockGitService.getCurrentBranchAt).toHaveBeenCalledWith("/repo");
    expect(mockGitService.diffStat).toHaveBeenCalledWith("/repo", "main", "feat/add-widget");
  });

  it("throws when thread is not found", async () => {
    mockThreadRepo.findById.mockReturnValue(null);

    await expect(service.generateDraft("ws-1", "missing-thread", "main")).rejects.toThrow(
      "Thread missing-thread not found",
    );
  });

  it("throws when repository is in detached HEAD state", async () => {
    mockGitService.getCurrentBranchAt.mockReturnValue("HEAD");
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });

    await expect(service.generateDraft("ws-1", "thread-1", "main")).rejects.toThrow(
      /detached HEAD/i,
    );
  });

  it("throws when thread does not belong to the requested workspace", async () => {
    mockThreadRepo.findById.mockReturnValue({
      id: "thread-1",
      workspace_id: "ws-other",
      mode: "direct",
      worktree_path: null,
    });

    await expect(service.generateDraft("ws-1", "thread-1", "main")).rejects.toThrow(
      "Thread thread-1 does not belong to workspace ws-1",
    );
  });

  it("throws when configured provider does not support completion", async () => {
    mockSettingsService.get.mockResolvedValue({
      model: { defaults: { provider: "codex" } },
      prDraft: { provider: "codex", model: "" },
    });
    mockProviderRegistry.resolve.mockReturnValue({ supportsCompletion: false });
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.log.mockResolvedValue([{ message: "feat: x", sha: "aaa" }]);
    mockGitService.diffStat.mockResolvedValue("1 file changed");
    mockMessageRepo.listByThread.mockReturnValue({ messages: [], hasMore: false });

    await expect(service.generateDraft("ws-1", "thread-1", "main")).rejects.toThrow(
      /does not support.*completion/i,
    );
  });

  describe("parseCompletionDraft (via generateWithAI)", () => {
    beforeEach(() => {
      mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
      mockGitService.log.mockResolvedValue([{ message: "feat: x", sha: "aaa" }]);
      mockGitService.diffStat.mockResolvedValue("1 file changed");
      mockMessageRepo.listByThread.mockReturnValue({ messages: [], hasMore: false });
    });

    it("throws when AI response contains no JSON object", async () => {
      mockComplete.mockResolvedValue("Here is your PR draft: title is great");

      await expect(service.generateDraft("ws-1", "thread-1", "main")).rejects.toThrow(
        "AI response contained no valid JSON",
      );
    });

    it("throws when AI JSON is missing the title field", async () => {
      mockComplete.mockResolvedValue(JSON.stringify({ body: "some body" }));

      await expect(service.generateDraft("ws-1", "thread-1", "main")).rejects.toThrow(
        /title/,
      );
    });

    it("throws when AI JSON is missing the body field", async () => {
      mockComplete.mockResolvedValue(JSON.stringify({ title: "feat: x" }));

      await expect(service.generateDraft("ws-1", "thread-1", "main")).rejects.toThrow(
        /body/,
      );
    });
  });
});
