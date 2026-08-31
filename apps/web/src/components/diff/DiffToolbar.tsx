import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Files } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";
import type { PanelScope } from "@/lib/panel-tabs";
import { visibleReviewViews, defaultReviewView } from "@/lib/review-views";
import { BranchRefPicker } from "./BranchRefPicker";
import { CommitPicker } from "./CommitPicker";
import { ReviewActions } from "./ReviewActions";
import { DiffStat } from "./DiffStat";

type CommitAvailability = "loading" | "available" | "empty";
type BranchAvailability = "loading" | "available" | "empty";
type DiffStoreState = ReturnType<typeof useDiffStore.getState>;
type WorkspaceThread = ReturnType<typeof useWorkspaceStore.getState>["threads"][number];
type ReviewViewMode = ReturnType<typeof visibleReviewViews>[number];

interface ReviewViewSynchronizationInput {
  readonly activeThreadId: string | null;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly getReviewView: DiffStoreState["getReviewView"];
  readonly hasTurnChanges: boolean;
  readonly pinnedReviewView: DiffStoreState["reviewViewByThread"][string] | undefined;
  readonly reviewViewManuallySelected: boolean;
  readonly scope: PanelScope;
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMode: DiffStoreState["viewMode"];
  readonly viewModes: readonly ReviewViewMode[];
  readonly workingTreeDirty: boolean;
}

/** Props for the Dev Review toolbar. */
export interface DiffToolbarProps {
  /** Whether the active-comparison Files navigator is visible. */
  readonly filesVisible: boolean;
  /** Toggles the active-comparison Files navigator. */
  readonly onToggleFiles: () => void;
}

/** Toolbar for the Review tab: dual-scope view switcher + unified/side-by-side toggle. */
export function DiffToolbar({ filesVisible, onToggleFiles }: DiffToolbarProps) {
  const viewMode = useDiffStore((s) => s.viewMode);
  const reviewFileCount = useDiffStore((s) => s.reviewFileCount);
  const reviewDiffStat = useDiffStore((s) => s.reviewDiffStat);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setReviewViewForThread = useDiffStore((s) => s.setReviewViewForThread);
  const getReviewView = useDiffStore((s) => s.getReviewView);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [commitProbeNonce, setCommitProbeNonce] = useState(0);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThread = useWorkspaceStore(
    (s) => s.threads.find((t) => t.id === s.activeThreadId) ?? null,
  );
  const threadBranch = useWorkspaceStore((s) => {
    const thread = s.threads.find((t) => t.id === s.activeThreadId);
    return thread?.branch ?? undefined;
  });
  const diffScopeRevision = useDiffStore((s) =>
    activeWorkspaceId ? (s.diffRevisionByScope[activeThreadId ?? activeWorkspaceId] ?? 0) : 0,
  );
  const [branchProbeNonce, setBranchProbeNonce] = useState(0);

  const isGitRepo = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.is_git_repo ?? false,
  );

  // Change-state signals for the per-thread default (ADR-0011).
  const reviewViewManuallySelected = useDiffStore((s) =>
    activeThreadId ? (s.reviewViewManuallySelectedByThread[activeThreadId] ?? false) : false,
  );
  const pinnedReviewView = useDiffStore((s) =>
    activeThreadId ? s.reviewViewByThread[activeThreadId] : undefined,
  );
  const hasTurnChanges = useDiffStore((s) => {
    if (!activeThreadId) return false;
    const snaps = s.snapshotsByThread[activeThreadId];
    return !!snaps && snaps.some((snap) => snap.files_changed.length > 0);
  });

  // The Review tab is dual-scope: threadless yields the git working-tree views,
  // a thread yields the turn views. Runtime gates drop the git views in a
  // non-git workspace.
  const scope: PanelScope = activeThreadId ? "thread" : "threadless";
  const viewModes = useMemo(
    () => visibleReviewViews(scope, { isGitRepo }),
    [scope, isGitRepo],
  );
  const commitAvailability = useCommitAvailability({
    activeWorkspaceId,
    activeThreadId,
    threadBranch,
    isGitRepo,
    diffScopeRevision,
    commitProbeNonce,
  });
  const branchAvailability = useBranchAvailability({
    activeWorkspaceId,
    activeThreadId,
    isGitRepo,
    diffScopeRevision,
    branchProbeNonce,
  });
  const workingTreeDirty = useWorkingTreeDirty({
    activeWorkspaceId,
    activeThreadId,
    isGitRepo,
    diffScopeRevision,
  });

  useReviewViewSynchronization({
    activeThreadId,
    branchAvailability,
    commitAvailability,
    getReviewView,
    hasTurnChanges,
    pinnedReviewView,
    reviewViewManuallySelected,
    scope,
    setViewMode,
    viewMode,
    viewModes,
    workingTreeDirty,
  });

  const activeView = useMemo(
    () => viewModes.find((m) => m.id === viewMode),
    [viewModes, viewMode],
  );

  return (
    <DiffToolbarContent
      activeThread={activeThread}
      activeThreadId={activeThreadId}
      activeView={activeView}
      activeWorkspaceId={activeWorkspaceId}
      branchAvailability={branchAvailability}
      commitAvailability={commitAvailability}
      diffScopeRevision={diffScopeRevision}
      filesVisible={filesVisible}
      onToggleFiles={onToggleFiles}
      onViewMenuOpenChange={(open) => {
        setViewMenuOpen(open);
        if (open) {
          setCommitProbeNonce((nonce) => nonce + 1);
          setBranchProbeNonce((nonce) => nonce + 1);
        }
      }}
      reviewDiffStat={reviewDiffStat}
      reviewFileCount={reviewFileCount}
      setReviewViewForThread={setReviewViewForThread}
      setViewMode={setViewMode}
      viewMenuOpen={viewMenuOpen}
      viewMode={viewMode}
      viewModes={viewModes}
    />
  );
}

