import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { validateName, createWorktree, removeWorktree, listBranches, getCurrentBranch, branchExists, checkoutBranch, listWorktrees } from "../worktree.js";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("validateName", () => {
  it("accepts valid names", () => {
    expect(() => validateName("my-feature")).not.toThrow();
    expect(() => validateName("fix-123")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateName("")).toThrow("1-100 characters");
  });

  it("rejects >100 chars", () => {
    expect(() => validateName("a".repeat(101))).toThrow("1-100 characters");
  });

  it("rejects path traversal with '..'", () => {
    expect(() => validateName("foo..bar")).toThrow("invalid characters");
  });

  it("rejects forward slash", () => {
    expect(() => validateName("foo/bar")).toThrow("invalid characters");
  });

  it("rejects backslash", () => {
    expect(() => validateName("foo\\bar")).toThrow("invalid characters");
  });

  it("rejects dot-prefixed names", () => {
    expect(() => validateName(".hidden")).toThrow("cannot start with '.'");
  });
});

// Tests in this describe block share a git repo and run in declared order.
// Some tests depend on state created by prior tests (e.g., removeWorktree
// depends on createWorktree having run). This is intentional for integration
// tests that exercise a real git repo lifecycle.
describe("Git operations (integration)", { timeout: 30_000 }, () => {
  let repoPath: string;

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.local",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.local",
  };

  beforeAll(() => {
    repoPath = mkdtempSync(join(tmpdir(), "mcode-test-"));
    execFileSync("git", ["init", repoPath], { stdio: "pipe", env: gitEnv });
    execFileSync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "init"], {
      stdio: "pipe",
      env: gitEnv,
    });
  }, 30_000);

  afterAll(() => {
    try {
      rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }, 30_000);

  it("createWorktree creates directory and branch", () => {
    const info = createWorktree(repoPath, "test-feature");
    expect(info.branch).toBe("mcode/test-feature");
    expect(info.path).toContain("test-feature");
    expect(branchExists(repoPath, "mcode/test-feature")).toBe(true);
  });

  it("createWorktree throws if repo path doesn't exist", () => {
    expect(() => createWorktree("/nonexistent/path", "foo")).toThrow();
  });

  it("createWorktree throws if worktree already exists", () => {
    expect(() => createWorktree(repoPath, "test-feature")).toThrow("already exists");
  });

  it("createWorktree accepts a custom branch name", () => {
    const info = createWorktree(repoPath, "custom-wt", "feat/custom-branch");
    expect(info.branch).toBe("feat/custom-branch");
    expect(info.path).toContain("custom-wt");
    expect(branchExists(repoPath, "feat/custom-branch")).toBe(true);
  });

  it("listWorktrees returns actual branch names", () => {
    createWorktree(repoPath, "branch-read-test", "fix/read-actual");
    const wts = listWorktrees(repoPath);
    const wt = wts.find((w) => w.name === "branch-read-test");
    expect(wt).toBeDefined();
    expect(wt!.branch).toBe("fix/read-actual");
    // cleanup
    removeWorktree(repoPath, "branch-read-test", "fix/read-actual");
  });

  it("removeWorktree deletes a custom-named branch", () => {
    removeWorktree(repoPath, "custom-wt", "feat/custom-branch");
    expect(branchExists(repoPath, "feat/custom-branch")).toBe(false);
  });

  it("listWorktrees returns entries", () => {
    const wts = listWorktrees(repoPath);
    expect(wts.some((w) => w.name === "test-feature")).toBe(true);
  });

  it("listBranches includes current branch first when multiple exist", () => {
    const branches = listBranches(repoPath);
    expect(branches.length).toBeGreaterThan(1);
    const currentIdx = branches.findIndex((b) => b.isCurrent);
    expect(currentIdx).toBe(0);
  });

  it("getCurrentBranch returns the branch name", () => {
    const branch = getCurrentBranch(repoPath);
    expect(branch).toBeTruthy();
  });

  it("getCurrentBranch returns 'main' on failure", () => {
    const branch = getCurrentBranch("/nonexistent");
    expect(branch).toBe("main");
  });

  it("removeWorktree cleans up directory and branch", () => {
    removeWorktree(repoPath, "test-feature");
    expect(branchExists(repoPath, "mcode/test-feature")).toBe(false);
  });

  it("removeWorktree returns true even if worktree already gone", () => {
    const result = removeWorktree(repoPath, "test-feature");
    expect(result).toBe(true);
  });

  it("checkoutBranch switches branches", () => {
    execFileSync("git", ["-C", repoPath, "branch", "test-branch"], {
      stdio: "pipe",
      env: gitEnv,
    });
    checkoutBranch(repoPath, "test-branch");
    expect(getCurrentBranch(repoPath)).toBe("test-branch");
  });

  it("branchExists returns false for nonexistent branch", () => {
    expect(branchExists(repoPath, "nonexistent-branch")).toBe(false);
  });
});
