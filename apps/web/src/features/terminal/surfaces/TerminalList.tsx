import { memo } from "react";
import { Terminal, X, Plus, Trash2, ChevronsLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { cn } from "@/lib/utils";

const EMPTY_TERMINALS: readonly TerminalInstance[] = [];

function terminalStateLabel(terminal: TerminalInstance): string {
  switch (terminal.state) {
    case "exited":
      return "Exited";
    case "failed":
      return "Failed";
    case "starting":
      return "Starting";
    case "exiting":
      return "Closing";
    default:
      return "Running";
  }
}

/** Props for the terminal sidebar. */
interface TerminalListProps {
  readonly threadId: string;
  readonly onClose: (ptyId: string, trigger: HTMLButtonElement) => void;
  readonly onAdd: () => void;
  readonly onDeleteAll: (trigger: HTMLButtonElement) => void;
}

// Stable action refs.
const { setActiveTerminal, toggleSplit } = useTerminalStore.getState();

/** Full-width shell row highlight (hover/active live on the row, not the inner Button). */
function shellRowClass(isActive: boolean): string {
  return cn(
    "group flex w-full min-h-8 items-center gap-0.5 pr-1 transition-colors",
    isActive
      ? "bg-muted/50 text-foreground"
      : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
  );
}

/** Select shell: shadcn Button without its own hover pill or press shift. */
const shellSelectButtonClass =
  "h-8 min-h-8 min-w-0 flex-1 justify-start gap-2 rounded-none border-0 bg-transparent px-2 font-normal shadow-none hover:bg-transparent active:translate-y-0 active:bg-transparent";

/** Terminal sidebar with shell list, header actions, and collapse toggle. */
export const TerminalList = memo(function TerminalList({
  threadId,
  onClose,
  onAdd,
  onDeleteAll,
}: TerminalListProps) {
  const collapsed = !useTerminalStore((s) => s.splitMode);
  const terminals = useTerminalStore(
    (s) => s.terminals[threadId] ?? EMPTY_TERMINALS,
  );
  const activeTerminalId = useTerminalStore(
    (s) => s.terminalPanelByThread[threadId]?.activeTerminalId ?? null,
  );

  if (collapsed) {
    return (
      <div className="flex w-[38px] flex-shrink-0 flex-col border-r border-border/40 bg-muted/20">
        <div className="flex h-[34px] items-center justify-center border-b border-border/40">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={toggleSplit}
                  className="text-muted-foreground"
                  aria-label="Expand sidebar"
                />
              }
            >
              <ChevronsLeft className="rotate-180" />
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              Expand sidebar
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-1 flex-col items-center gap-0.5 overflow-y-auto py-1">
          {terminals.map((terminal) => {
            const isActive = terminal.id === activeTerminalId;
            const stateLabel = terminalStateLabel(terminal);
            return (
              <div key={terminal.id} className={shellRowClass(isActive)}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setActiveTerminal(threadId, terminal.id)}
                        className="bg-transparent hover:bg-transparent active:translate-y-0 active:bg-transparent"
                        aria-label={`${terminal.label}, ${stateLabel}`}
                        aria-current={isActive ? "true" : undefined}
                      />
                    }
                  >
                    <Terminal />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="text-xs">
                    {terminal.label}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-[148px] flex-shrink-0 flex-col border-r border-border/40 bg-muted/20">
      {/* Header: collapse toggle + actions, left-aligned */}
      <div className="flex h-[34px] items-center gap-0.5 border-b border-border/40 px-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={toggleSplit}
                className="text-muted-foreground"
                aria-label="Collapse sidebar"
              />
            }
          >
            <ChevronsLeft />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Collapse
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
                onClick={(event) => onDeleteAll(event.currentTarget)}
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

      {/* Shell list */}
      <div className="flex-1 overflow-y-auto py-1">
        {terminals.map((terminal) => {
          const isActive = terminal.id === activeTerminalId;
          const stateLabel = terminalStateLabel(terminal);
          return (
            <div key={terminal.id} className={shellRowClass(isActive)}>
              <Button
                type="button"
                variant="ghost"
                className={shellSelectButtonClass}
                onClick={() => setActiveTerminal(threadId, terminal.id)}
                aria-current={isActive ? "true" : undefined}
                aria-label={`${terminal.label}, ${stateLabel}`}
                data-terminal-state={terminal.state ?? "running"}
              >
                <Terminal
                  className={cn(
                    "shrink-0",
                    isActive ? "opacity-70" : "opacity-40",
                  )}
                />
                <span
                  className={cn(
                    "truncate text-xs",
                    isActive && "font-semibold",
                  )}
                >
                  {terminal.label}
                </span>
                {stateLabel !== "Running" ? (
                  <Badge variant="secondary" size="sm" className="ml-auto">
                    {stateLabel}
                  </Badge>
                ) : null}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0 bg-transparent opacity-0 transition-opacity hover:bg-transparent active:translate-y-0 active:bg-transparent focus-visible:opacity-100 group-hover:opacity-60"
                onClick={(event) => onClose(terminal.id, event.currentTarget)}
                aria-label={`Close ${terminal.label}`}
              >
                <X />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
