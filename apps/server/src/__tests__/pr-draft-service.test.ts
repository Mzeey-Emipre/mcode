import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockCreate, mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockReadFileSync: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
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
  };
  const mockMessageRepo = {
    listByThread: vi.fn(),
  };
  const mockWorkspaceRepo = {
    findById: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PrDraftService(
      mockGitService as any,
      mockMessageRepo as any,
      mockWorkspaceRepo as any,
    );
  });

  it("generates draft from commit history and conversation", async () => {
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.log.mockResolvedValue([
      { message: "feat: add widget", sha: "abc123" },
    ]);
    mockGitService.diffStat.mockResolvedValue("2 files changed, 50 insertions(+)");
    mockGitService.getCurrentBranch.mockReturnValue("feat/add-widget");
    mockMessageRepo.listByThread.mockReturnValue({
      messages: [
        { role: "user", content: "Add a widget to the dashboard" },
        { role: "assistant", content: "I will create a widget component." },
      ],
      hasMore: false,
    });
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({
        title: "feat: add dashboard widget",
        body: "## What\nAdded a widget\n\n## Why\nUser requested dashboard widget\n\n## Key Changes\n- Added widget component",
      })}],
    });

    const result = await service.generateDraft("ws-1", "thread-1", "main");

    expect(result.title).toBe("feat: add dashboard widget");
    expect(result.body).toContain("## What");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.stringContaining("claude"),
        messages: expect.any(Array),
        system: expect.any(String),
      }),
    );
  });

  it("falls back to commit-only when AI fails", async () => {
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.log.mockResolvedValue([
      { message: "feat: add widget", sha: "abc123" },
      { message: "fix: widget sizing", sha: "def456" },
    ]);
    mockGitService.diffStat.mockResolvedValue("3 files changed");
    mockGitService.getCurrentBranch.mockReturnValue("feat/add-widget");
    mockMessageRepo.listByThread.mockReturnValue({
      messages: [],
      hasMore: false,
    });
    mockCreate.mockRejectedValue(new Error("API key invalid"));

    const result = await service.generateDraft("ws-1", "thread-1", "main");

    expect(result.title).toBe("feat: add widget");
    expect(result.body).toContain("feat: add widget");
    expect(result.body).toContain("fix: widget sizing");
    // Uses `message` field from GitCommit schema, not `subject`
  });

  it("retries log without range when baseBranch does not exist in repo", async () => {
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    // First log call (with range "main..master") fails; second (no range) succeeds
    mockGitService.log
      .mockRejectedValueOnce(
        new Error(
          "Command failed: git log main..master fatal: ambiguous argument 'main..master': unknown revision",
        ),
      )
      .mockResolvedValueOnce([{ message: "feat: add widget", sha: "abc123" }]);
    mockGitService.diffStat.mockResolvedValue("2 files changed");
    mockGitService.getCurrentBranch.mockReturnValue("master");
    mockMessageRepo.listByThread.mockReturnValue({ messages: [], hasMore: false });
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "feat: add widget",
            body: "## What\nAdded widget",
          }),
        },
      ],
    });

    const result = await service.generateDraft("ws-1", "thread-1", "main");

    // Should succeed despite invalid baseBranch
    expect(result.title).toBe("feat: add widget");
    // log called twice: once with range (failed), once without
    expect(mockGitService.log).toHaveBeenCalledTimes(2);
    expect(mockGitService.log).toHaveBeenNthCalledWith(1, "ws-1", "master", 50, "main");
    expect(mockGitService.log).toHaveBeenNthCalledWith(2, "ws-1", "master", 50);
  });

  it("uses repo PR template when available", async () => {
    mockWorkspaceRepo.findById.mockReturnValue({ path: "/repo" });
    mockGitService.log.mockResolvedValue([
      { message: "feat: thing", sha: "aaa" },
    ]);
    mockGitService.diffStat.mockResolvedValue("1 file changed");
    mockGitService.getCurrentBranch.mockReturnValue("feat/thing");
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
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({
        title: "feat: thing",
        body: "## Summary\nDid thing\n\n## Testing\nUnit tests\n\n## Screenshots\nN/A",
      })}],
    });

    const result = await service.generateDraft("ws-1", "thread-1", "main");

    // Verify the AI system prompt included the repo template structure
    const aiCall = mockCreate.mock.calls[0][0];
    expect(aiCall.system).toContain("## Summary");
  });
});
