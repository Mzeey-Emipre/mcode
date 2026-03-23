import { Columns2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerminalStore } from "@/stores/terminalStore";

interface TerminalToolbarProps {
  readonly threadId: string;
  readonly onAdd: () => void;
  readonly onDeleteAll: () => void;
}

export function TerminalToolbar({
  threadId: _threadId,
  onAdd,
  onDeleteAll,
}: TerminalToolbarProps) {
  const splitMode = useTerminalStore((s) => s.splitMode);
  const toggleSplit = useTerminalStore((s) => s.toggleSplit);

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={toggleSplit}
        className={splitMode ? "text-foreground" : "text-muted-foreground"}
        aria-label="Toggle split mode"
      >
        <Columns2 className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onAdd}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Add terminal"
      >
        <Plus className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDeleteAll}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Delete all terminals"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
