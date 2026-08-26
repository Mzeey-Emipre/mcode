/**
 * Git operations service.
 * Manages branches, worktrees, checkout, and fetch operations using the
 * injected GitExecutor abstraction. All git invocations go through the
 * executor so tests can swap in FakeGitExecutor and production code benefits
 * from per-repo serialisation and rev-parse caching.
 */

import { injectable, inject } from "tsyringe";
import type { GitBranch, WorktreeInfo, GitCommit, BranchComparison, GitRemoteUrl, ReviewComparison } from "@mcode/contracts";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import type { GitExecutor } from "./execution/index.js";
import { WorktreeDirectoryRemover } from "../worktrees/worktree-directory-remover.js";
import { RepositoryGitMutationLock } from "./repository-git-mutation-lock.js";
import {
  GitWorktreeService,
  type RemoveWorktreeOptions,
} from "./git-worktree-service.js";
import { GitComparisonService } from "./git-comparison-service.js";
import {
  PullRequestReviewGitService,
  type PullRequestReviewGitCandidate,
  type PullRequestReviewGitProvisionRequest,
  type PullRequestReviewGitProvisionResult,
  type PullRequestReviewGitSource,
} from "./pull-request-review-git-service.js";
import {
  GitRepositoryService,
  type NormalizedGitRemote,
} from "./git-repository-service.js";
import {
  WorktreeSafetyService,
  type BranchlessWorktreeRemovalSafety,
  type NamedWorktreeRemovalSafety,
  type WorktreeRemovalSafety,
} from "./worktree-safety-service.js";

export type { NormalizedGitRemote } from "./git-repository-service.js";
export type { RemoveWorktreeOptions } from "./git-worktree-service.js";
export { PullRequestReviewGitError } from "./pull-request-review-git-service.js";
export type {
  PullRequestReviewGitCandidate,
  PullRequestReviewGitProvisionRequest,
  PullRequestReviewGitProvisionResult,
  PullRequestReviewGitSource,
} from "./pull-request-review-git-service.js";
export type {
  BranchlessWorktreeRemovalSafety,
  NamedWorktreeRemovalSafety,
  WorktreeRemovalSafety,
} from "./worktree-safety-service.js";

/** Handles all git branch, worktree, checkout, and fetch operations. */
@injectable()
export class GitService {
  private readonly worktreeDirectoryRemover: WorktreeDirectoryRemover;
  private readonly repositoryMutationLock: RepositoryGitMutationLock;
  private readonly worktreeSafety: WorktreeSafetyService;
  private readonly gitRepository: GitRepositoryService;
  private readonly gitWorktrees: GitWorktreeService;
  private readonly gitComparison: GitComparisonService;
  private readonly pullRequestReviews: PullRequestReviewGitService;

  constructor(
    @inject(WorkspaceRepo) workspaceRepo: WorkspaceRepo,
    @inject("GitExecutor") gitExecutor: GitExecutor,
    @inject(WorktreeDirectoryRemover, { isOptional: true })
    worktreeDirectoryRemover?: WorktreeDirectoryRemover,
    @inject(RepositoryGitMutationLock, { isOptional: true })
    repositoryMutationLock?: RepositoryGitMutationLock,
    @inject(WorktreeSafetyService, { isOptional: true })
    worktreeSafety?: WorktreeSafetyService,
    @inject(GitRepositoryService, { isOptional: true })
    gitRepository?: GitRepositoryService,
    @inject(GitWorktreeService, { isOptional: true })
    gitWorktrees?: GitWorktreeService,
    @inject(GitComparisonService, { isOptional: true })
    gitComparison?: GitComparisonService,
    @inject(PullRequestReviewGitService, { isOptional: true })
    pullRequestReviews?: PullRequestReviewGitService,
  ) {
    this.worktreeDirectoryRemover = worktreeDirectoryRemover ?? new WorktreeDirectoryRemover();
    this.repositoryMutationLock = repositoryMutationLock ?? new RepositoryGitMutationLock();
    this.worktreeSafety = worktreeSafety ?? new WorktreeSafetyService(gitExecutor);
    this.gitRepository = gitRepository ?? new GitRepositoryService(workspaceRepo, gitExecutor);
    this.gitWorktrees = gitWorktrees ?? new GitWorktreeService(
      workspaceRepo,
      gitExecutor,
      this.worktreeDirectoryRemover,
      this.worktreeSafety,
      this.gitRepository,
    );
    this.gitComparison = gitComparison ?? new GitComparisonService(
      workspaceRepo,
      gitExecutor,
      this.gitRepository,
    );
    this.pullRequestReviews = pullRequestReviews ?? new PullRequestReviewGitService(
      gitExecutor,
      this.gitRepository,
      this.worktreeDirectoryRemover,
      this.repositoryMutationLock,
    );
  }

