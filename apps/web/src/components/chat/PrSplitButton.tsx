import { useState } from "react";
import { ChevronDown, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Props for {@link PrSplitButton}. */
interface PrSplitButtonProps {
  /** Active pull request for this branch. */
  pr: { number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED" | string };
  /** Called when the user wants to open CreatePrDialog. */
  onCreatePr: () => void;
  /** Called with the PR URL when the user wants to open it in the browser or preview. */
  onOpenPr: (url: string, event?: React.MouseEvent) => void;
  /** Optional test id for the PR primary action. */
  primaryButtonTestId?: string;
  /** Optional test id for the follow-up create action in the menu. */
  newPrButtonTestId?: string;
}

const ACTION_CLASS =
  "h-6 px-2 text-xs text-foreground/75 hover:bg-muted/40 hover:text-foreground";

function prStateTitle(pr: PrSplitButtonProps["pr"]): string {
  const state = pr.state.toLowerCase();
  if (state === "merged") return `View merged PR #${pr.number}`;
  if (state === "closed") return `View closed PR #${pr.number}`;
  return `View PR #${pr.number}`;
}

/**
 * Split button for an active pull request in the Overview row.
 *
 * Primary action opens the current PR. The chevron menu exposes Create new PR
 * without crowding the row when only one PR exists.
 */
export function PrSplitButton({
  pr,
  onCreatePr,
  onOpenPr,
  primaryButtonTestId,
  newPrButtonTestId,
}: PrSplitButtonProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const state = pr.state.toLowerCase();

  return (
    <div className="relative inline-flex shrink-0">
      <div className="inline-flex rounded-md">
        <Button
          variant="ghost"
          size="xs"
          type="button"
          data-testid={primaryButtonTestId}
          className={cn(
            ACTION_CLASS,
            "rounded-r-none",
            state === "closed" && "text-destructive/80 hover:text-destructive",
            state === "merged" && "text-primary/80 hover:text-primary",
          )}
          title={prStateTitle(pr)}
          onClick={(event) => onOpenPr(pr.url, event)}
        >
          View PR #{pr.number}
        </Button>

        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger
            aria-label="Open PR menu"
            className={cn(
              "inline-flex items-center rounded-r-md border-l border-border/20 px-1.5 h-6 text-xs transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "text-foreground/75 hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <ChevronDown
              size={11}
              className={cn("transition-transform duration-150", dropdownOpen && "rotate-180")}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-[170px] text-xs">
            <DropdownMenuItem
              data-testid={newPrButtonTestId}
              onClick={() => onCreatePr()}
              className="gap-2 text-foreground/75"
            >
              <GitPullRequest size={11} className="opacity-75" />
              Create new PR
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
