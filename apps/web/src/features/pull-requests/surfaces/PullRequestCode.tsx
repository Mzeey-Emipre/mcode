import type {
  PullRequestBoundedDataMarker,
  PullRequestDetail,
  PullRequestIdentity,
  PullRequestReviewThread,
} from "@mcode/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignJustify,
  AlertCircle,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Files,
  GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useElementWidth } from "@/hooks/useElementWidth";
import {
  selectPullRequestCodeCore,
  selectPullRequestCodeView,
} from "@/features/pull-requests/state/pull-request-code-selectors";
import {
  getPullRequestPatchKey,
  usePullRequestCodeStore,
} from "@/features/pull-requests/state/pullRequestCodeStore";
import { usePullRequestDetailStore } from "@/features/pull-requests/state/pullRequestDetailStore";
import { usePullRequestReviewDraftStore } from "@/features/pull-requests/state/pullRequestReviewDraftStore";
import { usePullRequestStore } from "@/features/pull-requests/state/pullRequestStore";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/shallow";
import { PullRequestChangedFilesPane } from "./PullRequestChangedFilesPane";
import { PullRequestDiffViewport } from "./PullRequestDiffViewport";

const FILES_PANEL_MIN_WIDTH = 280;
const FILES_PANEL_DEFAULT_WIDTH = 360;
const FILES_PANEL_WIDE_WIDTH = 520;
const DIFF_VIEWPORT_MIN_WIDTH = 520;
const DOCKED_FILES_MIN_WIDTH = FILES_PANEL_MIN_WIDTH + DIFF_VIEWPORT_MIN_WIDTH;
const FLOATING_FILES_PANEL_EDGE_GAP = 48;
const FLOATING_FILES_PANEL_FLOOR = 220;

interface ReviewThreadPaginationRun {
  generation: number | null;
  pendingAppend: { cursor: string; generation: number } | null;
  successfulAppendCursors: Set<string>;
}

/** Props for the lazy pull request Code panel. */
export interface PullRequestCodeProps {
  identity: PullRequestIdentity;
  identityKey: string;
  baseOid: string;
  headOid: string;
  isNarrow: boolean;
  transport?: PullRequestTransport;
  detail: PullRequestDetail;
}

function boundedFilesMessage(marker: PullRequestBoundedDataMarker): string {
  if (marker.reason === "catch_up_limit") {
    return "Search paused after four GitHub pages. More matching files may remain.";
  }
  if (marker.reason === "provider_limit") {
    return "GitHub's changed-file limit was reached. This Change stack is partial.";
  }
  if (marker.reason === "record_limit") {
    return "The changed-file record limit was reached. This Change stack is partial.";
  }
  if (marker.reason === "byte_limit") {
    return "The changed-file data limit was reached. This Change stack is partial.";
  }
  return "The changed-file read stopped before every file was loaded.";
}

