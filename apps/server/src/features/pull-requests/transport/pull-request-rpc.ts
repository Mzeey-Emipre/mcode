import type {
  PullRequestCapabilitiesRequest,
  PullRequestCancelRequest,
  PullRequestCloseRequest,
  PullRequestCreateReviewTaskRequest,
  PullRequestFilesRequest,
  PullRequestGetRequest,
  PullRequestListRequest,
  PullRequestMergeRequest,
  PullRequestPatchRequest,
  PullRequestPostCommentRequest,
  PullRequestReviewLinkRequest,
  PullRequestSetReadinessRequest,
  PullRequestSubmitReviewRequest,
  PullRequestTimelineRequest,
  Thread,
  Workspace,
  WsMethodName,
} from "@mcode/contracts";
import { validateBranchName } from "@mcode/shared";
import type { WebSocket } from "ws";
import type { GitRepositoryService } from "../../projects/git/git-repository-service.js";
import type { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import type { WorkspaceService } from "../../projects/lifecycle/workspace-service.js";
import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import type { ThreadService } from "../../thread-control/lifecycle/thread-service.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { broadcast } from "../../../application/transport/push.js";
import type { PrDraftService } from "../drafts/pr-draft-service.js";
import type { GithubService } from "../github/github-service.js";
import type { PullRequestMutationService } from "../mutations/pull-request-mutation-service.js";
import type { PullRequestService } from "../queries/pull-request-service.js";
import type { ReviewWorktreeService } from "../reviews/review-worktree-service.js";
import type { CiWatcherService, WatchEntry } from "../status/ci-watcher.js";

type GithubPullRequestMethod =
  | "github.branchPr"
  | "github.listOpenPrs"
  | "github.prByUrl"
  | "github.checkStatus"
  | "github.generatePrDraft"
  | "github.createPr";

type PullRequestOperationMethod =
  | "pullRequest.capabilities"
  | "pullRequest.list"
  | "pullRequest.get"
  | "pullRequest.timeline"
  | "pullRequest.files"
  | "pullRequest.patch"
  | "pullRequest.cancel"
  | "pullRequest.createReviewTask"
  | "pullRequest.reviewLink"
  | "pullRequest.postComment"
  | "pullRequest.submitReview"
  | "pullRequest.setReadiness"
  | "pullRequest.close"
  | "pullRequest.merge";

type PullRequestRpcMethod = GithubPullRequestMethod | PullRequestOperationMethod;

type GithubBranchPrParams = { branch: string; cwd: string };
type GithubListOpenPrsParams = { workspaceId: string };
type GithubPrByUrlParams = { url: string };
type GithubCheckStatusParams = { threadId: string; force?: boolean };
type GithubGeneratePrDraftParams = { workspaceId: string; threadId: string; baseBranch: string };
type GithubCreatePrParams = {
  workspaceId: string;
  threadId: string;
  title: string;
  body: string;
  baseBranch: string;
  isDraft: boolean;
};

type PullRequestOperationParams = {
  "pullRequest.capabilities": PullRequestCapabilitiesRequest;
  "pullRequest.list": PullRequestListRequest;
  "pullRequest.get": PullRequestGetRequest;
  "pullRequest.timeline": PullRequestTimelineRequest;
  "pullRequest.files": PullRequestFilesRequest;
  "pullRequest.patch": PullRequestPatchRequest;
  "pullRequest.cancel": PullRequestCancelRequest;
  "pullRequest.createReviewTask": PullRequestCreateReviewTaskRequest;
  "pullRequest.reviewLink": PullRequestReviewLinkRequest;
  "pullRequest.postComment": PullRequestPostCommentRequest;
  "pullRequest.submitReview": PullRequestSubmitReviewRequest;
  "pullRequest.setReadiness": PullRequestSetReadinessRequest;
  "pullRequest.close": PullRequestCloseRequest;
  "pullRequest.merge": PullRequestMergeRequest;
};

type PullRequestOperationHandler = (
  deps: PullRequestRouterDeps,
  params: unknown,
  connection: object,
) => Promise<unknown> | unknown;

const DEFAULT_PULL_REQUEST_CONNECTION = {};

const githubPullRequestMethods: Record<GithubPullRequestMethod, true> = {
  "github.branchPr": true,
  "github.listOpenPrs": true,
  "github.prByUrl": true,
  "github.checkStatus": true,
  "github.generatePrDraft": true,
  "github.createPr": true,
};

const pullRequestOperationHandlers = {
  "pullRequest.capabilities": (deps, params, connection) =>
    deps.pullRequestService.capabilities(
      operationParams<"pullRequest.capabilities">(params),
      connection,
    ),
  "pullRequest.list": (deps, params, connection) =>
    deps.pullRequestService.list(operationParams<"pullRequest.list">(params), connection),
  "pullRequest.get": (deps, params, connection) =>
    deps.pullRequestService.get(operationParams<"pullRequest.get">(params), connection),
  "pullRequest.timeline": (deps, params, connection) =>
    deps.pullRequestService.timeline(operationParams<"pullRequest.timeline">(params), connection),
  "pullRequest.files": (deps, params, connection) =>
    deps.pullRequestService.files(operationParams<"pullRequest.files">(params), connection),
  "pullRequest.patch": (deps, params, connection) =>
    deps.pullRequestService.patch(operationParams<"pullRequest.patch">(params), connection),
  "pullRequest.cancel": (deps, params, connection) =>
    deps.pullRequestService.cancel(connection, operationParams<"pullRequest.cancel">(params).operationId),
  "pullRequest.createReviewTask": (deps, params) =>
    deps.reviewWorktreeService.createReviewTask(
      operationParams<"pullRequest.createReviewTask">(params),
    ),
  "pullRequest.reviewLink": (deps, params) =>
    deps.reviewWorktreeService.getReviewLink(
      operationParams<"pullRequest.reviewLink">(params).threadId,
    ),
  "pullRequest.postComment": (deps, params) =>
    deps.pullRequestMutationService.postComment(
      operationParams<"pullRequest.postComment">(params),
    ),
  "pullRequest.submitReview": (deps, params) =>
    deps.pullRequestMutationService.submitReview(
      operationParams<"pullRequest.submitReview">(params),
    ),
  "pullRequest.setReadiness": (deps, params) =>
    deps.pullRequestMutationService.setReadiness(
      operationParams<"pullRequest.setReadiness">(params),
    ),
  "pullRequest.close": (deps, params) =>
    deps.pullRequestMutationService.close(operationParams<"pullRequest.close">(params)),
  "pullRequest.merge": (deps, params) =>
    deps.pullRequestMutationService.merge(operationParams<"pullRequest.merge">(params)),
} satisfies Record<PullRequestOperationMethod, PullRequestOperationHandler>;

/** Defines the services required to route validated pull-request RPC calls. */
export interface PullRequestRouterDeps {
  githubService: GithubService;
  pullRequestService: PullRequestService;
  pullRequestMutationService: PullRequestMutationService;
  reviewWorktreeService: ReviewWorktreeService;
  prDraftService: PrDraftService;
  ciWatcherService: CiWatcherService;
  workspaceService: WorkspaceService;
  workspaceRepo: WorkspaceRepo;
  threadService: ThreadService;
  threadRepo: ThreadRepo;
  gitRepository: GitRepositoryService;
  gitWorktrees: GitWorktreeService;
}

/** Checks whether a method belongs to the pull-request RPC family. */
export function isPullRequestRpcMethod(method: WsMethodName): method is PullRequestRpcMethod {
  return Object.hasOwn(githubPullRequestMethods, method)
    || Object.hasOwn(pullRequestOperationHandlers, method);
}

/** Routes validated pull-request RPC parameters to the pull-request feature. */
export async function routePullRequestRpc(
  method: WsMethodName,
  params: unknown,
  deps: PullRequestRouterDeps,
  client: WebSocket | undefined,
): Promise<unknown> {
  if (!isPullRequestRpcMethod(method)) {
    throw new Error(`Unsupported pull request method: ${method}`);
  }

  const connection = client ?? DEFAULT_PULL_REQUEST_CONNECTION;
  if (isPullRequestOperationMethod(method)) {
    return pullRequestOperationHandlers[method](deps, params, connection);
  }

  switch (method) {
    case "github.branchPr": {
      const request = githubParams<GithubBranchPrParams>(params);
      return deps.githubService.getBranchPr(request.branch, request.cwd);
    }
    case "github.listOpenPrs":
      return deps.githubService.listOpenPrs(
        githubParams<GithubListOpenPrsParams>(params).workspaceId,
      );
    case "github.prByUrl":
      return deps.githubService.getPrByUrl(githubParams<GithubPrByUrlParams>(params).url);
    case "github.checkStatus":
      return routeCheckStatus(deps, githubParams<GithubCheckStatusParams>(params));
    case "github.generatePrDraft": {
      const request = githubParams<GithubGeneratePrDraftParams>(params);
      return await deps.prDraftService.generateDraft(
        request.workspaceId,
        request.threadId,
        request.baseBranch,
      );
    }
    case "github.createPr":
      return routeCreatePr(deps, githubParams<GithubCreatePrParams>(params));
  }
}

function isPullRequestOperationMethod(method: PullRequestRpcMethod): method is PullRequestOperationMethod {
  return Object.hasOwn(pullRequestOperationHandlers, method);
}

function operationParams<M extends PullRequestOperationMethod>(
  params: unknown,
): PullRequestOperationParams[M] {
  return params as PullRequestOperationParams[M];
}

function githubParams<T>(params: unknown): T {
  return params as T;
}

async function routeCheckStatus(
  deps: PullRequestRouterDeps,
  params: GithubCheckStatusParams,
): Promise<unknown> {
  const stalenessMs = 15_000;
  if (!params.force) {
    const fresh = deps.ciWatcherService.getFreshCache(params.threadId, stalenessMs);
    if (fresh) return fresh;
  }

  let entry = deps.ciWatcherService.getEntry(params.threadId);
  if (!entry) {
    const bootstrap = bootstrapCheckStatusWatch(deps, params.threadId);
    if (bootstrap.kind === "terminal") {
      return deps.githubService.getCheckRuns(bootstrap.branch, bootstrap.repoPath);
    }
    entry = bootstrap.entry;
  }
  if (!entry) {
    return { aggregate: "no_checks" as const, runs: [], fetchedAt: Date.now() };
  }
  const checks = await deps.githubService.getCheckRuns(entry.branch, entry.repoPath);
  deps.ciWatcherService.refresh(params.threadId, checks);
  return checks;
}

function bootstrapCheckStatusWatch(
  deps: PullRequestRouterDeps,
  threadId: string,
): CheckStatusBootstrap {
  const thread = deps.threadRepo.findById(threadId);
  const prState = thread?.pr_status?.toLowerCase();
  const isTerminal = prState === "merged" || prState === "closed";
  if (
    !thread?.pr_number
    || thread.mode !== "worktree"
    || thread.checkout_state !== "named"
  ) {
    return { kind: "entry", entry: null };
  }

  const workspace = deps.workspaceRepo.findById(thread.workspace_id);
  if (!workspace) return { kind: "entry", entry: null };
  if (isTerminal) {
    return {
      kind: "terminal",
      branch: thread.branch,
      repoPath: workspace.path,
    };
  }
  deps.ciWatcherService.watch(
    threadId,
    thread.pr_number,
    thread.branch,
    workspace.path,
    { skipInitialFetch: true },
  );
  return { kind: "entry", entry: deps.ciWatcherService.getEntry(threadId) };
}

type CheckStatusBootstrap =
  | { kind: "entry"; entry: WatchEntry | null }
  | { kind: "terminal"; branch: string; repoPath: string };

async function routeCreatePr(
  deps: PullRequestRouterDeps,
  params: GithubCreatePrParams,
): Promise<unknown> {
  const { workspace, thread } = requirePrCreationContext(deps, params);
  const { repoPath, branch } = await resolvePrCreationBranch(deps, params.threadId, workspace, thread);

  await pushPullRequestBranch(deps, repoPath, branch);
  const result = await deps.githubService.createPr({
    cwd: repoPath,
    title: params.title,
    body: params.body,
    baseBranch: params.baseBranch,
    isDraft: params.isDraft,
  });

  deps.threadService.linkPr(params.threadId, result.number, "OPEN");
  broadcast("thread.prLinked", {
    threadId: params.threadId,
    prNumber: result.number,
    prStatus: "OPEN",
  });
  deps.ciWatcherService.unwatch(params.threadId);
  deps.ciWatcherService.watch(params.threadId, result.number, branch, repoPath);
  deps.ciWatcherService.scheduleBumpAfterPush(params.threadId);

  return result;
}

function requirePrCreationContext(
  deps: PullRequestRouterDeps,
  params: GithubCreatePrParams,
): { workspace: Workspace; thread: Thread } {
  const workspace = deps.workspaceService.findById(params.workspaceId);
  if (!workspace) throw new Error(`Workspace ${params.workspaceId} not found`);

  const thread = deps.threadService.findById(params.threadId);
  if (!thread) throw new Error(`Thread ${params.threadId} not found`);
  if (thread.workspace_id !== params.workspaceId) {
    throw new Error(`Thread ${params.threadId} does not belong to workspace ${params.workspaceId}`);
  }
  if (thread.mode !== "worktree" || thread.checkout_state !== "named") {
    throw new Error(
      `Thread ${params.threadId} must be a named worktree checkout before creating a PR`,
    );
  }
  return { workspace, thread };
}

async function resolvePrCreationBranch(
  deps: PullRequestRouterDeps,
  threadId: string,
  workspace: Workspace,
  thread: Thread,
): Promise<{ repoPath: string; branch: string }> {
  const repoPath = deps.gitWorktrees.resolveWorkingDir(
    workspace.path,
    thread.mode,
    thread.worktree_path,
  );
  const branch = thread.branch;
  if (!branch) throw new Error(`Missing branch for thread ${threadId}`);
  validateBranchName(branch);
  const currentBranch = await deps.gitRepository.getCurrentBranchAt(repoPath);
  if (!currentBranch || currentBranch === "HEAD" || currentBranch !== branch) {
    throw new Error(
      `Thread ${threadId} checkout is on ${currentBranch ?? "HEAD"}, expected ${branch}`,
    );
  }
  return { repoPath, branch };
}

async function pushPullRequestBranch(
  deps: PullRequestRouterDeps,
  repoPath: string,
  branch: string,
): Promise<void> {
  try {
    await deps.gitRepository.push(repoPath, branch);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to push branch "${branch}" to remote. Check push permissions. Details: ${detail}`,
    );
  }
}
