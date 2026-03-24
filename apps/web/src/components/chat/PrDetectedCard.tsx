import { GitPullRequest, X, GitFork } from "lucide-react";

interface PrDetectedCardProps {
  number: number;
  title: string;
  branch: string;
  author: string;
  onReview: () => void;
  onDismiss: () => void;
  loading?: boolean;
}

/** Inline card shown when a GitHub PR URL is detected in the composer input. */
export function PrDetectedCard({
  number,
  title,
  branch,
  author,
  onReview,
  onDismiss,
  loading,
}: PrDetectedCardProps) {
  return (
    <div className="mx-4 mt-2 flex items-center justify-between rounded-lg border border-border bg-card p-2.5 text-xs shadow-sm">
      <div className="flex items-center gap-2 truncate">
        <GitPullRequest size={14} className="shrink-0 text-green-500" />
        <div className="truncate">
          <span className="font-medium">
            #{number} {title}
          </span>
          <span className="ml-1.5 text-muted-foreground">
            {branch} &middot; {author}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 ml-2">
        <button
          onClick={onReview}
          disabled={loading}
          className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <GitFork size={10} />
          Review in worktree
        </button>
        <button
          onClick={onDismiss}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
