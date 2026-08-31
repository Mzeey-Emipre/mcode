import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type {
  BranchComparison,
  GitCommit,
  ReviewComparison,
  ReviewFileChange,
} from "@mcode/contracts";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import type { GitExecutor } from "./execution/index.js";
import { GitRepositoryService } from "./git-repository-service.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf899d69f82049264";
const MAX_REVIEW_COMPARISON_FILES = 10_000;

/** Computes Git history, diffs, file lists, and branch comparisons. */
@injectable()
export class GitComparisonService {
  private readonly gitRepository: GitRepositoryService;
  private readonly defaultBranchCache = new Map<string, string | null>();
  private readonly defaultComparisonRefCache = new Map<string, string | null>();
  private readonly originDefaultRefCache = new Map<string, string | null>();

  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject(GitRepositoryService, { isOptional: true })
    gitRepository?: GitRepositoryService,
  ) {
    this.gitRepository = gitRepository ?? new GitRepositoryService(workspaceRepo, gitExecutor);
  }

  /** List commits for a workspace branch or worktree. */
  async listCommits(
    workspaceId: string,
    branch?: string,
    limit = 50,
    baseBranch?: string,
    repoPath?: string,
    skip = 0,
    includeStats = true,
  ): Promise<GitCommit[]> {
    const effectivePath = repoPath ?? this.requireWorkspace(workspaceId).path;
    assertOptionalRef(branch);
    assertOptionalRef(baseBranch);
    const resolvedBase = await this.resolveCommitListBase(effectivePath, branch, baseBranch);
    const args = buildCommitLogArgs({
      effectivePath,
      branch,
      limit,
      resolvedBase,
      repoPath,
      skip,
      includeStats,
    });

    let stdout: string;
    try {
      ({ stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 }));
    } catch {
      return [];
    }
    return parseCommitLog(stdout, includeStats);
  }

  /** Read the unified diff for one commit. */
  async readCommitDiff(
    workspaceId: string,
    sha: string,
    filePath?: string,
    maxLines?: number,
  ): Promise<string> {
    assertCommitSha(sha);
    const repoPath = this.requireWorkspace(workspaceId).path;
    const readDiff = async (range: string, truncate: boolean) => {
      const args = ["-C", repoPath, "diff", "--find-renames", range];
      if (filePath) args.push("--", filePath);
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();
      return truncate && maxLines ? result.split("\n").slice(0, maxLines).join("\n") : result;
    };
    try {
      return await readDiff(`${sha}~1..${sha}`, true);
    } catch {
      try {
        return await readDiff(`${EMPTY_TREE}..${sha}`, false);
      } catch {
        return "";
      }
    }
  }

  /** List files changed by one commit. */
  async listCommitChangedFiles(workspaceId: string, sha: string): Promise<string[]> {
    assertCommitSha(sha);
    const repoPath = this.requireWorkspace(workspaceId).path;
    const readFiles = async (range: string) => {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "diff", "--name-only", range],
        { timeout: 5_000 },
      );
      return stdout.trim().split("\n").filter(Boolean);
    };
    try {
      return await readFiles(`${sha}~1..${sha}`);
    } catch {
      try {
        return await readFiles(`${EMPTY_TREE}..${sha}`);
      } catch {
        return [];
      }
    }
  }

  /** List changed files in a working tree. */
  async listWorkingTreeChangedFiles(workspaceId: string, staged: boolean, repoPath?: string): Promise<string[]> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const args = ["-C", cwd, "diff", "--name-only"];
    if (staged) args.push("--cached");
    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Read a working-tree diff, optionally for a single file. */
  async readWorkingTreeDiff(
    workspaceId: string,
    staged: boolean,
    filePath?: string,
    maxLines?: number,
    repoPath?: string,
  ): Promise<string> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const args = ["-C", cwd, "diff", "--find-renames"];
    if (staged) args.push("--cached");
    if (filePath) args.push("--", filePath);
    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();
      return maxLines ? result.split("\n").slice(0, maxLines).join("\n") : result;
    } catch {
      return "";
    }
  }

  /** List files changed on the target side of a branch comparison. */
  async listBranchComparisonChangedFiles(workspaceId: string, base?: string, target?: string, repoPath?: string): Promise<string[]> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const resolvedBase = base ?? await this.detectDefaultBranch(cwd);
    if (!resolvedBase) return [];
    const resolvedTarget = target ?? "HEAD";
    assertSafeRef(resolvedBase);
    assertSafeRef(resolvedTarget);
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", cwd, "diff", "--name-only", `${resolvedBase}...${resolvedTarget}`],
        { timeout: 10_000 },
      );
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Read a branch comparison diff, optionally for one file. */
  async readBranchComparisonDiff(
    workspaceId: string,
    base?: string,
    target?: string,
    filePath?: string,
    maxLines?: number,
    repoPath?: string,
  ): Promise<string> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const resolvedBase = base ?? await this.detectDefaultBranch(cwd);
    if (!resolvedBase) return "";
    const resolvedTarget = target ?? "HEAD";
    assertSafeRef(resolvedBase);
    assertSafeRef(resolvedTarget);
    const args = ["-C", cwd, "diff", "--find-renames", `${resolvedBase}...${resolvedTarget}`];
    if (filePath) args.push("--", filePath);
    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();
      return maxLines ? result.split("\n").slice(0, maxLines).join("\n") : result;
    } catch {
      return "";
    }
  }

  /** Read a file and stat batch for one Review comparison view. */
  async readReviewComparison(
    workspaceId: string,
    view: "unstaged" | "staged" | "branch" | "commit",
    opts: { base?: string; target?: string; sha?: string },
    repoPath?: string,
  ): Promise<ReviewComparison> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const suffix = await this.resolveReviewComparisonSuffix(cwd, view, opts);
    if (!suffix) return emptyReviewComparison();
    return this.readReviewComparisonWithCommitFallback(cwd, view, opts.sha, suffix);
  }

  /** Read Review-panel additions and deletions. */
  async readReviewDiffStats(
    workspaceId: string,
    view: "unstaged" | "staged" | "branch" | "commit",
    opts: { base?: string; target?: string; sha?: string },
    repoPath?: string,
  ): Promise<{ additions: number; deletions: number }> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const suffix = await this.resolveReviewComparisonSuffix(cwd, view, opts);
    if (!suffix) return emptyReviewDiffStats();
    try {
      return await this.readReviewDiffStatsForRange(cwd, suffix);
    } catch {
      return this.readCommitReviewDiffStatsFallback(cwd, view, opts.sha);
    }
  }

  /** Resolve the default Branch comparison and the available references. */
  async resolveBranchComparison(
    workspaceId: string,
    repoPath?: string,
    savedBaseBranch?: string | null,
  ): Promise<BranchComparison> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const refs = await this.gitRepository.listBranchesAt(cwd);
    if (!(await this.hasCommits(cwd))) {
      return { base: null, target: null, refs, isUnborn: true, isComparisonAvailable: false };
    }
    const selection = await this.selectBranchComparison(cwd, savedBaseBranch);
    return { ...selection, refs, isUnborn: false };
  }

  /** Read a diff stat summary between two refs. */
  async readBranchComparisonDiffStat(repoPath: string, base: string, head: string): Promise<string> {
    const { stdout } = await this.gitExecutor.exec(
      ["-C", repoPath, "diff", "--stat", `${base}...${head}`],
      { timeout: 30_000 },
    );
    return stdout.trim();
  }

  private async runReviewComparison(cwd: string, range: readonly string[]): Promise<ReviewComparison> {
    const [names, numstat] = await Promise.all([
      this.gitExecutor.exec(
        ["-C", cwd, "diff", "--name-status", "-z", "--find-renames", "--find-copies", ...range],
        { timeout: 10_000 },
      ),
      this.gitExecutor.exec(
        ["-C", cwd, "diff", "--numstat", "-z", "--find-renames", "--find-copies", ...range],
        { timeout: 10_000 },
      ),
    ]);
    return {
      files: parseReviewFileChanges(names.stdout, parseBinaryPaths(numstat.stdout)),
      ...this.parseNumstatTotal(numstat.stdout.replaceAll("\0", "\n")),
    };
  }

  private parseNumstatTotal(stdout: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const line of stdout.trim().split("\n")) {
      if (!line.includes("\t")) continue;
      const [additionsText, deletionsText] = line.split("\t");
      const parsedAdditions = additionsText === "-" ? 0 : Number.parseInt(additionsText ?? "", 10);
      const parsedDeletions = deletionsText === "-" ? 0 : Number.parseInt(deletionsText ?? "", 10);
      if (Number.isFinite(parsedAdditions)) additions += parsedAdditions;
      if (Number.isFinite(parsedDeletions)) deletions += parsedDeletions;
    }
    return { additions, deletions };
  }

  private async resolveCommitListBase(
    repoPath: string,
    branch: string | undefined,
    baseBranch: string | undefined,
  ): Promise<string | undefined> {
    if (baseBranch !== undefined) return baseBranch;
    if (!branch) return undefined;
    return (await this.detectDefaultComparisonRef(repoPath)) ?? undefined;
  }

  private async resolveReviewComparisonSuffix(
    cwd: string,
    view: ReviewView,
    opts: ReviewComparisonOptions,
  ): Promise<string[] | null> {
    switch (view) {
      case "unstaged": return [];
      case "staged": return ["--cached"];
      case "branch": return this.resolveBranchReviewSuffix(cwd, opts);
      case "commit": return resolveCommitReviewSuffix(opts.sha);
    }
  }

  private async resolveBranchReviewSuffix(
    cwd: string,
    opts: ReviewComparisonOptions,
  ): Promise<string[] | null> {
    const base = opts.base ?? await this.detectDefaultBranch(cwd);
    if (!base) return null;
    const target = opts.target ?? "HEAD";
    assertSafeRef(base);
    assertSafeRef(target);
    return [`${base}...${target}`];
  }

  private async readReviewComparisonWithCommitFallback(
    cwd: string,
    view: ReviewView,
    sha: string | undefined,
    suffix: readonly string[],
  ): Promise<ReviewComparison> {
    try {
      return await this.runReviewComparison(cwd, suffix);
    } catch (error) {
      if (isReviewComparisonLimitError(error) || view !== "commit") throw error;
      assertSafeSha(sha);
      return this.runReviewComparison(cwd, [EMPTY_TREE, sha]);
    }
  }

  private async readReviewDiffStatsForRange(
    cwd: string,
    suffix: readonly string[],
  ): Promise<{ additions: number; deletions: number }> {
    const { stdout } = await this.gitExecutor.exec(
      ["-C", cwd, "diff", "--numstat", ...suffix],
      { timeout: 10_000 },
    );
    return this.parseNumstatTotal(stdout);
  }

  private async readCommitReviewDiffStatsFallback(
    cwd: string,
    view: ReviewView,
    sha: string | undefined,
  ): Promise<{ additions: number; deletions: number }> {
    if (view !== "commit") return emptyReviewDiffStats();
    assertSafeSha(sha);
    try {
      return await this.readReviewDiffStatsForRange(cwd, [EMPTY_TREE, sha]);
    } catch {
      return emptyReviewDiffStats();
    }
  }

  private async selectBranchComparison(
    cwd: string,
    savedBaseBranch: string | null | undefined,
  ): Promise<BranchComparisonSelection> {
    const defaultBranch = await this.detectDefaultBranch(cwd);
    const originDefaultRef = await this.detectOriginDefaultRef(cwd);
    const current = await this.gitRepository.getCurrentBranchAt(cwd);
    const upstream = await this.getCurrentUpstreamRef(cwd, current);
    return selectBranchComparison({ current, defaultBranch, originDefaultRef, savedBaseBranch, upstream });
  }

  private async getCurrentUpstreamRef(cwd: string, current: string | null): Promise<string | null> {
    return current && current !== "HEAD" ? this.getUpstreamRef(cwd) : null;
  }

  private async getUpstreamRef(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--abbrev-ref", "@{upstream}"],
        { timeout: 5_000 },
      );
      const ref = stdout.trim();
      return !ref || ref === "@{upstream}" ? null : ref;
    } catch {
      return null;
    }
  }

  private async detectOriginDefaultRef(repoPath: string): Promise<string | null> {
    const cached = this.originDefaultRefCache.get(repoPath);
    if (cached !== undefined) return cached;
    const result = await this.resolveOriginDefaultRef(repoPath);
    this.originDefaultRefCache.set(repoPath, result);
    return result;
  }

  private async resolveOriginDefaultRef(repoPath: string): Promise<string | null> {
    try {
      return (await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      )).stdout.trim();
    } catch (error) {
      logger.debug("[detectOriginDefaultRef] origin/HEAD not set, trying set-head", { repoPath, err: error });
    }
    try {
      await this.gitExecutor.exec(["-C", repoPath, "remote", "set-head", "origin", "--auto"], { timeout: 1_500 });
      return (await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      )).stdout.trim();
    } catch (error) {
      logger.debug("[detectOriginDefaultRef] set-head failed", { repoPath, err: error });
      return null;
    }
  }

  private async hasCommits(repoPath: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(["-C", repoPath, "rev-parse", "--verify", "--quiet", "HEAD"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  private async detectDefaultComparisonRef(repoPath: string): Promise<string | null> {
    const cached = this.defaultComparisonRefCache.get(repoPath);
    if (cached !== undefined) return cached;
    const result = await this.resolveDefaultComparisonRef(repoPath);
    this.defaultComparisonRefCache.set(repoPath, result);
    return result;
  }

  private async resolveDefaultComparisonRef(repoPath: string): Promise<string | null> {
    try {
      return (await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      )).stdout.trim();
    } catch (error) {
      logger.debug("[detectDefaultComparisonRef] origin/HEAD not set, trying set-head", { repoPath, err: error });
    }
    try {
      await this.gitExecutor.exec(["-C", repoPath, "remote", "set-head", "origin", "--auto"], { timeout: 1_500 });
      return (await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      )).stdout.trim();
    } catch (error) {
      logger.debug("[detectDefaultComparisonRef] set-head failed, falling back to local default", { repoPath, err: error });
      return this.detectDefaultBranch(repoPath);
    }
  }

  private async detectDefaultBranch(repoPath: string): Promise<string | null> {
    const cached = this.defaultBranchCache.get(repoPath);
    if (cached !== undefined) return cached;
    const result = await this.resolveDefaultBranch(repoPath);
    this.defaultBranchCache.set(repoPath, result);
    return result;
  }

  private async resolveDefaultBranch(repoPath: string): Promise<string | null> {
    try {
      return (await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      )).stdout.trim().replace(/^[^/]+\//, "");
    } catch (error) {
      logger.debug("[detectDefaultBranch] origin/HEAD not set, trying set-head", { repoPath, err: error });
    }
    try {
      await this.gitExecutor.exec(["-C", repoPath, "remote", "set-head", "origin", "--auto"], { timeout: 1_500 });
      return (await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      )).stdout.trim().replace(/^[^/]+\//, "");
    } catch (error) {
      logger.debug("[detectDefaultBranch] set-head failed, falling back to HEAD", { repoPath, err: error });
    }
    for (const branchName of ["main", "master", "develop", "trunk"]) {
      try {
        await this.gitExecutor.exec(
          ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
          { timeout: 5_000 },
        );
        return branchName;
      } catch {
        continue;
      }
    }
    logger.debug("[detectDefaultBranch] no default branch detected", { repoPath });
    return null;
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }
}