/** Read-only Code shell for one immutable pull request base and head snapshot. */
export function PullRequestCode({
  identity,
  identityKey,
  baseOid,
  headOid,
  isNarrow,
  transport,
  detail,
}: PullRequestCodeProps) {
  const viewerNodeId = usePullRequestStore(
    (state) => state.viewer?.providerNodeId ?? null,
  );
  const snapshotIdentity = useMemo<PullRequestIdentity>(
    () => ({ ...identity }),
    [
      identity.number,
      identity.owner,
      identity.provider,
      identity.repository,
      identity.repositoryNodeId,
    ],
  );
  const code = usePullRequestCodeStore(useShallow(selectPullRequestCodeCore));
  const view = usePullRequestCodeStore(useShallow(selectPullRequestCodeView));
  const patchPresentationRevision = usePullRequestCodeStore(
    (state) => state.patchPresentationRevision,
  );
  const comments = usePullRequestDetailStore(
    useShallow((state) => {
      const entry = state.entries[identityKey];
      const lane = entry?.lanes.comments;
      return {
        items: entry?.comments ?? [],
        nextCursor: entry?.commentsNextCursor ?? null,
        generation: lane?.generation ?? 0,
        operationId: lane?.operationId ?? null,
        fetchedAt: lane?.fetchedAt ?? null,
        boundedData: lane?.boundedData ?? null,
        error: lane?.error ?? null,
      };
    }),
  );
  const [filesPanelWidth, setFilesPanelWidth] = useState(
    FILES_PANEL_DEFAULT_WIDTH,
  );
  const codeRootRef = useRef<HTMLElement>(null);
  const codeWidth = useElementWidth(codeRootRef, identityKey);
  const commentPaginationRunRef = useRef<ReviewThreadPaginationRun>({
    generation: null,
    pendingAppend: null,
    successfulAppendCursors: new Set(),
  });
  const [commentsPaginationStalled, setCommentsPaginationStalled] =
    useState(false);
  const reviewThreads = useMemo(
    () =>
      comments.items.filter(
        (item): item is PullRequestReviewThread =>
          item.kind === "review_thread",
      ),
    [comments.items],
  );
  const displayedFiles = useMemo(() => {
    const entry = code.entry;
    if (!entry) return code.files;
    const patches = usePullRequestCodeStore.getState().patches;
    return code.files.map((file) => {
      const patchKey = getPullRequestPatchKey(
        entry.viewerNodeId,
        entry.identity,
        entry.baseOid,
        entry.headOid,
        file.locator,
      );
      const patchStatus = patches[patchKey]?.result?.status;
      return patchStatus && patchStatus !== file.patchStatus
        ? { ...file, patchStatus }
        : file;
    });
  }, [code.entry, code.files, patchPresentationRevision]);
  const activeDraftIdentityKey = code.entry?.identityKey ?? null;
  const hasOutdatedDrafts = usePullRequestReviewDraftStore(
    (state) =>
      activeDraftIdentityKey !== null &&
      state.order.some((localId) => {
        const draft = state.drafts[localId];
        return draft?.identityKey === activeDraftIdentityKey && draft.outdated;
      }),
  );
  const hasOrphanContext =
    hasOutdatedDrafts || reviewThreads.some((thread) => thread.isOutdated);
  const commentsComplete =
    comments.fetchedAt !== null &&
    comments.nextCursor === null &&
    comments.boundedData === null &&
    comments.error === null;
  const getFilesPanelMaxWidth = useCallback(
    (panel: HTMLDivElement | null): number =>
      Math.max(
        FILES_PANEL_MIN_WIDTH,
        (panel?.parentElement?.clientWidth ?? window.innerWidth) -
          DIFF_VIEWPORT_MIN_WIDTH,
      ),
    [],
  );
  const floatingFilesPanelMaxWidth =
    codeWidth > 0
      ? Math.max(
          FLOATING_FILES_PANEL_FLOOR,
          codeWidth - FLOATING_FILES_PANEL_EDGE_GAP,
        )
      : FILES_PANEL_DEFAULT_WIDTH;
  const floatingFilesPanelMinWidth = Math.min(
    FILES_PANEL_MIN_WIDTH,
    floatingFilesPanelMaxWidth,
  );
  const getFloatingFilesPanelMaxWidth = useCallback(
    (panel: HTMLDivElement | null): number =>
      Math.max(
        floatingFilesPanelMinWidth,
        (panel?.parentElement?.clientWidth ?? window.innerWidth) -
          FLOATING_FILES_PANEL_EDGE_GAP,
      ),
    [floatingFilesPanelMinWidth],
  );

  useEffect(() => {
    if (viewerNodeId) return;
    void usePullRequestStore.getState().loadCapabilities(transport);
  }, [transport, viewerNodeId]);

  useEffect(() => {
    if (!viewerNodeId) return;
    usePullRequestCodeStore
      .getState()
      .activateSnapshot(
        { viewerNodeId, identity: snapshotIdentity, baseOid, headOid },
        transport,
      );
    return () => {
      void usePullRequestCodeStore.getState().cancelActive(transport);
    };
  }, [baseOid, headOid, snapshotIdentity, transport, viewerNodeId]);

  useEffect(() => {
    if (
      !code.entry ||
      code.filesLane?.status !== "idle" ||
      code.filesLane.fetchedAt !== null
    ) {
      return;
    }
    void usePullRequestCodeStore.getState().loadFiles({ transport });
  }, [code.entry, code.filesLane, transport]);

  useEffect(() => {
    const run = commentPaginationRunRef.current;
    run.generation = null;
    run.pendingAppend = null;
    run.successfulAppendCursors.clear();
    setCommentsPaginationStalled(false);
  }, [baseOid, headOid, identityKey]);

  useEffect(() => {
    const run = commentPaginationRunRef.current;
    if (comments.fetchedAt === null) {
      if (comments.operationId || comments.error) return;
      const generation = comments.generation + 1;
      run.generation = generation;
      run.pendingAppend = null;
      run.successfulAppendCursors.clear();
      if (commentsPaginationStalled) setCommentsPaginationStalled(false);
      void usePullRequestDetailStore.getState().loadComments({ transport });
      return;
    }

    const pendingAppend = run.pendingAppend;
    if (pendingAppend && pendingAppend.generation === comments.generation) {
      if (comments.operationId) return;
      run.pendingAppend = null;
      if (comments.error) return;
      run.successfulAppendCursors.add(pendingAppend.cursor);
      run.generation = comments.generation;
    } else if (run.generation === null) {
      run.generation = comments.generation;
    } else if (run.generation !== comments.generation) {
      run.generation = comments.generation;
      run.pendingAppend = null;
      run.successfulAppendCursors.clear();
      if (commentsPaginationStalled) setCommentsPaginationStalled(false);
    }

    if (comments.operationId || comments.error) return;
    if (!comments.nextCursor) {
      run.successfulAppendCursors.clear();
      if (commentsPaginationStalled) setCommentsPaginationStalled(false);
      return;
    }
    if (commentsPaginationStalled) return;
    if (run.successfulAppendCursors.has(comments.nextCursor)) {
      setCommentsPaginationStalled(true);
      return;
    }
    const generation = comments.generation + 1;
    run.generation = generation;
    run.pendingAppend = { cursor: comments.nextCursor, generation };
    void usePullRequestDetailStore
      .getState()
      .loadComments({ append: true, transport });
  }, [
    comments.error,
    comments.fetchedAt,
    comments.generation,
    comments.nextCursor,
    comments.operationId,
    commentsPaginationStalled,
    transport,
  ]);

  const activateFile = (path: string): void => {
    const file = code.files.find((item) => item.path === path);
    if (!file) return;
    if (!view.expandedPaths[path]) {
      usePullRequestCodeStore.getState().toggleFileExpanded(path);
    } else {
      usePullRequestCodeStore.getState().setActivePath(path);
    }
    void usePullRequestCodeStore.getState().ensurePatch(file, transport);
  };

  const updateFileQuery = useCallback(
    (query: typeof view.query): void => {
      usePullRequestCodeStore.getState().setFileQuery(query, transport);
    },
    [transport],
  );

  if (!viewerNodeId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 bg-page text-xs text-muted-foreground">
        <Spinner size="xs" aria-hidden />
        <span role="status">Loading GitHub viewer context</span>
      </div>
    );
  }

  const filesLane = code.filesLane;
  const filtersActive =
    view.query.search.length > 0 || view.query.changeTypes.length > 0;
  const readyEmptyFileView =
    code.files.length === 0 && filesLane?.status === "ready";
  const filesDocked =
    codeWidth === 0 ? !isNarrow : codeWidth >= DOCKED_FILES_MIN_WIDTH;
  const allFilesExpanded =
    code.files.length > 0 &&
    code.files.every((file) => Boolean(view.expandedPaths[file.path]));

  return (
    <>
      <section
        ref={codeRootRef}
        data-testid="pull-request-code-root"
        aria-label="Pull request Code"
        className="flex min-h-0 flex-1 flex-col bg-page"
      >
        <div
          data-testid="pull-request-code-toolbar"
          data-layout={filesDocked ? "wide" : "compact"}
          className="flex h-11 shrink-0 items-center gap-2 border-b border-border/35 bg-page px-3"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-xs text-muted-foreground">
            <GitBranch size={14} aria-hidden className="shrink-0" />
            <span className="min-w-0 truncate text-foreground/80">
              {detail.head.name}
            </span>
            <ChevronRight
              size={13}
              aria-hidden
              className="shrink-0 text-muted-foreground/55"
            />
            <span className="min-w-0 truncate">{detail.base.name}</span>
          </div>

          <div
            data-testid={
              !filesDocked ? "pull-request-code-actions-row" : undefined
            }
            className="ml-auto flex shrink-0 items-center justify-end gap-1"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={cn(
                "rounded-md text-muted-foreground",
                view.fileTreeVisible && "bg-muted/60 text-foreground",
              )}
              aria-label={
                view.fileTreeVisible
                  ? "Hide changed files"
                  : "Show changed files"
              }
              aria-pressed={view.fileTreeVisible}
              onClick={() =>
                usePullRequestCodeStore
                  .getState()
                  .setFileTreeVisible(!view.fileTreeVisible)
              }
            >
              <Files size={13} aria-hidden />
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={
                view.viewMode === "unified"
                  ? "Use split diff layout"
                  : "Use unified diff layout"
              }
              className="rounded-md text-muted-foreground"
              onClick={() =>
                usePullRequestCodeStore
                  .getState()
                  .setViewMode(
                    view.viewMode === "unified" ? "split" : "unified",
                  )
              }
            >
              {view.viewMode === "unified" ? (
                <Columns2 size={13} aria-hidden />
              ) : (
                <AlignJustify size={13} aria-hidden />
              )}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-md text-muted-foreground"
              aria-label={
                allFilesExpanded
                  ? "Collapse all file diffs"
                  : "Expand all file diffs"
              }
              onClick={() => {
                const store = usePullRequestCodeStore.getState();
                if (allFilesExpanded) store.collapseAll();
                else store.expandAll(code.files.map((file) => file.path));
              }}
            >
              {allFilesExpanded ? (
                <ChevronsDownUp size={13} aria-hidden />
              ) : (
                <ChevronsUpDown size={13} aria-hidden />
              )}
            </Button>
          </div>
        </div>

        {filesLane?.error && (
          <div
            role="alert"
            className="flex min-h-8 items-center gap-2 bg-destructive/8 px-3 text-xs text-muted-foreground"
          >
            <AlertCircle
              size={13}
              aria-hidden
              className="text-destructive/75"
            />
            <span className="min-w-0 flex-1 truncate">
              {filesLane.error.message}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-7 rounded-none text-xs"
              onClick={() =>
                void usePullRequestCodeStore.getState().loadFiles({ transport })
              }
            >
              Retry
            </Button>
          </div>
        )}

        {commentsPaginationStalled && (
          <p
            role="status"
            className="flex min-h-8 items-center gap-2 bg-primary/6 px-3 text-xs text-muted-foreground"
          >
            <AlertCircle size={13} aria-hidden className="text-primary/75" />
            Review thread loading stopped because GitHub repeated a page cursor.
            Some threads may be missing.
          </p>
        )}

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-page">
            {!code.entry ||
            (filesLane?.status === "loading" &&
              filesLane.fetchedAt === null) ? (
              <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                <Spinner size="xs" aria-hidden />
                <span role="status">Loading changed files</span>
              </div>
            ) : (
              <>
                {readyEmptyFileView && (
                  <div
                    className={cn(
                      "flex items-center justify-center px-6 text-center",
                      hasOrphanContext ? "shrink-0 py-4" : "min-h-0 flex-1",
                    )}
                  >
                    <div>
                      <span
                        aria-hidden
                        className="font-mono text-xl text-muted-foreground/40"
                      >
                        ∅
                      </span>
                      <p
                        role="status"
                        className="mt-1 text-xs text-muted-foreground"
                      >
                        No changed files match this view.
                      </p>
                    </div>
                  </div>
                )}
                {(!readyEmptyFileView || hasOrphanContext) && (
                  <PullRequestDiffViewport
                    identity={snapshotIdentity}
                    identityKey={identityKey}
                    baseOid={baseOid}
                    headOid={headOid}
                    files={code.files}
                    reviewThreads={reviewThreads}
                    commentsComplete={commentsComplete}
                    commentsBounded={comments.boundedData}
                    activePath={view.activePath}
                    isNarrow={isNarrow}
                    transport={transport}
                    onActivePathChange={(path) =>
                      usePullRequestCodeStore.getState().setActivePath(path)
                    }
                  />
                )}
              </>
            )}

            {filesLane?.boundedData && (
              <p
                role="status"
                className="shrink-0 bg-primary/6 px-3 py-1.5 text-xs text-muted-foreground"
              >
                {boundedFilesMessage(filesLane.boundedData)}
              </p>
            )}
            {filesLane?.nextCursor && (
              <div
                className="flex min-h-8 shrink-0 items-center gap-2 bg-background px-3 text-xs text-muted-foreground"
                style={
                  !filesDocked && view.fileTreeVisible
                    ? { marginRight: Math.min(filesPanelWidth, floatingFilesPanelMaxWidth) }
                    : undefined
                }
              >
                <span className="min-w-0 flex-1 truncate">
                  {filtersActive
                    ? `${code.files.length} matching files loaded. More results remain.`
                    : `${code.files.length} changed files loaded.`}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-7 rounded-none text-xs"
                  disabled={filesLane.status === "loading"}
                  onClick={() =>
                    void (filtersActive
                      ? usePullRequestCodeStore
                          .getState()
                          .loadAllFiles(transport)
                      : usePullRequestCodeStore
                          .getState()
                          .loadFiles({ append: true, transport }))
                  }
                >
                  {filtersActive ? "Search remaining files" : "Load more files"}
                </Button>
              </div>
            )}
          </div>

          {filesDocked && view.fileTreeVisible && (
            <PullRequestChangedFilesPane
              files={displayedFiles}
              activePath={view.activePath}
              query={view.query}
              width={filesPanelWidth}
              minWidth={FILES_PANEL_MIN_WIDTH}
              maxWidth={`calc(100% - ${DIFF_VIEWPORT_MIN_WIDTH}px)`}
              defaultWidth={FILES_PANEL_DEFAULT_WIDTH}
              wideWidth={FILES_PANEL_WIDE_WIDTH}
              getMaxWidth={getFilesPanelMaxWidth}
              onWidthChange={setFilesPanelWidth}
              onActivate={activateFile}
              onQueryChange={updateFileQuery}
            />
          )}
          {!filesDocked && view.fileTreeVisible && (
            <PullRequestChangedFilesPane
              files={displayedFiles}
              activePath={view.activePath}
              query={view.query}
              width={Math.min(filesPanelWidth, floatingFilesPanelMaxWidth)}
              minWidth={floatingFilesPanelMinWidth}
              maxWidth={`calc(100% - ${FLOATING_FILES_PANEL_EDGE_GAP}px)`}
              defaultWidth={FILES_PANEL_DEFAULT_WIDTH}
              wideWidth={FILES_PANEL_WIDE_WIDTH}
              getMaxWidth={getFloatingFilesPanelMaxWidth}
              onWidthChange={setFilesPanelWidth}
              className="absolute inset-y-0 right-0 z-30 h-full bg-popover shadow-lg animate-in slide-in-from-right-2 duration-150 motion-reduce:animate-none"
              onActivate={activateFile}
              onQueryChange={updateFileQuery}
            />
          )}
        </div>
      </section>
    </>
  );
}
