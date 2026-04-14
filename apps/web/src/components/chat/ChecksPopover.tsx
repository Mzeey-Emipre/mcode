import { useState, useCallback, useEffect } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { CircleCheck, CircleX, Loader2, RefreshCw, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getCiVisual } from "@/lib/ci-status";
import type { ChecksStatus, CheckRun } from "@mcode/contracts";

/** Props for {@link ChecksPopover}. */
interface ChecksPopoverProps {
  /** Thread ID used for refresh requests. */
  threadId: string;
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
    return <Loader2 size={12} className="text-amber-500 animate-spin shrink-0" />;
  }
  switch (run.conclusion) {
    case "success":
      return <CircleCheck size={12} className="text-green-500 shrink-0" />;
    case "failure":
    case "timed_out":
      return <CircleX size={12} className="text-red-500 shrink-0" />;
    case "cancelled":
      return <CircleX size={12} className="text-muted-foreground/50 shrink-0" />;
    default:
      return <CircleCheck size={12} className="text-muted-foreground/50 shrink-0" />;
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

/** Summarise the aggregate CI state as a headline string. */
function aggregateHeadline(checks: ChecksStatus): string {
  const total = checks.runs.length;
  const failing = checks.runs.filter(
    (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
  ).length;
  const running = checks.runs.filter((r) => r.status !== "completed").length;

  switch (checks.aggregate) {
    case "passing":
      return total === 1 ? "1 check passed" : `All ${total} checks passed`;
    case "failing":
      return failing === 1 ? "1 check failed" : `${failing} of ${total} checks failed`;
    case "pending":
      return running === 1 ? "1 check running" : `${running} checks running`;
    case "no_checks":
      return "No checks configured";
  }
}


/**
 * Popover that shows PR metadata and individual CI check run details.
 * The children prop is rendered as the trigger element.
 */
export function ChecksPopover({
  threadId,
  prUrl,
  prTitle,
  prAuthor,
  checks,
  children,
}: ChecksPopoverProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Keep the staleness label current while the popover is mounted.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(false);
    try {
      const fresh = await getTransport().checkStatus(threadId);
      useWorkspaceStore.setState((ws) => ({
        checksById: { ...ws.checksById, [threadId]: fresh },
      }));
    } catch {
      setRefreshError(true);
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

  const elapsed = Math.round((now - checks.fetchedAt) / 1000);
  const staleLabel =
    elapsed < 5
      ? "just now"
      : elapsed < 60
        ? `${elapsed}s ago`
        : `${Math.floor(elapsed / 60)}m ago`;

  const visual = getCiVisual(checks.aggregate);
  const StatusIcon = visual.icon;

  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex cursor-pointer"
        aria-label="View CI check details"
      >
        {children}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" sideOffset={6} className="w-80 p-0 overflow-hidden">
        {/* Aggregate status header */}
        <div className="flex items-center gap-3 px-4 pt-4 pb-2.5">
          <StatusIcon size={16} className={cn("shrink-0", visual.color)} />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground leading-tight">
              {aggregateHeadline(checks)}
            </div>
            {prTitle && (
              <div className="text-xs text-muted-foreground truncate mt-0.5">
                {prTitle}
                {prAuthor && <span className="opacity-70"> · {prAuthor}</span>}
              </div>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-border/50 mx-4" />

        {/* Check run list */}
        <div className="py-1.5 max-h-52 overflow-y-auto">
          {sortedRuns.map((run) => {
            const isRunning = run.status !== "completed";
            const isFailing =
              run.conclusion === "failure" || run.conclusion === "timed_out";
            return (
              <div
                key={run.name}
                className={cn(
                  "flex items-center gap-2.5 px-4 py-[5px] text-xs",
                  isFailing && "bg-red-500/[0.06]",
                )}
              >
                <CheckIcon run={run} />
                <span
                  className={cn(
                    "truncate flex-1",
                    isFailing
                      ? "text-red-400 font-medium"
                      : "text-foreground/80",
                  )}
                >
                  {run.name}
                </span>
                <span className="font-mono text-[10px] shrink-0 tabular-nums">
                  {isRunning ? (
                    <span className="text-amber-500/80">running</span>
                  ) : run.durationMs != null ? (
                    <span className="text-muted-foreground">{formatDuration(run.durationMs)}</span>
                  ) : null}
                </span>
              </div>
            );
          })}
          {sortedRuns.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-3">
              No checks configured
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="h-px bg-border/50 mx-4" />
        <div className="flex items-center justify-between px-4 py-2">
          <button
            onClick={handleOpenGitHub}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink size={10} className="opacity-60" />
            View on GitHub
          </button>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground tabular-nums">{staleLabel}</span>
            {refreshError && (
              <span className="text-[10px] text-red-400">failed</span>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="Refresh checks"
            >
              <RefreshCw size={9} className={cn(refreshing && "animate-spin")} />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
