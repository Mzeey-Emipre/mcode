import { Bot } from "lucide-react";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const SLOW_SPIN_STYLE = { animationDuration: "2s" } as const;

/** Shows "N subagents running" badge when subagents are active on the current thread. */
export function AgentStatusBar() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const count = useThreadStore((s) =>
    activeThreadId ? s.activeSubagentsByThread[activeThreadId] ?? 0 : 0,
  );

  if (count <= 0) return null;

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <Bot className="h-3 w-3 animate-spin text-muted-foreground" style={SLOW_SPIN_STYLE} />
      <span className="animate-shimmer-text font-medium">
        {count} subagent{count !== 1 ? "s" : ""} running
      </span>
    </div>
  );
}
