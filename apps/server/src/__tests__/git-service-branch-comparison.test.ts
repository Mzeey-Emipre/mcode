import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../repositories/workspace-repo";
import { GitService } from "../features/projects/index.js";
import { createMockGitExecutor } from "../services/git-executor/__tests__/mock-git-executor.js";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  rm: vi.fn(),
  rename: vi.fn(),
  rmdir: vi.fn(),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  validateBranchName: vi.fn(),
  validateWorktreeName: vi.fn(),
  logger: mockLogger,
}));

import type { Mock } from "vitest";
import type { GitExecOptions, GitExecResult } from "../services/git-executor/types.js";

/**
 * Builds the `git branch -a --format=...` output the standalone ref lister
 * parses: one line per ref, fields joined by `|||`
 * (refname, refname:short, objectname:short, HEAD marker, worktreepath).
 */
function branchListOutput(
  rows: Array<{ full: string; short: string; head?: boolean }>,
): string {
  return rows
    .map((r) => `${r.full}|||${r.short}|||abc1234|||${r.head ? "*" : ""}|||`)
    .join("\n");
}

const REPO = "/repo";

describe("GitService.resolveBranchComparison", () => {
  let gitService: GitService;
  let execFn: Mock<(args: string[], opts?: GitExecOptions) => Promise<GitExecResult>>;

  beforeEach(() => {
    vi.resetAllMocks();
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    gitService = new GitService({} as WorkspaceRepo, mock.executor);
  });

  /**
   * Wire the git mocks for one scenario. `current` is the abbreviated HEAD ref
   * (a branch name, or "HEAD" when detached); `hasCommits` toggles the unborn
   * path; `defaultBranch` is what `symbolic-ref origin/HEAD` resolves to.
   */
  function setup(opts: {
    current: string;
    branches: Array<{ full: string; short: string; head?: boolean }>;
    hasCommits?: boolean;
    defaultBranch?: string | null;
    localDefaultBranches?: string[];
    /** Tracked upstream ref from `@{upstream}`; omit to simulate no upstream. */
    upstream?: string | null;
  }) {
    const hasCommits = opts.hasCommits ?? true;
    const defaultBranch = opts.defaultBranch === undefined ? "main" : opts.defaultBranch;
    const localDefaultBranches = opts.localDefaultBranches ?? [];
    const upstream = opts.upstream === undefined ? null : opts.upstream;

    execFn.mockImplementation(async (args: string[]) => {
      if (args.includes("branch") && args.includes("-a")) {
        return { stdout: branchListOutput(opts.branches), stderr: "" };
      }
      if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
        if (args.includes("@{upstream}")) {
          if (!upstream) throw new Error("no upstream");
          return { stdout: `${upstream}\n`, stderr: "" };
        }
        return { stdout: `${opts.current}\n`, stderr: "" };
      }
      if (args.includes("rev-parse") && args.includes("--verify")) {
        if (!hasCommits) throw new Error("unborn");
        return { stdout: "deadbeef\n", stderr: "" };
      }
      if (args.includes("symbolic-ref")) {
        if (defaultBranch === null) throw new Error("no origin head");
        return { stdout: `origin/${defaultBranch}\n`, stderr: "" };
      }
      if (args.includes("remote")) throw new Error("no origin");
      if (args.includes("show-ref")) {
        const ref = args.at(-1) ?? "";
        const branch = ref.replace("refs/heads/", "");
        if (localDefaultBranches.includes(branch)) return { stdout: "", stderr: "" };
        throw new Error("missing local default");
      }
      return { stdout: "", stderr: "" };
    });
  }

  it("prefers upstream over origin default when the branch tracks a remote", async () => {
    setup({
      current: "feat/x",
      upstream: "origin/feat/x",
      branches: [
        { full: "refs/heads/main", short: "main" },
        { full: "refs/heads/feat/x", short: "feat/x", head: true },
        { full: "refs/remotes/origin/main", short: "origin/main" },
        { full: "refs/remotes/origin/feat/x", short: "origin/feat/x" },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: "origin/feat/x",
      target: "feat/x",
      isUnborn: false,
      isComparisonAvailable: true,
    });
  });

  it("compares origin default → current when the branch has no upstream", async () => {
    setup({
      current: "feat/x",
      branches: [
        { full: "refs/heads/main", short: "main" },
        { full: "refs/heads/feat/x", short: "feat/x", head: true },
        { full: "refs/remotes/origin/main", short: "origin/main" },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: "origin/main",
      target: "feat/x",
      isUnborn: false,
      isComparisonAvailable: true,
    });
    expect(result.refs.length).toBe(3);
  });

  it("compares current → upstream on the default branch when upstream is set", async () => {
    setup({
      current: "main",
      upstream: "origin/main",
      branches: [
        { full: "refs/heads/main", short: "main", head: true },
        { full: "refs/remotes/origin/main", short: "origin/main" },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: "main",
      target: "origin/main",
      isUnborn: false,
      isComparisonAvailable: true,
    });
  });

  it("compares current → origin default on the default branch when origin exists but upstream is unset", async () => {
    setup({
      current: "main",
      branches: [
        { full: "refs/heads/main", short: "main", head: true },
        { full: "refs/remotes/origin/main", short: "origin/main" },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: "main",
      target: "origin/main",
      isUnborn: false,
      isComparisonAvailable: true,
    });
  });

  it("marks comparison unavailable on a local-only default branch", async () => {
    setup({
      current: "main",
      defaultBranch: null,
      localDefaultBranches: ["main"],
      branches: [{ full: "refs/heads/main", short: "main", head: true }],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: "main",
      target: "main",
      isUnborn: false,
      isComparisonAvailable: false,
    });
  });

  it("compares base → HEAD on a detached HEAD", async () => {
    setup({
      current: "HEAD",
      branches: [
        { full: "refs/heads/main", short: "main" },
        { full: "refs/remotes/origin/main", short: "origin/main" },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: "origin/main",
      target: "HEAD",
      isUnborn: false,
      isComparisonAvailable: true,
    });
  });

  it("does not expose git's detached pseudo-ref as a selectable branch", async () => {
    setup({
      current: "HEAD",
      branches: [
        { full: "(no branch)", short: "(no branch)", head: true },
        { full: "refs/heads/main", short: "main" },
        { full: "refs/remotes/origin/main", short: "origin/main" },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: "origin/main",
      target: "HEAD",
      isUnborn: false,
      isComparisonAvailable: true,
    });
    expect(result.refs.map((ref) => ref.name)).not.toContain("(no branch)");
  });

  it("reports an explicit empty state on an unborn branch", async () => {
    setup({
      current: "main",
      branches: [],
      hasCommits: false,
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toEqual({
      base: null,
      target: null,
      refs: [],
      isUnborn: true,
      isComparisonAvailable: false,
    });
  });

  it("uses a non-main origin default branch", async () => {
    setup({
      current: "feat/y",
      defaultBranch: "develop",
      branches: [
        { full: "refs/heads/develop", short: "develop" },
        { full: "refs/heads/feat/y", short: "feat/y", head: true },
        { full: "refs/remotes/origin/develop", short: "origin/develop" },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: "origin/develop",
      target: "feat/y",
      isComparisonAvailable: true,
    });
  });

  it("falls back to a local main branch when origin is unavailable", async () => {
    setup({
      current: "feat/local-only",
      defaultBranch: null,
      localDefaultBranches: ["main"],
      branches: [
        { full: "refs/heads/main", short: "main" },
        { full: "refs/heads/feat/local-only", short: "feat/local-only", head: true },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: "main",
      target: "feat/local-only",
      isUnborn: false,
      isComparisonAvailable: true,
    });
  });

  it("opens with no base when no default branch can be detected", async () => {
    setup({
      current: "feat/unknown-base",
      defaultBranch: null,
      branches: [
        { full: "refs/heads/feat/unknown-base", short: "feat/unknown-base", head: true },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({
      base: null,
      target: "feat/unknown-base",
      isUnborn: false,
      isComparisonAvailable: true,
    });
  });
});

describe("GitService.branchFiles / branchDiff ranges", () => {
  let gitService: GitService;
  let execFn: Mock<(args: string[], opts?: GitExecOptions) => Promise<GitExecResult>>;

  beforeEach(() => {
    vi.resetAllMocks();
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    gitService = new GitService({} as WorkspaceRepo, mock.executor);
    execFn.mockResolvedValue({ stdout: "a.ts\nb.ts", stderr: "" });
  });

  it("diffs an explicit pair three-dot for branchFiles", async () => {
    const files = await gitService.branchFiles("ws", "main", "feat/x", REPO);

    expect(files).toEqual(["a.ts", "b.ts"]);
    expect(execFn).toHaveBeenCalledWith(
      ["-C", REPO, "diff", "--name-only", "main...feat/x"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("diffs an explicit pair three-dot for branchDiff with renames", async () => {
    await gitService.branchDiff("ws", "main", "origin/main", "a.ts", undefined, REPO);

    expect(execFn).toHaveBeenCalledWith(
      ["-C", REPO, "diff", "--find-renames", "main...origin/main", "--", "a.ts"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("rejects a ref that could smuggle a git flag (argument injection)", async () => {
    await expect(
      gitService.branchFiles("ws", "--output=/tmp/pwned", "HEAD", REPO),
    ).rejects.toThrow(/unsafe git ref/i);
    await expect(
      gitService.branchDiff("ws", "main", "-rf", undefined, undefined, REPO),
    ).rejects.toThrow(/unsafe git ref/i);
    expect(execFn).not.toHaveBeenCalled();
  });

  it("falls back to the detected default base ...HEAD when no pair is given", async () => {
    // symbolic-ref resolves the default branch; the diff call returns the files.
    execFn.mockImplementation(async (args: string[]) => {
      if (args.includes("symbolic-ref")) return { stdout: "origin/main\n", stderr: "" };
      return { stdout: "a.ts", stderr: "" };
    });

    await gitService.branchFiles("ws", undefined, undefined, REPO);

    expect(execFn).toHaveBeenCalledWith(
      ["-C", REPO, "diff", "--name-only", "main...HEAD"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("returns an explicit empty list when no default base is detected", async () => {
    execFn.mockImplementation(async (args: string[]) => {
      if (args.includes("symbolic-ref")) throw new Error("no origin head");
      if (args.includes("remote")) throw new Error("no origin");
      if (args.includes("show-ref")) throw new Error("missing local default");
      return { stdout: "a.ts", stderr: "" };
    });

    const files = await gitService.branchFiles("ws", undefined, undefined, REPO);

    expect(files).toEqual([]);
    expect(execFn).not.toHaveBeenCalledWith(
      expect.arrayContaining(["diff"]),
      expect.anything(),
    );
  });
});