type ReviewView = "unstaged" | "staged" | "branch" | "commit";

type ReviewComparisonOptions = { base?: string; target?: string; sha?: string };

type CommitLogArguments = {
  effectivePath: string;
  branch: string | undefined;
  limit: number;
  resolvedBase: string | undefined;
  repoPath: string | undefined;
  skip: number;
  includeStats: boolean;
};

type BranchComparisonContext = {
  current: string | null;
  defaultBranch: string | null;
  originDefaultRef: string | null;
  savedBaseBranch: string | null | undefined;
  upstream: string | null;
};

type BranchComparisonSelection = {
  base: string | null;
  target: string | null;
  isComparisonAvailable: boolean;
};

type ParsedReviewFileChange = {
  file: ReviewFileChange | null;
  nextIndex: number;
};

type ParsedNumstatRecord = {
  binary: boolean;
  path: string;
};

function assertOptionalRef(ref: string | undefined): void {
  if (ref !== undefined) assertSafeRef(ref);
}

function buildCommitLogArgs(input: CommitLogArguments): string[] {
  const args = [
    "-C", input.effectivePath, "log", "--pretty=format:MCODE_SEP%H|||%h|||%s|||%an|||%aI", `-${input.limit}`,
  ];
  if (input.skip > 0) args.push(`--skip=${input.skip}`);
  if (input.includeStats) args.push("--numstat");
  const range = selectCommitLogRange(input);
  if (range) args.push(range);
  return args;
}

