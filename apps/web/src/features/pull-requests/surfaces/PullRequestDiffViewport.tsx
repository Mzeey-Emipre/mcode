import type {
  PullRequestBoundedDataMarker,
  PullRequestFile,
  PullRequestIdentity,
  PullRequestReviewThread,
} from "@mcode/contracts";
import { AlertCircle, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  buildPullRequestDiffRowModel,
  buildPullRequestOrphanConversationRows,
  releasePullRequestPatchRows,
  type PullRequestDiffCell,
  type PullRequestDiffDraftLike,
  type PullRequestDiffFileInput,
  type PullRequestDiffFileRow,
  type PullRequestDiffLineRow,
  type PullRequestDiffPatchState,
} from "@/features/pull-requests/lib/pull-request-diff-row-model";
import type { PullRequestDiffCoordinate } from "@/features/pull-requests/lib/pull-request-diff-coordinates";
import {
  getPullRequestPatchKey,
  PULL_REQUEST_CODE_CACHE_MAX_BYTES,
  usePullRequestCodeStore,
  type PullRequestPatchLaneState,
} from "@/features/pull-requests/state/pullRequestCodeStore";
import {
  usePullRequestReviewDraftStore,
  type PullRequestDraftCoordinate,
  type PullRequestReviewDraft,
} from "@/features/pull-requests/state/pullRequestReviewDraftStore";
import { PullRequestVirtualDiff } from "./PullRequestVirtualDiff";

const EMPTY_EXPANDED_PATHS: Readonly<Record<string, true>> = {};

/** Props for the store-backed, immutable-snapshot pull request diff viewport. */
export interface PullRequestDiffViewportProps {
  identity: PullRequestIdentity;
  identityKey: string;
  baseOid: string;
  headOid: string;
  files: readonly PullRequestFile[];
  reviewThreads: readonly PullRequestReviewThread[];
  commentsComplete: boolean;
  commentsBounded: PullRequestBoundedDataMarker | null;
  activePath: string | null;
  isNarrow: boolean;
  transport?: PullRequestTransport;
  onActivePathChange(path: string): void;
}

function patchState(
  file: PullRequestFile,
  lane: PullRequestPatchLaneState | null,
  evicted: boolean,
): PullRequestDiffPatchState {
  if (!lane) {
    if (evicted) return "evicted";
    return file.patchStatus === "available" || file.patchStatus === "generated"
      ? "idle"
      : file.patchStatus;
  }
  if (lane.status === "loading") return "loading";
  if (lane.status === "error") return "error";
  if (lane.status !== "ready" || !lane.result) return "idle";
  return lane.result.status;
}

function rowCoordinateFromDraft(
  draft: PullRequestReviewDraft,
): PullRequestDiffCoordinate | null {
  if (!draft.coordinate) return null;
  return {
    subjectType: draft.coordinate.subjectType,
    side: draft.coordinate.side,
    startSide: draft.coordinate.startSide,
    line: draft.coordinate.line,
    startLine: draft.coordinate.startLine,
    originalSide: draft.coordinate.side,
    originalStartSide: draft.coordinate.startSide,
    originalLine: draft.coordinate.originalLine,
    originalStartLine: draft.coordinate.originalStartLine,
    commitOid: draft.coordinate.commitOid,
    headOid: draft.headOid,
  };
}

function draftCoordinateFromThread(
  thread: PullRequestReviewThread,
): PullRequestDraftCoordinate {
  return {
    subjectType: thread.subjectType,
    path: thread.path,
    side: thread.side,
    startSide: thread.startSide,
    line: thread.line,
    startLine: thread.startLine,
    originalLine: thread.originalLine,
    originalStartLine: thread.originalStartLine,
    commitOid: thread.commitOid,
  };
}

function sameIdentity(
  left: PullRequestIdentity,
  right: PullRequestIdentity,
): boolean {
  return (
    left.provider === right.provider &&
    left.repositoryNodeId === right.repositoryNodeId &&
    left.number === right.number
  );
}

interface ParsedPatchReconciliationInput {
  lane: PullRequestPatchLaneState | null;
  patchKey: string | null;
  parsedBytes: number;
  deferred: boolean;
  rejected: boolean;
}

