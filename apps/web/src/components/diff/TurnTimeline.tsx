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
      <div className="flex flex-col items-center justify-center gap-3 py-14">
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
      {[...withFiles].reverse().map(({ snapshot, turnNumber }) => (
        <TurnEntry key={snapshot.id} snapshot={snapshot} turnNumber={turnNumber} />
      ))}
    </div>
  );
}
