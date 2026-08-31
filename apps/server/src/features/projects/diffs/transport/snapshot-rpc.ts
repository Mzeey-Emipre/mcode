import { WS_METHODS, type WsMethodName } from "@mcode/contracts";
import type { z } from "zod";
import type { TurnSnapshotRepo } from "../../../agents/turns/persistence/turn-snapshot-repo.js";
import type { ThreadService } from "../../../thread-control/lifecycle/thread-service.js";
import type { GitWorktreeService } from "../../git/git-worktree-service.js";
import type { WorkspaceService } from "../../lifecycle/workspace-service.js";
import {
  attributedWorkspacePathGroups,
  attributedWorkspacePaths,
  collectAttributedWorkspacePathGroups,
  collectAttributedWorkspacePaths,
} from "../snapshots/snapshot-attribution.js";
import type { SnapshotService } from "../snapshots/snapshot-service.js";

type SnapshotRpcMethod = Extract<WsMethodName, `snapshot.${string}`>;

type SnapshotRpcParamsByMethod = {
  [Method in SnapshotRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

type StoredSnapshot = NonNullable<ReturnType<TurnSnapshotRepo["getById"]>>;

/** Defines the services required to route validated snapshot RPC calls. */
export interface SnapshotRouterDeps {
  turnSnapshotRepo: Pick<
    TurnSnapshotRepo,
    "getById" | "deleteExpired" | "listByThread"
  >;
  snapshotService: Pick<SnapshotService, "getDiff" | "getDiffStats">;
  threadService: Pick<ThreadService, "findById">;
  workspaceService: Pick<WorkspaceService, "findById">;
  gitWorktrees: Pick<GitWorktreeService, "resolveWorkingDir">;
}

type SnapshotHandlerMap = {
  [Method in SnapshotRpcMethod]: (
    deps: SnapshotRouterDeps,
    params: SnapshotRpcParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

const snapshotHandlers: SnapshotHandlerMap = {
  "snapshot.getDiff": routeSnapshotDiff,
  "snapshot.getDiffStats": routeSnapshotDiffStats,
  "snapshot.cleanup": (deps) => ({
    removed: deps.turnSnapshotRepo.deleteExpired(
      parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10),
    ),
  }),
  "snapshot.listByThread": (deps, params) => deps.turnSnapshotRepo.listByThread(params.threadId),
  "snapshot.getCumulativeDiff": routeCumulativeSnapshotDiff,
  "snapshot.getCumulativeDiffStats": routeCumulativeSnapshotDiffStats,
};

/** Checks whether a method belongs to the snapshot RPC family. */
export function isSnapshotRpcMethod(method: WsMethodName): method is SnapshotRpcMethod {
  return Object.hasOwn(snapshotHandlers, method);
}

/** Routes validated snapshot RPC parameters to feature services. */
export async function routeSnapshotRpc<Method extends SnapshotRpcMethod>(
  method: Method,
  params: SnapshotRpcParamsByMethod[Method],
  deps: SnapshotRouterDeps,
): Promise<unknown> {
  return await snapshotHandlers[method](deps, params);
}

async function routeSnapshotDiff(
  deps: SnapshotRouterDeps,
  params: SnapshotRpcParamsByMethod["snapshot.getDiff"],
): Promise<string> {
  const snapshot = requireSnapshot(deps, params.snapshotId);
  const snapshotCwd = resolveSnapshotCwd(deps, snapshot);
  const attributedPaths = attributedWorkspacePaths(snapshot);
  const attributedPathGroups = attributedWorkspacePathGroups(snapshot);
  if (!isAttributedFile(attributedPaths, params.filePath)) return "";
  return await deps.snapshotService.getDiff(
    snapshotCwd,
    snapshot.ref_before,
    snapshot.ref_after,
    params.filePath,
    params.maxLines,
    attributedPaths,
    attributedPathGroups,
  );
}

async function routeSnapshotDiffStats(
  deps: SnapshotRouterDeps,
  params: SnapshotRpcParamsByMethod["snapshot.getDiffStats"],
): Promise<unknown> {
  const snapshot = requireSnapshot(deps, params.snapshotId);
  return await deps.snapshotService.getDiffStats(
    resolveSnapshotCwd(deps, snapshot),
    snapshot.ref_before,
    snapshot.ref_after,
    attributedWorkspacePaths(snapshot),
    attributedWorkspacePathGroups(snapshot),
  );
}

async function routeCumulativeSnapshotDiff(
  deps: SnapshotRouterDeps,
  params: SnapshotRpcParamsByMethod["snapshot.getCumulativeDiff"],
): Promise<string> {
  const snapshots = getSnapshotsWithGitRefs(deps, params.threadId);
  if (snapshots.length === 0) return "";
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const attributedPaths = collectAttributedWorkspacePaths(snapshots);
  const attributedPathGroups = collectAttributedWorkspacePathGroups(snapshots);
  if (!isAttributedFile(attributedPaths, params.filePath)) return "";
  return await deps.snapshotService.getDiff(
    resolveCumulativeSnapshotCwd(deps, first, params.threadId),
    first.ref_before,
    last.ref_after,
    params.filePath,
    params.maxLines,
    attributedPaths,
    attributedPathGroups,
  );
}

async function routeCumulativeSnapshotDiffStats(
  deps: SnapshotRouterDeps,
  params: SnapshotRpcParamsByMethod["snapshot.getCumulativeDiffStats"],
): Promise<unknown> {
  const snapshots = getSnapshotsWithGitRefs(deps, params.threadId);
  if (snapshots.length === 0) return [];
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const stats = await deps.snapshotService.getDiffStats(
    resolveCumulativeSnapshotCwd(deps, first, params.threadId),
    first.ref_before,
    last.ref_after,
    collectAttributedWorkspacePaths(snapshots),
    collectAttributedWorkspacePathGroups(snapshots),
  );
  if (stats.length > 10_000) {
    throw new Error("Cumulative Review comparison is limited to 10000 files");
  }
  return stats;
}

function requireSnapshot(deps: SnapshotRouterDeps, snapshotId: string): StoredSnapshot {
  const snapshot = deps.turnSnapshotRepo.getById(snapshotId);
  if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
  return snapshot;
}

function getSnapshotsWithGitRefs(deps: SnapshotRouterDeps, threadId: string): StoredSnapshot[] {
  return deps.turnSnapshotRepo.listByThread(threadId).filter(
    (snapshot) => snapshot.ref_before && snapshot.ref_after,
  );
}

function isAttributedFile(attributedPaths: readonly string[], filePath?: string): boolean {
  return !filePath || attributedPaths.some(
    (path) => path.replaceAll("\\", "/") === filePath.replaceAll("\\", "/"),
  );
}

function resolveSnapshotCwd(deps: SnapshotRouterDeps, snapshot: StoredSnapshot): string {
  if (snapshot.worktree_path) return snapshot.worktree_path;
  const thread = deps.threadService.findById(snapshot.thread_id);
  if (!thread) throw new Error(`Thread not found for snapshot: ${snapshot.thread_id}`);
  const workspace = deps.workspaceService.findById(thread.workspace_id);
  if (!workspace) throw new Error(`Workspace not found: ${thread.workspace_id}`);
  return deps.gitWorktrees.resolveWorkingDir(
    workspace.path,
    thread.mode,
    thread.worktree_path,
  );
}

function resolveCumulativeSnapshotCwd(
  deps: SnapshotRouterDeps,
  first: StoredSnapshot,
  threadId: string,
): string {
  if (first.worktree_path) return first.worktree_path;
  const thread = deps.threadService.findById(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  const workspace = deps.workspaceService.findById(thread.workspace_id);
  if (!workspace) throw new Error(`Workspace not found: ${thread.workspace_id}`);
  return deps.gitWorktrees.resolveWorkingDir(
    workspace.path,
    thread.mode,
    thread.worktree_path,
  );
}
