import type { PullRequestFile } from "@mcode/contracts";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import {
  FilesPanel,
  type FilesPanelProps,
} from "@/components/files/FilesPanel";
import { Input } from "@/components/ui/input";
import type { PullRequestFileQuery } from "@/features/pull-requests/state/pullRequestCodeStore";
import { PullRequestFileTree } from "./PullRequestFileTree";

const FILE_SEARCH_DEBOUNCE_MS = 250;

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
  const searchActive = query.search.length > 0;

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- An externally restored file query replaces the local debounced search draft.
    setSearchInput(query.search);
  }, [query.search]);

  useEffect(() => {
    if (query.changeTypes.length === 0) return;
    onQueryChange({ search: query.search, changeTypes: [] });
  }, [onQueryChange, query.changeTypes.length, query.search]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      if (searchInput.trim() === query.search) return;
      onQueryChange({ search: searchInput, changeTypes: [] });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [onQueryChange, query.search, searchInput]);

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
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/35 px-2.5">
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
              className="h-8 rounded-md bg-background/70 pl-7 font-mono text-xs"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
        </div>
      }
    >
      <PullRequestFileTree
        files={files}
        activePath={activePath}
        searchActive={searchActive}
        className="min-h-0 flex-1"
        ariaLabel={ariaLabel}
        onActivate={onActivate}
      />
    </FilesPanel>
  );
}
