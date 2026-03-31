import { useState, useCallback, useMemo } from "react";
import { ChevronRight, FileText } from "lucide-react";
import { getTransport } from "@/transport";

/** Number of lines to request on the initial (truncated) fetch. */
const MAX_LINES = 500;

/** Parsed diff line with type classification. */
interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
}

/** Parse a unified diff string into typed lines. */
function parseDiffLines(diff: string): DiffLine[] {
  return diff.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      return { type: "header" as const, content: line };
    }
    if (line.startsWith("+")) return { type: "add" as const, content: line.slice(1) };
    if (line.startsWith("-")) return { type: "remove" as const, content: line.slice(1) };
    return { type: "context" as const, content: line.startsWith(" ") ? line.slice(1) : line };
  });
}

/** Props for the DiffViewer component. */
interface DiffViewerProps {
  snapshotId: string;
  filePath: string;
  changeType?: "created" | "deleted" | "renamed" | "modified" | "binary";
}

/** Inline unified diff renderer. Lazy-loads diff content on expand. */
export function DiffViewer({ snapshotId, filePath, changeType = "modified" }: DiffViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const handleToggle = useCallback(async () => {
    if (!expanded && diff === null) {
      setLoading(true);
      try {
        const result = await getTransport().getSnapshotDiff(snapshotId, filePath, MAX_LINES);
        setDiff(result);
      } catch {
        setDiff("Failed to load diff");
      } finally {
        setLoading(false);
      }
    }
    setExpanded((prev) => !prev);
  }, [expanded, diff, snapshotId, filePath]);

  /** Re-fetch the diff without a line cap so the user sees the complete output. */
  const handleShowAll = useCallback(async () => {
    try {
      const fullDiff = await getTransport().getSnapshotDiff(snapshotId, filePath);
      setDiff(fullDiff);
      setShowAll(true);
    } catch {
      // Keep existing truncated diff on error
    }
  }, [snapshotId, filePath]);

  const lines = useMemo(() => (diff ? parseDiffLines(diff) : []), [diff]);
  const truncated = !showAll && lines.length > MAX_LINES;
  const visibleLines = truncated ? lines.slice(0, MAX_LINES) : lines;

  const changeLabel = {
    created: "File created",
    deleted: "File deleted",
    renamed: "File renamed",
    modified: "Modified",
    binary: "Binary file changed",
  }[changeType];

  return (
    <div className="rounded-md border border-border/30 overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <FileText className="h-3 w-3 shrink-0" />
        <span className="truncate font-mono">{filePath}</span>
        <span className="ml-auto text-[10px] opacity-60">{changeLabel}</span>
        {loading && <span className="text-[10px]">Loading...</span>}
      </button>

      {expanded && diff !== null && changeType !== "binary" && (
        <div className="max-h-[500px] overflow-auto text-[11px] font-mono leading-relaxed">
          {visibleLines.map((line, i) => (
            <div
              key={i}
              className={
                line.type === "add"
                  ? "bg-primary/10 text-primary/70"
                  : line.type === "remove"
                    ? "bg-destructive/10 text-destructive/70"
                    : line.type === "header"
                      ? "bg-muted/30 text-muted-foreground/70"
                      : "text-muted-foreground"
              }
            >
              <span className="inline-block w-5 select-none text-right pr-2 opacity-40">
                {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              </span>
              {line.content}
            </div>
          ))}
          {truncated && (
            <button
              type="button"
              onClick={handleShowAll}
              className="w-full py-1.5 text-center text-xs text-muted-foreground/70 hover:text-foreground bg-muted/20"
            >
              Show full diff ({lines.length - MAX_LINES} more lines)
            </button>
          )}
        </div>
      )}

      {expanded && changeType === "binary" && (
        <div className="px-3 py-2 text-xs text-muted-foreground/70">
          Binary file changed. No diff available.
        </div>
      )}
    </div>
  );
}
