import type { PullRequestFile, ReviewFileChange } from "@mcode/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  buildPullRequestFileTree,
  flattenPullRequestFileTree,
  type PullRequestFileTreeRow,
} from "@/features/pull-requests/lib/pull-request-file-tree";
import { cn } from "@/lib/utils";
import { PullRequestFileRow } from "./PullRequestFileRow";
import { ReviewFileChangeRow } from "./ReviewFileChangeRow";

const VIRTUALIZATION_THRESHOLD = 30;
const TREE_ROW_HEIGHT = 32;
const TREE_OVERSCAN = 1;
const EMPTY_PULL_REQUEST_FILES: readonly PullRequestFile[] = [];
const EMPTY_REVIEW_FILE_CHANGES: readonly ReviewFileChange[] = [];

interface OverflowPathLabelProps {
  label: string;
  path: string;
}

function OverflowPathLabel({ label, path }: OverflowPathLabelProps) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const labelNode = labelRef.current;
    if (!labelNode) return;
    const measure = (): void => {
      setOverflowing(labelNode.scrollWidth > labelNode.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(labelNode);
    return () => observer.disconnect();
  }, [label]);

  return (
    <Tooltip disabled={!overflowing}>
      <TooltipTrigger
        render={
          <span ref={labelRef} className="min-w-0 truncate">
            {label}
          </span>
        }
      />
      <TooltipContent
        side="left"
        align="start"
        variant="surface"
        className="max-w-72 break-all whitespace-normal text-left font-mono leading-relaxed"
      >
        {path}
      </TooltipContent>
    </Tooltip>
  );
}

function collectDirectoryIds(
  nodes: ReturnType<typeof buildPullRequestFileTree>,
): Set<string> {
  const ids = new Set<string>();
  const visit = (
    children: ReturnType<typeof buildPullRequestFileTree>,
  ): void => {
    for (const child of children) {
      if (child.kind !== "directory") continue;
      ids.add(child.id);
      visit(child.children);
    }
  };
  visit(nodes);
  return ids;
}

/** Props for the virtual, keyboard-navigable pull request file tree. */
interface FileTreeBaseProps {
  activePath: string | null;
  searchActive?: boolean;
  className?: string;
  ariaLabel?: string;
  onActivate: (path: string) => void;
}

/** Props for the virtual, keyboard-navigable path tree. */
export type PullRequestFileTreeProps = FileTreeBaseProps &
  (
    | { files: readonly PullRequestFile[]; filePaths?: never; reviewFiles?: never }
    | { files?: never; filePaths: readonly string[]; reviewFiles?: never }
    | { files?: never; filePaths?: never; reviewFiles: readonly ReviewFileChange[] }
  );

