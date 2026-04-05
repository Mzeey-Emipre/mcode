import { useState } from "react";
import { ChevronRight } from "lucide-react";
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
    <div className="border-b border-border/20">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-muted-foreground/50 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/40 text-[10px] font-medium text-muted-foreground shrink-0">
          {turnNumber}
        </span>
        <span className="flex-1 truncate text-xs text-foreground/70">
          Turn {turnNumber}
        </span>
        <span className="text-[10px] text-muted-foreground/50">
          {fileCount} file{fileCount !== 1 ? "s" : ""}
        </span>
      </button>

      {expanded && (
        <div className="pb-1">
          <FileList files={snapshot.files_changed} source="snapshot" id={snapshot.id} />
        </div>
      )}
    </div>
  );
}
