import { Columns2, AlignJustify, WrapText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDiffStore, type DiffViewMode } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** View mode options for the diff panel toolbar. */
const ALL_VIEW_MODES: { value: DiffViewMode; label: string; worktreeOnly: boolean }[] = [
  { value: "all", label: "All", worktreeOnly: false },
  { value: "by-turn", label: "By Turn", worktreeOnly: false },
  { value: "commits", label: "Commits", worktreeOnly: true },
];

/** Toolbar for the diff panel: view mode switcher + unified/side-by-side toggle. */
export function DiffToolbar() {
  const viewMode = useDiffStore((s) => s.viewMode);
  const renderMode = useDiffStore((s) => s.renderMode);
  const lineWrap = useDiffStore((s) => s.lineWrap);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setRenderMode = useDiffStore((s) => s.setRenderMode);
  const toggleLineWrap = useDiffStore((s) => s.toggleLineWrap);

  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const isWorktree = useWorkspaceStore((s) => {
    const thread = s.threads.find((t) => t.id === activeThreadId);
    return thread?.mode === "worktree";
  });

  const viewModes = ALL_VIEW_MODES.filter((m) => !m.worktreeOnly || isWorktree);

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
      {/* View mode segmented control — underline-on-active rather than the generic shadow-pill */}
      <div className="flex items-center gap-4">
        {viewModes.map((mode) => {
          const active = viewMode === mode.value;
          return (
            <button
              key={mode.value}
              type="button"
              onClick={() => setViewMode(mode.value)}
              className={`relative pb-1 text-[11px] font-medium tracking-tight transition-colors ${
                active
                  ? "text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground/80"
              }`}
            >
              {mode.label}
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute -bottom-[1px] left-0 right-0 h-[1.5px] bg-foreground/85"
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={toggleLineWrap}
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
