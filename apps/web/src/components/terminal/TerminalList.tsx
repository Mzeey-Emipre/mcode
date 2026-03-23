import { TerminalSquare, X } from "lucide-react";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminalStore";

const EMPTY_TERMINALS: readonly TerminalInstance[] = [];

interface TerminalListProps {
  readonly threadId: string;
  readonly onClose: (ptyId: string) => void;
}

export function TerminalList({ threadId, onClose }: TerminalListProps) {
  const terminals = useTerminalStore(
    (s) => s.terminals[threadId] ?? EMPTY_TERMINALS,
  );
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);

  return (
    <div className="w-48 border-l border-border bg-background">
      {terminals.map((terminal) => {
        const isActive = terminal.id === activeTerminalId;

        return (
          <div
            key={terminal.id}
            className="group flex cursor-pointer items-center justify-between px-3 py-1.5 hover:bg-muted"
            onClick={() => setActiveTerminal(terminal.id)}
          >
            <div className="flex items-center gap-2">
              <TerminalSquare className="size-3.5 text-muted-foreground" />
              <span
                className={`text-xs ${
                  isActive
                    ? "font-bold text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {terminal.label}
              </span>
            </div>
            <button
              type="button"
              className="invisible text-muted-foreground hover:text-foreground group-hover:visible"
              onClick={(e) => {
                e.stopPropagation();
                onClose(terminal.id);
              }}
              aria-label={`Close ${terminal.label}`}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
