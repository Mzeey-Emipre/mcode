import { useState, useCallback, useEffect, useMemo } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { CircleCheck, CircleX, Loader2, RefreshCw, ExternalLink, MinusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getCiVisual, getBreakdown, getLeadRunningName, CI_ICON_STROKE } from "@/lib/ci-status";
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
  /**
   * Controlled open state. When provided the popover becomes fully controlled,
   * letting callers (e.g. a keyboard shortcut handler) open it programmatically.
   * When omitted the popover is uncontrolled and opens on click.
   */
  open?: boolean;
  /** Paired with `open` — called when Base UI wants to change the open state. */
  onOpenChange?: (open: boolean) => void;
}

/** Lanes that runs can land in — controls grouping, colour, and sort priority. */
type Lane = "failing" | "running" | "passing" | "other";

/** Lane metadata used for the section header chrome. Only the failing lane carries a wash
 *  so the popover stays calm: urgency is carried by one surface, not three. */
const LANE_META: Record<Lane, { label: string; icon: typeof CircleCheck; iconClass: string; wash: string; accent: string }> = {
  failing: {
    label: "Failing",
    icon: CircleX,
    iconClass: "text-[var(--diff-remove-strong)]",
    wash: "bg-[var(--diff-remove-strong)]/[0.05]",
    accent: "text-[var(--diff-remove-strong)]",
  },
  running: {
    label: "Running",
    icon: Loader2,
    iconClass: "text-primary",
    wash: "",
    accent: "text-primary",
  },
  passing: {
    label: "Passing",
    icon: CircleCheck,
    iconClass: "text-[var(--diff-add-strong)]",
    wash: "",
    accent: "text-[var(--diff-add-strong)]/85",
  },
  other: {
    label: "Skipped",
    icon: MinusCircle,
    iconClass: "text-muted-foreground/60",
    wash: "",
    accent: "text-muted-foreground",
  },
};

function laneOf(run: CheckRun): Lane {
  if (run.status !== "completed") return "running";
  if (run.conclusion === "failure" || run.conclusion === "timed_out") return "failing";
  if (run.conclusion === "success") return "passing";
  return "other";
}

/** Status icon for an individual check run, colour-matched to its lane. */
function RunIcon({ run }: { run: CheckRun }) {
  const lane = laneOf(run);
  const Meta = LANE_META[lane];
  return (
    <Meta.icon
      size={12}
      className={cn(
        Meta.iconClass,
        "shrink-0",
        lane === "running" && "motion-safe:animate-spin",
      )}
      strokeWidth={CI_ICON_STROKE}
    />
  );
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

/** Compute elapsed time since a startedAt timestamp, as a live-updating formatted string. */
function useLiveElapsed(startedAtIso: string | null | undefined, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAtIso) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active, startedAtIso]);
  if (!startedAtIso) return null;
  const started = new Date(startedAtIso).getTime();
  if (isNaN(started)) return null;
  return formatDuration(now - started);
}

/** Summarise the aggregate CI state as a headline string, e.g. "3 of 5 running". */
function aggregateHeadline(checks: ChecksStatus, elapsedLive: string | null): string {
  const b = getBreakdown(checks);
  switch (checks.aggregate) {
    case "passing":
      return b.total === 1 ? "1 check passed" : `All ${b.total} checks passed`;
    case "failing":
      return b.failing === 1
        ? `1 failing · ${b.total - b.failing} green`
        : `${b.failing} of ${b.total} failing`;
    case "pending":
      return elapsedLive
        ? `${b.total - b.running}/${b.total} · running for ${elapsedLive}`
        : `${b.total - b.running} of ${b.total} running`;
    case "no_checks":
      return "No checks configured";
  }
}

/**
 * Popover that shows PR metadata and per-lane grouped CI check run details.
 *
 * Layout: premium editorial hierarchy.
 * - Chrome header: large status icon + aggregate headline + PR title/author
 * - Live progress strip when aggregate is pending
 * - Grouped run lanes: Failing → Running → Passing → Skipped
 *   - failing lane is auto-expanded with a red wash for urgency
 *   - each run carries a live elapsed time while running
 * - Footer: freshness label, refresh button, GitHub link
 */