  /** List all branches (local, remote, and worktree-attached) for a workspace. */
  async listBranches(workspaceId: string): Promise<GitBranch[]> {
    return this.gitRepository.listBranches(workspaceId);
  }

  /** Get the current branch name for a workspace. Returns null for non-git workspaces. */
  async getCurrentBranch(workspaceId: string): Promise<string | null> {
    return this.gitRepository.getCurrentBranch(workspaceId);
  }

  /**
   * Get the current branch name for an arbitrary repo path.
   * Use this instead of getCurrentBranch when you already have the resolved path
   * (e.g. a worktree directory that may differ from the workspace root).
   */
  async getCurrentBranchAt(repoPath: string): Promise<string | null> {
    return this.gitRepository.getCurrentBranchAt(repoPath);
  }

  /** Checkout an existing branch in the workspace repository. */
  async checkout(workspaceId: string, branch: string): Promise<void> {
    await this.gitRepository.checkout(workspaceId, branch);
  }

  /** Create and checkout a new branch in the repository at the given path. */
  async createBranch(path: string, name: string): Promise<string> {
    return this.gitRepository.createBranch(path, name);
  }

  /** List all git worktrees registered for a workspace. */
  async listWorktrees(workspaceId: string): Promise<WorktreeInfo[]> {
    return this.gitWorktrees.listWorktrees(workspaceId);
  }

  /** Resolve the origin remote as a normalized https URL and UI label. */
  async getRemoteUrl(repoPath: string): Promise<GitRemoteUrl> {
    return this.gitRepository.getRemoteUrl(repoPath);
  }

  /** List bounded configured remotes normalized to repository identities. */
  async listNormalizedRemotes(repoPath: string): Promise<NormalizedGitRemote[]> {
    return this.gitRepository.listNormalizedRemotes(repoPath);
  }

  /** Resolve a server-owned Review worktree leaf beneath managed storage. */
  getReviewWorktreeDestination(repoPath: string, worktreeName: string): string {
    return this.pullRequestReviews.getReviewWorktreeDestination(repoPath, worktreeName);
  }

  /** Find registered worktrees that match an immutable pull request head. */
  async findCompatiblePullRequestReviewWorktrees(
    repoPath: string,
    source: PullRequestReviewGitSource,
  ): Promise<PullRequestReviewGitCandidate[]> {
    return this.pullRequestReviews.findCompatiblePullRequestReviewWorktrees(repoPath, source);
  }

  /** Provision or explicitly reuse a Review worktree for an immutable pull request head. */
  async provisionPullRequestReviewWorktree(
    repoPath: string,
    source: PullRequestReviewGitSource,
    request: PullRequestReviewGitProvisionRequest,
  ): Promise<PullRequestReviewGitProvisionResult> {
    return this.pullRequestReviews.provisionPullRequestReviewWorktree(repoPath, source, request);
  }

  /** Provision a Review worktree while holding its mutation lock through persistence. */
  async provisionPullRequestReviewWorktreeAndCommit<T>(
    repoPath: string,
    source: PullRequestReviewGitSource,
    request: PullRequestReviewGitProvisionRequest,
    commit: (
      provisioned: Extract<PullRequestReviewGitProvisionResult, { kind: "ready" }>,
    ) => Promise<T> | T,
  ): Promise<
    | Extract<PullRequestReviewGitProvisionResult, { kind: "requires_reuse" }>
    | { kind: "committed"; value: T }
  > {
    return this.pullRequestReviews.provisionPullRequestReviewWorktreeAndCommit(
      repoPath,
      source,
      request,
      commit,
    );
  }