function useReviewViewSynchronization(input: ReviewViewSynchronizationInput): void {
  const {
    activeThreadId,
    branchAvailability,
    commitAvailability,
    getReviewView,
    hasTurnChanges,
    pinnedReviewView,
    reviewViewManuallySelected,
    scope,
    setViewMode,
    viewMode,
    viewModes,
    workingTreeDirty,
  } = input;

  useEffect(() => {
    synchronizeReviewView({
      activeThreadId,
      branchAvailability,
      commitAvailability,
      getReviewView,
      hasTurnChanges,
      pinnedReviewView,
      reviewViewManuallySelected,
      scope,
      setViewMode,
      viewMode,
      viewModes,
      workingTreeDirty,
    });
  }, [
    activeThreadId,
    branchAvailability,
    commitAvailability,
    getReviewView,
    hasTurnChanges,
    pinnedReviewView,
    reviewViewManuallySelected,
    scope,
    setViewMode,
    viewMode,
    viewModes,
    workingTreeDirty,
  ]);
}

function synchronizeReviewView(input: ReviewViewSynchronizationInput): void {
  if (input.viewModes.length === 0) return;
  if (input.activeThreadId) {
    synchronizeThreadReviewView(input);
    return;
  }
  synchronizeThreadlessReviewView(input);
}

function synchronizeThreadReviewView(input: ReviewViewSynchronizationInput): void {
  const wantedView = input.getReviewView(input.activeThreadId!, {
    hasTurnChanges: input.hasTurnChanges,
    isDirty: input.workingTreeDirty,
  });
  const target = isAvailableThreadReviewView(wantedView, input)
    ? wantedView
    : input.viewModes[0].id;
  if (input.viewMode !== target) input.setViewMode(target);
}

function isAvailableThreadReviewView(
  wantedView: DiffStoreState["viewMode"],
  input: ReviewViewSynchronizationInput,
): boolean {
  return input.viewModes.some((mode) => mode.id === wantedView) &&
    !(wantedView === "commit" && input.commitAvailability === "empty");
}

function synchronizeThreadlessReviewView(input: ReviewViewSynchronizationInput): void {
  if (!isInvalidThreadlessReviewView(input)) return;
  const fallback = defaultReviewView(input.scope);
  const target = input.viewModes.some((mode) => mode.id === fallback)
    ? fallback
    : input.viewModes[0].id;
  input.setViewMode(target);
}

function isInvalidThreadlessReviewView(input: ReviewViewSynchronizationInput): boolean {
  return !input.viewModes.some((mode) => mode.id === input.viewMode) ||
    (input.viewMode === "commit" && input.commitAvailability === "empty") ||
    (input.viewMode === "branch" && input.branchAvailability === "empty");
}

