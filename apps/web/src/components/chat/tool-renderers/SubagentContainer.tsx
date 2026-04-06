import { useState, useEffect } from "react";
import { Bot, ChevronRight } from "lucide-react";
import { getTransport } from "@/transport";
import { useThreadStore } from "@/stores/threadStore";
import { TOOL_LABELS, TOOL_ICONS, DEFAULT_ICON } from "./constants";
import type { ToolCallRecord } from "@/transport/types";

const STATUS_COLORS = {
  completed: "text-primary",
  failed: "text-destructive",
  running: "text-yellow-600 dark:text-yellow-500",
} as const;

/** Props for the SubagentContainer component. */
interface SubagentContainerProps {
  toolCallId: string;
  description: string;
  status: "completed" | "failed" | "running";
  defaultExpanded?: boolean;
}

/** Non-expandable row for a persisted child record. */
function ChildRecordRow({ record }: { record: ToolCallRecord }) {
  const Icon = TOOL_ICONS[record.tool_name] ?? DEFAULT_ICON;
  const label = TOOL_LABELS[record.tool_name] ?? record.tool_name;

  return (
    <div className="flex items-center gap-2 pl-3 pr-1 py-1.5 text-xs">
      <Icon size={13} className="shrink-0 text-muted-foreground" />
      <span className="font-medium text-foreground/80 dark:text-foreground/70">{label}</span>
      {record.input_summary && (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground font-mono">
          {record.input_summary}
        </span>
      )}
    </div>
  );
}

/** Collapsible wrapper for subagent tool calls loaded from DB. */
export function SubagentContainer({
  toolCallId,
  description,
  status,
  defaultExpanded = false,
}: SubagentContainerProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [children, setChildren] = useState<ToolCallRecord[] | null>(null);

  // Fetch children eagerly on mount so we know the count and expandability
  useEffect(() => {
    let cancelled = false;
    const cacheKey = `parent:${toolCallId}`;
    const cached = useThreadStore.getState().getCachedToolCallRecords(cacheKey);
    if (cached) {
      setChildren(cached);
      return;
    }
    getTransport()
      .listToolCallRecordsByParent(toolCallId)
      .then((data) => {
        if (!cancelled) {
          setChildren(data);
          useThreadStore.getState().cacheToolCallRecords(cacheKey, data);
        }
      })
      .catch(() => { if (!cancelled) setChildren([]); });
    return () => { cancelled = true; };
  }, [toolCallId]);

  const statusColor = STATUS_COLORS[status];

  const hasChildren = children !== null && children.length > 0;
  const isExpandable = children === null || children.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => isExpandable && setExpanded((p) => !p)}
        className={`flex w-full items-center gap-2 pl-3 pr-1 py-1.5 text-xs text-muted-foreground transition-colors ${
          isExpandable ? "cursor-pointer hover:bg-muted/30" : "cursor-default"
        }`}
      >
        {isExpandable && (
          <ChevronRight
            className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        )}
        <Bot className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
        <span className="truncate text-foreground/80 dark:text-foreground/70">{description || "Subagent"}</span>
        <span className={`text-[10px] ${statusColor}`}>
          {status}
        </span>
        {children !== null && (
          <span className={`ml-auto text-[10px] text-muted-foreground/70 transition-opacity duration-300 ${
            hasChildren ? "opacity-100" : "opacity-0"
          }`}>
            {children.length} call{children.length !== 1 ? "s" : ""}
          </span>
        )}
      </button>

      {expanded && hasChildren && (
        <div className="relative pl-8 max-h-[400px] overflow-y-auto scrollbar-on-hover">
          <div className="absolute left-[18px] top-0 bottom-0 w-px bg-gradient-to-b from-purple-500/30 to-transparent" />
          {children.map((r) => (
            <ChildRecordRow key={r.id} record={r} />
          ))}
        </div>
      )}
    </div>
  );
}
