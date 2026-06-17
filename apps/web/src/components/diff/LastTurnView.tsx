import { useEffect } from "react";
import type { TurnSnapshot } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { getThreadRecord } from "@/stores/thread-record";
import { refreshTurnSnapshotsAfterPersist } from "@/lib/turn-snapshot-refresh";
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
  /** Files the chat banner already knows about for the latest turn with edits. */
  const pendingReviewFiles = useThreadStore((s) => {
    const rec = getThreadRecord(s.records, threadId);
    const msgId = rec.latestTurnWithChanges;
    if (!msgId) return null;
    const files = rec.persistedFilesChanged[msgId];
    return files && files.length > 0 ? files : null;
  });

  // Walk from the newest snapshot back to the first one that actually changed
  // files; earlier no-op turns (e.g. plan-only) are skipped so the view always
  // lands on a meaningful diff.
  const latest = [...snapshots].reverse().find((s) => s.files_changed.length > 0);

  // Chat (`threadStore`) learns about file changes on `turn.persisted` immediately;
  // Review reads `diffStore` snapshots, which can lag or stay empty if the panel
  // loaded before the turn finished. Self-heal when the two stores disagree.
  useEffect(() => {
    if (!pendingReviewFiles) return;
    if (latest) return;
    refreshTurnSnapshotsAfterPersist(threadId, pendingReviewFiles);
  }, [threadId, pendingReviewFiles, latest]);

  // Report this turn's total +/- to the toolbar (summed from per-file stats).
  const setReviewDiffStat = useDiffStore((s) => s.setReviewDiffStat);
  const latestId = latest?.id;
  useEffect(() => {
    let cancelled = false;
    setReviewDiffStat(null);
    if (!latestId) {
      setReviewDiffStat({ additions: 0, deletions: 0 });
      return () => {
        cancelled = true;
        setReviewDiffStat(null);
      };
    }
    void getTransport()
      .getSnapshotDiffStats(latestId)
      .then((stats) => {
        if (cancelled) return;
        setReviewDiffStat(
          stats.reduce(
            (acc, s) => ({
              additions: acc.additions + s.additions,
              deletions: acc.deletions + s.deletions,
            }),
            { additions: 0, deletions: 0 },
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setReviewDiffStat({ additions: 0, deletions: 0 });
      });
    return () => {
      cancelled = true;
      setReviewDiffStat(null);
    };
  }, [latestId, setReviewDiffStat]);

  if (!latest) {
    if (pendingReviewFiles) {
      return (
        <div className="flex items-center justify-center gap-1.5 py-10">
          {[0, 150, 300].map((delay) => (
            <div
              key={delay}
              className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      );
    }
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
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
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
