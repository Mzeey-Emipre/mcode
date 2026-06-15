import { useEffect, useMemo, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import type { TurnSnapshot } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { useDiffStore } from "@/stores/diffStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getTransport } from "@/transport";
import { FileList } from "./FileList";
import { SummaryView } from "./SummaryView";

/** Props for CumulativeView. */
interface CumulativeViewProps {
  snapshots: TurnSnapshot[];
  threadId: string;
}

/** Deduplicated file list across all snapshots for the "All" cumulative view. */
export function CumulativeView({ snapshots, threadId }: CumulativeViewProps) {
  const pending = useDiffStore((s) => s.snapshotsPendingByThread[threadId] ?? false);
  const setSnapshots = useDiffStore((s) => s.setSnapshots);
  const markSnapshotsPending = useDiffStore((s) => s.markSnapshotsPending);
  const diffSummaryEnabled = useSettingsStore((s) => s.settings.diffSummary.enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [summaryLens, setSummaryLens] = useState(false);

  const files = useMemo(() => {
    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      for (const file of snapshot.files_changed) {
        seen.add(file);
      }
    }
    return [...seen].sort();
  }, [snapshots]);

  const cacheVersion = useMemo(
    () => snapshots.map((snapshot) => snapshot.id).join("|"),
    [snapshots],
  );

  // Report the cumulative total +/- to the toolbar. Summed across each turn's
  // per-file stats, so this is total churn (a file edited across turns counts
  // each time), not the net base-to-head diff. Cleared on unmount.
  const setReviewDiffStat = useDiffStore((s) => s.setReviewDiffStat);
  useEffect(() => {
    let cancelled = false;
    setReviewDiffStat(null);
    const ids = snapshots.filter((s) => s.files_changed.length > 0).map((s) => s.id);
    if (ids.length === 0) {
      setReviewDiffStat({ additions: 0, deletions: 0 });
      return () => {
        cancelled = true;
        setReviewDiffStat(null);
      };
    }
    void Promise.all(
      ids.map((id) => getTransport().getSnapshotDiffStats(id).catch(() => [])),
    ).then((perSnapshot) => {
      if (cancelled) return;
      setReviewDiffStat(
        perSnapshot.flat().reduce(
          (acc, s) => ({
            additions: acc.additions + s.additions,
            deletions: acc.deletions + s.deletions,
          }),
          { additions: 0, deletions: 0 },
        ),
      );
    });
    return () => {
      cancelled = true;
      setReviewDiffStat(null);
    };
  }, [cacheVersion, snapshots, setReviewDiffStat]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await getTransport().listSnapshots(threadId);
      setSnapshots(threadId, result);
    } catch {
      // Best-effort refresh; leave the pending flag so the user can retry.
      markSnapshotsPending(threadId, true);
    } finally {
      setRefreshing(false);
    }
  };

  if (files.length === 0) {
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
          {files.length}
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/55">
          file{files.length !== 1 ? "s" : ""} · {snapshots.length} turn{snapshots.length !== 1 ? "s" : ""}
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
          <div className="flex items-center gap-2 rounded border border-primary/25 bg-background/80 px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.14)]"
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
              onClick={handleRefresh}
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
        />
      )}
    </div>
  );
}
