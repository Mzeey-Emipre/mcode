import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HunkSeparator } from "@/components/diff/HunkSeparator";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePullRequestDiffHighlighter } from "@/features/pull-requests/hooks/usePullRequestDiffHighlighter";
import { useShikiTheme } from "@/hooks/useTheme";
import {
  getPullRequestDiffCell,
  getPullRequestDiffCellKey,
  getPullRequestFocusableCellKeys,
  getPullRequestHunkTargets,
  type PullRequestDiffCell,
  type PullRequestDiffFileRow,
  type PullRequestDiffLineRow,
  type PullRequestDiffRow,
} from "@/features/pull-requests/lib/pull-request-diff-row-model";
import { cn } from "@/lib/utils";
import type { PullRequestReviewThread } from "@mcode/contracts";
import { PullRequestInlineThread } from "./PullRequestInlineThread";

const DIFF_ROW_ESTIMATE_PX = 28;
const DIFF_ROW_OVERSCAN = 3;

/** Props for the single row-major pull request diff virtualizer. */
export interface PullRequestVirtualDiffProps {
  rows: readonly PullRequestDiffRow[];
  mode: "unified" | "split";
  isNarrow: boolean;
  activePath: string | null;
  onToggleFile: (fileRow: PullRequestDiffFileRow) => void;
  onActivePathChange: (path: string) => void;
  onCreateDraft: (
    row: PullRequestDiffLineRow,
    cell: PullRequestDiffCell,
  ) => void;
  onCreateReply: (
    thread: PullRequestReviewThread,
    originLineKey: string | null,
  ) => void;
  onUpdateDraft: (localId: string, body: string) => boolean;
  onRemoveDraft: (localId: string) => void;
  onTokenBytesChange: (path: string, bytes: number) => boolean;
  onReloadPatch: (path: string) => void;
  /** Reports changed-file paths represented by the current virtual viewport. */
  onVisiblePathsChange?: (paths: readonly string[]) => void;
}

function renderedUnifiedCells(
  row: PullRequestDiffLineRow,
): PullRequestDiffCell[] {
  const cells: PullRequestDiffCell[] = [];
  const left = getPullRequestDiffCell(row, "left");
  const right = getPullRequestDiffCell(row, "right");
  if (left.type === "remove" || left.type === "metadata") {
    cells.push(left);
  }
  if (right.type !== "empty") {
    cells.push(right);
  } else if (left.type !== "empty" && cells.length === 0) {
    cells.push(left);
  }
  return cells;
}

function cellTone(cell: PullRequestDiffCell): string {
  if (cell.type === "add") {
    return "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]";
  }
  if (cell.type === "remove") {
    return "bg-[var(--diff-remove-bg)] text-[var(--diff-remove-text)]";
  }
  if (cell.type === "empty") return "bg-muted/[0.04] text-muted-foreground";
  if (cell.type === "metadata") return "bg-page/75 text-muted-foreground";
  return "text-foreground/75 hover:bg-muted/[0.08]";
}

function FileRow({
  row,
  active,
  focusActive,
  onToggle,
  onFocusActive,
  onMoveFocus,
}: {
  row: PullRequestDiffFileRow;
  active: boolean;
  focusActive: boolean;
  onToggle: (row: PullRequestDiffFileRow) => void;
  onFocusActive: (key: string) => void;
  onMoveFocus: (key: string, delta: -1 | 1) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-expanded={row.expanded}
      data-diff-focus-key={row.key}
      tabIndex={focusActive ? 0 : -1}
      className={cn(
        "h-10 w-full justify-start rounded-none border-y border-border/35 bg-background/75 px-3 text-left font-normal hover:bg-muted/30",
        active && "bg-muted/50",
      )}
      onFocus={() => onFocusActive(row.key)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        onMoveFocus(row.key, event.key === "ArrowDown" ? 1 : -1);
      }}
      onClick={() => onToggle(row)}
    >
      {row.expanded ? (
        <ChevronDown
          size={13}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
      ) : (
        <ChevronRight
          size={13}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
      )}
      <FileTypeIcon filePath={row.file.path} size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
        {row.file.path}
      </span>
      {row.file.previousPath && (
        <span className="hidden max-w-56 truncate font-mono text-xs text-muted-foreground lg:inline">
          from {row.file.previousPath}
        </span>
      )}
      <Badge
        variant="ghost"
        size="sm"
        className="shrink-0 capitalize text-muted-foreground"
      >
        {row.file.changeType}
      </Badge>
      {row.file.additions > 0 ? (
        <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--diff-add-strong)]">
          +{row.file.additions}
        </span>
      ) : null}
      {row.file.deletions > 0 ? (
        <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--diff-remove-strong)]">
          −{row.file.deletions}
        </span>
      ) : null}
      {(row.threadCount > 0 || row.draftCount > 0) && (
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {row.threadCount + row.draftCount} notes
        </span>
      )}
    </Button>
  );
}

