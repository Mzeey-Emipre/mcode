import { useEffect, useMemo } from "react";
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
import { useSettingsStore } from "@/stores/settingsStore";
import type { PanelScope } from "@/lib/panel-tabs";
import { visibleReviewViews, defaultReviewView } from "@/lib/review-views";

/** Toolbar for the Review tab: dual-scope view switcher + unified/side-by-side toggle. */
export function DiffToolbar() {
  const viewMode = useDiffStore((s) => s.viewMode);
  const renderMode = useDiffStore((s) => s.renderMode);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setRenderMode = useDiffStore((s) => s.setRenderMode);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const lineWrap = useDiffStore((s) =>
    activeThreadId ? s.getLineWrap(activeThreadId) : true,
  );
  const toggleLineWrap = useDiffStore((s) => s.toggleLineWrap);

  const isGitRepo = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.is_git_repo ?? false,
  );
  const diffSummaryEnabled = useSettingsStore((s) => s.settings.diffSummary.enabled);

  // The Review tab is dual-scope: threadless yields the git working-tree views,
  // a thread yields the turn views. Runtime gates drop the git views in a
  // non-git workspace and Summary when its setting is off.
  const scope: PanelScope = activeThreadId ? "thread" : "threadless";
  const viewModes = useMemo(
    () => visibleReviewViews(scope, { isGitRepo, diffSummaryEnabled }),
    [scope, isGitRepo, diffSummaryEnabled],
  );

  // Recover when the active view falls out of the current scope or gating (e.g.
  // switching to a threadless workspace, or disabling the summary setting).
  useEffect(() => {
    if (viewModes.length === 0) return;
    if (!viewModes.some((m) => m.id === viewMode)) {
      const fallback = defaultReviewView(scope);
      setViewMode(viewModes.some((m) => m.id === fallback) ? fallback : viewModes[0].id);
    }
  }, [viewMode, viewModes, scope, setViewMode]);

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
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="review-view-switcher"
            disabled={viewModes.length === 0}
            aria-label="Select review view"
            className="flex h-6 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium tracking-tight text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            {activeView?.label ?? "—"}
            <ChevronDown size={11} className="text-muted-foreground/60" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="start" sideOffset={4} className="min-w-[150px]">
            {viewModes.map((mode) => {
              const active = viewMode === mode.id;
              return (
                <DropdownMenuItem
                  key={mode.id}
                  onClick={() => setViewMode(mode.id)}
                  data-testid={`review-view-${mode.id}`}
                  data-active={active ? "true" : undefined}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs",
                    active ? "text-foreground" : "text-popover-foreground",
                  )}
                >
                  <span className="flex-1 text-left">{mode.label}</span>
                  {active && <Check size={11} className="text-muted-foreground" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Operand slot — reserved for the active view's picked operand. Empty
            for fixed-operand views; the per-operand picker lands in #641/#642. */}
        {activeView?.operand && (
          <div
            className="flex min-w-0 items-center"
            data-testid="review-operand-slot"
            data-operand={activeView.operand}
          />
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
