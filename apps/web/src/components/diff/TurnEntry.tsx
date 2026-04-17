import { useState } from "react";
import type { TurnSnapshot } from "@mcode/contracts";
import { FileList } from "./FileList";

/** Props for TurnEntry. */
interface TurnEntryProps {
  snapshot: TurnSnapshot;
  turnNumber: number;
}

/**
 * Single turn accordion. Leading element is an oversized ordinal — the page's
 * primary navigational rhythm. Expansion is a typographic chevron, not a heavy
 * plus/minus glyph.
 */
export function TurnEntry({ snapshot, turnNumber }: TurnEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const fileCount = snapshot.files_changed.length;
  const ordinal = String(turnNumber).padStart(2, "0");

  return (
    <div className={`border-b border-border/15 ${expanded ? "bg-muted/[0.04]" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="group flex w-full items-baseline gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/[0.08]"
      >
        {/* Oversized ordinal — the bold detail */}
        <span className="shrink-0 font-mono text-[15px] font-medium tabular-nums text-foreground/45 group-hover:text-foreground/70 transition-colors">
          {ordinal}
        </span>

        <span className="flex-1 truncate text-[11.5px] text-foreground/65">
          Turn {turnNumber}
        </span>

        {/* File count — quiet typographic label, no chip */}
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/55">
          {fileCount} file{fileCount === 1 ? "" : "s"}
        </span>

        <span
          aria-hidden="true"
          className={`shrink-0 font-mono text-[11px] leading-none text-muted-foreground/35 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        >
          ›
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