interface DiffCellProps {
  row: PullRequestDiffLineRow;
  cell: PullRequestDiffCell;
  active: boolean;
  split: boolean;
  semanticRole: "gridcell" | "group";
  tokens: ReturnType<typeof usePullRequestDiffHighlighter>["getLineTokens"];
  truncated: boolean;
  onActivate: (row: PullRequestDiffLineRow, cell: PullRequestDiffCell) => void;
  onKeyDown: (
    event: KeyboardEvent<HTMLDivElement>,
    row: PullRequestDiffLineRow,
    cell: PullRequestDiffCell,
  ) => void;
  onCreateDraft: (
    row: PullRequestDiffLineRow,
    cell: PullRequestDiffCell,
  ) => void;
}

const DiffCell = memo(function DiffCell({
  row,
  cell,
  active,
  split,
  semanticRole,
  tokens: getTokens,
  truncated,
  onActivate,
  onKeyDown,
  onCreateDraft,
}: DiffCellProps) {
  const tokenSpans = getTokens(cell.key);
  const highlightedLength =
    tokenSpans?.reduce((length, token) => length + token.content.length, 0) ??
    0;
  const trailingText = truncated ? cell.content.slice(highlightedLength) : "";
  const lineLabel =
    cell.lineNumber === null
      ? "Patch metadata"
      : `${cell.side === "left" ? "Original" : "Current"} line ${cell.lineNumber}`;
  const changeLabel =
    cell.type === "add" ? "Added" : cell.type === "remove" ? "Removed" : null;
  const changeMarker =
    cell.type === "add" ? "+" : cell.type === "remove" ? "−" : "";

  return (
    <div
      role={semanticRole}
      aria-label={`${changeLabel ? `${changeLabel} ` : ""}${lineLabel}: ${cell.content}`}
      aria-keyshortcuts="C"
      data-line-key={cell.key}
      data-diff-focus-key={cell.key}
      data-line-side={cell.side}
      tabIndex={active ? 0 : -1}
      className={cn(
        "group/cell relative flex min-h-7 min-w-0 items-stretch font-mono text-xs outline-none",
        cellTone(cell),
        split && "min-w-0 flex-1",
        active && "ring-1 ring-inset ring-primary/70",
      )}
      onFocus={() => onActivate(row, cell)}
      onClick={() => onActivate(row, cell)}
      onKeyDown={(event) => onKeyDown(event, row, cell)}
    >
      {cell.lineNumber !== null && cell.type !== "metadata" && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          tabIndex={-1}
          aria-label={`Draft comment on ${lineLabel.toLowerCase()}`}
          className={cn(
            "pointer-events-none absolute left-0.5 top-0.5 z-10 size-6 rounded-md bg-foreground text-background opacity-0 shadow-none transition-opacity duration-100 hover:bg-foreground hover:text-background dark:hover:bg-foreground group-hover/cell:pointer-events-auto group-hover/cell:opacity-100 group-focus-within/cell:pointer-events-auto group-focus-within/cell:opacity-100 motion-reduce:transition-none",
            active && "pointer-events-auto opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onCreateDraft(row, cell);
          }}
        >
          <Plus className="size-4" strokeWidth={2.5} aria-hidden />
        </Button>
      )}
      <span
        aria-hidden
        data-testid="pull-request-diff-gutter"
        className="inline-grid w-10 shrink-0 select-none grid-cols-[0.75rem_1fr] items-center bg-page/35 pr-1.5 tabular-nums text-muted-foreground/70"
      >
        <span className="text-center text-current">{changeMarker}</span>
        <span className="text-right">{cell.lineNumber ?? ""}</span>
      </span>
      <code className="min-w-0 flex-1 whitespace-pre px-2 py-1 leading-5">
        {tokenSpans
          ? tokenSpans.map((token, index) => (
              <span
                key={`${token.content}:${index}`}
                style={{ color: token.color }}
              >
                {token.content}
              </span>
            ))
          : cell.content}
        {trailingText}
      </code>
    </div>
  );
});

