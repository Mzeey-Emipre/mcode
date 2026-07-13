import type {
  PullRequestBoundedDataMarker,
  PullRequestCapability,
  PullRequestDetail,
  PullRequestFileChangeType,
  PullRequestIdentity,
  PullRequestReviewThread,
} from "@mcode/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignJustify,
  AlertCircle,
  ChevronDown,
  ChevronsDownUp,
  Columns2,
  Files,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
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
import { PullRequestDiffViewport } from "./PullRequestDiffViewport";
import { PullRequestFileTree } from "./PullRequestFileTree";
import { PullRequestSubmitReviewDialog } from "./PullRequestSubmitReviewDialog";
import { pullRequestCapabilityReason } from "./PullRequestMutationError";

const FILE_SEARCH_DEBOUNCE_MS = 250;

interface ReviewThreadPaginationRun {
  generation: number | null;
  pendingAppend: { cursor: string; generation: number } | null;
  successfulAppendCursors: Set<string>;
}

const changeTypeOptions: Array<{
  value: PullRequestFileChangeType;
  label: string;
}> = [
  { value: "added", label: "Added" },
  { value: "modified", label: "Modified" },
  { value: "deleted", label: "Deleted" },
  { value: "renamed", label: "Renamed" },
  { value: "copied", label: "Copied" },
  { value: "changed", label: "Changed" },
  { value: "unchanged", label: "Unchanged" },
];

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
  const [searchInput, setSearchInput] = useState("");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
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
    const timeoutId = window.setTimeout(() => {
      if (searchInput.trim() === view.query.search) return;
      usePullRequestCodeStore
        .getState()
        .setFileQuery({ ...view.query, search: searchInput }, transport);
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [searchInput, transport, view.query]);

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

  const toggleChangeType = (changeType: PullRequestFileChangeType): void => {
    const changeTypes = view.query.changeTypes.includes(changeType)
      ? view.query.changeTypes.filter((item) => item !== changeType)
      : [...view.query.changeTypes, changeType];
    usePullRequestCodeStore
      .getState()
      .setFileQuery({ ...view.query, changeTypes }, transport);
  };

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

  return (
    <>
      <section
        data-testid="pull-request-code-root"
        aria-label="Pull request Code"
        className="flex min-h-0 flex-1 flex-col bg-page"
      >
        <div
          data-testid="pull-request-code-toolbar"
          data-layout={isNarrow ? "compact" : "wide"}
          className={cn(
            "shrink-0 bg-background",
            !isNarrow &&
              "flex h-10 items-center gap-2 px-3",
          )}
        >
          {isNarrow && (
            <div
              data-testid="pull-request-code-file-row"
              className="flex h-10 min-w-0 items-center px-3"
            >
              <Popover open={filePickerOpen} onOpenChange={setFilePickerOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 min-w-0 flex-1 justify-start gap-2 px-2 font-mono text-xs text-foreground/90"
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
                  className="h-80 w-[min(22rem,calc(100vw-2rem))] rounded-none p-0"
                >
                  <PullRequestFileTree
                    files={displayedFiles}
                    activePath={view.activePath}
                    searchActive={filtersActive}
                    className="h-full"
                    ariaLabel="Choose a changed file"
                    onActivate={activateFile}
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}

          <div
            data-testid={isNarrow ? "pull-request-code-actions-row" : undefined}
            className={cn(
              isNarrow
                ? "flex h-10 min-w-0 items-center gap-1 px-3"
                : "contents",
            )}
          >
            <div
              className={cn("relative", isNarrow ? "min-w-0 flex-1" : "w-64")}
            >
              <Search
                size={13}
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/70"
              />
              <Input
                size="sm"
                value={searchInput}
                maxLength={200}
                aria-label="Search changed files"
                placeholder="Find changed files"
                className="rounded-none bg-page pl-8 font-mono text-xs"
                onChange={(event) => setSearchInput(event.target.value)}
              />
            </div>

            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1 rounded-none px-2 text-xs text-muted-foreground"
                    aria-label="Filter changed files by status"
                  >
                    <SlidersHorizontal size={12} aria-hidden />
                    {!isNarrow && "Status"}
                    {view.query.changeTypes.length > 0 && (
                      <Badge
                        variant="secondary"
                        size="sm"
                        className="font-mono tabular-nums"
                      >
                        {view.query.changeTypes.length}
                      </Badge>
                    )}
                  </Button>
                }
              />
              <PopoverContent
                align="start"
                sideOffset={6}
                className="w-56 rounded-none p-2"
              >
                <div
                  role="group"
                  aria-label="Changed file statuses"
                  className="grid grid-cols-2 gap-1"
                >
                  {changeTypeOptions.map((option) => {
                    const pressed = view.query.changeTypes.includes(
                      option.value,
                    );
                    return (
                      <Button
                        key={option.value}
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-pressed={pressed}
                        className={cn(
                          "justify-start rounded-none px-2 text-xs font-normal",
                          pressed && "bg-primary/9 text-foreground",
                        )}
                        onClick={() => toggleChangeType(option.value)}
                      >
                        {option.label}
                      </Button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>

            <div
              role="group"
              aria-label="Diff layout"
              className="ml-auto flex items-center"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Use unified diff layout"
                aria-pressed={view.viewMode === "unified"}
                className={cn(
                  "rounded-none text-muted-foreground",
                  view.viewMode === "unified" && "bg-primary/9 text-foreground",
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
                  "rounded-none text-muted-foreground",
                  view.viewMode === "split" && "bg-primary/9 text-foreground",
                )}
                onClick={() =>
                  usePullRequestCodeStore.getState().setViewMode("split")
                }
              >
                <Columns2 size={13} aria-hidden />
              </Button>
            </div>

            {!isNarrow && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-none text-muted-foreground"
                aria-label={
                  view.fileTreeVisible
                    ? "Hide Change stack"
                    : "Show Change stack"
                }
                aria-pressed={view.fileTreeVisible}
                onClick={() =>
                  usePullRequestCodeStore
                    .getState()
                    .setFileTreeVisible(!view.fileTreeVisible)
                }
              >
                {view.fileTreeVisible ? (
                  <PanelLeftClose size={13} aria-hidden />
                ) : (
                  <PanelLeftOpen size={13} aria-hidden />
                )}
              </Button>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-none text-muted-foreground"
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
          {!isNarrow && view.fileTreeVisible && (
            <aside
              className="flex w-64 shrink-0 flex-col bg-background"
              aria-label="Change stack"
            >
              <div className="flex h-8 shrink-0 items-center px-3">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Change stack
                </span>
                <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/75">
                  {code.files.length}
                </span>
              </div>
              <PullRequestFileTree
                files={displayedFiles}
                activePath={view.activePath}
                searchActive={filtersActive}
                className="min-h-0 flex-1"
                onActivate={activateFile}
              />
            </aside>
          )}

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
                className="shrink-0 bg-primary/6 px-3 py-1.5 text-[11px] text-muted-foreground"
              >
                {boundedFilesMessage(filesLane.boundedData)}
              </p>
            )}
            {filesLane?.nextCursor && (
              <div className="flex min-h-8 shrink-0 items-center gap-2 bg-background px-3 text-[11px] text-muted-foreground">
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
              className={cn(
                "min-h-10 shrink-0 bg-background px-3 py-1.5",
                isNarrow
                  ? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
                  : "flex flex-wrap items-center gap-2",
              )}
            >
              <div
                className={cn(
                  "min-w-0",
                  isNarrow ? "flex flex-col gap-1" : "contents",
                )}
              >
                <div
                  className={cn(
                    "flex items-center gap-2",
                    !isNarrow && "contents",
                  )}
                >
                  <span className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground/80">
                    Review
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {activeDraftCount}{" "}
                    {activeDraftCount === 1 ? "draft" : "drafts"}
                  </span>
                </div>
                {reviewUnavailableReason ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {reviewUnavailableReason}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    HEAD {headOid.slice(0, 8)}
                  </span>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                disabled={Boolean(reviewUnavailableReason)}
                onClick={() => setSubmitReviewOpen(true)}
              >
                Submit review
              </Button>
            </div>
          </div>
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
