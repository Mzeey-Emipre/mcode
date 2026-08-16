import { useCallback } from "react";
import { useTerminalStore } from "@/features/terminal";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { executeCommand } from "@/lib/command-registry";
import { Spinner } from "@/components/ui/spinner";

const SLOW_SPIN_STYLE = { animationDuration: "2s" } as const;

/** Shows a clickable "N active terminal(s)" chip when PTYs exist on the current thread. */
export function TerminalStatusIndicator() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const count = useTerminalStore((s) =>
    activeThreadId ? (s.terminals[activeThreadId]?.length ?? 0) : 0,
  );
  const togglePanel = useCallback(() => {
    executeCommand("terminal.toggle");
  }, []);

  if (count <= 0) return null;

  return (
    // button, not div — this element is interactive
    <button
      type="button"
      aria-label="Toggle terminal"
      onClick={togglePanel}
      className="flex cursor-pointer items-center gap-1.5 text-xs hover:opacity-80"
    >
      <Spinner size={12} className="text-muted-foreground" style={SLOW_SPIN_STYLE} />
      <span className="flex items-center gap-1.5 text-muted-foreground font-medium">
        <span className="size-1.5 rounded-full bg-primary animate-pulse" />
        {count} active terminal{count !== 1 ? "s" : ""}
      </span>
    </button>
  );
}
