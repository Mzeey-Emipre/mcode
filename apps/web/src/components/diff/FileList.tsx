import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  FileSearch,
  WrapText,
  Columns2,
  MoreHorizontal,
  RefreshCw,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";
import { FileEntry } from "./FileEntry";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { useDiffStore, type SelectedFile } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DIFF_FILE_LIST_PADDING } from "./diff-surface";

const FILE_ROW_ESTIMATE_PX = 260;
const FILE_ROW_OVERSCAN = 4;
const FILE_LIST_VIRTUALIZE_THRESHOLD = 30;

/** Props for FileList. */
interface FileListProps {
  files: string[];
  source: SelectedFile["source"];
  id: string;
  /** Thread that owns these files, used to scope the inline diff cache. */
  threadId: string;
  /** When true every file entry starts expanded (used for the latest turn). */
  defaultFilesExpanded?: boolean;
  /** Extra identity for mutable comparisons whose ref names can stay stable while content changes. */
  cacheVersion?: string | number;
  /** Whether this comparison can change and exposes manual refresh. */
  refreshable?: boolean;
  /** Whether the parent is retaining settled content while a replacement loads. */
  refreshing?: boolean;
  /** Refresh the complete comparison through the owning Review lifecycle. */
  onRefresh?: () => void;
}

/**
 * Renders the changed files as a flat list of self-describing cards, one per
 * file. Each card header carries the file's full path (dimmed parent +
 * emphasized basename), so no folder-grouping chrome is needed. Sorted
 * alphabetically by path for a stable, scannable order.
 */
