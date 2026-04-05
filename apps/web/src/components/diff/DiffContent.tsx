import { useEffect, useMemo } from "react";
import { GitCompareArrows } from "lucide-react";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { parseDiffLines } from "@/lib/diff-parser";
import { UnifiedDiff } from "./UnifiedDiff";
import { SideBySideDiff } from "./SideBySideDiff";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Bottom section of the diff panel: renders the diff for the selected file. */
export function DiffContent() {
  const selectedFile = useDiffStore((s) => s.selectedFile);
  const diffContent = useDiffStore((s) => s.diffContent);
  const diffLoading = useDiffStore((s) => s.diffLoading);
  const renderMode = useDiffStore((s) => s.renderMode);
  const setDiffContent = useDiffStore((s) => s.setDiffContent);
  const setDiffLoading = useDiffStore((s) => s.setDiffLoading);

  useEffect(() => {
    if (!selectedFile) return;

    let cancelled = false;
    setDiffLoading(true);

    const load = async () => {
      try {
        let result: string;
        const transport = getTransport();
        if (selectedFile.source === "snapshot") {
          result = await transport.getSnapshotDiff(selectedFile.id, selectedFile.filePath);
        } else if (selectedFile.source === "cumulative") {
          result = await transport.getCumulativeDiff(selectedFile.id, selectedFile.filePath);
        } else {
          const { useWorkspaceStore } = await import("@/stores/workspaceStore");
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
          result = workspaceId
            ? await transport.getCommitDiff(workspaceId, selectedFile.id, selectedFile.filePath)
            : "";
        }
        if (!cancelled) setDiffContent(result);
      } catch {
        if (!cancelled) setDiffContent("Failed to load diff");
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [selectedFile, setDiffContent, setDiffLoading]);

  const lines = useMemo(
    () => (diffContent ? parseDiffLines(diffContent) : []),
    [diffContent],
  );

  const stats = useMemo(() => {
    const additions = lines.filter((l) => l.type === "add").length;
    const deletions = lines.filter((l) => l.type === "remove").length;
    return { additions, deletions };
  }, [lines]);

  if (!selectedFile) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 border-t border-border/20">
        <GitCompareArrows size={22} className="text-muted-foreground/15" strokeWidth={1.5} />
        <p className="text-[11px] text-muted-foreground/25">Select a file to view changes</p>
      </div>
    );
  }

  // Build breadcrumb parts
  const pathParts = selectedFile.filePath.split("/");
  const filename = pathParts.pop() ?? "";
  const dirParts = pathParts;

  return (
    <div className="flex flex-1 flex-col overflow-hidden border-t border-border/20 min-h-0">
      {/* File path header */}
      <div className="flex flex-none items-center gap-2 border-b border-border/15 bg-muted/5 px-3 py-1.5">
        <div className="flex flex-1 min-w-0 items-center gap-0.5 font-mono text-[10px]">
          {dirParts.map((part, i) => (
            <span key={i} className="flex shrink-0 items-center gap-0.5 text-muted-foreground/30">
              {part}
              <span className="text-muted-foreground/20">/</span>
            </span>
          ))}
          <span className="truncate font-medium text-foreground/65">{filename}</span>
        </div>
        {!diffLoading && lines.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
            {stats.additions > 0 && (
              <span className="text-emerald-400/70">+{stats.additions}</span>
            )}
            {stats.deletions > 0 && (
              <span className="text-red-400/60">-{stats.deletions}</span>
            )}
          </div>
        )}
      </div>

      {diffLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-1.5">
            {[0, 150, 300].map((delay) => (
              <div
                key={delay}
                className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          {lines.length > 0 ? (
            renderMode === "unified" ? (
              <UnifiedDiff lines={lines} />
            ) : (
              <SideBySideDiff lines={lines} />
            )
          ) : (
            <div className="flex items-center justify-center py-10">
              <p className="text-[11px] text-muted-foreground/25">No changes in this file</p>
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  );
}
