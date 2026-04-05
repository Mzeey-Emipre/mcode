import { GitCompareArrows } from "lucide-react";
import type { TurnSnapshot } from "@mcode/contracts";
import { TurnEntry } from "./TurnEntry";

/** Props for TurnTimeline. */
interface TurnTimelineProps {
  snapshots: TurnSnapshot[];
}

/** Vertical list of turn accordions, newest-first. */
export function TurnTimeline({ snapshots }: TurnTimelineProps) {
  if (snapshots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10">
        <GitCompareArrows size={22} className="text-muted-foreground/15" strokeWidth={1.5} />
        <p className="text-[11px] text-muted-foreground/30">No changes yet</p>
      </div>
    );
  }

  // Show newest turns first, but 1-based numbering from oldest
  const reversed = [...snapshots].reverse();

  return (
    <div className="flex flex-col">
      {reversed.map((snapshot, i) => (
        <TurnEntry
          key={snapshot.id}
          snapshot={snapshot}
          turnNumber={snapshots.length - i}
        />
      ))}
    </div>
  );
}
