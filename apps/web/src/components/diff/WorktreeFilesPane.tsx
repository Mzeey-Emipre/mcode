import { RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReviewFileChange } from "@mcode/contracts";
import { FilesPanel, type FilesPanelProps } from "@/components/files/FilesPanel";
import { PullRequestFileTree } from "@/features/pull-requests";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/** Props for the active-comparison Files navigator shown beside a Review diff. */
export interface WorktreeFilesPaneProps {
  readonly files: readonly ReviewFileChange[];
  readonly activePath: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly className?: string;
  readonly onActivate: (path: string) => void;
  readonly onClose: () => void;
  readonly refreshable: boolean;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number | string;
  readonly defaultWidth: number;
  readonly wideWidth: number;
  readonly getMaxWidth: NonNullable<FilesPanelProps["getMaxWidth"]>;
  readonly onWidthChange: NonNullable<FilesPanelProps["onWidthChange"]>;
}

/** Renders the active Review comparison's changed-file tree. */
export function WorktreeFilesPane({
  files,
  activePath,
  loading,
  error,
  className,
  onActivate,
  onClose,
  refreshable,
  refreshing,
  onRefresh,
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  wideWidth,
  getMaxWidth,
  onWidthChange,
}: WorktreeFilesPaneProps) {
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredFiles = useMemo(
    () =>
      normalizedSearch
        ? files.filter((file) =>
            `${file.previousPath ?? ""} ${file.path}`.toLocaleLowerCase().includes(normalizedSearch),
          )
        : files,
    [files, normalizedSearch],
  );

  return (
    <FilesPanel
      title="Files"
      count={files.length}
      ariaLabel="Files"
      testId="dev-worktree-files-pane"
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
        <div className="flex h-11 shrink-0 items-center border-b border-border/35 px-2.5">
          <div className="relative min-w-0 flex-1">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70"
            />
            <Input
              size="sm"
              value={search}
              maxLength={200}
              aria-label="Search files"
              placeholder="Filter files"
              className="h-8 rounded-md bg-background/70 pl-7 font-mono text-xs"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {refreshable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh comparison"
              disabled={refreshing}
              onClick={onRefresh}
              className="ml-1 h-7 w-7 shrink-0 text-muted-foreground"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      }
    >
      {loading ? (
        <div className="flex flex-1 items-center justify-center" role="status">
          <span className="font-mono text-[1.05rem] uppercase tracking-[0.18em] text-muted-foreground/50">
            Loading files
          </span>
        </div>
      ) : error ? (
        <p role="alert" className="px-3 py-4 text-xs text-destructive">
          {error}
        </p>
      ) : filteredFiles.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <span aria-hidden className="font-mono text-2xl text-muted-foreground/15">
            ⊘
          </span>
          <p className="font-mono text-[1.05rem] uppercase tracking-[0.18em] text-muted-foreground/40">
            {files.length === 0 ? "No changed files" : "No matching files"}
          </p>
        </div>
      ) : (
        <PullRequestFileTree
          reviewFiles={filteredFiles}
          activePath={activePath}
          searchActive={normalizedSearch.length > 0}
          className="min-h-0 flex-1"
          ariaLabel="Files"
          onActivate={onActivate}
        />
      )}
    </FilesPanel>
  );
}
