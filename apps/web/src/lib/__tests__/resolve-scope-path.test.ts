import { describe, it, expect } from "vitest";
import { resolveScopeBasePath } from "../resolve-scope-path";

const WORKSPACE = { id: "ws-1", path: "/repo/main" };
const OTHER_WORKSPACE = { id: "ws-2", path: "/repo/other" };

const WORKTREE_THREAD = {
  id: "thread-wt",
  mode: "worktree" as const,
  worktree_path: "/repo/worktrees/feature",
};
const DIRECT_THREAD = {
  id: "thread-direct",
  mode: "direct" as const,
  worktree_path: null,
};
// A worktree-mode thread whose path has not been populated yet (creation in
// flight). It must not resolve to a bogus base path.
const PENDING_WORKTREE_THREAD = {
  id: "thread-wt-pending",
  mode: "worktree" as const,
  worktree_path: null,
};

describe("resolveScopeBasePath", () => {
  it("returns the workspace root when the scope is the workspace (threadless)", () => {
    expect(
      resolveScopeBasePath("ws-1", "ws-1", [], [WORKSPACE]),
    ).toBe("/repo/main");
  });

  it("returns the workspace root for a direct-mode thread", () => {
    expect(
      resolveScopeBasePath(
        "thread-direct",
        "ws-1",
        [DIRECT_THREAD],
        [WORKSPACE],
      ),
    ).toBe("/repo/main");
  });

  it("returns the thread worktree for a worktree-mode thread", () => {
    expect(
      resolveScopeBasePath(
        "thread-wt",
        "ws-1",
        [WORKTREE_THREAD],
        [WORKSPACE],
      ),
    ).toBe("/repo/worktrees/feature");
  });

  it("rebinds from workspace root to worktree when a worktree thread becomes the scope", () => {
    const threads = [WORKTREE_THREAD];
    // Threadless: scope is the workspace id -> workspace root.
    expect(
      resolveScopeBasePath("ws-1", "ws-1", threads, [WORKSPACE]),
    ).toBe("/repo/main");
    // A worktree thread becomes active: same workspace, scope is now the thread
    // id -> the thread's worktree. This is the threadless -> worktree rebind.
    expect(
      resolveScopeBasePath("thread-wt", "ws-1", threads, [WORKSPACE]),
    ).toBe("/repo/worktrees/feature");
  });

  it("falls back to the workspace root for a worktree thread with no worktree path yet", () => {
    expect(
      resolveScopeBasePath(
        "thread-wt-pending",
        "ws-1",
        [PENDING_WORKTREE_THREAD],
        [WORKSPACE],
      ),
    ).toBe("/repo/main");
  });

  it("resolves the workspace root from the active workspace id, not the scope id", () => {
    // A direct thread in ws-2 should resolve against ws-2's root even though
    // ws-1 is also known.
    expect(
      resolveScopeBasePath(
        "thread-direct-2",
        "ws-2",
        [{ id: "thread-direct-2", mode: "direct", worktree_path: null }],
        [WORKSPACE, OTHER_WORKSPACE],
      ),
    ).toBe("/repo/other");
  });

  it("returns null when the owning workspace is unknown", () => {
    expect(resolveScopeBasePath("ws-x", "ws-x", [], [WORKSPACE])).toBeNull();
    expect(resolveScopeBasePath(null, null, [], [WORKSPACE])).toBeNull();
  });
});