  /** Push a linked Review branch to its persisted pull request target. */
  async pushPullRequestReviewBranch(
    repoPath: string,
    pushRemote: string,
    pushRef: string,
    expectedHeadRepositoryUrl: string,
  ): Promise<void> {
    return this.pullRequestReviews.pushPullRequestReviewBranch(
      repoPath,
      pushRemote,
      pushRef,
      expectedHeadRepositoryUrl,
    );
  }

  /** Check whether a filesystem path is a git-registered worktree for a repository. */
  async isRegisteredWorktreePath(repoPath: string, worktreePath: string): Promise<boolean> {
    return this.gitWorktrees.isRegisteredWorktreePath(repoPath, worktreePath);
  }

  /**
   * Fetch a remote branch from origin and create a local tracking branch.
   * When prNumber is provided, fetches via `refs/pull/<n>/head` refspec.
   */
  async fetchBranch(
    workspaceId: string,
    branch: string,
    prNumber?: number,
  ): Promise<void> {
    await this.gitRepository.fetchBranch(workspaceId, branch, prNumber);
  }

  /**
   * Create a new git worktree in the mcode data directory.
   * Returns the worktree metadata including the filesystem path, whether this
   * call created the branch or attached to an existing one, and any non-fatal
   * warnings (e.g. post-checkout hook failures).
   */
  async createWorktree(
    repoPath: string,
    name: string,
    branchName?: string,
    options: { branchless?: boolean; baseRef?: string } = {},
  ): Promise<WorktreeInfo & { createdBranch: boolean; warnings: string[] }> {
    return this.gitWorktrees.createWorktree(repoPath, name, branchName, options);
  }