export function FileList({
  files,
  source,
  id,
  threadId,
  defaultFilesExpanded = false,
  cacheVersion = 0,
  refreshable = false,
  refreshing = false,
  onRefresh,
}: FileListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [fallbackAnchorIndex, setFallbackAnchorIndex] = useState(0);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<{ path: string; token: number } | null>(null);
  const [highlightTarget, setHighlightTarget] = useState<{ path: string; token: number } | null>(null);
  const jumpTokenRef = useRef(0);
  const handledExternalJumpNonceRef = useRef<number | null>(null);
  const highlightClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => a.localeCompare(b)),
    [files],
  );

  // Report this view's changed-file count so the toolbar can badge it. The
  // active Review view always renders exactly one FileList, so its count is the
  // view's count; clear on unmount so a switching view doesn't show a stale badge.
  const setReviewFileCount = useDiffStore((s) => s.setReviewFileCount);
  useEffect(() => {
    setReviewFileCount(files.length);
    return () => setReviewFileCount(null);
  }, [files.length, setReviewFileCount]);

  // Diff-display controls now live on this bar. Line-wrap is keyed by the active
  // thread (matching the renderers); render mode is global.
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const renderMode = useDiffStore((s) => s.renderMode);
  const setRenderMode = useDiffStore((s) => s.setRenderMode);
  const toggleLineWrap = useDiffStore((s) => s.toggleLineWrap);
  const lineWrap = useDiffStore((s) => (activeThreadId ? s.getLineWrap(activeThreadId) : true));
  const setBulkDiffExpand = useDiffStore((s) => s.setBulkDiffExpand);
  const bulkDiffExpand = useDiffStore((s) => s.bulkDiffExpand);
  const reviewFileJumpRequest = useDiffStore((s) => s.reviewFileJumpRequest);
  // The expand/collapse toggle reflects the last bulk action, falling back to
  // the view's default expand state when none has run yet.
  const allExpanded = bulkDiffExpand?.expand ?? defaultFilesExpanded;
  const shouldVirtualize = sortedFiles.length > FILE_LIST_VIRTUALIZE_THRESHOLD;

  useLayoutEffect(() => {
    const list = listRef.current;
    const viewport = list?.closest<HTMLElement>("[data-slot='scroll-area-viewport']") ?? null;
    const nextScrollElement = viewport ?? list;
    setScrollElement((prev) => (prev === nextScrollElement ? prev : nextScrollElement));
    setScrollMargin((prev) => {
      const next = list?.offsetTop ?? 0;
      return prev === next ? prev : next;
    });
  }, [sortedFiles.length]);

  const virtualizer = useVirtualizer({
    count: sortedFiles.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => FILE_ROW_ESTIMATE_PX,
    getItemKey: (index) => sortedFiles[index] ?? String(index),
    overscan: FILE_ROW_OVERSCAN,
    scrollMargin,
    useFlushSync: false,
  });
  const virtualItems = shouldVirtualize ? virtualizer.getVirtualItems() : [];
  const fileVirtualItems = useMemo(() => {
    if (!shouldVirtualize) return [];
    if (virtualItems.length > 0) return virtualItems;

    const visibleCount = Math.min(
      sortedFiles.length,
      Math.max(1, Math.ceil((scrollElement?.clientHeight ?? 0) / FILE_ROW_ESTIMATE_PX) + FILE_ROW_OVERSCAN * 2),
    );
    const firstIndex = Math.min(
      fallbackAnchorIndex,
      Math.max(0, sortedFiles.length - visibleCount),
    );
    return Array.from({ length: visibleCount }, (_, offset) => {
      const index = firstIndex + offset;
      return {
        index,
        key: sortedFiles[index] ?? String(index),
        start: index * FILE_ROW_ESTIMATE_PX,
      };
    });
  }, [fallbackAnchorIndex, scrollElement?.clientHeight, shouldVirtualize, sortedFiles, virtualItems]);

  // The parent lifecycle owns refresh so the diff and Files publish together.
  const refreshInProgress = refreshing;

  useEffect(() => {
    return () => {
      if (highlightClearRef.current) clearTimeout(highlightClearRef.current);
    };
  }, []);

  const jumpToFile = useCallback((path: string) => {
    const token = ++jumpTokenRef.current;
    const index = sortedFiles.indexOf(path);
    setJumpOpen(false);
    setJumpTarget({ path, token });
    setHighlightTarget({ path, token });
    if (index >= 0) {
      setFallbackAnchorIndex(index);
      virtualizer.scrollToIndex(index, { align: "start" });
    }

    if (highlightClearRef.current) clearTimeout(highlightClearRef.current);
    highlightClearRef.current = setTimeout(() => {
      setHighlightTarget((current) => (current?.token === token ? null : current));
      highlightClearRef.current = null;
    }, 1500);
  }, [sortedFiles, virtualizer]);

  const clearJumpTarget = useCallback((token: number) => {
    setJumpTarget((current) => (current?.token === token ? null : current));
  }, []);

  useEffect(() => {
    if (!reviewFileJumpRequest || reviewFileJumpRequest.scopeId !== threadId) return;
    if (handledExternalJumpNonceRef.current === reviewFileJumpRequest.nonce) return;
    if (!sortedFiles.includes(reviewFileJumpRequest.path)) return;
    handledExternalJumpNonceRef.current = reviewFileJumpRequest.nonce;
    jumpToFile(reviewFileJumpRequest.path);
  }, [jumpToFile, reviewFileJumpRequest, sortedFiles, threadId]);

  if (files.length === 0) {
    return (
      <p className="px-3 py-1 text-[11px] text-muted-foreground">No files changed</p>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-20 flex items-center gap-0.5 bg-background/95 px-2 py-1.5 shadow-[0_8px_12px_-12px_oklch(0_0_0/0.35)] backdrop-blur-sm">
        {/* Diff-display controls: review-options menu, jump, split toggle. The
            changed-file count lives on the toolbar's view switcher, so this bar
            carries only the controls; `ml-auto` keeps the group at the right. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Review options"
            data-testid="review-options-menu"
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 outline-none transition-colors hover:bg-muted/40 hover:text-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
          >
            <MoreHorizontal size={13} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-[190px]">
            {refreshable ? (
              <DropdownMenuItem
                onClick={onRefresh}
                disabled={refreshInProgress}
                data-testid="review-option-refresh"
                className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs"
              >
                <RefreshCw size={13} className={cn("text-muted-foreground", refreshInProgress && "animate-spin")} />
                {refreshInProgress ? "Refreshing" : "Refresh"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={!activeThreadId}
              onClick={() => {
                if (activeThreadId) toggleLineWrap(activeThreadId);
              }}
              data-testid="review-option-word-wrap"
              className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs data-disabled:cursor-not-allowed"
            >
              <WrapText size={13} className="text-muted-foreground" />
              {lineWrap ? "Disable word wrap" : "Enable word wrap"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setBulkDiffExpand(!allExpanded)}
              data-testid="review-option-toggle-all"
              className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs"
            >
              {allExpanded ? (
                <ChevronsDownUp size={13} className="text-muted-foreground" />
              ) : (
                <ChevronsUpDown size={13} className="text-muted-foreground" />
              )}
              {allExpanded ? "Collapse all" : "Expand all"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {refreshInProgress ? (
          <span
            role="status"
            aria-label="Refreshing comparison"
            data-testid="review-refresh-progress"
            className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground/55"
          >
            <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
          </span>
        ) : null}

        <Popover open={jumpOpen} onOpenChange={setJumpOpen}>
          {/* Icon-only trigger; the tooltip carries the description on hover. */}
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Jump to file"
                    data-testid="review-file-jump-trigger"
                    className="h-6 w-6 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground"
                  >
                    <FileSearch size={13} aria-hidden="true" />
                  </Button>
                }
              />
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">
              Jump to file
            </TooltipContent>
          </Tooltip>
          <PopoverContent align="end" sideOffset={6} className="w-[min(360px,calc(100vw-2rem))] p-0">
            <Command className="rounded-lg">
              <CommandInput
                autoFocus
                placeholder="Jump to file"
                aria-label="Jump to file"
                data-testid="review-file-filter"
                className="h-9 font-mono text-[11px]"
              />
              <CommandList className="max-h-72">
                <CommandEmpty>No files found</CommandEmpty>
                <CommandGroup heading="Changed files">
                  {sortedFiles.map((file) => {
                    const basename = getFileBasename(file);
                    const parent = getParentPath(file);
                    return (
                      <CommandItem
                        key={file}
                        value={file}
                        data-testid={`review-file-jump-item-${file}`}
                        onSelect={() => jumpToFile(file)}
                        className="items-start gap-2 px-2 py-2"
                      >
                        <FileTypeIcon filePath={file} size={14} className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[11px] text-foreground/85">
                            {basename}
                          </span>
                          {parent && (
                            <span className="block truncate font-mono text-[10px] text-muted-foreground/65">
                              {parent}/
                            </span>
                          )}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setRenderMode(renderMode === "unified" ? "side-by-side" : "unified")}
                aria-pressed={renderMode === "side-by-side"}
                aria-label={renderMode === "unified" ? "Switch to split view" : "Switch to unified view"}
                className={cn(
                  "h-6 w-6 transition-colors",
                  renderMode === "side-by-side"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground/50 hover:bg-muted/40 hover:text-foreground/70",
                )}
              >
                <Columns2 size={13} />
              </Button>
            }
          />
          <TooltipContent side="bottom" className="text-xs">
            {renderMode === "unified" ? "Switch to split view" : "Switch to unified view"}
          </TooltipContent>
        </Tooltip>
      </div>
      <div
        ref={listRef}
        className={
          shouldVirtualize
            ? `${DIFF_FILE_LIST_PADDING} relative`
            : `flex flex-col gap-2 ${DIFF_FILE_LIST_PADDING}`
        }
        style={shouldVirtualize ? { height: virtualizer.getTotalSize() } : undefined}
      >
        {shouldVirtualize
          ? fileVirtualItems.map((virtualItem) => {
              const file = sortedFiles[virtualItem.index];
              if (!file) return null;
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute left-0 w-full pb-2"
                  style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
                >
                  <FileEntry
                    filePath={file}
                    source={source}
                    id={id}
                    threadId={threadId}
                    defaultExpanded={defaultFilesExpanded}
                    cacheVersion={cacheVersion}
                    jumpToken={jumpTarget?.path === file ? jumpTarget.token : undefined}
                    onJumpSettled={clearJumpTarget}
                    highlightToken={highlightTarget?.path === file ? highlightTarget.token : undefined}
                  />
                </div>
              );
            })
          : sortedFiles.map((file) => (
              <FileEntry
                key={file}
                filePath={file}
                source={source}
                id={id}
                threadId={threadId}
                defaultExpanded={defaultFilesExpanded}
                cacheVersion={cacheVersion}
                jumpToken={jumpTarget?.path === file ? jumpTarget.token : undefined}
                onJumpSettled={clearJumpTarget}
                highlightToken={highlightTarget?.path === file ? highlightTarget.token : undefined}
              />
            ))}
      </div>
    </div>
  );
}

/** Extract the basename from a file path for jump result labels. */
function getFileBasename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

/** Extract the parent path from a file path for jump result labels. */
function getParentPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}
