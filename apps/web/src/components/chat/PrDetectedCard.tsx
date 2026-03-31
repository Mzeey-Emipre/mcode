import { GitPullRequest, X, GitFork } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Props for {@link PrDetectedCard}, describing a detected GitHub PR. */
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
        <GitPullRequest size={14} className="shrink-0 text-primary/70" />
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
        <Button size="xs" onClick={onReview} disabled={loading}>
          <GitFork size={10} />
          Review in worktree
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label="Dismiss" className="text-muted-foreground">
          <X size={12} />
        </Button>
      </div>
    </div>
  );
}
