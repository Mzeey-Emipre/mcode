import type { ReviewComparison } from "@mcode/contracts";
import type { SelectedFile } from "@/stores/diffStore";
import { FileList } from "./FileList";

/** The threadless git working-tree views the Review tab renders against the workspace root. */
export type GitView = "unstaged" | "staged" | "commit" | "branch";

/** One settled git comparison consumed by both the diff and Files projections. */
export interface ResolvedGitComparison {
  comparison: ReviewComparison;
  source: SelectedFile["source"];
  id: string;
  cacheVersion: string | number;
}

/** Props for GitDiffView. */
interface GitDiffViewProps {
  resolved: ResolvedGitComparison | null;
  threadId: string;
  loading: boolean;
  immutable: boolean;
  onRefresh: () => void;
  emptyLabel: string;
}

/** The empty-state glyph and label shown for a comparison with no changes. */
function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-14">
      <span aria-hidden="true" className="font-mono text-2xl leading-none text-muted-foreground/15">⊘</span>
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">{label}</p>
    </div>
  );
}

/** The three-dot loading pulse shared across the diff views. */
function LoadingPulse() {
  return (
    <div className="flex items-center justify-center gap-1.5 py-10">
      {[0, 150, 300].map((delay) => (
        <div key={delay} className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </div>
  );
}

/** Render the diff projection of a comparison resolved by the parent Review lifecycle. */
export function GitDiffView({ resolved, threadId, loading, immutable, onRefresh, emptyLabel }: GitDiffViewProps) {
  if (loading && !resolved) return <LoadingPulse />;
  if (!resolved || resolved.comparison.files.length === 0) return <EmptyState label={emptyLabel} />;

  return (
    <div className="flex flex-col">
      <FileList
        files={resolved.comparison.files.map((file) => file.path)}
        source={resolved.source}
        id={resolved.id}
        threadId={threadId}
        cacheVersion={resolved.cacheVersion}
        refreshable={!immutable}
        refreshing={loading}
        onRefresh={onRefresh}
        defaultFilesExpanded
      />
    </div>
  );
}
