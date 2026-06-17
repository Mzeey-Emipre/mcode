import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getTransport } from "@/transport";
import type { PanelScope } from "@/lib/panel-tabs";
import { visibleReviewViews, defaultReviewView } from "@/lib/review-views";
import { BranchRefPicker } from "./BranchRefPicker";
import { CommitPicker } from "./CommitPicker";
import { ReviewActions } from "./ReviewActions";
import { DiffStat } from "./DiffStat";

type CommitAvailability = "loading" | "available" | "empty";

/** Toolbar for the Review tab: dual-scope view switcher + unified/side-by-side toggle. */
export function DiffToolbar() {
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
  const workingTreeDirty = useWorkingTreeDirty({
    activeWorkspaceId,
    activeThreadId,
    isGitRepo,
    diffScopeRevision,
  });

  // A thread follows the per-thread resolver (live default until pinned);
  // threadless keeps the scope-recovery fallback. See ADR-0011.
  useEffect(() => {
    if (viewModes.length === 0) return;
    if (activeThreadId) {
      const want = getReviewView(activeThreadId, { hasTurnChanges, isDirty: workingTreeDirty });
      const blockedCommit = want === "commit" && commitAvailability === "empty";
      const target =
        viewModes.some((m) => m.id === want) && !blockedCommit ? want : viewModes[0].id;
      if (viewMode !== target) setViewMode(target);
      return;
    }
    if (
      !viewModes.some((m) => m.id === viewMode) ||
      (viewMode === "commit" && commitAvailability === "empty")
    ) {
      const fallback = defaultReviewView(scope);
      setViewMode(viewModes.some((m) => m.id === fallback) ? fallback : viewModes[0].id);
    }
  }, [
    activeThreadId,
    getReviewView,
    reviewViewManuallySelected,
    pinnedReviewView,
    hasTurnChanges,
    workingTreeDirty,
    commitAvailability,
    viewMode,
    viewModes,
    scope,
    setViewMode,
  ]);

  const activeView = useMemo(
    () => viewModes.find((m) => m.id === viewMode),
    [viewModes, viewMode],
  );

  // The branch picker is wide, so it wraps to its own full-width row below.
  const branchOnSecondRow = activeView?.operand === "branch" && !!activeWorkspaceId;
  // Files present but no totalled stat yet → the stat is still loading.
  const diffStatLoading =
    reviewDiffStat == null && reviewFileCount != null && reviewFileCount > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-y-1.5 px-3 py-2 border-b border-border/30">
      {/* View selector + changed-file badge + total +/- stat. The wide branch
          picker wraps to its own full-width row below; commit stays inline. */}
      <div className="flex min-w-0 items-center gap-2">
        <DropdownMenu
          open={viewMenuOpen}
          onOpenChange={(open) => {
            setViewMenuOpen(open);
            if (open) setCommitProbeNonce((nonce) => nonce + 1);
          }}
        >
          <DropdownMenuTrigger
            data-testid="review-view-switcher"
            disabled={viewModes.length === 0}
            aria-label="Select review view"
            className="flex h-6 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium tracking-tight text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            {activeView?.label ?? "-"}
            {reviewFileCount != null && reviewFileCount > 0 && (
              <span
                className="ml-1 rounded-full bg-muted-foreground/15 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground"
                data-testid="review-file-count"
              >
                {reviewFileCount}
              </span>
            )}
            <ChevronDown size={11} className="text-muted-foreground/60" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="start" sideOffset={4} className="min-w-[150px]">
            {viewModes.map((mode) => {
              const active = viewMode === mode.id;
              const disabled = mode.id === "commit" && commitAvailability !== "available";
              return (
                <DropdownMenuItem
                  key={mode.id}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    // A pick in a thread sets the sticky per-thread override.
                    if (activeThreadId) setReviewViewForThread(activeThreadId, mode.id);
                    else setViewMode(mode.id);
                  }}
                  data-testid={`review-view-${mode.id}`}
                  data-active={active ? "true" : undefined}
                  aria-disabled={disabled ? "true" : undefined}
                  // base-ui menuitems have no checked state; aria-current exposes
                  // the active view to assistive tech (the Check is visual-only).
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
                  {active && <Check size={11} className="text-muted-foreground" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Total +/- for the active view; spinner while the stat loads. */}
        {diffStatLoading ? (
          <Loader2
            size={12}
            className="shrink-0 animate-spin text-muted-foreground/50"
            aria-label="Loading diff stats"
            data-testid="review-diff-stat-loading"
          />
        ) : (
          reviewDiffStat != null &&
          (reviewDiffStat.additions > 0 || reviewDiffStat.deletions > 0) && (
            <DiffStat
              additions={reviewDiffStat.additions}
              deletions={reviewDiffStat.deletions}
              className="shrink-0"
            />
          )
        )}

        {/* Commit operand stays inline; the wider branch picker is on row 2. */}
        {activeView?.operand === "commit" && (
          <div
            className="ml-1 flex min-w-0 items-center border-l border-border/25 pl-2"
            data-testid="review-operand-slot"
            data-operand="commit"
          >
            <CommitPicker />
          </div>
        )}
      </div>

      {/* Commit-or-push + Create-PR (worktree threads only). Wrap / split / jump
          now live on the file-list bar below. */}
      <div className="flex items-center gap-1">
        {activeThread && <ReviewActions thread={activeThread} />}
      </div>

      {/* Branch comparison wraps to its own full-width row; the picker is too
          wide to sit inline next to the selector. */}
      {branchOnSecondRow && activeWorkspaceId && (
        <div
          className="flex w-full min-w-0 basis-full items-center"
          data-testid="review-operand-slot"
          data-operand="branch"
        >
          <BranchRefPicker
            workspaceId={activeWorkspaceId}
            threadId={activeThreadId ?? undefined}
          />
        </div>
      )}
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
  const [availability, setAvailability] = useState<CommitAvailability>("loading");

  useEffect(() => {
    if (!activeWorkspaceId || !isGitRepo) {
      setAvailability("empty");
      return;
    }

    let cancelled = false;
    setAvailability("loading");

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
        if (!cancelled) setAvailability(commits.length > 0 ? "available" : "empty");
      } catch {
        if (!cancelled) setAvailability("empty");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceId,
    activeThreadId,
    threadBranch,
    isGitRepo,
    diffScopeRevision,
    commitProbeNonce,
  ]);

  return availability;
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
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!activeWorkspaceId || !isGitRepo) {
      setDirty(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const files = await getTransport().getWorkingTreeFiles(
          activeWorkspaceId,
          false,
          activeThreadId ?? undefined,
        );
        if (!cancelled) setDirty(files.length > 0);
      } catch {
        if (!cancelled) setDirty(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, activeThreadId, isGitRepo, diffScopeRevision]);

  return dirty;
}
