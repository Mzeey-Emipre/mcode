import { WS_METHODS, type WsMethodName } from "@mcode/contracts";
import type { z } from "zod";
import type { HandoffCheckoutService } from "../../../handoff/checkout/handoff-checkout-service.js";
import type { CiWatcherService } from "../../../pull-requests/status/ci-watcher.js";
import type { ReviewWorktreeService } from "../../../pull-requests/reviews/review-worktree-service.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { ThreadService } from "../../../thread-control/lifecycle/thread-service.js";
import { broadcast } from "../../../../application/transport/push.js";
import type { WorkspaceService } from "../../lifecycle/workspace-service.js";
import type { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import type { GitComparisonService } from "../git-comparison-service.js";
import type { GitRepositoryService } from "../git-repository-service.js";
import type { GitWorktreeService } from "../git-worktree-service.js";
import type { PullRequestReviewGitService } from "../pull-request-review-git-service.js";

type GitRpcMethod = Extract<WsMethodName, `git.${string}`>;

type GitRpcParamsByMethod = {
  [Method in GitRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

type ReviewPushTarget = Extract<
  ReturnType<ReviewWorktreeService["resolvePushTarget"]>,
  { kind: "review" }
>["target"];

/** Defines the services required to route validated Git RPC calls. */
export interface GitRouterDeps {
  workspaceService: Pick<WorkspaceService, "findById">;
  gitComparison: Pick<
    GitComparisonService,
    | "listCommits"
    | "readCommitDiff"
    | "listCommitChangedFiles"
    | "listWorkingTreeChangedFiles"
    | "readWorkingTreeDiff"
    | "listBranchComparisonChangedFiles"
    | "readBranchComparisonDiff"
    | "resolveBranchComparison"
    | "readReviewDiffStats"
    | "readReviewComparison"
  >;
  gitRepository: Pick<
    GitRepositoryService,
    | "listBranches"
    | "getCurrentBranch"
    | "checkout"
    | "getRemoteUrl"
    | "fetchBranch"
    | "getCurrentBranchAt"
    | "push"
  >;
  gitWorktrees: Pick<GitWorktreeService, "listWorktrees" | "resolveWorkingDir">;
  handoffCheckoutService: Pick<HandoffCheckoutService, "createBranchForThread">;
  threadService: Pick<ThreadService, "findById">;
  threadRepo: Pick<ThreadRepo, "findById">;
  workspaceRepo: Pick<WorkspaceRepo, "findById">;
  pullRequestReviews: Pick<PullRequestReviewGitService, "pushPullRequestReviewBranch">;
  reviewWorktreeService: Pick<ReviewWorktreeService, "resolvePushTarget">;
  ciWatcherService: Pick<CiWatcherService, "findByWorkspaceBranch" | "scheduleBumpAfterPush">;
}

type GitHandlerMap = {
  [Method in GitRpcMethod]: (
    deps: GitRouterDeps,
    params: GitRpcParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

const gitHandlers: GitHandlerMap = {
  "git.listBranches": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitRepository.listBranches(params.workspaceId)
      : [],
  "git.currentBranch": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitRepository.getCurrentBranch(params.workspaceId)
      : null,
  "git.checkout": async (deps, params) => {
    if (!isGitWorkspace(deps, params.workspaceId)) return;
    await deps.gitRepository.checkout(params.workspaceId, params.branch);
  },
  "git.createBranch": routeGitCreateBranch,
  "git.listWorktrees": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitWorktrees.listWorktrees(params.workspaceId)
      : [],
  "git.getRemoteUrl": (deps, params) =>
    deps.gitRepository.getRemoteUrl(
      resolveWorkspaceRepoPath(deps, params.workspaceId, params.threadId),
    ),
  "git.fetchBranch": async (deps, params) => {
    if (!isGitWorkspace(deps, params.workspaceId)) return;
    await deps.gitRepository.fetchBranch(params.workspaceId, params.branch, params.prNumber);
  },
  "git.log": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitComparison.listCommits(
        params.workspaceId,
        params.branch,
        params.limit,
        params.baseBranch,
        resolveThreadRepoPath(deps, params.threadId),
        params.skip,
        params.includeStats,
      )
      : [],
  "git.commitDiff": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitComparison.readCommitDiff(
        params.workspaceId,
        params.sha,
        params.filePath,
        params.maxLines,
      )
      : "",
  "git.commitFiles": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitComparison.listCommitChangedFiles(params.workspaceId, params.sha)
      : [],
  "git.workingTreeFiles": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitComparison.listWorkingTreeChangedFiles(
        params.workspaceId,
        params.staged,
        resolveThreadRepoPath(deps, params.threadId),
      )
      : [],
  "git.workingTreeDiff": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitComparison.readWorkingTreeDiff(
        params.workspaceId,
        params.staged,
        params.filePath,
        params.maxLines,
        resolveThreadRepoPath(deps, params.threadId),
      )
      : "",
  "git.branchFiles": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitComparison.listBranchComparisonChangedFiles(
        params.workspaceId,
        params.base,
        params.target,
        resolveThreadRepoPath(deps, params.threadId),
      )
      : [],
  "git.branchDiff": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitComparison.readBranchComparisonDiff(
        params.workspaceId,
        params.base,
        params.target,
        params.filePath,
        params.maxLines,
        resolveThreadRepoPath(deps, params.threadId),
      )
      : "",
  "git.branchComparison": (deps, params) => {
    if (!isGitWorkspace(deps, params.workspaceId)) {
      return { base: null, target: null, refs: [], isUnborn: false, isComparisonAvailable: false };
    }
    const thread = params.threadId ? deps.threadRepo.findById(params.threadId) : null;
    return deps.gitComparison.resolveBranchComparison(
      params.workspaceId,
      resolveThreadRepoPath(deps, params.threadId),
      thread?.checkout_state === "branchless" ? thread.base_branch ?? thread.branch : null,
    );
  },
  "git.reviewDiffStats": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitComparison.readReviewDiffStats(
        params.workspaceId,
        params.view,
        { base: params.base, target: params.target, sha: params.sha },
        resolveThreadRepoPath(deps, params.threadId),
      )
      : { additions: 0, deletions: 0 },
  "git.reviewComparison": (deps, params) =>
    isGitWorkspace(deps, params.workspaceId)
      ? deps.gitComparison.readReviewComparison(
        params.workspaceId,
        params.view,
        { base: params.base, target: params.target, sha: params.sha },
        resolveThreadRepoPath(deps, params.threadId),
      )
      : { files: [], additions: 0, deletions: 0 },
  "git.push": routeGitPush,
};

/** Checks whether a method belongs to the Git RPC family. */
export function isGitRpcMethod(method: WsMethodName): method is GitRpcMethod {
  return Object.hasOwn(gitHandlers, method);
}

/** Routes validated Git RPC parameters to feature services. */
export async function routeGitRpc<Method extends GitRpcMethod>(
  method: Method,
  params: GitRpcParamsByMethod[Method],
  deps: GitRouterDeps,
): Promise<unknown> {
  return await gitHandlers[method](deps, params);
}

function isGitWorkspace(deps: GitRouterDeps, workspaceId: string): boolean {
  return deps.workspaceService.findById(workspaceId)?.is_git_repo === true;
}

async function routeGitCreateBranch(
  deps: GitRouterDeps,
  params: GitRpcParamsByMethod["git.createBranch"],
): Promise<{ branch: string }> {
  const branch = await deps.handoffCheckoutService.createBranchForThread(
    params.workspaceId,
    params.threadId,
    params.name,
  );
  if (params.threadId) {
    broadcastThreadCheckoutChange(deps, params.threadId);
  }
  return { branch };
}

function broadcastThreadCheckoutChange(deps: GitRouterDeps, threadId: string): void {
  const thread = deps.threadService.findById(threadId);
  if (!thread) return;
  broadcast("thread.checkoutChanged", {
    threadId: thread.id,
    workspaceId: thread.workspace_id,
    branch: thread.branch,
    checkoutState: thread.checkout_state,
    baseBranch: thread.base_branch,
    prNumber: thread.pr_number,
    prStatus: thread.pr_status,
  });
}

function resolveThreadRepoPath(deps: GitRouterDeps, threadId?: string): string | undefined {
  if (!threadId) return undefined;
  const thread = deps.threadRepo.findById(threadId);
  const workspace = thread ? deps.workspaceRepo.findById(thread.workspace_id) : null;
  if (!thread || !workspace) return undefined;
  return deps.gitWorktrees.resolveWorkingDir(
    workspace.path,
    thread.mode,
    thread.worktree_path,
  );
}

function resolveWorkspaceRepoPath(
  deps: GitRouterDeps,
  workspaceId: string,
  threadId?: string,
): string {
  const workspace = deps.workspaceService.findById(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  if (!threadId) return workspace.path;

  const thread = deps.threadRepo.findById(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  if (thread.workspace_id !== workspaceId) {
    throw new Error(`Thread ${threadId} does not belong to workspace ${workspaceId}`);
  }
  return deps.gitWorktrees.resolveWorkingDir(
    workspace.path,
    thread.mode,
    thread.worktree_path,
  );
}

async function routeGitPush(
  deps: GitRouterDeps,
  params: GitRpcParamsByMethod["git.push"],
): Promise<{ success: true } | undefined> {
  const workspace = deps.workspaceService.findById(params.workspaceId);
  if (!workspace) throw new Error(`Workspace ${params.workspaceId} not found`);
  if (!workspace.is_git_repo) return;

  await pushToResolvedTarget(deps, params, workspace.path);
  schedulePushBumps(deps, params.workspaceId, params.branch);
  return { success: true };
}

async function pushToResolvedTarget(
  deps: GitRouterDeps,
  params: GitRpcParamsByMethod["git.push"],
  workspacePath: string,
): Promise<void> {
  const resolution = params.threadId
    ? deps.reviewWorktreeService.resolvePushTarget(params.threadId)
    : { kind: "standard" as const };
  if (resolution.kind === "invalid_review") {
    throw new Error("The Review task link changed. Reload the task before pushing.");
  }
  if (resolution.kind === "review") {
    await pushReviewTarget(deps, params, resolution.target);
    return;
  }
  await deps.gitRepository.push(workspacePath, params.branch);
}

async function pushReviewTarget(
  deps: GitRouterDeps,
  params: GitRpcParamsByMethod["git.push"],
  target: ReviewPushTarget,
): Promise<void> {
  if (target.workspaceId !== params.workspaceId || target.localBranch !== params.branch) {
    throw new Error("Review task push target does not match the requested Workspace branch.");
  }
  const currentBranch = await deps.gitRepository.getCurrentBranchAt(target.worktreePath);
  if (currentBranch !== target.localBranch) {
    throw new Error(
      `Review task checkout is on ${currentBranch ?? "detached HEAD"}, expected ${target.localBranch}.`,
    );
  }
  await deps.pullRequestReviews.pushPullRequestReviewBranch(
    target.worktreePath,
    target.pushRemote,
    target.pushRef,
    target.expectedHeadRepositoryUrl,
  );
}

function schedulePushBumps(
  deps: GitRouterDeps,
  workspaceId: string,
  branch: string,
): void {
  // Fresh CI runs appear 3-15s after push. Schedule bumps so the UI surfaces
  // "pending" without waiting a full passive poll cycle.
  const threadIds = deps.ciWatcherService.findByWorkspaceBranch(
    (id) => deps.threadRepo.findById(id),
    workspaceId,
    branch,
  );
  for (const threadId of threadIds) {
    deps.ciWatcherService.scheduleBumpAfterPush(threadId);
  }
}