DiffCell.displayName = "DiffCell";

function gridCell(children: ReactNode, className?: string): ReactNode {
  return (
    <div role="gridcell" className={className}>
      {children}
    </div>
  );
}

function PullRequestVirtualDiffComponent({
  rows,
  mode,
  isNarrow,
  activePath,
  onToggleFile,
  onActivePathChange,
  onCreateDraft,
  onCreateReply,
  onUpdateDraft,
  onRemoveDraft,
  onTokenBytesChange,
  onReloadPatch,
  onVisiblePathsChange,
}: PullRequestVirtualDiffProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const effectiveMode = isNarrow ? "unified" : mode;
  const focusableKeys = useMemo(() => {
    const keys: string[] = [];
    for (const row of rows) {
      if (row.kind === "file") {
        keys.push(row.key);
      } else if (row.kind === "line") {
        keys.push(...getPullRequestFocusableCellKeys([row], effectiveMode));
      }
    }
    return keys;
  }, [effectiveMode, rows]);
  const [activeFocusKey, setActiveFocusKey] = useState<string | null>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row?.kind === "file") return 40;
      if (row?.kind === "inline") return 160;
      if (row?.kind === "notice") return 44;
      if (row?.kind === "hunk") {
        return row.hiddenLineCount > 0 ? DIFF_ROW_ESTIMATE_PX : 0;
      }
      if (
        row?.kind === "line" &&
        effectiveMode === "unified" &&
        (row.leftType === "remove" || row.leftType === "metadata") &&
        row.rightType !== "empty"
      ) {
        return DIFF_ROW_ESTIMATE_PX * 2;
      }
      return DIFF_ROW_ESTIMATE_PX;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: DIFF_ROW_OVERSCAN,
    useFlushSync: false,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visiblePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const item of virtualItems) {
      const row = rows[item.index];
      if (!row) continue;
      if (row.kind === "file") paths.add(row.file.path);
      else if ("path" in row && typeof row.path === "string")
        paths.add(row.path);
    }
    return [...paths];
  }, [rows, virtualItems]);
  useEffect(() => {
    onVisiblePathsChange?.(visiblePaths);
  }, [onVisiblePathsChange, visiblePaths]);
  const visibleRange = useMemo(() => {
    if (virtualItems.length === 0) return { startIndex: 0, endIndex: -1 };
    return {
      startIndex: virtualItems[0].index,
      endIndex: virtualItems[virtualItems.length - 1].index,
    };
  }, [virtualItems]);
  const theme = useShikiTheme();
  const highlighted = usePullRequestDiffHighlighter(rows, visibleRange, theme, {
    onTokenBytesChange,
  });
  const hunkTargets = useMemo(
    () => getPullRequestHunkTargets(rows, effectiveMode),
    [effectiveMode, rows],
  );
  const cellRowIndex = useMemo(() => {
    const index = new Map<string, number>();
    rows.forEach((row, rowIndex) => {
      if (row.kind !== "line") return;
      index.set(getPullRequestDiffCellKey(row, "left"), rowIndex);
      index.set(getPullRequestDiffCellKey(row, "right"), rowIndex);
    });
    return index;
  }, [rows]);
  const mountedFocusKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of virtualItems) {
      const row = rows[item.index];
      if (row?.kind === "file") keys.add(row.key);
      if (row?.kind === "line") {
        for (const key of getPullRequestFocusableCellKeys(
          [row],
          effectiveMode,
        )) {
          keys.add(key);
        }
      }
    }
    return keys;
  }, [effectiveMode, rows, virtualItems]);
  const mountedFallbackKey = useMemo(() => {
    for (const item of virtualItems) {
      const row = rows[item.index];
      if (row?.kind === "file") return row.key;
      if (row?.kind === "line") {
        const keys = getPullRequestFocusableCellKeys([row], effectiveMode);
        if (keys[0]) return keys[0];
      }
    }
    return null;
  }, [effectiveMode, rows, virtualItems]);
  const activeFocusMounted =
    activeFocusKey !== null && mountedFocusKeys.has(activeFocusKey);

  useEffect(() => {
    setActiveFocusKey((current) => {
      if (current && focusableKeys.includes(current)) return current;
      if (activePath) {
        const pathRow = rows.find(
          (row) =>
            row.kind === "line" &&
            row.path === activePath &&
            getPullRequestFocusableCellKeys([row], effectiveMode).length > 0,
        );
        if (pathRow?.kind === "line") {
          return (
            getPullRequestFocusableCellKeys([pathRow], effectiveMode)[0] ?? null
          );
        }
        const fileRow = rows.find(
          (row) => row.kind === "file" && row.file.path === activePath,
        );
        if (fileRow?.kind === "file") return fileRow.key;
      }
      return focusableKeys[0] ?? null;
    });
  }, [activePath, effectiveMode, focusableKeys, rows]);

  const focusItem = useCallback(
    (focusKey: string | null): void => {
      if (!focusKey) return;
      setActiveFocusKey(focusKey);
      const rowIndex =
        cellRowIndex.get(focusKey) ??
        rows.findIndex((row) => row.key === focusKey);
      if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "auto" });
      requestAnimationFrame(() => {
        const elements = viewportRef.current?.querySelectorAll<HTMLElement>(
          "[data-diff-focus-key]",
        );
        const target = elements
          ? [...elements].find(
              (element) => element.dataset.diffFocusKey === focusKey,
            )
          : undefined;
        target?.focus();
      });
    },
    [cellRowIndex, rows, virtualizer],
  );

  const moveFocus = useCallback(
    (focusKey: string, delta: -1 | 1): void => {
      const currentIndex = focusableKeys.indexOf(focusKey);
      if (currentIndex < 0) return;
      const nextIndex = Math.max(
        0,
        Math.min(focusableKeys.length - 1, currentIndex + delta),
      );
      focusItem(focusableKeys[nextIndex] ?? null);
    },
    [focusItem, focusableKeys],
  );

  const activateCell = useCallback(
    (row: PullRequestDiffLineRow, cell: PullRequestDiffCell) => {
      setActiveFocusKey(cell.key);
      onActivePathChange(row.path);
    },
    [onActivePathChange],
  );

  const handleLineKeyDown = useCallback(
    (
      event: KeyboardEvent<HTMLDivElement>,
      row: PullRequestDiffLineRow,
      cell: PullRequestDiffCell,
    ) => {
      if (
        event.key.toLowerCase() === "c" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        onCreateDraft(row, cell);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        moveFocus(cell.key, delta);
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k") return;
      event.preventDefault();
      const currentRowIndex = cellRowIndex.get(cell.key) ?? 0;
      const target =
        key === "j"
          ? hunkTargets.find(
              (candidate) => candidate.rowIndex > currentRowIndex,
            )
          : [...hunkTargets]
              .reverse()
              .find((candidate) => candidate.rowIndex < currentRowIndex);
      if (target) focusItem(target.cellKey);
    },
    [cellRowIndex, focusItem, hunkTargets, moveFocus, onCreateDraft],
  );

  const renderRow = (row: PullRequestDiffRow): ReactNode => {
    if (row.kind === "file") {
      return gridCell(
        <FileRow
          row={row}
          active={row.file.path === activePath}
          focusActive={activeFocusKey === row.key}
          onToggle={onToggleFile}
          onFocusActive={setActiveFocusKey}
          onMoveFocus={moveFocus}
        />,
      );
    }
    if (row.kind === "hunk") {
      return gridCell(
        row.hiddenLineCount > 0 ? (
          <HunkSeparator hiddenLineCount={row.hiddenLineCount} />
        ) : (
          <div aria-hidden className="h-0 overflow-hidden" />
        ),
      );
    }
    if (row.kind === "notice") {
      return gridCell(
        <div className="flex items-center gap-2 bg-background/45 px-4 py-2 text-xs text-muted-foreground">
          <p role="status" className="min-w-0 flex-1">
            {row.message}
          </p>
          {(row.state === "evicted" || row.state === "error") && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0 rounded-none"
              onClick={() => onReloadPatch(row.path)}
            >
              {row.state === "error" ? "Retry patch" : "Load patch again"}
            </Button>
          )}
        </div>,
      );
    }
    if (row.kind === "inline") {
      return gridCell(
        <PullRequestInlineThread
          row={row}
          onCreateReply={onCreateReply}
          onUpdateDraft={onUpdateDraft}
          onRemoveDraft={onRemoveDraft}
          onRestoreFocus={focusItem}
        />,
      );
    }
    if (effectiveMode === "split") {
      const left = getPullRequestDiffCell(row, "left");
      const right = getPullRequestDiffCell(row, "right");
      return (
        <>
          <DiffCell
            row={row}
            cell={left}
            active={activeFocusKey === left.key}
            split
            semanticRole="gridcell"
            tokens={highlighted.getLineTokens}
            truncated={highlighted.truncatedLineKeys.has(left.key)}
            onActivate={activateCell}
            onKeyDown={handleLineKeyDown}
            onCreateDraft={onCreateDraft}
          />
          <DiffCell
            row={row}
            cell={right}
            active={activeFocusKey === right.key}
            split
            semanticRole="gridcell"
            tokens={highlighted.getLineTokens}
            truncated={highlighted.truncatedLineKeys.has(right.key)}
            onActivate={activateCell}
            onKeyDown={handleLineKeyDown}
            onCreateDraft={onCreateDraft}
          />
        </>
      );
    }
    return (
      <div role="gridcell" className="min-w-0">
        {renderedUnifiedCells(row).map((cell) => (
          <DiffCell
            key={cell.key}
            row={row}
            cell={cell}
            active={activeFocusKey === cell.key}
            split={false}
            semanticRole="group"
            tokens={highlighted.getLineTokens}
            truncated={highlighted.truncatedLineKeys.has(cell.key)}
            onActivate={activateCell}
            onKeyDown={handleLineKeyDown}
            onCreateDraft={onCreateDraft}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-view-mode={effectiveMode}
    >
      {isNarrow && mode === "split" && (
        <p
          role="status"
          className="bg-page/65 px-3 py-2 text-xs text-muted-foreground"
        >
          Split view needs a wider pane. Showing unified diff.
        </p>
      )}
      <ScrollArea
        className="min-h-0 flex-1"
        viewportRef={viewportRef}
        viewportProps={{
          "aria-label": "Pull request diff viewport",
          tabIndex: !activeFocusMounted ? 0 : -1,
          onFocus: (event) => {
            if (event.target !== event.currentTarget) return;
            focusItem(mountedFallbackKey);
          },
        }}
      >
        {rows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <span
              aria-hidden
              className="font-mono text-lg text-muted-foreground/40"
            >
              ∅
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              No files selected
            </p>
          </div>
        ) : (
          <div
            role="grid"
            aria-label="Pull request diff"
            aria-rowcount={rows.length}
            aria-colcount={effectiveMode === "split" ? 2 : 1}
            className="relative min-w-full w-max"
            style={{
              height: virtualizer.getTotalSize(),
              contain: "layout paint style",
            }}
          >
            {virtualItems.map((virtualItem) => {
              const row = rows[virtualItem.index];
              if (!row) return null;
              return (
                <div
                  key={virtualItem.key}
                  ref={
                    row.kind === "inline" || row.kind === "notice"
                      ? virtualizer.measureElement
                      : undefined
                  }
                  role="row"
                  aria-rowindex={virtualItem.index + 1}
                  data-index={virtualItem.index}
                  data-row-key={row.key}
                  className={cn(
                    "absolute left-0 top-0 min-w-full",
                    effectiveMode === "split" && row.kind === "line" && "flex",
                  )}
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {renderRow(row)}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/** One measured virtual diff engine shared by unified and split presentation. */
export const PullRequestVirtualDiff = memo(PullRequestVirtualDiffComponent);

PullRequestVirtualDiff.displayName = "PullRequestVirtualDiff";
