import { Pin, GitBranch, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
      <ProjectRowIdentity workspace={workspace} home={home} onPin={onPin} />
      <ProjectRowMetadata enrichment={enrichment} lastOpenedLabel={lastOpenedLabel} />
      <ProjectRowRemoveAction workspaceId={workspace.id} onRemove={onRemove} />
    </div>
  );
}

function ProjectRowIdentity({
  workspace,
  home,
  onPin,
}: Pick<Props, "workspace" | "home" | "onPin">) {
  const pinLabel = workspace.pinned ? "Unpin" : "Pin";
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        <span className="truncate font-medium">{workspace.name}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                data-testid="project-row-pin"
                className="ml-1 inline-flex shrink-0 items-center justify-center rounded-sm p-0.5 text-primary/80 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[pinned=true]:opacity-100"
                data-pinned={workspace.pinned}
                onClick={(event) => {
                  event.stopPropagation();
                  onPin(workspace.id, !workspace.pinned);
                }}
                aria-label={pinLabel}
              >
                <Pin size={11} strokeWidth={2} className={workspace.pinned ? "fill-primary/80" : ""} />
              </button>
            }
          />
          <TooltipContent>{`${pinLabel} project`}</TooltipContent>
        </Tooltip>
      </div>
      <PathLabel path={workspace.path} home={home} />
    </div>
  );
}

function ProjectRowMetadata({
  enrichment,
  lastOpenedLabel,
}: {
  enrichment: ReturnType<typeof useProjectSelectorStore.getState>["enrichmentCache"] extends Map<string, infer Value> ? Value | undefined : never;
  lastOpenedLabel: string | null;
}) {
  return (
    <div className="flex shrink-0 min-w-0 max-w-[52%] flex-col items-end gap-0.5 font-mono text-[11px] text-muted-foreground/60 max-[520px]:max-w-none max-[520px]:flex-row max-[520px]:items-center max-[520px]:justify-between">
      {enrichment ? <ProjectRowEnrichment enrichment={enrichment} /> : null}
      {lastOpenedLabel ? <span className="whitespace-nowrap tabular-nums">{lastOpenedLabel}</span> : null}
    </div>
  );
}

function ProjectRowEnrichment({
  enrichment,
}: {
  enrichment: NonNullable<ReturnType<typeof useProjectSelectorStore.getState>["enrichmentCache"] extends Map<string, infer Value> ? Value : never>;
}) {
  if (!enrichment.isGit) {
    return <span className="col-span-4 truncate justify-self-end text-muted-foreground/40">not a git repo</span>;
  }
  const branch = enrichment.branch ?? "detached";
  const workingTreeLabel = enrichment.isClean ? "Clean working tree" : "Uncommitted changes";
  return (
    <div className="grid w-full min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn("h-1.5 w-1.5 shrink-0 rounded-full", enrichment.isClean ? "bg-green-600/70" : "bg-amber-600/70")}
              aria-label={workingTreeLabel}
            />
          }
        />
        <TooltipContent>{workingTreeLabel}</TooltipContent>
      </Tooltip>
      <GitBranch size={10} strokeWidth={2} className="shrink-0 opacity-70" aria-hidden />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate text-right">{branch}</span>} />
        <TooltipContent>{branch}</TooltipContent>
      </Tooltip>
      <ProjectRowThreadCount count={enrichment.threadCount} />
    </div>
  );
}

function ProjectRowThreadCount({ count }: { count: number }) {
  if (count === 0) return null;
  const label = `${count} thread${count === 1 ? "" : "s"}`;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="shrink-0 tabular-nums">· {count}</span>} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ProjectRowRemoveAction({ workspaceId, onRemove }: Pick<Props, "onRemove"> & { workspaceId: string }) {
  if (!onRemove) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            data-testid="project-row-remove"
            className="inline-flex shrink-0 items-center justify-center rounded-sm p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-accent/60 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(workspaceId);
            }}
            aria-label="Remove from recents"
          >
            <X size={11} strokeWidth={2.25} aria-hidden />
          </button>
        }
      />
      <TooltipContent>Remove from recents (Ctrl+Backspace)</TooltipContent>
    </Tooltip>
  );
}
