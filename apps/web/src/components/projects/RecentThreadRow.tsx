import { GitBranch, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PathLabel } from "./PathLabel";
import type { RecentThread } from "@/transport/types";

/** Props for RecentThreadRow. */
interface Props {
  /** Joined thread + workspace data for this row. */
  thread: RecentThread;
  /** Whether this row is the currently active (keyboard-focused) item. */
  isActive?: boolean;
  /** Called when the user clicks the row to open the thread. */
  onSelect: (thread: RecentThread) => void;
  /** Called when the user removes the thread from recents. Optional — row hides the button if absent. */
  onRemove?: (thread: RecentThread) => void;
  /** Home directory prefix used by PathLabel to collapse the workspace path to ~. */
  home?: string;
}

/**
 * Format an ISO-8601 timestamp as a short relative time string.
 * Returns null when the input cannot be parsed to a finite millisecond value
 * so callers can skip rendering.
 */
function relativeTime(iso: string): string | null {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff)) return null;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/**
 * Visual signal for a thread's persisted lifecycle status. Returns null for
 * calm states (active/completed/archived) so the right-rail stays quiet by
 * default — dots only appear when something needs attention.
 */
function statusDot(status: RecentThread["status"]): { className: string; label: string } | null {
  switch (status) {
    case "errored":
      return { className: "bg-destructive/80", label: "Errored" };
    case "interrupted":
      return { className: "bg-amber-600/70", label: "Interrupted" };
    case "paused":
      return { className: "bg-muted-foreground/40", label: "Paused" };
    default:
      return null;
  }
}

/**
 * One row in the landing's "Recent threads" list. Carries the parent
 * workspace's name + path so the user can read which project the thread
 * belongs to without enriching after the fact.
 *
 * Visual treatment mirrors `ProjectRow` (same row density, same right-rail
 * meta strip) so the two sections share rhythm. The thread title is the
 * primary identity; the workspace name + collapsed path sits below in muted
 * mono — the same role the path plays for project rows.
 */
export function RecentThreadRow({ thread, isActive, onSelect, onRemove, home }: Props) {
  const dot = statusDot(thread.status);
  const updatedLabel = relativeTime(thread.updated_at);

  return (
    <div
      role="option"
      aria-selected={isActive}
      data-active={isActive}
      data-testid="recent-thread-row"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(thread);
        }
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-[13px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring max-[520px]:flex-col max-[520px]:items-stretch max-[520px]:gap-1.5",
        "hover:bg-accent/60 data-[active=true]:bg-accent",
      )}
      onClick={() => onSelect(thread)}
    >
      {/* Left: thread title + workspace meta line */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{thread.title}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground/70">
          <span className="shrink-0 truncate">{thread.workspace_name}</span>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">·</span>
          <PathLabel path={thread.workspace_path} home={home} className="text-[11.5px]" />
        </div>
      </div>

      {/* Right: status dot, branch, ago time */}
      <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] text-muted-foreground/60 max-[520px]:flex-row max-[520px]:items-center max-[520px]:justify-between">
        <div className="flex items-center gap-1.5">
          {dot && (
            <span
              className={cn("h-1.5 w-1.5 rounded-full", dot.className)}
              aria-label={dot.label}
              title={dot.label}
            />
          )}
          {thread.branch && (
            <>
              <GitBranch size={10} strokeWidth={2} className="opacity-70" aria-hidden />
              <span className="max-w-[14ch] truncate" title={thread.branch}>
                {thread.branch}
              </span>
            </>
          )}
        </div>
        {updatedLabel && (
          <span className="whitespace-nowrap tabular-nums">{updatedLabel}</span>
        )}
      </div>

      {/* Remove from recents — only shown when handler is provided. */}
      {onRemove && (
        <button
          data-testid="recent-thread-row-remove"
          className="inline-flex shrink-0 items-center justify-center rounded-sm p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-accent/60 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(thread);
          }}
          aria-label="Remove from recents"
          title="Remove from recents"
        >
          <X size={11} strokeWidth={2.25} aria-hidden />
        </button>
      )}
    </div>
  );
}