function selectCommitLogRange(input: CommitLogArguments): string | undefined {
  if (!input.resolvedBase) return input.branch;
  const headRef = input.repoPath ? "HEAD" : input.branch;
  return `${input.resolvedBase}..${headRef ?? "HEAD"}`;
}

function parseCommitLog(stdout: string, includeStats: boolean): GitCommit[] {
  return stdout.split("MCODE_SEP").filter(Boolean).flatMap((block) => parseCommitLogBlock(block, includeStats));
}

function parseCommitLogBlock(block: string, includeStats: boolean): GitCommit[] {
  const lines = block.split("\n");
  const meta = lines[0];
  if (!meta) return [];
  const [sha, shortSha, message, author, date] = meta.split("|||");
  if (!sha) return [];
  return [{
    sha,
    shortSha: shortSha ?? "",
    message: message ?? "",
    author: author ?? "",
    date: date ?? "",
    filesChanged: includeStats ? lines.slice(1).filter((line) => line.includes("\t")).length : 0,
  }];
}

function resolveCommitReviewSuffix(sha: string | undefined): string[] {
  assertSafeSha(sha);
  return [`${sha}~1`, sha];
}

function isReviewComparisonLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Review comparison is limited");
}

function emptyReviewDiffStats(): { additions: number; deletions: number } {
  return { additions: 0, deletions: 0 };
}

