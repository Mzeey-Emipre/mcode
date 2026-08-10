import { useState } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface InterruptedSessionsBannerProps {
  /** Thread IDs that have "interrupted" status */
  threadIds: string[];
  /** Callback to retry a set of interrupted threads as new executions. */
  onRetry: (threadIds: string[]) => void;
  /** Callback to dismiss the banner */
  onDismiss: () => void;
}

/** Banner shown after server restart when threads were interrupted mid-task. */
export function InterruptedSessionsBanner({
  threadIds,
  onRetry,
  onDismiss,
}: InterruptedSessionsBannerProps) {
  const [retrying, setRetrying] = useState(false);

  if (threadIds.length === 0) return null;

  const handleRetry = () => {
    setRetrying(true);
    onRetry(threadIds);
  };

  const count = threadIds.length;

  return (
    <div className="flex items-center gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-2.5 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-500" />
      <span className="flex-1">
        {count} {count === 1 ? "session was" : "sessions were"} interrupted
        during a server restart.
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={retrying}
        onClick={handleRetry}
      >
        <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />
        {retrying ? "Retrying..." : "Retry all"}
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
