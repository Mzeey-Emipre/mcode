import { useState, useCallback } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { CircleCheck, CircleX, Loader2, RefreshCw, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { ChecksStatus, CheckRun } from "@mcode/contracts";

/** Props for {@link ChecksPopover}. */
interface ChecksPopoverProps {
  /** Thread ID used for refresh requests. */
  threadId: string;
  /** GitHub PR number. */
  prNumber: number;
  /** GitHub PR URL, used for the "View on GitHub" link. */
  prUrl: string;
  /** Optional PR title shown in the header. */
  prTitle?: string;
  /** Optional PR author shown below the title. */
  prAuthor?: string;
  /** Latest CI check status to display. */
  checks: ChecksStatus;
  /** Trigger element rendered inside the popover trigger. */
  children: React.ReactNode;
}

/** Status icon for an individual check run. */
function CheckIcon({ run }: { run: CheckRun }) {
  if (run.status === "in_progress" || run.status === "queued") {
    return <Loader2 size={12} className="text-orange-500 animate-spin" />;
  }
  switch (run.conclusion) {
    case "success":
      return <CircleCheck size={12} className="text-green-500" />;
    case "failure":
    case "timed_out":
      return <CircleX size={12} className="text-red-500" />;
    case "cancelled":
      return <CircleX size={12} className="text-muted-foreground" />;
    default:
      return <CircleCheck size={12} className="text-muted-foreground" />;
  }
}

/** Format a duration in milliseconds to a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
}

/** Summarise the check runs as a human-readable string. */
function summarise(checks: ChecksStatus): string {
  const total = checks.runs.length;
  const passing = checks.runs.filter((r) => r.conclusion === "success").length;
  const failing = checks.runs.filter(
    (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
  ).length;
  const running = checks.runs.filter((r) => r.status !== "completed").length;

  const parts: string[] = [`${total} check${total !== 1 ? "s" : ""}`];
  if (passing > 0) parts.push(`${passing} passing`);
  if (failing > 0) parts.push(`${failing} failing`);
  if (running > 0) parts.push(`${running} running`);
  return parts.join(" · ");
}

/**
 * Popover that shows PR metadata and individual CI check run details.
 * The children prop is rendered as the trigger element.
 */
export function ChecksPopover({
  threadId,
  prNumber: _prNumber,
  prUrl,
  prTitle,
  prAuthor,
  checks,
  children,
}: ChecksPopoverProps) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await getTransport().checkStatus(threadId);
      useWorkspaceStore.setState((ws) => ({
        checksById: { ...ws.checksById, [threadId]: fresh },
      }));
    } finally {
      setRefreshing(false);
    }
  }, [threadId]);

  const handleOpenGitHub = useCallback(() => {
    try {
      const parsed = new URL(prUrl);
      // Only allow https URLs to prevent javascript: or other protocol abuse
      if (parsed.protocol === "https:") {
        window.desktopBridge?.openExternalUrl(prUrl);
      }
    } catch {
      // Invalid URL - do nothing
    }
  }, [prUrl]);

  // Sort: failing first, then running, then passing/other
  const sortedRuns = [...checks.runs].sort((a, b) => {
    const order = (r: CheckRun) => {
      if (r.conclusion === "failure" || r.conclusion === "timed_out") return 0;
      if (r.status !== "completed") return 1;
      return 2;
    };
    return order(a) - order(b);
  });

  const elapsed = Math.round((Date.now() - checks.fetchedAt) / 1000);
  const staleLabel =
    elapsed < 5
      ? "just now"
      : elapsed < 60
        ? `${elapsed}s ago`
        : `${Math.floor(elapsed / 60)}m ago`;

  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex cursor-pointer"
        aria-label="View CI check details"
      >
        {children}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" sideOffset={6} className="w-72 p-0">
        {/* Header: PR title and summary */}
        {prTitle && (
          <div className="border-b border-border px-3 py-2">
            <div className="text-sm font-medium text-foreground truncate">{prTitle}</div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {prAuthor && <span>by {prAuthor}</span>}
              <span>·</span>
              <span>{summarise(checks)}</span>
            </div>
          </div>
        )}

        {/* Check run list */}
        <div className="px-3 py-2 space-y-1.5 max-h-48 overflow-y-auto">
          {sortedRuns.map((run) => (
            <div key={run.name} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <CheckIcon run={run} />
                <span
                  className={cn(
                    "truncate",
                    run.conclusion === "failure" || run.conclusion === "timed_out"
                      ? "text-red-400 font-medium"
                      : "text-foreground/80",
                  )}
                >
                  {run.name}
                </span>
              </div>
              <span className="text-muted-foreground shrink-0 ml-2">
                {run.status !== "completed"
                  ? "running…"
                  : run.durationMs != null
                    ? formatDuration(run.durationMs)
                    : ""}
              </span>
            </div>
          ))}
          {sortedRuns.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-2">
              No checks configured
            </div>
          )}
        </div>

        {/* Footer: GitHub link, staleness label, and refresh button */}
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <button
            onClick={handleOpenGitHub}
            className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
          >
            View on GitHub <ExternalLink size={10} />
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">{staleLabel}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="Refresh checks"
            >
              <RefreshCw size={10} className={cn(refreshing && "animate-spin")} />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