function DiffToolbarContent({
  activeThread,
  activeThreadId,
  activeView,
  activeWorkspaceId,
  branchAvailability,
  commitAvailability,
  diffScopeRevision,
  filesVisible,
  onToggleFiles,
  onViewMenuOpenChange,
  reviewDiffStat,
  reviewFileCount,
  setReviewViewForThread,
  setViewMode,
  viewMenuOpen,
  viewMode,
  viewModes,
}: {
  readonly activeThread: WorkspaceThread | null;
  readonly activeThreadId: string | null;
  readonly activeView: ReviewViewMode | undefined;
  readonly activeWorkspaceId: string | null;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly diffScopeRevision: number;
  readonly filesVisible: boolean;
  readonly onToggleFiles: () => void;
  readonly onViewMenuOpenChange: (open: boolean) => void;
  readonly reviewDiffStat: DiffStoreState["reviewDiffStat"];
  readonly reviewFileCount: number | null;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMenuOpen: boolean;
  readonly viewMode: DiffStoreState["viewMode"];
  readonly viewModes: readonly ReviewViewMode[];
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-y-1.5 px-3 py-2 border-b border-border/30">
      <ReviewToolbarStart
        activeThreadId={activeThreadId}
        activeView={activeView}
        branchAvailability={branchAvailability}
        commitAvailability={commitAvailability}
        onViewMenuOpenChange={onViewMenuOpenChange}
        reviewDiffStat={reviewDiffStat}
        reviewFileCount={reviewFileCount}
        setReviewViewForThread={setReviewViewForThread}
        setViewMode={setViewMode}
        viewMenuOpen={viewMenuOpen}
        viewMode={viewMode}
        viewModes={viewModes}
      />
      <ReviewToolbarActions
        activeThread={activeThread}
        filesVisible={filesVisible}
        onToggleFiles={onToggleFiles}
      />
      <BranchOperand
        activeThreadId={activeThreadId}
        activeView={activeView}
        activeWorkspaceId={activeWorkspaceId}
        diffScopeRevision={diffScopeRevision}
      />
    </div>
  );
}

function ReviewToolbarStart({
  activeThreadId,
  activeView,
  branchAvailability,
  commitAvailability,
  onViewMenuOpenChange,
  reviewDiffStat,
  reviewFileCount,
  setReviewViewForThread,
  setViewMode,
  viewMenuOpen,
  viewMode,
  viewModes,
}: {
  readonly activeThreadId: string | null;
  readonly activeView: ReviewViewMode | undefined;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly onViewMenuOpenChange: (open: boolean) => void;
  readonly reviewDiffStat: DiffStoreState["reviewDiffStat"];
  readonly reviewFileCount: number | null;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMenuOpen: boolean;
  readonly viewMode: DiffStoreState["viewMode"];
  readonly viewModes: readonly ReviewViewMode[];
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ReviewViewMenu
        activeThreadId={activeThreadId}
        activeView={activeView}
        branchAvailability={branchAvailability}
        commitAvailability={commitAvailability}
        onOpenChange={onViewMenuOpenChange}
        reviewFileCount={reviewFileCount}
        setReviewViewForThread={setReviewViewForThread}
        setViewMode={setViewMode}
        viewMenuOpen={viewMenuOpen}
        viewMode={viewMode}
        viewModes={viewModes}
      />
      <ReviewDiffStat reviewDiffStat={reviewDiffStat} reviewFileCount={reviewFileCount} />
      <CommitOperand activeView={activeView} />
    </div>
  );
}

