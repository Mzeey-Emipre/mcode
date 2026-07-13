import type { PullRequestFile, PullRequestFileChangeType } from "@mcode/contracts";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { PullRequestFileQuery } from "@/stores/pullRequestCodeStore";
import { cn } from "@/lib/utils";
import { PullRequestFileTree } from "./PullRequestFileTree";

const FILE_SEARCH_DEBOUNCE_MS = 250;

const changeTypeOptions: Array<{
  value: PullRequestFileChangeType;
  label: string;
}> = [
  { value: "added", label: "Added" },
  { value: "modified", label: "Modified" },
  { value: "deleted", label: "Deleted" },
  { value: "renamed", label: "Renamed" },
  { value: "copied", label: "Copied" },
  { value: "changed", label: "Changed" },
  { value: "unchanged", label: "Unchanged" },
];

/** Props for the reusable changed-files navigator shown beside a pull request diff. */
export interface PullRequestChangedFilesPaneProps {
  files: readonly PullRequestFile[];
  activePath: string | null;
  query: PullRequestFileQuery;
  className?: string;
  ariaLabel?: string;
  onActivate: (path: string) => void;
  onQueryChange: (query: PullRequestFileQuery) => void;
  onClose?: () => void;
}

/** Renders a self-contained changed-files navigator with filtering and selection. */
export function PullRequestChangedFilesPane({
  files,
  activePath,
  query,
  className,
  ariaLabel = "Pull request changed files",
  onActivate,
  onQueryChange,
  onClose,
}: PullRequestChangedFilesPaneProps) {
  const [searchInput, setSearchInput] = useState(query.search);
  const filtersActive = query.search.length > 0 || query.changeTypes.length > 0;

  useEffect(() => {
    setSearchInput(query.search);
  }, [query.search]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      if (searchInput.trim() === query.search) return;
      onQueryChange({ ...query, search: searchInput });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [onQueryChange, query, searchInput]);

  const toggleChangeType = (changeType: PullRequestFileChangeType): void => {
    const changeTypes = query.changeTypes.includes(changeType)
      ? query.changeTypes.filter((item) => item !== changeType)
      : [...query.changeTypes, changeType];
    onQueryChange({ ...query, search: searchInput, changeTypes });
  };

  return (
    <aside
      data-testid="pull-request-changed-files-pane"
      aria-label={`${ariaLabel} navigator`}
      className={cn(
        "flex min-h-0 flex-col border-r border-border/70 bg-background",
        className,
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 px-2.5">
        <span className="text-xs font-medium text-foreground/85">
          Changed files
        </span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/75">
          {files.length}
        </span>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto rounded-none text-muted-foreground"
            aria-label="Hide changed files"
            onClick={onClose}
          >
            <X size={13} aria-hidden />
          </Button>
        )}
      </header>

      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70"
          />
          <Input
            size="sm"
            value={searchInput}
            maxLength={200}
            aria-label="Search changed files"
            placeholder="Filter files"
            className="h-7 rounded-none bg-page pl-7 font-mono text-xs"
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>

        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="relative rounded-none text-muted-foreground"
                aria-label="Filter changed files by status"
              >
                <SlidersHorizontal size={13} aria-hidden />
                {query.changeTypes.length > 0 && (
                  <Badge
                    variant="secondary"
                    size="sm"
                    className="absolute -right-1 -top-1 min-w-3 justify-center px-0.5 font-mono text-[8px] tabular-nums"
                  >
                    {query.changeTypes.length}
                  </Badge>
                )}
              </Button>
            }
          />
          <PopoverContent
            align="start"
            sideOffset={6}
            className="w-56 rounded-none p-2"
          >
            <div
              role="group"
              aria-label="Changed file statuses"
              className="grid grid-cols-2 gap-1"
            >
              {changeTypeOptions.map((option) => {
                const pressed = query.changeTypes.includes(option.value);
                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={pressed}
                    className={cn(
                      "justify-start rounded-none px-2 text-xs font-normal",
                      pressed && "bg-primary/9 text-foreground",
                    )}
                    onClick={() => toggleChangeType(option.value)}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <PullRequestFileTree
        files={files}
        activePath={activePath}
        searchActive={filtersActive}
        className="min-h-0 flex-1"
        ariaLabel={ariaLabel}
        onActivate={onActivate}
      />
    </aside>
  );
}
