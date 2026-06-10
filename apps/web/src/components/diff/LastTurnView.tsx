import type { TurnSnapshot } from "@mcode/contracts";
import { FileList } from "./FileList";

/** Props for LastTurnView. */
interface LastTurnViewProps {
  snapshots: TurnSnapshot[];
  threadId: string;
}

/**
 * The "Last turn" view: a single diff for the most recent turn that changed
 * files. This is the default glance when a thread is active. It renders exactly
 * one turn's diff — never the whole timeline — so the panel stays fast on long
 * threads. See CONTEXT.md → "Review tab".
 */
export function LastTurnView({ snapshots, threadId }: LastTurnViewProps) {
  // Walk from the newest snapshot back to the first one that actually changed
  // files; earlier no-op turns (e.g. plan-only) are skipped so the view always
  // lands on a meaningful diff.
  const latest = [...snapshots].reverse().find((s) => s.files_changed.length > 0);

  if (!latest) {
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
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/15">
        <span className="font-mono text-[11px] tabular-nums text-foreground/70">
          {latest.files_changed.length}
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/55">
          file{latest.files_changed.length !== 1 ? "s" : ""} · last turn
        </span>
      </div>
      <FileList
        files={latest.files_changed}
        source="snapshot"
        id={latest.id}
        threadId={threadId}
        defaultFilesExpanded
      />
    </div>
  );
}
