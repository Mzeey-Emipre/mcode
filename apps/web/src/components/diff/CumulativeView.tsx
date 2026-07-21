import { useMemo, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import type { ReviewComparison } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { useDiffStore } from "@/stores/diffStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { FileList } from "./FileList";
import { SummaryView } from "./SummaryView";

/** Props for CumulativeView. */
interface CumulativeViewProps {
  threadId: string;
  comparison?: ReviewComparison | null;
  cacheVersion?: string | number;
  turnCount?: number;
  refreshing?: boolean;
  onRefresh?: () => void;
}

/** Deduplicated file list across all snapshots for the "All" cumulative view. */
export function CumulativeView({ threadId, comparison = null, cacheVersion = "", turnCount = 0, refreshing = false, onRefresh = () => {} }: CumulativeViewProps) {
  const pending = useDiffStore((s) => s.snapshotsPendingByThread[threadId] ?? false);
  const diffSummaryEnabled = useSettingsStore((s) => s.settings.diffSummary.enabled);
  const [summaryLens, setSummaryLens] = useState(false);

  const files = useMemo(() => (comparison?.files ?? []).map((file) => file.path), [comparison]);

  if (files.length === 0) {
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
          {files.length}
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
          file{files.length !== 1 ? "s" : ""} · {turnCount} turn{turnCount !== 1 ? "s" : ""}
        </span>
        {diffSummaryEnabled && (
          <Button
            type="button"
            variant={summaryLens ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={summaryLens}
            onClick={() => setSummaryLens((value) => !value)}
            data-testid="cumulative-summary-toggle"
            className="ml-auto gap-1.5 px-2 font-mono text-[10.5px] uppercase tracking-[0.12em]"
          >
            <FileText size={11} />
            {summaryLens ? "Diff" : "Summarize"}
          </Button>
        )}
      </div>
      {pending && (
        <div className="border-b border-primary/20 bg-primary/[0.045] px-3 py-2">
          <div className="flex items-center gap-2 rounded border border-primary/25 bg-background/80 px-2.5 py-2 shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground),transparent_94%)]">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary),transparent_85%)]"
            />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-foreground/85">
                New changes available
              </p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/55">
                Refresh to review the new files.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh All turns diff"
              data-testid="cumulative-view-refresh"
              className="h-7 shrink-0 gap-1.5 rounded border-primary/35 bg-primary/10 px-2.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-primary hover:border-primary/55 hover:bg-primary/18"
            >
              <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Refreshing" : "Refresh"}
            </Button>
          </div>
        </div>
      )}
      {summaryLens && diffSummaryEnabled ? (
        <SummaryView />
      ) : (
        <FileList
          files={files}
          source="cumulative"
          id={threadId}
          threadId={threadId}
          cacheVersion={cacheVersion}
          refreshable
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}