  /**
   * Remove a git worktree by name.
   * Returns true only when the target worktree and managed parent directories are clean.
   * Returns false when a transient lock leaves a managed parent directory for retry.
   * When deleteBranch is true, deletes options.branchName or the default managed branch.
   * When worktreePath is set, removes that exact worktree path instead of deriving
   * one under the managed mcode worktree directory.
   */
  async removeWorktree(
    repoPath: string,
    name: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<boolean> {
    return this.gitWorktrees.removeWorktree(repoPath, name, options);
  }

  /**
   * Resolve the working directory for a thread, accounting for worktree mode.
   * Uses the thread's worktree_path when available, otherwise the workspace root.
   */
  resolveWorkingDir(
    workspacePath: string,
    threadMode: string | null,
    worktreePath: string | null,
  ): string {
    return this.gitWorktrees.resolveWorkingDir(workspacePath, threadMode, worktreePath);
  }

  /** Get commit log for a workspace. When baseBranch is provided, only returns commits on branch that are not on baseBranch. Pass repoPath to run from a worktree directory instead of the workspace root. */
  async log(
    workspaceId: string,
    branch?: string,
    limit = 50,
    baseBranch?: string,
    repoPath?: string,
    skip = 0,
    includeStats = true,
  ): Promise<GitCommit[]> {
    return this.gitComparison.listCommits(workspaceId, branch, limit, baseBranch, repoPath, skip, includeStats);
  }

  /** Get the unified diff for a specific Git commit. */
  async commitDiff(workspaceId: string, sha: string, filePath?: string, maxLines?: number): Promise<string> {
    return this.gitComparison.readCommitDiff(workspaceId, sha, filePath, maxLines);
  }

  /** List files changed in a specific Git commit. */
  async commitFiles(workspaceId: string, sha: string): Promise<string[]> {
    return this.gitComparison.listCommitChangedFiles(workspaceId, sha);
  }

  /** List changed files in a working tree. */
  async workingTreeFiles(workspaceId: string, staged: boolean, repoPath?: string): Promise<string[]> {
    return this.gitComparison.listWorkingTreeChangedFiles(workspaceId, staged, repoPath);
  }

  /** Get a working-tree diff, optionally for a single file. */
  async workingTreeDiff(workspaceId: string, staged: boolean, filePath?: string, maxLines?: number, repoPath?: string): Promise<string> {
    return this.gitComparison.readWorkingTreeDiff(workspaceId, staged, filePath, maxLines, repoPath);
  }

  /** List files changed on the target side of a branch comparison. */
  async branchFiles(workspaceId: string, base?: string, target?: string, repoPath?: string): Promise<string[]> {
    return this.gitComparison.listBranchComparisonChangedFiles(workspaceId, base, target, repoPath);
  }

  /** Get a branch comparison diff, optionally for one file. */
  async branchDiff(workspaceId: string, base?: string, target?: string, filePath?: string, maxLines?: number, repoPath?: string): Promise<string> {
    return this.gitComparison.readBranchComparisonDiff(workspaceId, base, target, filePath, maxLines, repoPath);
  }

  /** Return one file and stat batch for a Review comparison. */
  async reviewComparison(workspaceId: string, view: "unstaged" | "staged" | "branch" | "commit", opts: { base?: string; target?: string; sha?: string }, repoPath?: string): Promise<ReviewComparison> {
    return this.gitComparison.readReviewComparison(workspaceId, view, opts, repoPath);
  }

  /** Return additions and deletions for a Review comparison. */
  async reviewDiffStats(workspaceId: string, view: "unstaged" | "staged" | "branch" | "commit", opts: { base?: string; target?: string; sha?: string }, repoPath?: string): Promise<{ additions: number; deletions: number }> {
    return this.gitComparison.readReviewDiffStats(workspaceId, view, opts, repoPath);
  }

  /** Resolve the default branch comparison for a checkout. */
  async resolveBranchComparison(workspaceId: string, repoPath?: string, savedBaseBranch?: string | null): Promise<BranchComparison> {
    return this.gitComparison.resolveBranchComparison(workspaceId, repoPath, savedBaseBranch);
  }
  /** Push a branch to the origin remote, creating the upstream tracking ref if needed. */
  async push(repoPath: string, branch: string): Promise<void> {
    await this.gitRepository.push(repoPath, branch);
  }

  /** Return a diff stat summary between two refs. */
  async diffStat(repoPath: string, base: string, head: string): Promise<string> {
    return this.gitComparison.readBranchComparisonDiffStat(repoPath, base, head);
  }

  /**
   * Check whether the working tree at repoPath has no uncommitted changes.
   * Returns true only for genuinely clean trees or paths git reports as
   * "not a git repository". Other failures (timeouts, permission errors)
   * return false so a dirty repo is never silently labelled clean — the
   * UI then surfaces the warning state instead of the green "clean" pill.
   */
  async isWorkingTreeClean(repoPath: string): Promise<boolean> {
    return this.worktreeSafety.isWorkingTreeClean(repoPath);
  }

  /** Compare bounded active sibling paths by canonical filesystem identity. */
  async assessWorktreeRemovalSafety(
    worktreePath: string,
    activeSiblingPaths: readonly string[],
    truncated: boolean,
  ): Promise<WorktreeRemovalSafety> {
    return this.worktreeSafety.assessWorktreeRemovalSafety(
      worktreePath,
      activeSiblingPaths,
      truncated,
    );
  }

  /** Verify that a branchless worktree is clean and has no commits beyond its base. */
  async assessBranchlessWorktreeRemoval(
    worktreePath: string,
    baseBranch: string,
  ): Promise<BranchlessWorktreeRemovalSafety> {
    return this.worktreeSafety.assessBranchlessWorktreeRemoval(worktreePath, baseBranch);
  }

  /** Verify that a named worktree is accessible and has no uncommitted files. */
  async assessNamedWorktreeRemoval(worktreePath: string): Promise<NamedWorktreeRemovalSafety> {
    return this.worktreeSafety.assessNamedWorktreeRemoval(worktreePath);
  }

  /** Serialize Review provisioning and cleanup mutations for one repository. */
  async withReviewWorktreeMutationLock<T>(
    repoPath: string,
    action: () => Promise<T> | T,
  ): Promise<T> {
    return this.pullRequestReviews.withReviewWorktreeMutationLock(repoPath, async () => action());
  }


}