function ReviewViewMenu({
  activeThreadId,
  activeView,
  branchAvailability,
  commitAvailability,
  onOpenChange,
  reviewFileCount,
  setReviewViewForThread,
  setViewMode,
  viewMenuOpen,
  viewMode,
  viewModes,
}: {
  readonly activeThreadId: string | null;
  readonly activeView: ReviewViewMode | undefined;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly onOpenChange: (open: boolean) => void;
  readonly reviewFileCount: number | null;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMenuOpen: boolean;
  readonly viewMode: DiffStoreState["viewMode"];
  readonly viewModes: readonly ReviewViewMode[];
}) {
  return (
    <DropdownMenu open={viewMenuOpen} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        data-testid="review-view-switcher"
        disabled={viewModes.length === 0}
        aria-label="Select review view"
        className="flex h-6 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium tracking-tight text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
      >
        {activeView?.label ?? "-"}
        <ReviewFileCount fileCount={reviewFileCount} />
        <ChevronDown size={11} className="text-muted-foreground/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[150px]">
        {viewModes.map((mode) => (
          <ReviewViewMenuItem
            key={mode.id}
            activeThreadId={activeThreadId}
            branchAvailability={branchAvailability}
            commitAvailability={commitAvailability}
            mode={mode}
            setReviewViewForThread={setReviewViewForThread}
            setViewMode={setViewMode}
            viewMode={viewMode}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReviewFileCount({ fileCount }: { readonly fileCount: number | null }) {
  if (fileCount === null || fileCount <= 0) return null;
  return (
    <span
      className="ml-1 rounded-full bg-muted-foreground/15 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground"
      data-testid="review-file-count"
    >
      {fileCount}
    </span>
  );
}

function ReviewViewMenuItem({
  activeThreadId,
  branchAvailability,
  commitAvailability,
  mode,
  setReviewViewForThread,
  setViewMode,
  viewMode,
}: {
  readonly activeThreadId: string | null;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly mode: ReviewViewMode;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMode: DiffStoreState["viewMode"];
}) {
  const active = viewMode === mode.id;
  const disabled = isReviewViewUnavailable(mode, commitAvailability, branchAvailability);
  return (
    <DropdownMenuItem
      disabled={disabled}
      onClick={() => selectReviewView({
        activeThreadId,
        disabled,
        mode,
        setReviewViewForThread,
        setViewMode,
      })}
      data-testid={`review-view-${mode.id}`}
      data-active={active ? "true" : undefined}
      aria-disabled={disabled ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs",
        disabled
          ? "cursor-not-allowed text-muted-foreground/45"
          : active
            ? "text-foreground"
            : "text-popover-foreground",
      )}
    >
      <span className="flex-1 text-left">{mode.label}</span>
      {active ? <Check size={11} className="text-muted-foreground" /> : null}
    </DropdownMenuItem>
  );
}

function isReviewViewUnavailable(
  mode: ReviewViewMode,
  commitAvailability: CommitAvailability,
  branchAvailability: BranchAvailability,
): boolean {
  return (mode.id === "commit" && commitAvailability === "empty") ||
    (mode.id === "branch" && branchAvailability === "empty");
}

function selectReviewView({
  activeThreadId,
  disabled,
  mode,
  setReviewViewForThread,
  setViewMode,
}: {
  readonly activeThreadId: string | null;
  readonly disabled: boolean;
  readonly mode: ReviewViewMode;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
}): void {
  if (disabled) return;
  if (activeThreadId) {
    setReviewViewForThread(activeThreadId, mode.id);
    return;
  }
  setViewMode(mode.id);
}

function ReviewDiffStat({
  reviewDiffStat,
  reviewFileCount,
}: {
  readonly reviewDiffStat: DiffStoreState["reviewDiffStat"];
  readonly reviewFileCount: number | null;
}) {
  if (reviewDiffStat === null && reviewFileCount !== null && reviewFileCount > 0) {
    return (
      <Spinner
        size={12}
        className="text-muted-foreground/50"
        aria-label="Loading diff stats"
        data-testid="review-diff-stat-loading"
      />
    );
  }
  if (reviewDiffStat === null || (reviewDiffStat.additions === 0 && reviewDiffStat.deletions === 0)) {
    return null;
  }
  return (
    <DiffStat
      additions={reviewDiffStat.additions}
      deletions={reviewDiffStat.deletions}
      className="shrink-0"
    />
  );
}

function CommitOperand({ activeView }: { readonly activeView: ReviewViewMode | undefined }) {
  if (activeView?.operand !== "commit") return null;
  return (
    <div
      className="ml-1 flex min-w-0 items-center border-l border-border/25 pl-2"
      data-testid="review-operand-slot"
      data-operand="commit"
    >
      <CommitPicker />
    </div>
  );
}

function ReviewToolbarActions({
  activeThread,
  filesVisible,
  onToggleFiles,
}: {
  readonly activeThread: WorkspaceThread | null;
  readonly filesVisible: boolean;
  readonly onToggleFiles: () => void;
}) {
  const filesLabel = filesVisible ? "Hide files" : "Show files";
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={filesLabel}
              aria-pressed={filesVisible}
              className={cn(
                "rounded-md text-muted-foreground",
                filesVisible && "bg-muted/60 text-foreground",
              )}
              onClick={onToggleFiles}
            >
              <Files size={13} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="bottom" className="text-xs">
          {filesLabel}
        </TooltipContent>
      </Tooltip>
      {activeThread ? <ReviewActions thread={activeThread} /> : null}
    </div>
  );
}

function BranchOperand({
  activeThreadId,
  activeView,
  activeWorkspaceId,
  diffScopeRevision,
}: {
  readonly activeThreadId: string | null;
  readonly activeView: ReviewViewMode | undefined;
  readonly activeWorkspaceId: string | null;
  readonly diffScopeRevision: number;
}) {
  if (activeView?.operand !== "branch" || !activeWorkspaceId) return null;
  return (
    <div
      className="flex w-full min-w-0 basis-full items-center"
      data-testid="review-operand-slot"
      data-operand="branch"
    >
      <BranchRefPicker
        workspaceId={activeWorkspaceId}
        threadId={activeThreadId ?? undefined}
        diffScopeRevision={diffScopeRevision}
      />
    </div>
  );
}

function useCommitAvailability({
  activeWorkspaceId,
  activeThreadId,
  threadBranch,
  isGitRepo,
  diffScopeRevision,
  commitProbeNonce,
}: {
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  threadBranch?: string;
  isGitRepo: boolean;
  diffScopeRevision: number;
  commitProbeNonce: number;
}): CommitAvailability {
  const [result, setResult] = useState<{ key: string; value: CommitAvailability } | null>(null);
  const canProbe = activeWorkspaceId !== null && isGitRepo;
  const key = JSON.stringify([
    activeWorkspaceId,
    activeThreadId,
    threadBranch,
    diffScopeRevision,
    commitProbeNonce,
  ]);

  useEffect(() => {
    if (!canProbe || !activeWorkspaceId) return;

    let cancelled = false;

    void (async () => {
      try {
        const transport = getTransport();
        const branch = activeThreadId
          ? threadBranch
          : ((await transport.getCurrentBranch(activeWorkspaceId)) ?? undefined);
        const commits = await transport.getGitLog(
          activeWorkspaceId,
          branch,
          1,
          undefined,
          activeThreadId ?? undefined,
          { skip: 0, includeStats: false },
        );
        if (!cancelled) setResult({ key, value: commits.length > 0 ? "available" : "empty" });
      } catch {
        if (!cancelled) setResult({ key, value: "empty" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceId,
    activeThreadId,
    threadBranch,
    canProbe,
    key,
  ]);

  if (!canProbe) return "empty";
  return result?.key === key ? result.value : "loading";
}

/** Probe whether the Branch view has a resolvable comparison for the active scope. */
function useBranchAvailability({
  activeWorkspaceId,
  activeThreadId,
  isGitRepo,
  diffScopeRevision,
  branchProbeNonce,
}: {
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  isGitRepo: boolean;
  diffScopeRevision: number;
  branchProbeNonce: number;
}): BranchAvailability {
  const [result, setResult] = useState<{ key: string; value: BranchAvailability } | null>(null);
  const canProbe = activeWorkspaceId !== null && isGitRepo;
  const key = JSON.stringify([
    activeWorkspaceId,
    activeThreadId,
    diffScopeRevision,
    branchProbeNonce,
  ]);

  useEffect(() => {
    if (!canProbe || !activeWorkspaceId) return;

    let cancelled = false;

    void getTransport()
      .getBranchComparison(activeWorkspaceId, activeThreadId ?? undefined)
      .then((result) => {
        if (cancelled) return;
        // Treat a missing flag as available for older servers; only explicit false
        // disables the view (local-only default branch, unborn repo, etc.).
        const available = !result.isUnborn && result.isComparisonAvailable !== false;
        setResult({ key, value: available ? "available" : "empty" });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, value: "empty" });
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, activeThreadId, canProbe, key]);

  if (!canProbe) return "empty";
  return result?.key === key ? result.value : "loading";
}

/**
 * Probes whether the active scope's working tree has uncommitted changes — the
 * `isDirty` signal for the per-thread Review default (ADR-0011). Refetches on
 * `diffScopeRevision` bumps; returns false while loading, off-git, or on error.
 */
function useWorkingTreeDirty({
  activeWorkspaceId,
  activeThreadId,
  isGitRepo,
  diffScopeRevision,
}: {
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  isGitRepo: boolean;
  diffScopeRevision: number;
}): boolean {
  const [result, setResult] = useState<{ key: string; value: boolean } | null>(null);
  const canProbe = activeWorkspaceId !== null && isGitRepo;
  const key = JSON.stringify([activeWorkspaceId, activeThreadId, diffScopeRevision]);

  useEffect(() => {
    if (!canProbe || !activeWorkspaceId) return;

    let cancelled = false;
    void (async () => {
      try {
        const files = await getTransport().getWorkingTreeFiles(
          activeWorkspaceId,
          false,
          activeThreadId ?? undefined,
        );
        if (!cancelled) setResult({ key, value: files.length > 0 });
      } catch {
        if (!cancelled) setResult({ key, value: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, activeThreadId, canProbe, key]);

  return canProbe && result?.key === key ? result.value : false;
}