function readyPatchLane(
  patchKey: string | null,
  lane: PullRequestPatchLaneState | null,
): { patchKey: string; lane: PullRequestPatchLaneState } | null {
  if (!patchKey) return null;
  if (!lane) return null;
  if (lane.status !== "ready") return null;
  return { patchKey, lane };
}

function reconcileParsedPatchBytes({
  lane,
  patchKey,
  parsedBytes,
  deferred,
  rejected,
}: ParsedPatchReconciliationInput): boolean {
  const readyPatch = readyPatchLane(patchKey, lane);
  if (!readyPatch) return false;
  const { patchKey: readyPatchKey, lane: readyLane } = readyPatch;
  const store = usePullRequestCodeStore.getState();
  if (deferred) {
    releasePullRequestPatchRows(readyLane.result);
    if (parsedBytes > 0 && readyLane.parsedBytes !== parsedBytes) {
      store.reportPatchDerivedBytes(readyPatchKey, { parsedBytes });
    }
    return false;
  }
  if (rejected) {
    releasePullRequestPatchRows(readyLane.result);
    store.clearPatchDerivedBytes(readyPatchKey);
    return false;
  }
  if (parsedBytes === 0 || readyLane.parsedBytes === parsedBytes) return false;
  if (store.reportPatchDerivedBytes(readyPatchKey, { parsedBytes })) return false;
  releasePullRequestPatchRows(readyLane.result);
  store.clearPatchDerivedBytes(readyPatchKey);
  return true;
}

function synchronizeParsedPatchRejections({
  files,
  patchKeys,
  patchLanes,
  rowModel,
  parsedRejectedPaths,
}: {
  files: readonly PullRequestFile[];
  patchKeys: readonly (string | null)[];
  patchLanes: readonly (PullRequestPatchLaneState | null)[];
  rowModel: ReturnType<typeof buildPullRequestDiffRowModel>;
  parsedRejectedPaths: ReadonlySet<string>;
}): ReadonlySet<string> {
  const rejected = new Set(parsedRejectedPaths);
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const rejectedByModel = rowModel.rejectedPatchLocators.has(file.locator);
    if (rejectedByModel) rejected.add(file.path);
    const exceededBudget = reconcileParsedPatchBytes({
      lane: patchLanes[index],
      patchKey: patchKeys[index],
      parsedBytes: rowModel.parsedBytesByLocator.get(file.locator) ?? 0,
      deferred: rowModel.deferredPatchLocators.has(file.locator),
      rejected: rejected.has(file.path),
    });
    if (exceededBudget) rejected.add(file.path);
  }
  if (
    rejected.size === parsedRejectedPaths.size &&
    [...rejected].every((path) => parsedRejectedPaths.has(path))
  ) {
    return parsedRejectedPaths;
  }
  return rejected;
}