function selectBranchComparison(context: BranchComparisonContext): BranchComparisonSelection {
  if (!context.current || context.current === "HEAD") {
    return selectDetachedBranchComparison(context);
  }
  return selectNamedBranchComparison(context, context.current);
}

function selectDetachedBranchComparison(context: BranchComparisonContext): BranchComparisonSelection {
  const base = context.savedBaseBranch
    ?? context.upstream
    ?? context.originDefaultRef
    ?? context.defaultBranch;
  return branchComparisonSelection(base, "HEAD", base !== null);
}

function selectNamedBranchComparison(
  context: BranchComparisonContext,
  current: string,
): BranchComparisonSelection {
  if (context.upstream) return selectTrackedBranchComparison(context, current, context.upstream);
  if (context.originDefaultRef) return selectTrackedBranchComparison(context, current, context.originDefaultRef);
  return selectUntrackedBranchComparison(context, current);
}

function selectTrackedBranchComparison(
  context: BranchComparisonContext,
  current: string,
  comparisonRef: string,
): BranchComparisonSelection {
  return isDefaultBranch(context.defaultBranch, current)
    ? branchComparisonSelection(current, comparisonRef, true)
    : branchComparisonSelection(comparisonRef, current, true);
}

function selectUntrackedBranchComparison(
  context: BranchComparisonContext,
  current: string,
): BranchComparisonSelection {
  if (!isDefaultBranch(context.defaultBranch, current) && context.defaultBranch) {
    return branchComparisonSelection(context.defaultBranch, current, true);
  }
  if (isDefaultBranch(context.defaultBranch, current)) {
    return branchComparisonSelection(current, current, false);
  }
  return branchComparisonSelection(null, current, true);
}

