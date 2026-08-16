import { Pin, GitBranch, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PathLabel } from "./PathLabel";
import { useProjectSelectorStore } from "./state/projectSelectorStore";

/** Props for ProjectRow. */
interface Props {
  /** Workspace data for this row. */
  workspace: {
    id: string;
    name: string;
    path: string;
    pinned: boolean;
    last_opened_at: number | null;
    is_git_repo: boolean;
  };
  /** Whether this row is the currently active (keyboard-focused) item. */
  isActive?: boolean;
  /** Called when the user clicks the row to open the workspace. */
  onSelect: (id: string) => void;
  /** Called when the user toggles the pin state. Second argument is the desired new pinned value. */
  onPin: (id: string, pinned: boolean) => void;
  /** Called when the user removes the workspace from recents. Optional — row hides the button if absent. */
  onRemove?: (id: string) => void;
  /** Home directory prefix used by PathLabel to collapse the path to ~. */
  home?: string;
}

/**
 * Format a unix timestamp (ms) as a short relative time string (e.g. "2h ago", "3d ago").
 * Returns null when the input is not a finite number so callers can skip rendering.
 */
function relativeTime(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff)) return null;
  if (diff <= 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

/**
 * One row in the project selector list.
 * Lazy enrichment (branch, clean state, thread count) fades in from projectSelectorStore
 * as the RPC resolves. The parent is responsible for batching the enrichment call
 * across all visible rows — each row owning its own `enrich([id])` produces one RPC
 * per workspace on first paint. Pin and remove actions are callbacks to keep
 * optimistic updates in the parent.
 */
export function ProjectRow({ workspace, isActive, onSelect, onPin, onRemove, home }: Props) {
  const enrichment = useProjectSelectorStore((s) => s.enrichmentCache.get(workspace.id));
  const lastOpenedLabel =
    workspace.last_opened_at != null ? relativeTime(workspace.last_opened_at) : null;

  return (
    <div
      role="option"
      aria-selected={isActive}
      data-active={isActive}
      data-testid="project-row"
      // Keyboard reachability: in the landing page (no parent CommandItem),
      // the row needs to be tabbable so non-mouse users can open a project.
      // Inside the palette the parent CommandItem already handles focus, so the
      // duplicate tab stop is harmless — both routes call onSelect.
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(workspace.id);
        }
      }}
      className={cn(
        "group flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-[13px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring max-[520px]:flex-col max-[520px]:items-stretch max-[520px]:gap-1.5",
        // group-aria-selected/cmd responds to parent CommandItem keyboard focus in the palette.
        // has no effect in landing page context (no parent with group/cmd).
        "hover:bg-accent/60 data-[active=true]:bg-accent group-aria-selected/cmd:bg-accent",
      )}
      onClick={() => onSelect(workspace.id)}
    >
      {/* Left: name + path */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{workspace.name}</span>
          {/* Pin toggle — always visible when pinned (filled), shown on hover otherwise (outline).
              Lucide Pin icon keeps visual language consistent with the rest of the picker. */}
          <button
            data-testid="project-row-pin"
            className="ml-1 inline-flex shrink-0 items-center justify-center rounded-sm p-0.5 text-primary/80 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[pinned=true]:opacity-100"
            data-pinned={workspace.pinned}
            onClick={(e) => {
              e.stopPropagation();
              onPin(workspace.id, !workspace.pinned);
            }}
            aria-label={workspace.pinned ? "Unpin" : "Pin"}
            title={workspace.pinned ? "Unpin project" : "Pin project"}
          >
            <Pin
              size={11}
              strokeWidth={2}
              className={workspace.pinned ? "fill-primary/80" : ""}
            />
          </button>
        </div>
        <PathLabel path={workspace.path} home={home} />
      </div>

      {/* Right: meta strip — branch, status dot, thread count, relative timestamp.
          Cap the column fraction so the project title + path keep priority; inner
          layout uses a grid so the branch absorbs remaining width inside that cap
          instead of an arbitrary 10rem clip (impeccable: information-dense, mono meta). */}
      <div className="flex shrink-0 min-w-0 max-w-[52%] flex-col items-end gap-0.5 font-mono text-[11px] text-muted-foreground/60 max-[520px]:max-w-none max-[520px]:flex-row max-[520px]:items-center max-[520px]:justify-between">
        {enrichment ? (
          <>
            <div className="grid w-full min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-1.5">
              {enrichment.isGit ? (
                <>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      enrichment.isClean ? "bg-green-600/70" : "bg-amber-600/70",
                    )}
                    aria-label={enrichment.isClean ? "Clean working tree" : "Uncommitted changes"}
                    title={enrichment.isClean ? "Clean working tree" : "Uncommitted changes"}
                  />
                  <GitBranch size={10} strokeWidth={2} className="shrink-0 opacity-70" aria-hidden />
                  <span
                    className="min-w-0 truncate text-right"
                    title={enrichment.branch ?? "detached"}
                  >
                    {enrichment.branch ?? "detached"}
                  </span>
                  {enrichment.threadCount > 0 ? (
                    <span
                      className="shrink-0 tabular-nums"
                      title={`${enrichment.threadCount} thread${enrichment.threadCount === 1 ? "" : "s"}`}
                    >
                      · {enrichment.threadCount}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="col-span-4 truncate justify-self-end text-muted-foreground/40">
                  not a git repo
                </span>
              )}
            </div>
            {lastOpenedLabel && (
              <span className="whitespace-nowrap tabular-nums">{lastOpenedLabel}</span>
            )}
          </>
        ) : (
          // Show timestamp as skeleton while enrichment is loading
          lastOpenedLabel && (
            <span className="whitespace-nowrap tabular-nums">{lastOpenedLabel}</span>
          )
        )}
      </div>

      {/* Remove from recents — only shown when handler is provided. Hidden until row hover so
          the right rail stays calm; lucide X keeps the icon set consistent. */}
      {onRemove && (
        <button
          data-testid="project-row-remove"
          className="inline-flex shrink-0 items-center justify-center rounded-sm p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-accent/60 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(workspace.id);
          }}
          aria-label="Remove from recents"
          title="Remove from recents (Ctrl+Backspace)"
        >
          <X size={11} strokeWidth={2.25} aria-hidden />
        </button>
      )}
    </div>
  );
}
