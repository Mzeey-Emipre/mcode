import { useMemo } from "react";
import type { TurnSnapshot } from "@mcode/contracts";
import { FileList } from "./FileList";

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
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-14">
        <span aria-hidden="true" className="font-mono text-[28px] leading-none text-muted-foreground/15">
          ⊘
        </span>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">
          No changes yet
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-2 px-3 py-2 border-b border-border/15">
        <span className="font-mono text-[11px] tabular-nums text-foreground/70">
          {files.length}
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/55">
          file{files.length !== 1 ? "s" : ""} · {snapshots.length} turn{snapshots.length !== 1 ? "s" : ""}
        </span>
      </div>
      <FileList files={files} source="cumulative" id={threadId} />
    </div>
  );
}
