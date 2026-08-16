import { memo } from "react";
import { Columns2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";

interface TerminalToolbarProps {
  readonly onAdd: () => void;
  readonly onDeleteAll: () => void;
}

// Stable action ref — avoids a reactive subscription for a function that never changes.
const { toggleSplit } = useTerminalStore.getState();

/** Toolbar actions for terminal list visibility, creation, and bulk kill. */
export const TerminalToolbar = memo(function TerminalToolbar({
  onAdd,
  onDeleteAll,
}: TerminalToolbarProps) {
  const splitMode = useTerminalStore((s) => s.splitMode);

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={toggleSplit}
              className={splitMode ? "text-foreground" : "text-muted-foreground"}
              aria-label="Toggle terminal list"
            />
          }
        >
          <Columns2 />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Toggle terminal list
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onAdd}
              className="text-muted-foreground hover:text-foreground"
              aria-label="New terminal"
            />
          }
        >
          <Plus />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          New terminal
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onDeleteAll}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Kill all terminals"
            />
          }
        >
          <Trash2 />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Kill all
        </TooltipContent>
      </Tooltip>
    </div>
  );
});
