import { WS_METHODS, type WsMethodName } from "@mcode/contracts";
import type { z } from "zod";
import type { TurnSnapshotRepo } from "../../../agents/turns/persistence/turn-snapshot-repo.js";
import type { ThreadService } from "../../../thread-control/lifecycle/thread-service.js";
import type { GitWorktreeService } from "../../git/git-worktree-service.js";
import type { WorkspaceService } from "../../lifecycle/workspace-service.js";
import type { DiffSummaryService } from "../summaries/diff-summary-service.js";

type DiffSummaryRpcMethod = Extract<WsMethodName, `diffSummary.${string}`>;

type DiffSummaryRpcParamsByMethod = {
  [Method in DiffSummaryRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

/** Defines the services required to route validated diff-summary RPC calls. */
export interface DiffSummaryRouterDeps {
  diffSummaryService: Pick<DiffSummaryService, "get" | "generateFromSnapshots">;
  threadService: Pick<ThreadService, "findById">;
  workspaceService: Pick<WorkspaceService, "findById">;
  gitWorktrees: Pick<GitWorktreeService, "resolveWorkingDir">;
  turnSnapshotRepo: Pick<TurnSnapshotRepo, "listByThread">;
}

type DiffSummaryHandlerMap = {
  [Method in DiffSummaryRpcMethod]: (
    deps: DiffSummaryRouterDeps,
    params: DiffSummaryRpcParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

const diffSummaryHandlers: DiffSummaryHandlerMap = {
  "diffSummary.get": (deps, params) => deps.diffSummaryService.get(params.threadId),
  "diffSummary.generate": routeDiffSummaryGeneration,
};

/** Checks whether a method belongs to the diff-summary RPC family. */
export function isDiffSummaryRpcMethod(method: WsMethodName): method is DiffSummaryRpcMethod {
  return Object.hasOwn(diffSummaryHandlers, method);
}

/** Routes validated diff-summary RPC parameters to feature services. */
export async function routeDiffSummaryRpc<Method extends DiffSummaryRpcMethod>(
  method: Method,
  params: DiffSummaryRpcParamsByMethod[Method],
  deps: DiffSummaryRouterDeps,
): Promise<unknown> {
  return await diffSummaryHandlers[method](deps, params);
}

async function routeDiffSummaryGeneration(
  deps: DiffSummaryRouterDeps,
  params: DiffSummaryRpcParamsByMethod["diffSummary.generate"],
): Promise<unknown> {
  const thread = deps.threadService.findById(params.threadId);
  if (!thread) throw new Error(`Thread not found: ${params.threadId}`);
  const workspace = deps.workspaceService.findById(thread.workspace_id);
  if (!workspace) throw new Error(`Workspace not found: ${thread.workspace_id}`);
  const cwd = deps.gitWorktrees.resolveWorkingDir(
    workspace.path,
    thread.mode,
    thread.worktree_path,
  );
  // listByThread returns parsed TurnSnapshot[]; the summary source expects raw JSON.
  const snapshots = deps.turnSnapshotRepo.listByThread(params.threadId).map((snapshot) => ({
    ...snapshot,
    files_changed: JSON.stringify(snapshot.files_changed),
  }));
  return await deps.diffSummaryService.generateFromSnapshots(params.threadId, snapshots, cwd);
}
