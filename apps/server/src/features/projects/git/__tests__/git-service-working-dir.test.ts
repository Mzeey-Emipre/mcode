import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { FakeGitExecutor } from "../execution/fake-git-executor.js";
import { GitWorktreeService } from "../git-worktree-service.js";

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

/**
 * resolveWorkingDir decides the cwd a threadless or thread-scoped terminal
 * spawns in. It needs no repo access, so a bare GitService is enough to
 * exercise the worktree-vs-root branch the terminal rebind relies on.
 */
function makeGitService(): GitWorktreeService {
  return new GitWorktreeService(undefined as never, new FakeGitExecutor(), TEST_HOST_RUNTIME);
}

describe("GitWorktreeService.resolveWorkingDir", () => {
  const WORKSPACE_ROOT = "/repo/main";
  const WORKTREE = "/repo/worktrees/feature";

  it("uses the workspace root for the threadless shell (no thread mode)", () => {
    const git = makeGitService();
    expect(git.resolveWorkingDir(WORKSPACE_ROOT, null, null)).toBe(WORKSPACE_ROOT);
  });

  it("uses the workspace root for a direct-mode thread", () => {
    const git = makeGitService();
    expect(git.resolveWorkingDir(WORKSPACE_ROOT, "direct", null)).toBe(
      WORKSPACE_ROOT,
    );
  });

  it("uses the thread worktree for a worktree-mode thread", () => {
    const git = makeGitService();
    expect(git.resolveWorkingDir(WORKSPACE_ROOT, "worktree", WORKTREE)).toBe(
      WORKTREE,
    );
  });

  it("rebinds from workspace root to worktree as a thread becomes active", () => {
    const git = makeGitService();
    // Threadless: no thread mode -> workspace root.
    expect(git.resolveWorkingDir(WORKSPACE_ROOT, null, null)).toBe(WORKSPACE_ROOT);
    // A worktree thread becomes active -> its worktree. This is the
    // threadless -> worktree rebind the Terminal tab relies on.
    expect(git.resolveWorkingDir(WORKSPACE_ROOT, "worktree", WORKTREE)).toBe(
      WORKTREE,
    );
  });

  it("falls back to the workspace root when a worktree thread has no path yet", () => {
    const git = makeGitService();
    expect(git.resolveWorkingDir(WORKSPACE_ROOT, "worktree", null)).toBe(
      WORKSPACE_ROOT,
    );
  });
});
