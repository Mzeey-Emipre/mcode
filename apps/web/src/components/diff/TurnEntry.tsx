import { useState } from "react";
import { Plus, Minus } from "lucide-react";
import type { TurnSnapshot } from "@mcode/contracts";
import { FileList } from "./FileList";

/** Props for TurnEntry. */
interface TurnEntryProps {
  snapshot: TurnSnapshot;
  turnNumber: number;
}

/** Single turn accordion: turn number, file count, expand/collapse. */
export function TurnEntry({ snapshot, turnNumber }: TurnEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const fileCount = snapshot.files_changed.length;

  return (
    <div className={`border-b border-border/15 ${expanded ? "bg-muted/5" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/15 transition-colors"
      >
        {expanded ? (
          <Minus size={11} className="shrink-0 text-muted-foreground/30" />
        ) : (
          <Plus size={11} className="shrink-0 text-muted-foreground/30" />
        )}

        {/* Turn pill */}
        <span className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-widest bg-muted/40 text-muted-foreground/50">
          T{turnNumber}
        </span>

        <span className="flex-1 truncate text-[11px] text-foreground/60">
          Turn {turnNumber}
        </span>

        {/* File count chip */}
        <span className="shrink-0 rounded-full bg-amber-400/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-400/60">
          {fileCount}
        </span>
      </button>

      {expanded && (
        <div className="pb-0.5">
          <FileList files={snapshot.files_changed} source="snapshot" id={snapshot.id} />
        </div>
      )}
    </div>
  );
}
