import type {
  PullRequestBoundedDataMarker,
  PullRequestCapability,
  PullRequestDetail,
  PullRequestIdentity,
  PullRequestReviewThread,
} from "@mcode/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignJustify,
  AlertCircle,
  ChevronDown,
  ChevronsDownUp,
  Columns2,
  Files,
  PanelRightOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useElementWidth } from "@/hooks/useElementWidth";
import {
  selectPullRequestCodeCore,
  selectPullRequestCodeView,
} from "@/stores/pull-request-code-selectors";
import {
  getPullRequestPatchKey,
  usePullRequestCodeStore,
} from "@/stores/pullRequestCodeStore";
import { usePullRequestDetailStore } from "@/stores/pullRequestDetailStore";
import { usePullRequestReviewDraftStore } from "@/stores/pullRequestReviewDraftStore";
import { usePullRequestStore } from "@/stores/pullRequestStore";
import type { PullRequestTransport } from "@/transport/pull-requests";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/shallow";
import { PullRequestChangedFilesPane } from "./PullRequestChangedFilesPane";
import { PullRequestDiffViewport } from "./PullRequestDiffViewport";
import { PullRequestSubmitReviewDialog } from "./PullRequestSubmitReviewDialog";
import { pullRequestCapabilityReason } from "./PullRequestMutationError";

