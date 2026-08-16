import type {
  PullRequestRelationship,
  PullRequestState,
} from "@mcode/contracts";
import {
  CircleCheck,
  FolderGit2,
  ListFilter,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { PullRequestCheckState } from "@/features/pull-requests/state/pullRequestStore";

/** Props for the pull request search and filter controls. */
export interface PullRequestFiltersProps {
  search: string;
  states: PullRequestState[];
  repositories: string[];
  authors: string[];
  repositoryFilter: string | null;
  authorFilter: string | null;
  reviewFilters: PullRequestRelationship[];
  checkFilters: PullRequestCheckState[];
  onSearchChange: (value: string) => void;
  onStatesChange: (states: PullRequestState[]) => void;
  onRepositoryChange: (repository: string | null) => void;
  onAuthorChange: (author: string | null) => void;
  onReviewToggle: (relationship: PullRequestRelationship) => void;
  onCheckToggle: (check: PullRequestCheckState) => void;
  onClearAll: () => void;
}

type StateFilter = PullRequestState | "all";

const stateLabels: Record<StateFilter, string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
  all: "All states",
};

const stateOptions: Array<{ value: StateFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "All states" },
];

function getStateFilter(states: PullRequestState[]): StateFilter {
  return states.length === 1 ? states[0]! : "all";
}

/** Compact search control and accessible filter popover for the PR inbox. */
export function PullRequestFilters({
  search,
  states,
  repositories,
  repositoryFilter,
  authorFilter,
  reviewFilters,
  checkFilters,
  onSearchChange,
  onStatesChange,
  onRepositoryChange,
  onClearAll,
}: PullRequestFiltersProps) {
  const stateFilter = getStateFilter(states);
  const descriptions = [
    ...(stateFilter === "open" ? [] : [`Status: ${stateLabels[stateFilter]}`]),
    ...(repositoryFilter ? [`Repository: ${repositoryFilter}`] : []),
    ...(authorFilter ? [`Author: ${authorFilter}`] : []),
    ...(reviewFilters.length > 0 ? [`Review: ${reviewFilters.length}`] : []),
    ...(checkFilters.length > 0 ? [`Checks: ${checkFilters.length}`] : []),
  ];
  const activeCount = descriptions.length;

  const filterLabel =
    activeCount === 0
      ? "Filter pull requests"
      : `Filter pull requests, ${activeCount} filters active`;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/70"
          />
          <Input
            size="sm"
            value={search}
            maxLength={200}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search pull requests"
            aria-label="Search pull requests"
            className="bg-page pl-8 text-xs"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={filterLabel}
                className="relative bg-page"
              >
                <ListFilter size={13} aria-hidden />
                {activeCount > 0 && (
                  <Badge
                    variant="secondary"
                    size="sm"
                    aria-hidden
                    className="absolute -right-1 -top-1 min-w-4 rounded-full px-1 font-mono tabular-nums"
                  >
                    {activeCount}
                  </Badge>
                )}
              </Button>
            }
          />
          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="w-52"
          >
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <CircleCheck aria-hidden />
                Status
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                {stateOptions.map((option) => (
                  <DropdownMenuCheckboxItem
                    key={option.value}
                    checked={stateFilter === option.value}
                    closeOnClick
                    onCheckedChange={() =>
                      onStatesChange(
                        option.value === "all"
                          ? ["open", "closed", "merged"]
                          : [option.value],
                      )
                    }
                  >
                    {option.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderGit2 aria-hidden />
                Repository
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72">
                <DropdownMenuCheckboxItem
                  checked={repositoryFilter === null}
                  closeOnClick
                  onCheckedChange={() => onRepositoryChange(null)}
                >
                  All repositories
                </DropdownMenuCheckboxItem>
                {repositories.map((repository) => (
                  <DropdownMenuCheckboxItem
                    key={repository}
                    checked={repositoryFilter === repository}
                    closeOnClick
                    onCheckedChange={() => onRepositoryChange(repository)}
                  >
                    <span className="truncate">{repository}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {activeCount > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onClearAll}>
                  <X aria-hidden />
                  Clear filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {activeCount > 0 && (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <p aria-live="polite" className="min-w-0 flex-1 truncate">
            {descriptions.join(" · ")}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onClearAll}
            className="h-6 gap-1 px-1.5 text-xs"
          >
            <X size={12} aria-hidden />
            Clear filters
          </Button>
        </div>
      )}
    </div>
  );
}