function isDefaultBranch(defaultBranch: string | null, current: string): boolean {
  return defaultBranch !== null && current === defaultBranch;
}

function branchComparisonSelection(
  base: string | null,
  target: string | null,
  isComparisonAvailable: boolean,
): BranchComparisonSelection {
  return { base, target, isComparisonAvailable };
}

function parseReviewFileChanges(stdout: string, binaryPaths: ReadonlySet<string>): ReviewFileChange[] {
  const fields = stdout.split("\0");
  const files: ReviewFileChange[] = [];
  for (let index = 0; index < fields.length;) {
    const parsed = parseReviewFileChange(fields, index, binaryPaths);
    index = parsed.nextIndex;
    if (!parsed.file) continue;
    files.push(parsed.file);
    assertReviewComparisonFileCount(files.length);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function parseReviewFileChange(
  fields: readonly string[],
  index: number,
  binaryPaths: ReadonlySet<string>,
): ParsedReviewFileChange {
  const status = fields[index] ?? "";
  if (!status) return { file: null, nextIndex: index + 1 };
  const code = status[0] ?? "";
  return isMovedFileChange(code)
    ? parseMovedFileChange(fields, index, code, binaryPaths)
    : parseStandardFileChange(fields, index, code, binaryPaths);
}

function isMovedFileChange(code: string): boolean {
  return code === "R" || code === "C";
}

function parseMovedFileChange(
  fields: readonly string[],
  index: number,
  code: string,
  binaryPaths: ReadonlySet<string>,
): ParsedReviewFileChange {
  const previousPath = fields[index + 1] ?? "";
  const path = fields[index + 2] ?? "";
  if (!previousPath || !path) return { file: null, nextIndex: index + 3 };
  return {
    file: {
      path,
      previousPath,
      changeType: code === "R" ? "renamed" : "copied",
      binary: binaryPaths.has(path),
    },
    nextIndex: index + 3,
  };
}

function parseStandardFileChange(
  fields: readonly string[],
  index: number,
  code: string,
  binaryPaths: ReadonlySet<string>,
): ParsedReviewFileChange {
  const path = fields[index + 1] ?? "";
  if (!path) return { file: null, nextIndex: index + 2 };
  return {
    file: {
      path,
      previousPath: null,
      changeType: standardFileChangeType(code),
      binary: binaryPaths.has(path),
    },
    nextIndex: index + 2,
  };
}

function standardFileChangeType(code: string): ReviewFileChange["changeType"] {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  return "modified";
}

function assertReviewComparisonFileCount(fileCount: number): void {
  if (fileCount > MAX_REVIEW_COMPARISON_FILES) {
    throw new Error(`Review comparison is limited to ${MAX_REVIEW_COMPARISON_FILES} files`);
  }
}

function parseBinaryPaths(stdout: string): Set<string> {
  const fields = stdout.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const record = fields[index++] ?? "";
    const parsed = parseNumstatRecord(record);
    if (!parsed) continue;
    if (parsed.path) {
      if (parsed.binary) paths.add(parsed.path);
      continue;
    }
    const previousPath = fields[index++] ?? "";
    const nextPath = fields[index++] ?? "";
    addBinaryRenamePaths(paths, parsed.binary, previousPath, nextPath);
  }
  return paths;
}

function parseNumstatRecord(record: string): ParsedNumstatRecord | null {
  if (!record) return null;
  const firstSeparator = record.indexOf("\t");
  const secondSeparator = record.indexOf("\t", firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0) return null;
  const additions = record.slice(0, firstSeparator);
  const deletions = record.slice(firstSeparator + 1, secondSeparator);
  return {
    binary: additions === "-" || deletions === "-",
    path: record.slice(secondSeparator + 1),
  };
}

function addBinaryRenamePaths(
  paths: Set<string>,
  binary: boolean,
  previousPath: string,
  nextPath: string,
): void {
  if (!binary) return;
  if (previousPath) paths.add(previousPath);
  if (nextPath) paths.add(nextPath);
}

function assertSafeRef(ref: string): void {
  if (!/^(?!-)[A-Za-z0-9._/-]+$/.test(ref)) throw new Error(`Unsafe git ref: ${ref}`);
}

function assertSafeSha(sha: string | undefined): asserts sha is string {
  if (!sha || !/^[0-9a-fA-F]{4,40}$/.test(sha)) throw new Error(`Invalid or missing git SHA for commit view: ${sha}`);
}

function assertCommitSha(sha: string): void {
  if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) throw new Error(`Invalid git SHA: ${sha}`);
}

function emptyReviewComparison(): ReviewComparison {
  return { files: [], additions: 0, deletions: 0 };
}
