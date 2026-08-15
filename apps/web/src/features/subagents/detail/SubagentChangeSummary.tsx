import { ExternalLink, FileText } from "lucide-react";
import type { FileEffect } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { DiffStat } from "@/components/diff/DiffStat";
import { diffCardSurfaceClass } from "@/components/diff/diff-surface";

interface SubagentChangeSummaryProps {
  readonly effects: readonly FileEffect[];
  readonly onViewAllDiffs: (paths: readonly string[], additions: number, deletions: number) => void;
}

/** Workspace-only change summary for one trustworthy subagent attribution. */
export function SubagentChangeSummary({ effects, onViewAllDiffs }: SubagentChangeSummaryProps) {
  const workspaceEffects = effects.filter((effect) => effect.scope === "workspace");
  const paths = [...new Set(workspaceEffects.map((effect) => effect.path))];
  if (paths.length === 0) return null;

  const additions = workspaceEffects.reduce((total, effect) => total + (effect.additions ?? 0), 0);
  const deletions = workspaceEffects.reduce((total, effect) => total + (effect.deletions ?? 0), 0);

  return (
    <div className={diffCardSurfaceClass("mt-6")}>
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <FileText size={13} aria-hidden className="shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1">
          {paths.length} file{paths.length === 1 ? "" : "s"} changed
        </span>
        {(additions > 0 || deletions > 0) && (
          <DiffStat additions={additions} deletions={deletions} />
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 gap-1 text-muted-foreground/70"
          onClick={() => onViewAllDiffs(paths, additions, deletions)}
        >
          <ExternalLink size={10} aria-hidden />
          View all diffs
        </Button>
      </div>
    </div>
  );
}
