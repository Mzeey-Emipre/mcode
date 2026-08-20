import { useState } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErroredSessionsBannerProps {
  /** Thread IDs that have an errored execution available for retry. */
  threadIds: string[];
  /** Callback to retry a set of errored threads as new executions. */
  onRetry: (threadIds: string[]) => void;
  /** Callback to dismiss the banner. */
  onDismiss: () => void;
}

/** Banner for failed executions that do not have an assistant footer to show Retry. */
export function ErroredSessionsBanner({
  threadIds,
  onRetry,
  onDismiss,
}: ErroredSessionsBannerProps) {
  const [retrying, setRetrying] = useState(false);

  if (threadIds.length === 0) return null;

  const handleRetry = () => {
    setRetrying(true);
    onRetry(threadIds);
  };

  const count = threadIds.length;

  return (
    <div className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
      <span className="flex-1">
        {count} {count === 1 ? "session failed" : "sessions failed"} and can be retried.
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={retrying}
        onClick={handleRetry}
      >
        <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />
        {retrying ? "Retrying..." : "Retry failed"}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