export function ChecksPopover({
  threadId,
  prUrl,
  prTitle,
  prAuthor,
  checks,
  children,
  open,
  onOpenChange,
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
      if (parsed.protocol === "https:" && parsed.hostname === "github.com") {
        window.desktopBridge?.openExternalUrl(prUrl);
      }
    } catch {
      // Invalid URL - do nothing
    }
  }, [prUrl]);

  // Group runs by lane, ordered by priority.
  const laned = useMemo(() => {
    const groups: Record<Lane, CheckRun[]> = { failing: [], running: [], passing: [], other: [] };
    for (const r of checks.runs) groups[laneOf(r)].push(r);
    return groups;
  }, [checks.runs]);

  const breakdown = useMemo(() => getBreakdown(checks), [checks]);

  // Lead running job for the subtitle ("currently running: lint").
  const leadRunning = useMemo(
    () => (checks.aggregate === "pending" ? getLeadRunningName(checks) : null),
    [checks],
  );
  // Elapsed time of the lead running run, live-updating.
  const leadRunningStartedAt = useMemo(() => {
    if (checks.aggregate !== "pending") return null;
    const r = checks.runs.find((x) => x.status !== "completed");
    return r?.startedAt ?? null;
  }, [checks]);
  const liveElapsed = useLiveElapsed(leadRunningStartedAt, checks.aggregate === "pending");

  const elapsed = Math.round((now - checks.fetchedAt) / 1000);
  const staleLabel =
    elapsed < 5
      ? "just now"
      : elapsed < 60
        ? `${elapsed}s ago`
        : `${Math.floor(elapsed / 60)}m ago`;

  const visual = getCiVisual(checks.aggregate);
  const StatusIcon = visual.icon;

  // Visible lane order (skip empty).
  const laneOrder: Lane[] = ["failing", "running", "passing", "other"];
  const visibleLanes = laneOrder.filter((l) => laned[l].length > 0);

  // Progress bar fill ratio — completed / total, used when pending.
  const progressPercent = breakdown.total > 0
    ? Math.round(((breakdown.passing + breakdown.failing + breakdown.other) / breakdown.total) * 100)
    : 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        className="inline-flex cursor-pointer"
        aria-label="View CI check details"
      >
        {children}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" sideOffset={8} className="w-[340px] p-0 overflow-hidden">
        {/* Header chrome */}
        <div className={cn("px-4 pt-3.5 pb-3", visual.surface)}>
          <div className="flex items-start gap-2.5">
            <StatusIcon
              size={18}
              className={cn(
                "shrink-0 mt-0.5",
                visual.color,
                checks.aggregate === "pending" && "motion-safe:animate-spin",
              )}
              strokeWidth={CI_ICON_STROKE}
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground leading-tight">
                {aggregateHeadline(checks, liveElapsed)}
              </div>
              {prTitle ? (
                <div className="text-[11px] text-muted-foreground truncate mt-1 leading-snug">
                  <span className="text-foreground/75">{prTitle}</span>
                  {prAuthor && <span className="opacity-70"> · by {prAuthor}</span>}
                </div>
              ) : leadRunning ? (
                <div className="text-[11px] text-muted-foreground truncate mt-1 leading-snug">
                  Currently running: <span className="text-foreground/75">{leadRunning}</span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Progress strip — pending only */}
          {checks.aggregate === "pending" && breakdown.total > 0 && (
            <div className="mt-3 h-[3px] w-full rounded-full bg-muted/50 overflow-hidden">
              <div
                className="h-full bg-primary/90 transition-[width] duration-500 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
        </div>

        {/* Lane groups */}
        <div className="max-h-72 overflow-y-auto scrollbar-on-hover">
          {visibleLanes.map((lane, laneIdx) => {
            const runs = laned[lane];
            const meta = LANE_META[lane];
            const LaneIcon = meta.icon;
            return (
              <section
                key={lane}
                className={cn(
                  laneIdx > 0 && "border-t border-border/30",
                  meta.wash,
                )}
              >
                <header className="flex items-center gap-1.5 px-4 pt-2 pb-1">
                  <LaneIcon
                    size={10}
                    className={cn(
                      meta.iconClass,
                      lane === "running" && "motion-safe:animate-spin",
                    )}
                    strokeWidth={CI_ICON_STROKE}
                  />
                  <span className={cn("text-[10px] font-semibold uppercase tracking-wider", meta.accent)}>
                    {meta.label}
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums ml-1">
                    {runs.length}
                  </span>
                </header>
                <ul className="pb-1.5">
                  {runs.map((run) => (
                    <RunRow key={run.name} run={run} />
                  ))}
                </ul>
              </section>
            );
          })}
          {breakdown.total === 0 && (
            <div className="text-xs text-muted-foreground text-center py-5">
              No checks configured
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border/50" />
        <div className="flex items-center justify-between px-4 py-2">
          <button
            onClick={handleOpenGitHub}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink size={10} className="opacity-60" />
            View on GitHub
          </button>
          <div className="flex items-center gap-1.5">
            {refreshError ? (
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                title="Last refresh failed — click to retry"
                className="inline-flex items-center gap-1 text-[10px] text-[var(--diff-remove-strong)] hover:text-[var(--diff-remove-strong)]/80 transition-colors tabular-nums disabled:opacity-60"
              >
                <span>refresh failed</span>
                <span className="underline underline-offset-2">retry</span>
              </button>
            ) : (
              <>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  refreshed {staleLabel}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  aria-label="Refresh checks"
                >
                  <RefreshCw
                    size={10}
                    strokeWidth={CI_ICON_STROKE}
                    className={cn(refreshing && "motion-safe:animate-spin")}
                  />
                </Button>
              </>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Single run row with live elapsed time while running, or static duration once completed. */
function RunRow({ run }: { run: CheckRun }) {
  const lane = laneOf(run);
  const isRunning = lane === "running";
  const live = useLiveElapsed(run.startedAt, isRunning);

  const tailLabel = isRunning
    ? live ?? "running"
    : run.durationMs != null
      ? formatDuration(run.durationMs)
      : null;

  const tailClass = isRunning
    ? "text-primary/90"
    : lane === "failing"
      ? "text-[var(--diff-remove-strong)]/90"
      : "text-muted-foreground/80";

  return (
    <li
      className={cn(
        "flex items-center gap-2.5 px-4 py-[5px] text-xs",
      )}
    >
      <RunIcon run={run} />
      <span
        className={cn(
          "truncate flex-1",
          lane === "failing" ? "text-[var(--diff-remove-strong)] font-medium" : "text-foreground/80",
        )}
      >
        {run.name}
      </span>
      {tailLabel && (
        <span className={cn("font-mono text-[10px] shrink-0 tabular-nums", tailClass)}>
          {tailLabel}
        </span>
      )}
    </li>
  );
}
