import { useMemo } from "react";
import type { TurnSnapshot } from "@mcode/contracts";
import { FileEntry } from "./FileEntry";

/** Props for CumulativeView. */
interface CumulativeViewProps {
  snapshots: TurnSnapshot[];
  threadId: string;
}

/** Deduplicated file list across all snapshots for the "All" cumulative view. */
export function CumulativeView({ snapshots, threadId }: CumulativeViewProps) {
  const files = useMemo(() => {
    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      for (const file of snapshot.files_changed) {
        seen.add(file);
      }
    }
    return [...seen].sort();
  }, [snapshots]);

  if (files.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-8">
        <p className="text-xs text-muted-foreground/40">No changes yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground/50">
        {files.length} file{files.length !== 1 ? "s" : ""} changed across {snapshots.length} turn{snapshots.length !== 1 ? "s" : ""}
      </div>
      {files.map((filePath) => (
        <FileEntry key={filePath} filePath={filePath} source="cumulative" id={threadId} />
      ))}
    </div>
  );
}
