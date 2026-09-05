import type { ReviewComparison, ReviewFileChange, TurnSnapshot, WsMethodName, WS_METHODS } from "@mcode/contracts";
import type { z } from "zod";
import type { TurnDiffService } from "../../../agents/turns/turn-diff-service.js";
import { parseTurnDiff } from "../../../agents/turns/turn-diff-patch.js";
import type { StoredTurnDiff } from "../../../agents/turns/persistence/turn-diff-repo.js";
import type { SnapshotRouterDeps } from "./snapshot-rpc.js";
import { routeSnapshotRpc } from "./snapshot-rpc.js";
import { attributedWorkspacePaths, attributedWorkspacePathGroups } from "../snapshots/snapshot-attribution.js";

type TurnDiffMethod = Extract<WsMethodName, `turnDiff.${string}`>;
type TurnDiffParams = { [M in TurnDiffMethod]: z.input<ReturnType<typeof WS_METHODS>[M]["params"]> };

/** Services used by the provider-neutral Last turn comparison endpoints. */
export interface TurnDiffRouterDeps extends SnapshotRouterDeps {
  turnDiffs: TurnDiffService;
}

/** Recognize the Last turn comparison RPC family. */
export function isTurnDiffRpcMethod(method: WsMethodName): method is TurnDiffMethod {
  return method === "turnDiff.getComparison" || method === "turnDiff.getFileDiff";
}

/** Read Last turn evidence through one contract, independent of provider identity. */
export async function routeTurnDiffRpc<M extends TurnDiffMethod>(method: M, params: TurnDiffParams[M], deps: TurnDiffRouterDeps): Promise<unknown> {
  if (!deps.threadService.findById(params.threadId)) throw new Error("Thread not found");
  if (method === "turnDiff.getComparison") return comparison(deps, params.threadId, "includeLive" in params ? params.includeLive : undefined);
  if ("comparisonId" in params) return fileDiff(deps, params);
  throw new Error("Invalid turn diff request");
}

async function comparison(deps: TurnDiffRouterDeps, threadId: string, includeLive = true): Promise<ReviewComparison | null> {
  const live = includeLive ? deps.turnDiffs.liveComparison(threadId) : null;
  if (live) return live;
  const record = deps.turnDiffs.latest(threadId);
  if (record?.source === "native") return nativeComparison(record);
  const snapshot = selectedSnapshot(deps, threadId, record?.message_id);
  if (!snapshot) return null;
  return gitComparison(deps, snapshot, record?.id ?? `git:${snapshot.id}`);
}

function nativeComparison(record: StoredTurnDiff): ReviewComparison {
  const parsed = record.patch ? parseTurnDiff(record.patch) : { files: [], additions: 0, deletions: 0 };
  if (!parsed) throw new Error("Invalid stored turn diff");
  return { files: parsed.files, additions: parsed.additions, deletions: parsed.deletions,
    turnDiff: { id: record.id, phase: "settled", source: "native", fidelity: "agent", revision: record.revision } };
}

function selectedSnapshot(deps: TurnDiffRouterDeps, threadId: string, messageId: string | undefined): TurnSnapshot | undefined {
  const snapshots = deps.turnSnapshotRepo.listByThread(threadId);
  if (messageId) return snapshots.find((entry) => entry.message_id === messageId);
  const legacyId = deps.turnDiffs.latestLegacySnapshotId(threadId);
  return snapshots.find((entry) => entry.id === legacyId);
}

async function gitComparison(deps: TurnDiffRouterDeps, snapshot: TurnSnapshot, id: string): Promise<ReviewComparison> {
  const stats = await deps.snapshotService.getDiffStats(
    resolveCwd(deps, snapshot), snapshot.ref_before, snapshot.ref_after,
    attributedWorkspacePaths(snapshot), attributedWorkspacePathGroups(snapshot),
  );
  return {
    files: fallbackFiles(snapshot),
    additions: stats.reduce((total, entry) => total + entry.additions, 0),
    deletions: stats.reduce((total, entry) => total + entry.deletions, 0),
    turnDiff: { id, phase: "settled", source: "git", fidelity: "same-file-changes-possible", revision: 0 },
  };
}

function fallbackFiles(snapshot: TurnSnapshot): ReviewFileChange[] {
  const effects = snapshot.file_effects?.effects.filter((effect) => effect.scope === "workspace") ?? [];
  if (effects.length === 0) return snapshot.files_changed.map((path) => ({ path, previousPath: null, changeType: "modified", binary: false }));
  return effects.map((effect) => ({ path: effect.path, previousPath: effect.oldPath ?? null, binary: effect.binary,
    changeType: effect.kind === "removed" ? "deleted" : effect.kind === "edited" ? "modified" : effect.kind }));
}

async function fileDiff(deps: TurnDiffRouterDeps, params: TurnDiffParams["turnDiff.getFileDiff"]): Promise<string> {
  const live = deps.turnDiffs.liveFileDiff(params.threadId, params.comparisonId, params.filePath);
  if (live !== undefined) return live;
  const record = deps.turnDiffs.find(params.threadId, params.comparisonId);
  if (record?.source === "native") return record.patch ? parseTurnDiff(record.patch)?.filePatches.get(params.filePath) ?? "" : "";
  const snapshots = deps.turnSnapshotRepo.listByThread(params.threadId);
  const snapshot = record ? snapshots.find((entry) => entry.message_id === record.message_id)
    : snapshots.find((entry) => `git:${entry.id}` === params.comparisonId);
  return snapshot ? String(await routeSnapshotRpc("snapshot.getDiff", { snapshotId: snapshot.id, filePath: params.filePath }, deps)) : "";
}

function resolveCwd(deps: TurnDiffRouterDeps, snapshot: TurnSnapshot): string {
  const thread = deps.threadService.findById(snapshot.thread_id);
  const workspace = thread && deps.workspaceService.findById(thread.workspace_id);
  if (!thread || !workspace) throw new Error("Turn diff workspace not found");
  return snapshot.worktree_path ?? deps.gitWorktrees.resolveWorkingDir(workspace.path, thread.mode, thread.worktree_path);
}