/** Virtual path tree and jump index for the loaded pull request Change stack. */
export function PullRequestFileTree(props: PullRequestFileTreeProps) {
  const {
    activePath,
    searchActive = false,
    className,
    ariaLabel = "Pull request changed files",
    onActivate,
  } = props;
  const files =
    "files" in props && props.files ? props.files : EMPTY_PULL_REQUEST_FILES;
  const providedFilePaths =
    "filePaths" in props && props.filePaths ? props.filePaths : undefined;
  const reviewFiles =
    "reviewFiles" in props && props.reviewFiles
      ? props.reviewFiles
      : EMPTY_REVIEW_FILE_CHANGES;
  const filePaths = useMemo(
    () => providedFilePaths ?? (reviewFiles.length > 0 ? reviewFiles : files).map((file) => file.path),
    [files, providedFilePaths, reviewFiles],
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const tree = useMemo(
    () => buildPullRequestFileTree(filePaths),
    [filePaths],
  );
  const filesByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  const reviewFilesByPath = useMemo(
    () => new Map(reviewFiles.map((file) => [file.path, file])),
    [reviewFiles],
  );
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(
    () => new Set(),
  );
  const userCollapsedDirectoryIdsRef = useRef(new Set<string>());
  const rows = useMemo(
    () => flattenPullRequestFileTree(tree, expandedDirectoryIds, searchActive),
    [expandedDirectoryIds, searchActive, tree],
  );
  const activeRowId = activePath ? `file:${activePath}` : null;
  const [focusedId, setFocusedId] = useState<string | null>(activeRowId);
  const virtualized = rows.length > VIRTUALIZATION_THRESHOLD;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => TREE_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.node.id ?? index,
    overscan: TREE_OVERSCAN,
    useFlushSync: false,
  });
  const virtualRows = virtualized ? virtualizer.getVirtualItems() : [];
  const focusedRowMounted = virtualized
    ? virtualRows.some(
        (virtualRow) => rows[virtualRow.index]?.node.id === focusedId,
      )
    : rows.some((row) => row.node.id === focusedId);

  useEffect(() => {
    const directoryIds = collectDirectoryIds(tree);
    setExpandedDirectoryIds((current) => {
      const next = new Set([...current].filter((id) => directoryIds.has(id)));
      for (const id of directoryIds) {
        if (!userCollapsedDirectoryIdsRef.current.has(id)) next.add(id);
      }
      if (
        next.size === current.size &&
        [...next].every((id) => current.has(id))
      ) {
        return current;
      }
      return next;
    });
  }, [tree]);

  useEffect(() => {
    if (focusedId && rows.some((row) => row.node.id === focusedId)) return;
    setFocusedId(activeRowId ?? rows[0]?.node.id ?? null);
  }, [activeRowId, focusedId, rows]);

  useEffect(() => {
    if (!activePath || searchActive) return;
    const segments = activePath.split("/");
    if (segments.length <= 1) return;
    setExpandedDirectoryIds((current) => {
      const next = new Set(current);
      for (let index = 1; index < segments.length; index += 1) {
        const id = `directory:${segments.slice(0, index).join("/")}`;
        userCollapsedDirectoryIdsRef.current.delete(id);
        next.add(id);
      }
      return next.size === current.size ? current : next;
    });
  }, [activePath, searchActive]);

  const focusIndex = (index: number): void => {
    const boundedIndex = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[boundedIndex];
    if (!row) return;
    setFocusedId(row.node.id);
    if (virtualized) virtualizer.scrollToIndex(boundedIndex, { align: "auto" });
    const mountedRow = rowRefs.current.get(row.node.id);
    if (mountedRow) {
      mountedRow.focus();
      return;
    }
    requestAnimationFrame(() => rowRefs.current.get(row.node.id)?.focus());
  };

  const toggleDirectory = (id: string): void => {
    setExpandedDirectoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        userCollapsedDirectoryIdsRef.current.add(id);
      } else {
        next.add(id);
        userCollapsedDirectoryIdsRef.current.delete(id);
      }
      return next;
    });
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    row: PullRequestFileTreeRow,
    index: number,
  ): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusIndex(index + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusIndex(index - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusIndex(rows.length - 1);
      return;
    }
    if (event.key === "ArrowRight") {
      if (row.node.kind === "directory") {
        event.preventDefault();
        if (!expandedDirectoryIds.has(row.node.id))
          toggleDirectory(row.node.id);
        else focusIndex(index + 1);
      } else {
        onActivate(row.node.path);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (
        row.node.kind === "directory" &&
        expandedDirectoryIds.has(row.node.id)
      ) {
        toggleDirectory(row.node.id);
        return;
      }
      if (!row.node.parentId) return;
      const parentIndex = rows.findIndex(
        (candidate) => candidate.node.id === row.node.parentId,
      );
      if (parentIndex >= 0) focusIndex(parentIndex);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (row.node.kind === "directory") toggleDirectory(row.node.id);
    else onActivate(row.node.path);
  };

  const renderRow = (row: PullRequestFileTreeRow, index: number) => {
    if (row.node.kind === "file") {
      const item = filesByPath.get(row.node.path);
      const reviewFile = reviewFilesByPath.get(row.node.path);
      return item ? (
        <PullRequestFileRow
          file={item}
          active={item.path === activePath}
          depth={row.depth}
          positionInSet={row.positionInSet}
          setSize={row.setSize}
          tabIndex={focusedId === row.node.id ? 0 : -1}
          buttonRef={(node) => {
            if (node) rowRefs.current.set(row.node.id, node);
            else rowRefs.current.delete(row.node.id);
          }}
          onActivate={onActivate}
          onFocus={() => setFocusedId(row.node.id)}
          onKeyDown={(event) => handleKeyDown(event, row, index)}
        />
      ) : reviewFile ? (
        <ReviewFileChangeRow
          file={reviewFile}
          active={reviewFile.path === activePath}
          depth={row.depth}
          positionInSet={row.positionInSet}
          setSize={row.setSize}
          tabIndex={focusedId === row.node.id ? 0 : -1}
          buttonRef={(node) => {
            if (node) rowRefs.current.set(row.node.id, node);
            else rowRefs.current.delete(row.node.id);
          }}
          onActivate={onActivate}
          onFocus={() => setFocusedId(row.node.id)}
          onKeyDown={(event) => handleKeyDown(event, row, index)}
        />
      ) : (
        <Button
          type="button"
          role="treeitem"
          variant="ghost"
          size="sm"
          tabIndex={focusedId === row.node.id ? 0 : -1}
          aria-label={row.node.path}
          aria-level={row.depth}
          aria-posinset={row.positionInSet}
          aria-setsize={row.setSize}
          aria-selected={row.node.path === activePath}
          ref={(node) => {
            if (node) rowRefs.current.set(row.node.id, node);
            else rowRefs.current.delete(row.node.id);
          }}
          title={row.node.path}
          className={cn(
            "mx-1 h-8 w-[calc(100%-0.5rem)] justify-start gap-1.5 rounded-md px-2 font-mono text-xs font-normal",
            row.node.path === activePath
              ? "bg-muted/70 text-foreground"
              : "text-foreground/75 hover:bg-muted/40",
          )}
          style={{ paddingLeft: `${Math.max(8, row.depth * 12 - 4)}px` }}
          onClick={() => onActivate(row.node.path)}
          onFocus={() => setFocusedId(row.node.id)}
          onKeyDown={(event) => handleKeyDown(event, row, index)}
        >
          <FileTypeIcon filePath={row.node.path} size={14} />
          <OverflowPathLabel label={row.node.name} path={row.node.path} />
        </Button>
      );
    }

    const expanded = searchActive || expandedDirectoryIds.has(row.node.id);
    return (
      <Button
        type="button"
        role="treeitem"
        variant="ghost"
        size="sm"
        tabIndex={focusedId === row.node.id ? 0 : -1}
        aria-level={row.depth}
        aria-posinset={row.positionInSet}
        aria-setsize={row.setSize}
        aria-expanded={expanded}
        ref={(node) => {
          if (node) rowRefs.current.set(row.node.id, node);
          else rowRefs.current.delete(row.node.id);
        }}
        className="mx-1 h-8 w-[calc(100%-0.5rem)] justify-start gap-1 rounded-md px-2 font-mono text-xs font-medium text-muted-foreground aria-expanded:bg-transparent hover:bg-muted/40 hover:text-foreground"
        style={{ paddingLeft: `${Math.max(8, row.depth * 12 - 4)}px` }}
        onClick={() => toggleDirectory(row.node.id)}
        onFocus={() => setFocusedId(row.node.id)}
        onKeyDown={(event) => handleKeyDown(event, row, index)}
      >
        {expanded ? (
          <ChevronDown size={11} aria-hidden />
        ) : (
          <ChevronRight size={11} aria-hidden />
        )}
        {expanded ? (
          <FolderOpen
            size={12}
            aria-hidden
            className="text-muted-foreground/80"
          />
        ) : (
          <Folder size={12} aria-hidden />
        )}
        <OverflowPathLabel label={row.node.name} path={row.node.path} />
      </Button>
    );
  };

  return (
    <ScrollArea
      className={cn("min-h-0", className)}
      viewportRef={viewportRef}
      viewportProps={{
        role: "tree",
        "aria-label": ariaLabel,
        tabIndex: rows.length === 0 || !focusedRowMounted ? 0 : -1,
        onFocus: (event) => {
          if (event.target !== event.currentTarget || rows.length === 0) return;
          const fallback = virtualized
            ? rows[virtualRows[0]?.index ?? 0]
            : (rows.find((row) => row.node.id === focusedId) ?? rows[0]);
          if (!fallback) return;
          setFocusedId(fallback.node.id);
          requestAnimationFrame(() =>
            rowRefs.current.get(fallback.node.id)?.focus(),
          );
        },
      }}
    >
      {rows.length === 0 ? (
        <p className="px-3 py-8 text-center text-xs text-muted-foreground">
          No changed files match this view.
        </p>
      ) : virtualized ? (
        <div
          className="relative w-full"
          style={{
            height: virtualizer.getTotalSize(),
            contain: "layout paint style",
          }}
        >
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRow(row, virtualRow.index)}
              </div>
            );
          })}
        </div>
      ) : (
        <div>
          {rows.map((row, index) => (
            <div key={row.node.id}>{renderRow(row, index)}</div>
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
