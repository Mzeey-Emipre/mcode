import type { ReviewComparison } from "@mcode/contracts";
import { FileList } from "./FileList";
import { Badge } from "@/components/ui/badge";

/** Props for LastTurnView. */
interface LastTurnViewProps {
  threadId: string;
  comparison?: ReviewComparison | null;
  cacheVersion?: string | number;
  refreshing?: boolean;
  onRefresh?: () => void;
}

/**
 * The "Last turn" view: a single diff for the most recent turn that changed
 * files. This is the default glance when a thread is active. It renders exactly
 * one turn's diff — never the whole timeline — so the panel stays fast on long
 * threads. See CONTEXT.md → "Review tab".
 */
export function LastTurnView({ threadId, comparison, cacheVersion, refreshing, onRefresh }: LastTurnViewProps) {
  const comparisonId = comparison?.turnDiff?.id;
  if (!comparisonId || !comparison) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-14">
        <span aria-hidden="true" className="font-mono text-2xl leading-none text-muted-foreground/15">
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
          {comparison.files.length}
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
          {turnLabel(comparison)}
        </span>
        <TurnDiffSource comparison={comparison} />
      </div>
      <FileList
        files={comparison.files.map((file) => file.path)}
        source="turn-diff"
        id={comparisonId}
        threadId={threadId}
        cacheVersion={cacheVersion}
        defaultFilesExpanded
        refreshable
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
    </div>
  );
}

function turnLabel(comparison: ReviewComparison): string {
  const files = comparison.files.length === 1 ? "file" : "files";
  const phase = comparison.turnDiff?.phase === "live" ? "Live" : "last turn";
  return `${files} · ${phase}`;
}

function TurnDiffSource({ comparison }: { comparison: ReviewComparison }) {
  if (!comparison.turnDiff) return null;
  return <Badge variant="secondary">
    {comparison.turnDiff.source === "git" ? "Git fallback: same-file edits may appear" : "Agent changes"}
  </Badge>;
}
