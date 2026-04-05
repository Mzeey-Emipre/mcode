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
      <div className="flex flex-1 items-center justify-center py-8">
        <p className="text-xs text-muted-foreground/40">No changes yet</p>
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
