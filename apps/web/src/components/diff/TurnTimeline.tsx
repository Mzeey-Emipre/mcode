import { FileDiff } from "lucide-react";
import type { TurnSnapshot } from "@mcode/contracts";
import { TurnEntry } from "./TurnEntry";

/** Props for TurnTimeline. */
interface TurnTimelineProps {
  snapshots: TurnSnapshot[];
}

/** Vertical list of turn accordions (newest-first), showing only turns with file changes. */
export function TurnTimeline({ snapshots }: TurnTimelineProps) {
  // Assign 1-based turn numbers before filtering so numbering matches the actual turn order
  const withNumbers = snapshots.map((snap, i) => ({ snapshot: snap, turnNumber: i + 1 }));
  const withFiles = withNumbers.filter((t) => t.snapshot.files_changed.length > 0);

  if (withFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10">
        <FileDiff size={22} className="text-muted-foreground/15" strokeWidth={1.5} />
        <p className="text-[11px] text-muted-foreground/30">No changes yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {[...withFiles].reverse().map(({ snapshot, turnNumber }) => (
        <TurnEntry key={snapshot.id} snapshot={snapshot} turnNumber={turnNumber} />
      ))}
    </div>
  );
}
