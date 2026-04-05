import { useEffect, useMemo } from "react";
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
          // commit - wired in Phase 4
          const { useWorkspaceStore } = await import("@/stores/workspaceStore");
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
          if (workspaceId) {
            result = await transport.getCommitDiff(workspaceId, selectedFile.id, selectedFile.filePath);
          } else {
            result = "";
          }
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

  if (!selectedFile) {
    return (
      <div className="flex flex-1 items-center justify-center border-t border-border/30">
        <p className="text-[11px] text-muted-foreground/30">Select a file to view changes</p>
      </div>
    );
  }

  if (diffLoading) {
    return (
      <div className="flex flex-1 items-center justify-center border-t border-border/30">
        <p className="text-[11px] text-muted-foreground/40">Loading diff...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col border-t border-border/30 overflow-hidden">
      <div className="flex items-center px-3 py-1 border-b border-border/20 flex-none">
        <span className="text-[11px] font-mono text-foreground/60 truncate">
          {selectedFile.filePath}
        </span>
      </div>
      <ScrollArea className="flex-1">
        {lines.length > 0 ? (
          renderMode === "unified" ? (
            <UnifiedDiff lines={lines} />
          ) : (
            <SideBySideDiff lines={lines} />
          )
        ) : (
          <div className="flex items-center justify-center py-8">
            <p className="text-[11px] text-muted-foreground/30">No changes</p>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
