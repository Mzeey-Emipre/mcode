import type {
  PullRequestFile,
  PullRequestFileChangeType,
} from "@mcode/contracts";
import { Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import {
  FilesPanel,
  type FilesPanelProps,
} from "@/components/files/FilesPanel";
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
  width?: FilesPanelProps["width"];
  minWidth?: FilesPanelProps["minWidth"];
  maxWidth?: FilesPanelProps["maxWidth"];
  defaultWidth?: FilesPanelProps["defaultWidth"];
  wideWidth?: FilesPanelProps["wideWidth"];
  getMaxWidth?: FilesPanelProps["getMaxWidth"];
  onWidthChange?: FilesPanelProps["onWidthChange"];
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
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  wideWidth,
  getMaxWidth,
  onWidthChange,
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
    <FilesPanel
      title="Changed files"
      count={files.length}
      ariaLabel={ariaLabel}
      testId="pull-request-changed-files-pane"
      className={className}
      onClose={onClose}
      width={width}
      minWidth={minWidth}
      maxWidth={maxWidth}
      defaultWidth={defaultWidth}
      wideWidth={wideWidth}
      getMaxWidth={getMaxWidth}
      onWidthChange={onWidthChange}
      controls={
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
              className="h-7 rounded-md bg-page pl-7 font-mono text-xs"
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
                  className="relative rounded-md text-muted-foreground"
                  aria-label="Filter changed files by status"
                >
                  <SlidersHorizontal size={13} aria-hidden />
                  {query.changeTypes.length > 0 && (
                    <Badge
                      variant="secondary"
                      size="sm"
                      className="absolute -right-1 -top-1 min-w-3 justify-center px-0.5 font-mono tabular-nums"
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
              className="w-56 rounded-lg p-2"
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
                        "justify-start rounded-md px-2 text-xs font-normal",
                        pressed && "bg-muted/70 text-foreground",
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
      }
    >
      <PullRequestFileTree
        files={files}
        activePath={activePath}
        searchActive={filtersActive}
        className="min-h-0 flex-1"
        ariaLabel={ariaLabel}
        onActivate={onActivate}
      />
    </FilesPanel>
  );
}