const FILES_PANEL_MIN_WIDTH = 220;
const FILES_PANEL_DEFAULT_WIDTH = 256;
const FILES_PANEL_WIDE_WIDTH = 480;
const DIFF_VIEWPORT_MIN_WIDTH = 440;
const DOCKED_FILES_MIN_WIDTH = FILES_PANEL_MIN_WIDTH + DIFF_VIEWPORT_MIN_WIDTH;

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
  reviewCapability: PullRequestCapability | null | undefined;
  mutationTransport?: PullRequestMutationTransport;
  onRefresh: () => Promise<boolean> | boolean;
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
  reviewCapability,
  mutationTransport,
  onRefresh,
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
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filesPanelWidth, setFilesPanelWidth] = useState(
    FILES_PANEL_DEFAULT_WIDTH,
  );
  const codeRootRef = useRef<HTMLElement>(null);
  const codeWidth = useElementWidth(codeRootRef, identityKey);
  const [submitReviewOpen, setSubmitReviewOpen] = useState(false);
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
  const activeDraftCount = usePullRequestReviewDraftStore((state) =>
    activeDraftIdentityKey === null
      ? 0
      : state.order.reduce(
          (count, localId) =>
            count +
            (state.drafts[localId]?.identityKey === activeDraftIdentityKey
              ? 1
              : 0),
          0,
        ),
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
    setFilePickerOpen(false);
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
  const activeFileLabel =
    code.files.find((file) => file.path === view.activePath)?.path ??
    "Choose a changed file";
  const reviewUnavailableReason =
    pullRequestCapabilityReason(reviewCapability) ??
    (activeDraftIdentityKey ? null : "The review snapshot is still loading.");
  const filesDocked =
    codeWidth === 0 ? !isNarrow : codeWidth >= DOCKED_FILES_MIN_WIDTH;

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
          className="flex h-11 shrink-0 items-center gap-2 bg-background/80 px-3"
        >
          {!filesDocked ? (
            <div
              data-testid="pull-request-code-file-row"
              className="flex min-w-0 flex-1 items-center"
            >
              <Popover open={filePickerOpen} onOpenChange={setFilePickerOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 min-w-0 flex-1 justify-start gap-2 rounded-md bg-page/65 px-2 font-mono text-xs text-foreground/90 hover:bg-muted/35"
                      aria-label="Choose a changed file"
                    >
                      <Files
                        size={14}
                        aria-hidden
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{activeFileLabel}</span>
                      <ChevronDown
                        size={13}
                        aria-hidden
                        className={cn(
                          "ml-auto shrink-0 text-muted-foreground/70 transition-transform duration-200 motion-reduce:transition-none",
                          filePickerOpen && "rotate-180",
                        )}
                      />
                    </Button>
                  }
                />
                <PopoverContent
                  align="start"
                  sideOffset={6}
                  className="h-80 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg p-0"
                >
                  <PullRequestChangedFilesPane
                    files={displayedFiles}
                    activePath={view.activePath}
                    query={view.query}
                    className="h-full"
                    ariaLabel="Choose a changed file"
                    onActivate={activateFile}
                    onQueryChange={updateFileQuery}
                  />
                </PopoverContent>
              </Popover>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Files size={14} aria-hidden className="shrink-0" />
              <span className="font-mono tabular-nums">
                {code.files.length} changed files
              </span>
            </div>
          )}

          <div
            data-testid={
              !filesDocked ? "pull-request-code-actions-row" : undefined
            }
            className="ml-auto flex shrink-0 items-center justify-end gap-1"
          >
            <div
              role="group"
              aria-label="Diff layout"
              className="flex items-center rounded-md bg-page/65 p-0.5"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Use unified diff layout"
                aria-pressed={view.viewMode === "unified"}
                className={cn(
                  "rounded-sm text-muted-foreground",
                  view.viewMode === "unified" && "bg-muted/70 text-foreground",
                )}
                onClick={() =>
                  usePullRequestCodeStore.getState().setViewMode("unified")
                }
              >
                <AlignJustify size={13} aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Use split diff layout"
                aria-pressed={view.viewMode === "split"}
                className={cn(
                  "rounded-sm text-muted-foreground",
                  view.viewMode === "split" && "bg-muted/70 text-foreground",
                )}
                onClick={() =>
                  usePullRequestCodeStore.getState().setViewMode("split")
                }
              >
                <Columns2 size={13} aria-hidden />
              </Button>
            </div>

            {filesDocked && !view.fileTreeVisible && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-md text-muted-foreground"
                aria-label="Show changed files"
                onClick={() =>
                  usePullRequestCodeStore.getState().setFileTreeVisible(true)
                }
              >
                <PanelRightOpen size={13} aria-hidden />
              </Button>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-md text-muted-foreground"
              aria-label="Collapse all file diffs"
              onClick={() => usePullRequestCodeStore.getState().collapseAll()}
            >
              <ChevronsDownUp size={13} aria-hidden />
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

        <div className="flex min-h-0 flex-1">
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
              <div className="flex min-h-8 shrink-0 items-center gap-2 bg-background px-3 text-xs text-muted-foreground">
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
            <div
              data-testid="pull-request-review-footer"
              data-layout={isNarrow ? "compact" : "wide"}
              className="flex h-11 shrink-0 items-center gap-2 border-t border-border/35 bg-page px-3"
            >
              {reviewUnavailableReason ? (
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {reviewUnavailableReason}
                </span>
              ) : activeDraftCount > 0 ? (
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {activeDraftCount} draft{" "}
                  {activeDraftCount === 1 ? "comment" : "comments"}
                </span>
              ) : null}
              <Button
                type="button"
                size="xs"
                className="ml-auto shrink-0"
                disabled={Boolean(reviewUnavailableReason)}
                onClick={() => setSubmitReviewOpen(true)}
              >
                Submit review
              </Button>
            </div>
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
              onClose={() =>
                usePullRequestCodeStore.getState().setFileTreeVisible(false)
              }
            />
          )}
        </div>
      </section>
      {activeDraftIdentityKey ? (
        <PullRequestSubmitReviewDialog
          open={submitReviewOpen}
          onOpenChange={setSubmitReviewOpen}
          detail={detail}
          draftIdentityKey={activeDraftIdentityKey}
          threadIndexComplete={commentsComplete}
          capability={reviewCapability}
          mutationTransport={mutationTransport}
          readTransport={transport}
          onRefresh={onRefresh}
        />
      ) : null}
    </>
  );
}
