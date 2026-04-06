import { TerminalSquare } from "lucide-react";
import { useTerminalStore } from "@/stores/terminalStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const SLOW_SPIN_STYLE = { animationDuration: "2s" } as const;

/** Shows a clickable "Running N terminal(s)" chip when PTYs are active on the current thread. */
export function TerminalStatusIndicator() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const count = useTerminalStore((s) =>
    activeThreadId ? (s.terminals[activeThreadId]?.length ?? 0) : 0,
  );
  const togglePanel = useTerminalStore((s) => s.togglePanel);

  if (count <= 0) return null;

  return (
    // button, not div — this element is interactive; AgentStatusBar uses div because it is display-only
    <button
      type="button"
      aria-label="Toggle terminal panel"
      onClick={togglePanel}
      className="flex cursor-pointer items-center gap-1.5 text-[11px] hover:opacity-80"
    >
      <TerminalSquare
        className="h-3 w-3 animate-spin text-muted-foreground"
        style={SLOW_SPIN_STYLE}
      />
      <span className="animate-shimmer-text font-medium">
        Running {count} terminal{count !== 1 ? "s" : ""}
      </span>
    </button>
  );
}
