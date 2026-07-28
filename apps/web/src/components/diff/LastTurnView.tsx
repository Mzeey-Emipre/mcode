import { useEffect } from "react";
import type { ReviewComparison } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import { getThreadRecord } from "@/stores/thread-record";
import { refreshTurnSnapshotsAfterPersist } from "@/lib/turn-snapshot-refresh";
import { FileList } from "./FileList";

/** Props for LastTurnView. */
interface LastTurnViewProps {
  threadId: string;
  comparison?: ReviewComparison | null;
  snapshotId?: string | null;
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
export function LastTurnView({ threadId, comparison = null, snapshotId = null, cacheVersion = "", refreshing = false, onRefresh = () => {} }: LastTurnViewProps) {
  /** Files the chat banner already knows about for the latest turn with edits. */
  const pendingReviewFiles = useThreadStore((s) => {
    const rec = getThreadRecord(s.records, threadId);
    const msgId = rec.latestTurnWithChanges;
    if (!msgId) return null;
    const files = rec.persistedFilesChanged[msgId];
    return files && files.length > 0 ? files : null;
  });

  // Chat (`threadStore`) learns about file changes on `turn.persisted` immediately;
  // Review reads `diffStore` snapshots, which can lag or stay empty if the panel
  // loaded before the turn finished. Self-heal when the two stores disagree.
  useEffect(() => {
    if (!pendingReviewFiles) return;
    if (snapshotId) return;
    refreshTurnSnapshotsAfterPersist(threadId, pendingReviewFiles);
  }, [threadId, pendingReviewFiles, snapshotId]);

  if (!snapshotId || !comparison) {
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
          file{comparison.files.length !== 1 ? "s" : ""} · last turn
        </span>
      </div>
      <FileList
        files={comparison.files.map((file) => file.path)}
        source="snapshot"
        id={snapshotId}
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