/** Store-backed pull request patch viewport with bounded rows, tokens, and local drafts. */
export function PullRequestDiffViewport({
  identity,
  identityKey,
  baseOid,
  headOid,
  files,
  reviewThreads,
  commentsComplete,
  commentsBounded,
  activePath,
  isNarrow,
  transport,
  onActivePathChange,
}: PullRequestDiffViewportProps) {
  const activeSnapshotKey = usePullRequestCodeStore(
    (state) => state.activeSnapshotKey,
  );
  const activeEntry = usePullRequestCodeStore((state) =>
    state.activeSnapshotKey
      ? (state.entries[state.activeSnapshotKey] ?? null)
      : null,
  );
  const viewMode = usePullRequestCodeStore((state) =>
    state.activeSnapshotKey
      ? (state.entries[state.activeSnapshotKey]?.viewMode ?? "unified")
      : "unified",
  );
  const expandedPaths = usePullRequestCodeStore(
    useShallow((state) =>
      state.activeSnapshotKey
        ? (state.entries[state.activeSnapshotKey]?.expandedPaths ??
          EMPTY_EXPANDED_PATHS)
        : EMPTY_EXPANDED_PATHS,
    ),
  );
  const entryMatches =
    activeEntry !== null &&
    sameIdentity(activeEntry.identity, identity) &&
    activeEntry.baseOid === baseOid &&
    activeEntry.headOid === headOid;
  const patchKeys = useMemo(() => {
    if (!entryMatches || !activeEntry) return files.map(() => null);
    return files.map((file) =>
      getPullRequestPatchKey(
        activeEntry.viewerNodeId,
        activeEntry.identity,
        activeEntry.baseOid,
        activeEntry.headOid,
        file.locator,
      ),
    );
  }, [activeEntry, entryMatches, files]);
  const patchPresentationRevision = usePullRequestCodeStore(
    (state) => state.patchPresentationRevision,
  );
  const patchLanes = useMemo(() => {
    const state = usePullRequestCodeStore.getState();
    return patchKeys.map((key) => (key ? (state.patches[key] ?? null) : null));
  }, [patchKeys, patchPresentationRevision]);
  const draftIdentityKey = activeEntry?.identityKey ?? identityKey;
  const draftPlacementRevision = usePullRequestReviewDraftStore(
    (state) => state.placementRevision,
  );
  const drafts = useMemo(() => {
    const state = usePullRequestReviewDraftStore.getState();
    return state.order
      .map((localId) => state.drafts[localId])
      .filter((draft): draft is PullRequestReviewDraft =>
        Boolean(draft && draft.identityKey === draftIdentityKey),
      );
  }, [draftIdentityKey, draftPlacementRevision]);
  const [memoryPausedPaths, setMemoryPausedPaths] = useState<
    ReadonlySet<string>
  >(new Set());
  const [evictedPatchPaths, setEvictedPatchPaths] = useState<
    ReadonlySet<string>
  >(new Set());
  const [parsedRejectedPaths, setParsedRejectedPaths] = useState<
    ReadonlySet<string>
  >(new Set());
  const seenPatchKeysRef = useRef<Set<string>>(new Set());
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    setMemoryPausedPaths(new Set());
    setEvictedPatchPaths(new Set());
    setParsedRejectedPaths(new Set());
    seenPatchKeysRef.current.clear();
  }, [activeSnapshotKey]);

  useEffect(() => {
    setEvictedPatchPaths((current) => {
      const next = new Set(current);
      for (let index = 0; index < files.length; index += 1) {
        const key = patchKeys[index];
        const lane = patchLanes[index];
        const path = files[index].path;
        if (!key) continue;
        if (lane?.status === "ready") {
          seenPatchKeysRef.current.add(key);
          next.delete(path);
        } else if (
          lane === null &&
          expandedPaths[path] &&
          seenPatchKeysRef.current.has(key)
        ) {
          next.add(path);
        }
      }
      if (
        next.size === current.size &&
        [...next].every((path) => current.has(path))
      ) {
        return current;
      }
      return next;
    });
  }, [expandedPaths, files, patchKeys, patchLanes]);

  const rowDrafts = useMemo<PullRequestDiffDraftLike[]>(
    () =>
      drafts.map((draft) => ({
        localId: draft.localId,
        path: draft.path,
        coordinate: rowCoordinateFromDraft(draft),
        outdated: draft.outdated,
      })),
    [drafts],
  );
  const fileInputs = useMemo<PullRequestDiffFileInput[]>(
    () =>
      files.map((file, index) => {
        const lane = patchLanes[index] ?? null;
        return {
          file,
          expanded: Boolean(expandedPaths[file.path]),
          patchState: parsedRejectedPaths.has(file.path)
            ? "too_large"
            : patchState(file, lane, evictedPatchPaths.has(file.path)),
          patchResult: parsedRejectedPaths.has(file.path)
            ? null
            : (lane?.result ?? null),
          errorMessage: lane?.error?.message ?? null,
          threads: reviewThreads.filter(
            (thread) =>
              thread.path === file.path ||
              (file.previousPath !== null && thread.path === file.previousPath),
          ),
          drafts: rowDrafts.filter(
            (draft) =>
              draft.path === file.path ||
              (file.previousPath !== null && draft.path === file.previousPath),
          ),
        };
      }),
    [
      evictedPatchPaths,
      expandedPaths,
      files,
      parsedRejectedPaths,
      patchLanes,
      reviewThreads,
      rowDrafts,
    ],
  );
  const rowModel = useMemo(() => {
    const codeState = usePullRequestCodeStore.getState();
    const retainedBytes = Object.values(codeState.patches).reduce(
      (total, lane) => total + lane.estimatedBytes,
      0,
    );
    const reservedParsedBytesByLocator = new Map<string, number>();
    const intrinsicParsedBytesByLocator = new Map<string, number>();
    for (let index = 0; index < files.length; index += 1) {
      const patchKey = patchKeys[index];
      const lane = patchKey ? codeState.patches[patchKey] : null;
      if (lane) {
        reservedParsedBytesByLocator.set(
          files[index].locator,
          lane.parsedBytes,
        );
        intrinsicParsedBytesByLocator.set(
          files[index].locator,
          Math.max(
            0,
            PULL_REQUEST_CODE_CACHE_MAX_BYTES - lane.rawBytes - lane.tokenBytes,
          ),
        );
      }
    }
    const built = buildPullRequestDiffRowModel({
      snapshotKey: activeSnapshotKey ?? `${identityKey}:${baseOid}:${headOid}`,
      headOid,
      files: fileInputs,
      parsedByteBudget: Math.max(
        0,
        PULL_REQUEST_CODE_CACHE_MAX_BYTES - retainedBytes,
      ),
      reservedParsedBytesByLocator,
      intrinsicParsedBytesByLocator,
    });
    const knownPaths = new Set(
      files.flatMap((file) =>
        file.previousPath ? [file.path, file.previousPath] : [file.path],
      ),
    );
    const orphanRows = buildPullRequestOrphanConversationRows({
      snapshotKey: activeSnapshotKey ?? `${identityKey}:${baseOid}:${headOid}`,
      threads: reviewThreads.filter(
        (thread) => thread.isOutdated && !knownPaths.has(thread.path),
      ),
      drafts: rowDrafts.filter(
        (draft) => draft.outdated && !knownPaths.has(draft.path),
      ),
    });
    return { ...built, rows: [...built.rows, ...orphanRows] };
  }, [
    activeSnapshotKey,
    baseOid,
    fileInputs,
    files,
    headOid,
    identityKey,
    patchKeys,
    reviewThreads,
    rowDrafts,
  ]);

  useEffect(() => {
    setParsedRejectedPaths((current) =>
      synchronizeParsedPatchRejections({
        files,
        patchKeys,
        patchLanes,
        rowModel,
        parsedRejectedPaths: current,
      }),
    );
  }, [files, patchKeys, patchLanes, rowModel]);

  useEffect(
    () => () => {
      for (const patchKey of patchKeys) {
        if (!patchKey) continue;
        const state = usePullRequestCodeStore.getState();
        releasePullRequestPatchRows(state.patches[patchKey]?.result ?? null);
        state.clearPatchDerivedBytes(patchKey);
      }
    },
    [patchKeys],
  );

  const reportTokenBytes = useCallback(
    (path: string, bytes: number): boolean => {
      const index = files.findIndex((file) => file.path === path);
      const patchKey = index >= 0 ? patchKeys[index] : null;
      if (!patchKey) return false;
      if (memoryPausedPaths.has(path)) {
        if (bytes > 0) {
          usePullRequestCodeStore
            .getState()
            .reportPatchDerivedBytes(patchKey, { tokenBytes: 0 });
        }
        return false;
      }
      const accepted = usePullRequestCodeStore
        .getState()
        .reportPatchDerivedBytes(patchKey, { tokenBytes: bytes });
      if (!accepted && bytes > 0) {
        usePullRequestCodeStore
          .getState()
          .reportPatchDerivedBytes(patchKey, { tokenBytes: 0 });
        setMemoryPausedPaths((current) => new Set(current).add(path));
      }
      return accepted;
    },
    [files, memoryPausedPaths, patchKeys],
  );

  const toggleFile = useCallback(
    (row: PullRequestDiffFileRow): void => {
      const wasExpanded = Boolean(expandedPaths[row.file.path]);
      usePullRequestCodeStore.getState().toggleFileExpanded(row.file.path);
      onActivePathChange(row.file.path);
      if (!wasExpanded) {
        void usePullRequestCodeStore
          .getState()
          .ensurePatch(row.file, transport);
      }
    },
    [expandedPaths, onActivePathChange, transport],
  );

  const loadVisiblePatches = useCallback(
    (paths: readonly string[]): void => {
      if (!entryMatches) return;
      const visible = new Set(paths);
      for (const file of files) {
        if (!visible.has(file.path) || !expandedPaths[file.path]) continue;
        void usePullRequestCodeStore.getState().ensurePatch(file, transport);
      }
    },
    [entryMatches, expandedPaths, files, transport],
  );

  const snapshot = useMemo(
    () => ({ identityKey: draftIdentityKey, baseOid, headOid }),
    [baseOid, draftIdentityKey, headOid],
  );

  const createDraft = useCallback(
    (row: PullRequestDiffLineRow, cell: PullRequestDiffCell): void => {
      if (cell.lineNumber === null) return;
      const originalLine =
        cell.side === "left" ? cell.lineNumber : row.leftLineNumber;
      const result = usePullRequestReviewDraftStore.getState().createDraft({
        snapshot,
        kind: "inline",
        path: row.path,
        coordinate: {
          subjectType: "line",
          path: row.path,
          side: cell.side,
          startSide: cell.side,
          line: cell.lineNumber,
          startLine: cell.lineNumber,
          originalLine,
          originalStartLine: originalLine,
          commitOid: headOid,
        },
      });
      setDraftError(result.ok ? null : "Local review draft limit reached.");
    },
    [headOid, snapshot],
  );

  const createReply = useCallback(
    (thread: PullRequestReviewThread): void => {
      const result = usePullRequestReviewDraftStore.getState().createDraft({
        snapshot,
        kind: "reply",
        path: thread.path,
        coordinate: draftCoordinateFromThread(thread),
        threadProviderNodeId: thread.providerNodeId,
      });
      setDraftError(result.ok ? null : "Local review draft limit reached.");
    },
    [snapshot],
  );

  const updateDraft = useCallback((localId: string, body: string): boolean => {
    const result = usePullRequestReviewDraftStore
      .getState()
      .updateDraft(localId, body);
    return result.ok;
  }, []);

  return (
    <section
      aria-label="Pull request Code diff"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      {!commentsComplete && (
        <p
          role="status"
          className="flex items-center gap-2 bg-page/70 px-3 py-1.5 text-xs text-muted-foreground"
        >
          <MessageSquare size={12} aria-hidden className="text-primary/75" />
          {commentsBounded
            ? "Review threads are bounded. Some inline conversations may be missing."
            : "Review thread index is incomplete."}
        </p>
      )}
      {memoryPausedPaths.size > 0 && (
        <p
          role="status"
          className="flex items-center gap-2 bg-page/70 px-3 py-1.5 text-xs text-muted-foreground"
        >
          <AlertCircle size={12} aria-hidden className="text-primary/75" />
          Syntax highlighting paused for memory. Plain-text diff remains
          available.
        </p>
      )}
      {draftError && (
        <p
          role="alert"
          className="bg-destructive/8 px-3 py-1.5 text-xs text-destructive"
        >
          {draftError}
        </p>
      )}
      <PullRequestVirtualDiff
        rows={rowModel.rows}
        mode={viewMode}
        isNarrow={isNarrow}
        activePath={activePath}
        onToggleFile={toggleFile}
        onActivePathChange={onActivePathChange}
        onCreateDraft={createDraft}
        onCreateReply={createReply}
        onUpdateDraft={updateDraft}
        onRemoveDraft={(localId) =>
          usePullRequestReviewDraftStore.getState().removeDraft(localId)
        }
        onTokenBytesChange={reportTokenBytes}
        onVisiblePathsChange={loadVisiblePatches}
        onReloadPatch={(path) => {
          const file = files.find((candidate) => candidate.path === path);
          if (!file) return;
          setEvictedPatchPaths((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
          void usePullRequestCodeStore.getState().ensurePatch(file, transport);
        }}
      />
    </section>
  );
}
