import { useState } from "react";
import { ChevronDown, ExternalLink, GitPullRequest, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Props for {@link PrSplitButton}. */
interface PrSplitButtonProps {
  /** Active pull request for this branch. */
  pr: { number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED" | string };
  /** Primary row label, usually the PR title or PR number. */
  label: string;
  /** Whether the primary label is generated repository data rather than prose. */
  machineLabel?: boolean;
  /** Called when the user wants to open CreatePrDialog. */
  onCreatePr: () => void;
  /** Called with the PR URL when the user wants to open it in the browser or preview. */
  onOpenPr: (url: string, event?: React.MouseEvent) => void;
  /** Optional trailing content rendered before the menu chevron (for example a CI badge). */
  trailing?: React.ReactNode;
  /** Optional test id for the PR row trigger. */
  primaryButtonTestId?: string;
  /** Optional test id for the open action inside the popover. */
  openActionTestId?: string;
  /** Optional test id for the follow-up create action in the menu. */
  newPrButtonTestId?: string;
}

function prStateTitle(pr: PrSplitButtonProps["pr"]): string {
  const state = pr.state.toLowerCase();
  if (state === "merged") return `View merged PR #${pr.number}`;
  if (state === "closed") return `View closed PR #${pr.number}`;
  return `View PR #${pr.number}`;
}

function openPrLabel(pr: PrSplitButtonProps["pr"]): string {
  const state = pr.state.toLowerCase();
  if (state === "merged") return `Open merged PR #${pr.number}`;
  if (state === "closed") return `Open closed PR #${pr.number}`;
  return `Open PR #${pr.number}`;
}

/**
 * Overview row for an active pull request.
 *
 * Uses the same full-row Popover trigger as Local and Branch so the actions panel
 * opens to the left of the Overview column instead of under the chevron.
 */
export function PrSplitButton({
  pr,
  label,
  machineLabel = false,
  onCreatePr,
  onOpenPr,
  trailing,
  primaryButtonTestId,
  openActionTestId = "workspace-menu-open-pr-action",
  newPrButtonTestId,
}: PrSplitButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div data-testid="workspace-menu-open-pr-split">
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              type="button"
              data-testid={primaryButtonTestId}
              aria-label={`Pull request, ${label}`}
              className={cn(
                "h-8 w-full justify-between gap-3 px-2 text-left",
                menuOpen && "bg-muted text-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
                <span
                  className={cn(
                    "truncate text-xs font-medium",
                    machineLabel && "font-mono tabular-nums",
                  )}
                >
                  {label}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {trailing ? (
                  <span
                    className="flex items-center"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {trailing}
                  </span>
                ) : null}
                <ChevronDown
                  size={13}
                  aria-hidden
                  className={cn(
                    "shrink-0 text-muted-foreground transition-transform duration-150",
                    menuOpen && "rotate-180",
                  )}
                />
              </span>
            </Button>
          }
        />
        <PopoverContent align="start" side="left" sideOffset={12} className="w-72 p-0">
          <div data-testid="thread-overview-pr-popover" className="animate-popover-enter space-y-1 p-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid={openActionTestId}
                    className="h-8 w-full cursor-pointer justify-start gap-2 px-2 text-left text-xs text-foreground/75 hover:bg-muted/40 hover:text-foreground"
                    onClick={(event) => {
                      setMenuOpen(false);
                      onOpenPr(pr.url, event);
                    }}
                  >
                    <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{openPrLabel(pr)}</span>
                  </Button>
                }
              />
              <TooltipContent>{prStateTitle(pr)}</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              data-testid={newPrButtonTestId}
              className="h-8 w-full cursor-pointer justify-start gap-2 px-2 text-left text-xs text-foreground/75 hover:bg-muted/40 hover:text-foreground"
              onClick={() => {
                setMenuOpen(false);
                onCreatePr();
              }}
            >
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium">Create new PR</span>
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
