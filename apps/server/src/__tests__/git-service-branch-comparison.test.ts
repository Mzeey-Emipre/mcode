import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../repositories/workspace-repo";

const { mockExecFile, mockExecFileSync, mockLogger } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFile,
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

import { GitService } from "../services/git-service";

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

  beforeEach(() => {
    vi.resetAllMocks();
    gitService = new GitService({} as WorkspaceRepo);
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
    defaultBranch?: string;
  }) {
    const hasCommits = opts.hasCommits ?? true;
    const defaultBranch = opts.defaultBranch ?? "main";

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("branch")) return branchListOutput(opts.branches);
      if (args.includes("rev-parse")) return `${opts.current}\n`;
      return "";
    });

    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("--verify")) {
        if (!hasCommits) throw new Error("unborn");
        return { stdout: "deadbeef\n", stderr: "" };
      }
      if (args.includes("symbolic-ref")) {
        return { stdout: `origin/${defaultBranch}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
  }

  it("compares base → current when current differs from the detected base", async () => {
    setup({
      current: "feat/x",
      branches: [
        { full: "refs/heads/main", short: "main" },
        { full: "refs/heads/feat/x", short: "feat/x", head: true },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({ base: "main", target: "feat/x", isUnborn: false });
    expect(result.refs.length).toBe(2);
  });

  it("compares current → origin/current on the base branch when an upstream exists", async () => {
    setup({
      current: "main",
      branches: [
        { full: "refs/heads/main", short: "main", head: true },
        { full: "refs/remotes/origin/main", short: "origin/main" },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({ base: "main", target: "origin/main", isUnborn: false });
  });

  it("falls back to base → current on the base branch with no upstream", async () => {
    setup({
      current: "main",
      branches: [{ full: "refs/heads/main", short: "main", head: true }],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({ base: "main", target: "main", isUnborn: false });
  });

  it("compares base → HEAD on a detached HEAD", async () => {
    setup({
      current: "HEAD",
      branches: [{ full: "refs/heads/main", short: "main" }],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({ base: "main", target: "HEAD", isUnborn: false });
  });

  it("reports an explicit empty state on an unborn branch", async () => {
    setup({
      current: "main",
      branches: [],
      hasCommits: false,
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toEqual({ base: null, target: null, refs: [], isUnborn: true });
  });

  it("uses a non-main detected default branch", async () => {
    setup({
      current: "feat/y",
      defaultBranch: "develop",
      branches: [
        { full: "refs/heads/develop", short: "develop" },
        { full: "refs/heads/feat/y", short: "feat/y", head: true },
      ],
    });

    const result = await gitService.resolveBranchComparison("ws", REPO);

    expect(result).toMatchObject({ base: "develop", target: "feat/y" });
  });
});

describe("GitService.branchFiles / branchDiff ranges", () => {
  let gitService: GitService;

  beforeEach(() => {
    vi.resetAllMocks();
    gitService = new GitService({} as WorkspaceRepo);
    mockExecFile.mockResolvedValue({ stdout: "a.ts\nb.ts", stderr: "" });
  });

  it("diffs an explicit pair three-dot for branchFiles", async () => {
    const files = await gitService.branchFiles("ws", "main", "feat/x", REPO);

    expect(files).toEqual(["a.ts", "b.ts"]);
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["-C", REPO, "diff", "--name-only", "main...feat/x"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("diffs an explicit pair three-dot for branchDiff with renames", async () => {
    await gitService.branchDiff("ws", "main", "origin/main", "a.ts", undefined, REPO);

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["-C", REPO, "diff", "--find-renames", "main...origin/main", "--", "a.ts"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("falls back to the detected default base ...HEAD when no pair is given", async () => {
    // symbolic-ref resolves the default branch; the diff call returns the files.
    mockExecFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("symbolic-ref")) return { stdout: "origin/main\n", stderr: "" };
      return { stdout: "a.ts", stderr: "" };
    });

    await gitService.branchFiles("ws", undefined, undefined, REPO);

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["-C", REPO, "diff", "--name-only", "main...HEAD"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });
});
