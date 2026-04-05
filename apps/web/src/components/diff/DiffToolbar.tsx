import { Columns2, AlignJustify } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDiffStore, type DiffViewMode } from "@/stores/diffStore";

/** View mode options for the diff panel toolbar. */
const VIEW_MODES: { value: DiffViewMode; label: string }[] = [
  { value: "by-turn", label: "By Turn" },
  { value: "all", label: "All" },
  { value: "commits", label: "Commits" },
];

/** Toolbar for the diff panel: view mode switcher + unified/side-by-side toggle. */
export function DiffToolbar() {
  const viewMode = useDiffStore((s) => s.viewMode);
  const renderMode = useDiffStore((s) => s.renderMode);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setRenderMode = useDiffStore((s) => s.setRenderMode);

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
      <div className="flex items-center gap-0.5 rounded-md bg-muted/30 p-0.5">
        {VIEW_MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            onClick={() => setViewMode(mode.value)}
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              viewMode === mode.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground/70"
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>

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
  );
}
