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

  /** Get commits for a workspace branch or worktree. */
  async log(
    workspaceId: string,
    branch?: string,
    limit = 50,
    baseBranch?: string,
    repoPath?: string,
    skip = 0,
    includeStats = true,
  ): Promise<GitCommit[]> {
    const effectivePath = repoPath ?? this.requireWorkspace(workspaceId).path;
    if (branch !== undefined) assertSafeRef(branch);
    if (baseBranch !== undefined) assertSafeRef(baseBranch);
    const resolvedBase = baseBranch ?? (branch ? await this.detectDefaultComparisonRef(effectivePath) : undefined);
    const args = [
      "-C", effectivePath, "log", "--pretty=format:MCODE_SEP%H|||%h|||%s|||%an|||%aI", `-${limit}`,
    ];
    if (skip > 0) args.push(`--skip=${skip}`);
    if (includeStats) args.push("--numstat");
    const headRef = repoPath ? "HEAD" : branch;
    if (resolvedBase && headRef) args.push(`${resolvedBase}..${headRef}`);
    else if (resolvedBase) args.push(`${resolvedBase}..HEAD`);
    else if (branch) args.push(branch);

    let stdout: string;
    try {
      ({ stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 }));
    } catch {
      return [];
    }
    return stdout.split("MCODE_SEP").filter(Boolean).flatMap((block) => {
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
    });
  }

  /** Get the unified diff for one commit. */
  async commitDiff(
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
  async commitFiles(workspaceId: string, sha: string): Promise<string[]> {
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
  async workingTreeFiles(workspaceId: string, staged: boolean, repoPath?: string): Promise<string[]> {
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

  /** Get a working-tree diff, optionally for a single file. */
  async workingTreeDiff(
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
  async branchFiles(workspaceId: string, base?: string, target?: string, repoPath?: string): Promise<string[]> {
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

  /** Get a branch comparison diff, optionally for one file. */
  async branchDiff(
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

  /** Return a file and stat batch for one Review comparison view. */
  async reviewComparison(
    workspaceId: string,
    view: "unstaged" | "staged" | "branch" | "commit",
    opts: { base?: string; target?: string; sha?: string },
    repoPath?: string,
  ): Promise<ReviewComparison> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    let suffix: string[] = [];
    if (view === "staged") suffix = ["--cached"];
    if (view === "branch") {
      const base = opts.base ?? await this.detectDefaultBranch(cwd);
      if (!base) return emptyReviewComparison();
      const target = opts.target ?? "HEAD";
      assertSafeRef(base);
      assertSafeRef(target);
      suffix = [`${base}...${target}`];
    }
    if (view === "commit") {
      assertSafeSha(opts.sha);
      suffix = [`${opts.sha}~1`, opts.sha!];
    }

    try {
      return await this.readReviewComparison(cwd, suffix);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Review comparison is limited")) throw error;
      if (view !== "commit") throw error;
      return this.readReviewComparison(cwd, [EMPTY_TREE, opts.sha!]);
    }
  }

  /** Return Review-panel additions and deletions. */
  async reviewDiffStats(
    workspaceId: string,
    view: "unstaged" | "staged" | "branch" | "commit",
    opts: { base?: string; target?: string; sha?: string },
    repoPath?: string,
  ): Promise<{ additions: number; deletions: number }> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const empty = { additions: 0, deletions: 0 };
    if (view === "unstaged" || view === "staged") {
      const args = ["-C", cwd, "diff", "--numstat"];
      if (view === "staged") args.push("--cached");
      try {
        return this.parseNumstatTotal((await this.gitExecutor.exec(args, { timeout: 10_000 })).stdout);
      } catch {
        return empty;
      }
    }
    if (view === "branch") {
      const base = opts.base ?? await this.detectDefaultBranch(cwd);
      if (!base) return empty;
      const target = opts.target ?? "HEAD";
      assertSafeRef(base);
      assertSafeRef(target);
      try {
        return this.parseNumstatTotal((await this.gitExecutor.exec(
          ["-C", cwd, "diff", "--numstat", `${base}...${target}`],
          { timeout: 10_000 },
        )).stdout);
      } catch {
        return empty;
      }
    }
    assertSafeSha(opts.sha);
    try {
      return this.parseNumstatTotal((await this.gitExecutor.exec(
        ["-C", cwd, "diff", "--numstat", `${opts.sha}~1`, opts.sha!],
        { timeout: 10_000 },
      )).stdout);
    } catch {
      try {
        return this.parseNumstatTotal((await this.gitExecutor.exec(
          ["-C", cwd, "diff", "--numstat", EMPTY_TREE, opts.sha!],
          { timeout: 10_000 },
        )).stdout);
      } catch {
        return empty;
      }
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
    const defaultBranch = await this.detectDefaultBranch(cwd);
    const originDefaultRef = await this.detectOriginDefaultRef(cwd);
    const current = await this.gitRepository.getCurrentBranchAt(cwd);
    const upstream = current && current !== "HEAD" ? await this.getUpstreamRef(cwd) : null;
    const onDefaultBranch = defaultBranch !== null && current === defaultBranch;
    const available = (base: string | null, target: string | null, isComparisonAvailable: boolean) => ({
      base, target, refs, isUnborn: false, isComparisonAvailable,
    });
    if (!current || current === "HEAD") {
      const base = savedBaseBranch ?? upstream ?? originDefaultRef ?? defaultBranch;
      return available(base, "HEAD", base !== null);
    }
    if (upstream) return onDefaultBranch
      ? available(current, upstream, true)
      : available(upstream, current, true);
    if (originDefaultRef) return onDefaultBranch
      ? available(current, originDefaultRef, true)
      : available(originDefaultRef, current, true);
    if (!onDefaultBranch && defaultBranch) return available(defaultBranch, current, true);
    if (onDefaultBranch) return available(current, current, false);
    return available(null, current, true);
  }

  /** Return a diff stat summary between two refs. */
  async diffStat(repoPath: string, base: string, head: string): Promise<string> {
    const { stdout } = await this.gitExecutor.exec(
      ["-C", repoPath, "diff", "--stat", `${base}...${head}`],
      { timeout: 30_000 },
    );
    return stdout.trim();
  }

  private async readReviewComparison(cwd: string, range: readonly string[]): Promise<ReviewComparison> {
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
      files: this.parseReviewFileChanges(names.stdout, this.parseBinaryPaths(numstat.stdout)),
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

  private parseReviewFileChanges(stdout: string, binaryPaths: ReadonlySet<string>): ReviewFileChange[] {
    const fields = stdout.split("\0");
    const files: ReviewFileChange[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++];
      if (!status) continue;
      const code = status[0];
      if (code === "R" || code === "C") {
        const previousPath = fields[index++] ?? "";
        const path = fields[index++] ?? "";
        if (!previousPath || !path) continue;
        files.push({ path, previousPath, changeType: code === "R" ? "renamed" : "copied", binary: binaryPaths.has(path) });
      } else {
        const path = fields[index++] ?? "";
        if (!path) continue;
        const changeType: ReviewFileChange["changeType"] = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
        files.push({ path, previousPath: null, changeType, binary: binaryPaths.has(path) });
      }
      if (files.length > MAX_REVIEW_COMPARISON_FILES) {
        throw new Error(`Review comparison is limited to ${MAX_REVIEW_COMPARISON_FILES} files`);
      }
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  private parseBinaryPaths(stdout: string): Set<string> {
    const fields = stdout.split("\0");
    const paths = new Set<string>();
    for (let index = 0; index < fields.length;) {
      const record = fields[index++];
      if (!record) continue;
      const firstSeparator = record.indexOf("\t");
      const secondSeparator = firstSeparator < 0 ? -1 : record.indexOf("\t", firstSeparator + 1);
      if (firstSeparator < 0 || secondSeparator < 0) continue;
      const binary = record.slice(0, firstSeparator) === "-" || record.slice(firstSeparator + 1, secondSeparator) === "-";
      const path = record.slice(secondSeparator + 1);
      if (path) {
        if (binary) paths.add(path);
        continue;
      }
      const previousPath = fields[index++] ?? "";
      const nextPath = fields[index++] ?? "";
      if (binary) {
        if (previousPath) paths.add(previousPath);
        if (nextPath) paths.add(nextPath);
      }
    }
    return paths;
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
