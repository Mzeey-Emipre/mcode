import { WS_METHODS, type Thread, type Workspace, type WsMethodName } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { z } from "zod";
import type { GoalLifecycleService } from "../../../agents/goals/goal-lifecycle-service.js";
import { broadcast } from "../../../../application/transport/push.js";
import type { GithubService } from "../../../pull-requests/github/github-service.js";
import type { CiWatcherService } from "../../../pull-requests/status/ci-watcher.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { ThreadCompletionService } from "../../../thread-control/lifecycle/thread-completion-service.js";
import type { ThreadService } from "../../../thread-control/lifecycle/thread-service.js";
import type { ThreadDeletionTeardownService } from "../../../thread-control/lifecycle/thread-deletion-teardown-service.js";
import type { ProjectActionService } from "../../environment/project-action-service.js";
import type { WorkspaceEnvironmentService } from "../../environment/workspace-environment-service.js";
import type { GitWatcherService } from "../../git/git-watcher-service.js";
import type { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import type { FilesystemBrowser } from "../filesystem-browser.js";
import type { WorkspaceEnricher } from "../workspace-enricher.js";
import type { WorkspaceService } from "../workspace-service.js";

type WorkspaceThreadRpcMethod = Exclude<
  Extract<WsMethodName, `workspace.${string}` | `thread.${string}` | "filesystem.browse">,
  `workspace.environment.${string}` | `thread.control.${string}` | "thread.getTasks"
>;

type WorkspaceThreadRpcParamsByMethod = {
  [Method in WorkspaceThreadRpcMethod]: z.output<
    ReturnType<typeof WS_METHODS>[Method]["params"]
  >;
};

type WorkspaceThreadRpcHandlerMap = {
  [Method in WorkspaceThreadRpcMethod]: (
    deps: WorkspaceThreadRouterDeps,
    params: WorkspaceThreadRpcParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

type PrSyncThread = Pick<
  Thread,
  "id" | "branch" | "mode" | "checkout_state" | "pr_number" | "pr_status"
>;

type PrSyncResult = { threadId: string; prNumber: number; prStatus: string };

/** Defines the feature services required to route validated Workspace and Thread RPC calls. */
export interface WorkspaceThreadRouterDeps {
  workspaceService: Pick<WorkspaceService, "create" | "delete" | "findById" | "forceDelete" | "list" | "rename" | "reorder" | "touch">;
  workspaceEnvironmentService: Pick<
    WorkspaceEnvironmentService,
    "beginThreadDeletion" | "beginWorkspaceDeletion" | "cancelSetupForThread" | "cancelSetupForWorkspace" | "clearApprovals" | "read"
  >;
  projectActionService: Pick<ProjectActionService, "beginThreadTeardown" | "beginWorkspaceTeardown" | "reopenThread" | "stopForThread">;
  threadService: Pick<ThreadService, "create" | "delete" | "findById" | "linkPr" | "list" | "listRecent" | "markViewed" | "search" | "updateSettings" | "updateTitle">;
  goalLifecycleService: Pick<GoalLifecycleService, "clear" | "get">;
  threadCompletionService: Pick<ThreadCompletionService, "cleanupBlockedCount" | "complete" | "reopen" | "retryCleanup">;
  threadDeletionTeardownService: Pick<ThreadDeletionTeardownService, "teardownThread">;
  threadRepo: Pick<ThreadRepo, "findById" | "listAllByWorkspace">;
  workspaceRepo: Pick<WorkspaceRepo, "findById" | "removeRecent" | "setPinned" | "touchLastOpened">;
  gitWatcherService: Pick<GitWatcherService, "retryWatch" | "unwatchThreadWorktree" | "unwatchWorkspace" | "watchThreadWorktree" | "watchWorkspace">;
  githubService: Pick<GithubService, "cancelForRepoPath" | "getBranchPr" | "getPullRequestWatchSnapshots">;
  ciWatcherService: Pick<CiWatcherService, "refresh" | "teardownThread" | "unwatch" | "watch">;
  enricher: Pick<WorkspaceEnricher, "enrich">;
  filesystemBrowser: Pick<FilesystemBrowser, "browse">;
}

const workspaceThreadHandlers = {
  "workspace.list": (deps) => deps.workspaceService.list(),
  "workspace.create": createWorkspace,
  "workspace.rename": (deps, params) => deps.workspaceService.rename(params.id, params.name),
  "workspace.delete": (deps, params) => deleteWorkspace(deps, params.id),
  "workspace.forceDelete": (deps, params) => forceDeleteWorkspace(deps, params.id),
  "workspace.pin": (deps, params) => {
    deps.workspaceRepo.setPinned(params.id, params.pinned);
    return { ok: true as const };
  },
  "workspace.removeRecent": (deps, params) => {
    deps.workspaceRepo.removeRecent(params.id);
    return { ok: true as const };
  },
  "workspace.touchLastOpened": (deps, params) => {
    deps.workspaceRepo.touchLastOpened(params.id);
    return { ok: true as const };
  },
  "workspace.reorder": (deps, params) => {
    deps.workspaceService.reorder(params.id, params.newIndex);
    broadcast("workspace.orderChanged", {});
    return { ok: true as const };
  },
  "workspace.enrich": enrichWorkspaces,
  "filesystem.browse": (deps, params) => deps.filesystemBrowser.browse(params.path),
  "thread.list": listThreads,
  "thread.recent": (deps, params) => deps.threadService.listRecent(params.limit),
  "thread.create": createThread,
  "thread.delete": (deps, params) => deleteThread(deps, params),
  "thread.complete": (deps, params) => completeThread(deps, params.threadId),
  "thread.reopen": (deps, params) => reopenThread(deps, params.threadId),
  "thread.cleanupBlockedCount": (deps) => deps.threadCompletionService.cleanupBlockedCount(),
  "thread.retryCleanup": (deps, params) => retryThreadCleanup(deps, params.threadId),
  "thread.updateTitle": (deps, params) => deps.threadService.updateTitle(params.threadId, params.title),
  "thread.updateSettings": updateThreadSettings,
  "thread.markViewed": (deps, params) => deps.threadService.markViewed(params.threadId),
  "thread.goal.get": (deps, params) => deps.goalLifecycleService.get(params.threadId),
  "thread.goal.clear": (deps, params) => deps.goalLifecycleService.clear(params.threadId),
  "thread.search": (deps, params) => deps.threadService.search({
    query: params.query,
    filters: params.filters,
    sort: params.sort,
    limit: params.limit,
  }),
  "thread.syncPrs": (deps, params) => syncThreadPullRequests(deps, params.workspaceId),
} satisfies WorkspaceThreadRpcHandlerMap;

/** Checks whether a WebSocket method belongs to the Workspace and Thread RPC families. */
export function isWorkspaceThreadRpcMethod(
  method: WsMethodName,
): method is WorkspaceThreadRpcMethod {
  return Object.hasOwn(workspaceThreadHandlers, method);
}

/** Routes validated Workspace and Thread RPC parameters to their feature services. */
export async function routeWorkspaceThreadRpc<Method extends WorkspaceThreadRpcMethod>(
  method: Method,
  params: WorkspaceThreadRpcParamsByMethod[Method],
  deps: WorkspaceThreadRouterDeps,
): Promise<unknown> {
  return await workspaceThreadHandlers[method](deps, params);
}

async function createWorkspace(
  deps: WorkspaceThreadRouterDeps,
  params: { name: string; path: string },
): Promise<Workspace> {
  const workspace = await deps.workspaceService.create(params.name, params.path);
  await deps.workspaceEnvironmentService.read(workspace.id);
  try {
    deps.gitWatcherService.watchWorkspace(workspace.id, workspace.path);
  } catch (error) {
    logger.warn("Failed to start branch watcher for workspace", {
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return workspace;
}

async function deleteWorkspace(
  deps: WorkspaceThreadRouterDeps,
  workspaceId: string,
): Promise<boolean> {
  return await deleteWorkspaceWithTeardown(
    deps,
    workspaceId,
    (id) => deps.workspaceService.delete(id),
    () => broadcast("workspace.orderChanged", {}),
  );
}

async function forceDeleteWorkspace(
  deps: WorkspaceThreadRouterDeps,
  workspaceId: string,
): Promise<boolean> {
  return await deleteWorkspaceWithTeardown(
    deps,
    workspaceId,
    (id) => deps.workspaceService.forceDelete(id),
    () => {
      broadcast("workspace.deleted", { workspaceId });
      broadcast("workspace.orderChanged", {});
    },
  );
}

async function deleteWorkspaceWithTeardown(
  deps: WorkspaceThreadRouterDeps,
  workspaceId: string,
  removeWorkspace: (workspaceId: string) => boolean,
  publishDeleted: () => void,
): Promise<boolean> {
  const releaseDeletionBarrier = deps.workspaceEnvironmentService.beginWorkspaceDeletion(workspaceId);
  const releaseActionAdmission = await deps.projectActionService.beginWorkspaceTeardown(workspaceId);
  try {
    await teardownWorkspaceThreads(deps, workspaceId);
    const deleted = removeWorkspace(workspaceId);
    if (deleted) {
      deps.workspaceEnvironmentService.clearApprovals(workspaceId);
      deps.gitWatcherService.unwatchWorkspace(workspaceId);
      publishDeleted();
    }
    return deleted;
  } finally {
    releaseActionAdmission();
    releaseDeletionBarrier();
  }
}

async function enrichWorkspaces(
  deps: WorkspaceThreadRouterDeps,
  params: { ids: string[] },
): Promise<{ items: unknown }> {
  const workspaces = params.ids
    .map((id) => deps.workspaceRepo.findById(id))
    .filter((workspace): workspace is NonNullable<typeof workspace> => workspace !== null && workspace !== undefined)
    .map((workspace) => ({ id: workspace.id, path: workspace.path }));
  return { items: await deps.enricher.enrich(workspaces) };
}

function listThreads(
  deps: WorkspaceThreadRouterDeps,
  params: { workspaceId: string },
): Thread[] {
  deps.workspaceService.touch(params.workspaceId);
  // Re-detect git status for non-git workspaces (catches `git init` within a session)
  const workspace = deps.workspaceService.findById(params.workspaceId);
  if (workspace && !workspace.is_git_repo) {
    deps.gitWatcherService.retryWatch(workspace.id, workspace.path);
  }
  return deps.threadService.list(params.workspaceId);
}

async function createThread(
  deps: WorkspaceThreadRouterDeps,
  params: { workspaceId: string; title: string; mode: string; branch: string },
): Promise<Thread> {
  const thread = await deps.threadService.create(
    params.workspaceId,
    params.title,
    params.mode,
    params.branch,
    { branchless: params.mode === "worktree" },
  );
  watchReturnedThreadWorktree(deps, thread);
  return thread;
}

function watchReturnedThreadWorktree(
  deps: WorkspaceThreadRouterDeps,
  thread: unknown,
): void {
  const maybeThread = thread as { id?: string; mode?: string; worktree_path?: string | null } | null;
  if (maybeThread?.mode !== "worktree" || !maybeThread.worktree_path || !maybeThread.id) return;
  void Promise.resolve(
    deps.gitWatcherService?.watchThreadWorktree?.(maybeThread.id, maybeThread.worktree_path),
  ).catch((error) => {
    logger.warn("Failed to start thread worktree watcher", {
      threadId: maybeThread.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function deleteThread(
  deps: WorkspaceThreadRouterDeps,
  params: { threadId: string; cleanupWorktree: boolean },
): Promise<boolean> {
  await deps.threadDeletionTeardownService.teardownThread(params.threadId);
  return await deps.threadService.delete(params.threadId, params.cleanupWorktree);
}

async function completeThread(
  deps: WorkspaceThreadRouterDeps,
  threadId: string,
): Promise<Thread> {
  let lifecyclePublished = false;
  try {
    const completed = await deps.threadCompletionService.complete(threadId);
    broadcast("thread.lifecycleChanged", { thread: completed });
    lifecyclePublished = true;
    return completed;
  } catch (error) {
    const persisted = deps.threadRepo.findById(threadId);
    if (!lifecyclePublished && persisted && persisted.user_completed_at !== null) {
      broadcast("thread.lifecycleChanged", { thread: persisted });
    }
    throw error;
  }
}

function reopenThread(deps: WorkspaceThreadRouterDeps, threadId: string): Thread {
  const reopened = deps.threadCompletionService.reopen(threadId);
  deps.projectActionService.reopenThread(threadId);
  broadcast("thread.lifecycleChanged", { thread: reopened });
  return reopened;
}

function retryThreadCleanup(deps: WorkspaceThreadRouterDeps, threadId: string): Thread {
  const queued = deps.threadCompletionService.retryCleanup(threadId);
  broadcast("thread.lifecycleChanged", { thread: queued });
  return queued;
}

function updateThreadSettings(
  deps: WorkspaceThreadRouterDeps,
  params: {
    threadId: string;
    reasoningLevel?: string;
    interactionMode?: string;
    orchestrationMode?: string;
    permissionMode?: string;
    copilotAgent?: string | null;
    contextWindow?: Thread["context_window_mode"];
    thinking?: boolean | null;
    codexFastMode?: boolean | null;
    defaultOpenInApp?: string | null;
  },
): boolean {
  return deps.threadService.updateSettings(params.threadId, {
    reasoning_level: params.reasoningLevel,
    interaction_mode: params.interactionMode,
    orchestration_mode: params.orchestrationMode,
    permission_mode: params.permissionMode,
    copilot_agent: params.copilotAgent,
    context_window_mode: params.contextWindow,
    thinking: params.thinking,
    codex_fast_mode: params.codexFastMode,
    default_open_in_app: params.defaultOpenInApp,
  });
}

async function syncThreadPullRequests(
  deps: WorkspaceThreadRouterDeps,
  workspaceId: string,
): Promise<PrSyncResult[]> {
  const syncWorkspace = deps.workspaceService.findById(workspaceId);
  if (!syncWorkspace?.is_git_repo) return [];
  const threads = deps.threadService.list(workspaceId).filter(isNamedWorktreeThread);
  const candidates = threads.filter(needsPullRequestCheck);
  if (candidates.length === 0) return [];
  const workspace = deps.workspaceService.findById(workspaceId);
  if (!workspace) return [];
  const results: PrSyncResult[] = [];
  await syncLinkedPullRequests(deps, candidates, workspace, results);
  await syncUnlinkedPullRequests(deps, candidates, workspace, results);
  return results;
}

function isNamedWorktreeThread(thread: Thread): boolean {
  return thread.mode === "worktree" && thread.checkout_state === "named";
}

/** Returns true if the thread has no linked PR, missing status, or a non-terminal PR state. */
function needsPullRequestCheck(thread: PrSyncThread): boolean {
  return thread.pr_number === null || thread.pr_status === null || !isTerminalPullRequestState(thread.pr_status);
}

function isTerminalPullRequestState(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "merged" || normalized === "closed";
}

async function syncLinkedPullRequests(
  deps: WorkspaceThreadRouterDeps,
  candidates: readonly PrSyncThread[],
  workspace: Workspace,
  results: PrSyncResult[],
): Promise<void> {
  const linkedThreads = candidates.filter(
    (thread): thread is PrSyncThread & { pr_number: number } => thread.pr_number !== null,
  );
  if (linkedThreads.length === 0) return;
  const linkedThreadsById = new Map(linkedThreads.map((thread) => [thread.id, thread]));
  const snapshots = await deps.githubService.getPullRequestWatchSnapshots(
    linkedThreads.map((thread) => ({
      threadId: thread.id,
      prNumber: thread.pr_number,
      repoPath: workspace.path,
    })),
  );
  for (const snapshot of snapshots) {
    if (!linkedThreadsById.has(snapshot.threadId)) continue;
    const thread = deps.threadService.findById(snapshot.threadId);
    if (!thread || thread.pr_number !== snapshot.prNumber) continue;
    if (thread.pr_status?.toLowerCase() !== snapshot.state.toLowerCase()) {
      deps.threadService.linkPr(thread.id, snapshot.prNumber, snapshot.state);
      results.push({ threadId: thread.id, prNumber: snapshot.prNumber, prStatus: snapshot.state });
    }
    refreshLinkedPullRequestWatcher(deps, thread, snapshot, workspace.path);
  }
}

function refreshLinkedPullRequestWatcher(
  deps: WorkspaceThreadRouterDeps,
  thread: Thread,
  snapshot: Awaited<ReturnType<GithubService["getPullRequestWatchSnapshots"]>>[number],
  workspacePath: string,
): void {
  if (snapshot.state === "OPEN") {
    deps.ciWatcherService.watch(
      thread.id,
      snapshot.prNumber,
      thread.branch,
      workspacePath,
      { skipInitialFetch: true },
    );
    deps.ciWatcherService.refresh(thread.id, snapshot.checks);
    return;
  }
  deps.ciWatcherService.unwatch(thread.id);
}

async function syncUnlinkedPullRequests(
  deps: WorkspaceThreadRouterDeps,
  candidates: readonly PrSyncThread[],
  workspace: Workspace,
  results: PrSyncResult[],
): Promise<void> {
  const unlinkedThreads = candidates.filter((thread) => thread.pr_number === null);
  await Promise.allSettled(
    unlinkedThreads.map((thread) => syncUnlinkedPullRequest(deps, thread, workspace.path, results)),
  );
}

async function syncUnlinkedPullRequest(
  deps: WorkspaceThreadRouterDeps,
  thread: PrSyncThread,
  workspacePath: string,
  results: PrSyncResult[],
): Promise<void> {
  const pullRequest = await deps.githubService.getBranchPr(thread.branch, workspacePath);
  if (!pullRequest) return;
  const numberChanged = thread.pr_number !== pullRequest.number;
  const statusChanged = thread.pr_status?.toLowerCase() !== pullRequest.state.toLowerCase();
  if (numberChanged || statusChanged) {
    deps.threadService.linkPr(thread.id, pullRequest.number, pullRequest.state);
    results.push({ threadId: thread.id, prNumber: pullRequest.number, prStatus: pullRequest.state });
  }
  // Start CI watching if PR is not in terminal state.
  // Unwatch first when the PR number changed so the watcher targets the new PR.
  if (!isTerminalPullRequestState(pullRequest.state)) {
    if (numberChanged) deps.ciWatcherService.unwatch(thread.id);
    deps.ciWatcherService.watch(thread.id, pullRequest.number, thread.branch, workspacePath);
    return;
  }
  deps.ciWatcherService.unwatch(thread.id);
}

async function teardownWorkspaceThreads(
  deps: WorkspaceThreadRouterDeps,
  workspaceId: string,
): Promise<void> {
  await deps.workspaceEnvironmentService.cancelSetupForWorkspace(workspaceId);
  const threads = deps.threadRepo.listAllByWorkspace(workspaceId);
  const results = await Promise.allSettled(
    threads.map((thread) => teardownWorkspaceThread(deps, thread)),
  );
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length === 0) {
    for (const thread of threads) {
      deps.gitWatcherService?.unwatchThreadWorktree?.(thread.id);
    }
    return;
  }
  throw new Error(
    `Workspace teardown failed for ${workspaceId}: ${failures.map(teardownFailureMessage).join("; ")}`,
  );
}

async function teardownWorkspaceThread(
  deps: WorkspaceThreadRouterDeps,
  thread: Pick<Thread, "id">,
): Promise<void> {
  await deps.threadDeletionTeardownService.teardownThread(thread.id);
}

function teardownFailureMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}
