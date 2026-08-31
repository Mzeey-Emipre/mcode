import { SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLocalPorts } from "./useLocalPorts";

/** Props for the empty-browser localhost quick-open list. */
export interface LocalPortsEmptyStateProps {
  /** True while this empty state is mounted/visible; gates port polling. */
  readonly active: boolean;
  /** Open a detected port in the preview (navigates to http://localhost:<port>). */
  readonly onOpenPort: (port: number) => void;
}

/**
 * Empty-browser body listing detected localhost ports as one-click cards (name,
 * port, online dot). Shown when no page is loaded. The sort/filter control is a
 * deliberately disabled stub for a future slice. Port detection comes from
 * {@link useLocalPorts}; until the backend (#613) exists it shows a quiet
 * "nothing detected" line.
 */
export function LocalPortsEmptyState({
  active,
  onOpenPort,
}: LocalPortsEmptyStateProps) {
  const { ports, loading, unsupported } = useLocalPorts(active);

  return (
    <div
      data-testid="browser-local-ports"
      className="mx-auto mt-16 w-full max-w-md px-6"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Local</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled
                  aria-label="Sort and filter (coming soon)"
                  className="text-muted-foreground opacity-40"
                >
                  <SlidersHorizontal size={13} aria-hidden />
                </Button>
              </span>
            }
          />
          <TooltipContent>Sort & filter (coming soon)</TooltipContent>
        </Tooltip>
      </div>

      {ports.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {ports.map((p) => (
            <li key={p.port}>
              <button
                type="button"
                data-testid="browser-local-port"
                onClick={() => onOpenPort(p.port)}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5 text-left transition hover:bg-card focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
              >
                <span className="flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-background">
                  <span className="flex flex-col gap-0.5" aria-hidden>
                    <span className="flex gap-0.5">
                      <span className="h-1 w-1 rounded-full bg-red-400/70" />
                      <span className="h-1 w-1 rounded-full bg-amber-400/70" />
                      <span className="h-1 w-1 rounded-full bg-emerald-400/70" />
                    </span>
                    <span className="h-3 w-8 rounded-[1px] bg-muted" />
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {p.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    localhost:{p.port}
                  </span>
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        data-testid="browser-local-port-status"
                        data-online={p.online ? "true" : "false"}
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          p.online ? "bg-emerald-500" : "bg-muted-foreground/40",
                        )}
                        aria-label={p.online ? "Online" : "Offline"}
                      />
                    }
                  />
                  <TooltipContent side="top">
                    {p.online ? "Online" : "Offline"}
                  </TooltipContent>
                </Tooltip>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground/70">
          {loading && !unsupported
            ? "Looking for local servers\u2026"
            : "No local servers detected."}
        </p>
      )}
    </div>
  );
}
