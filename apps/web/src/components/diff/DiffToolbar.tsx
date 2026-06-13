import { useEffect, useMemo, useState } from "react";
import { Columns2, AlignJustify, WrapText, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

type CommitAvailability = "loading" | "available" | "empty";

/** Toolbar for the Review tab: dual-scope view switcher + unified/side-by-side toggle. */
export function DiffToolbar() {
  const viewMode = useDiffStore((s) => s.viewMode);
  const renderMode = useDiffStore((s) => s.renderMode);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setRenderMode = useDiffStore((s) => s.setRenderMode);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [commitProbeNonce, setCommitProbeNonce] = useState(0);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const threadBranch = useWorkspaceStore((s) => {
    const thread = s.threads.find((t) => t.id === s.activeThreadId);
    return thread?.branch ?? undefined;
  });
  const diffScopeRevision = useDiffStore((s) =>
    activeWorkspaceId ? (s.diffRevisionByScope[activeThreadId ?? activeWorkspaceId] ?? 0) : 0,
  );
  const lineWrap = useDiffStore((s) =>
    activeThreadId ? s.getLineWrap(activeThreadId) : true,
  );
  const toggleLineWrap = useDiffStore((s) => s.toggleLineWrap);

  const isGitRepo = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.is_git_repo ?? false,
  );

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

  // Recover when the active view falls out of the current scope or gating.
  useEffect(() => {
    if (viewModes.length === 0) return;
    if (
      !viewModes.some((m) => m.id === viewMode) ||
      (viewMode === "commit" && commitAvailability === "empty")
    ) {
      const fallback = defaultReviewView(scope);
      setViewMode(viewModes.some((m) => m.id === fallback) ? fallback : viewModes[0].id);
    }
  }, [commitAvailability, viewMode, viewModes, scope, setViewMode]);

  const activeView = useMemo(
    () => viewModes.find((m) => m.id === viewMode),
    [viewModes, viewMode],
  );

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
      {/* View selection is a dropdown labelled with the active view, with a
          contextual operand slot beside it for views that carry a picked
          operand (Branch, Commit). The slot stays empty until the picker
          slices land. */}
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
                    if (!disabled) setViewMode(mode.id);
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

        {/* Operand slot: the active view's picked operand. */}
        {activeView?.operand && (
          <div
            className="ml-1 flex min-w-0 items-center border-l border-border/25 pl-2"
            data-testid="review-operand-slot"
            data-operand={activeView.operand}
          >
            {activeView.operand === "branch" && activeWorkspaceId && (
              <BranchRefPicker
                workspaceId={activeWorkspaceId}
                threadId={activeThreadId ?? undefined}
              />
            )}
            {activeView.operand === "commit" && <CommitPicker />}
          </div>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  if (activeThreadId) toggleLineWrap(activeThreadId);
                }}
                disabled={!activeThreadId}
                className={`h-6 w-6 transition-colors ${lineWrap ? "text-foreground/70" : "text-muted-foreground/40 hover:text-foreground/60"}`}
                aria-label={lineWrap ? "Disable line wrap" : "Wrap long lines"}
              >
                <WrapText size={13} />
              </Button>
            }
          />
          <TooltipContent side="left" className="text-xs">
            {lineWrap ? "Disable line wrap" : "Wrap long lines"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setRenderMode(renderMode === "unified" ? "side-by-side" : "unified")}
                className="h-6 w-6 text-muted-foreground/50 hover:text-foreground/70"
                aria-label={`Switch to ${renderMode === "unified" ? "side-by-side" : "unified"} view`}
              >
                {renderMode === "unified" ? <Columns2 size={13} /> : <AlignJustify size={13} />}
              </Button>
            }
          />
          <TooltipContent side="left" className="text-xs">
            {renderMode === "unified" ? "Side-by-side view" : "Unified view"}
          </TooltipContent>
        </Tooltip>
      </div>
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
