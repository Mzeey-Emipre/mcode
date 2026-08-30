import { memo, useState, useEffect, useRef, useMemo, useId } from "react";
import { ChevronsDownUp, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDiffStore, type SelectedFile } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";
import { parseDiffLines, isMarkdownFile, getLeadingHiddenLineCount } from "@/lib/diff-parser";
import { loadFileDiff } from "@/lib/load-file-diff";
import { parseFirstHunkLine } from "@/lib/parse-first-hunk-line";
import { langFromPath } from "@/lib/lang-from-path";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { UnifiedDiff } from "./UnifiedDiff";
import { SideBySideDiff } from "./SideBySideDiff";
import { DiffPreview } from "./DiffPreview";
import { FileActionBar } from "./FileActionBar";
import { DiffStat } from "./DiffStat";

/** Props for FileEntry. */
interface FileEntryProps {
  filePath: string;
  source: SelectedFile["source"];
  id: string;
  /** Thread that owns this file, used to scope the inline diff cache. */
  threadId: string;
  /** When true the diff starts expanded on mount and after its diff identity changes. */
  defaultExpanded?: boolean;
  /** Extra identity for mutable comparisons whose visible id can stay stable. */
  cacheVersion?: string | number;
  /** Changes when search/jump asks this row to open and scroll into view. */
  jumpToken?: number;
  /** Clears the active jump once this row has scrolled into view. */
  onJumpSettled?: (token: number) => void;
  /** Changes when this row should show the jump confirmation highlight. */
  highlightToken?: number;
}

/** Extract the basename from a file path. */
function getFileBasename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

/**
 * Number of lines shown initially for large diffs before truncation.
 * Diffs with more than LARGE_DIFF_THRESHOLD lines start truncated.
 */
const LARGE_DIFF_THRESHOLD = 200;
const INITIAL_LINES_SHOWN = 100;

/**
 * Pixels reserved above a jumped-to file so it lands just below the sticky
 * FileList jump bar (and the file's own sticky header) rather than tucked
 * underneath it. Matches the `top-10` sticky offset used on the headers.
 */
const JUMP_STICKY_OFFSET = 40;

/**
 * Diff loading state.
 * null = not yet started; { loading: true } = in-flight; { loading: false; data } = settled.
 */
type DiffState = null | { loading: true } | { loading: false; data: string };

/**
 * Single file row with an inline expandable diff.
 * Clicking toggles the diff open/closed directly below the filename.
 * Diff is loaded lazily on the first expand, or immediately for auto-opened views.
 * Large diffs (>200 lines) are truncated with a "Show all N lines" button.
 */
export const FileEntry = memo(function FileEntry({
  filePath,
  source,
  id,
  threadId,
  defaultExpanded: defaultExpandedProp = false,
  cacheVersion = 0,
  jumpToken,
  onJumpSettled,
  highlightToken,
}: FileEntryProps) {
  const contentId = useId();
  // Bulk commands live in global Review state so rows mounted later by
  // virtualization inherit the user's last expand/collapse choice.
  const bulkDiffExpand = useDiffStore((s) => s.bulkDiffExpand);
  const [expanded, setExpanded] = useState(() => bulkDiffExpand?.expand ?? defaultExpandedProp);
  const [showAllLines, setShowAllLines] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [jumpHighlight, setJumpHighlight] = useState(false);
  const cacheKey = `${threadId}:${source}:${id}:${filePath}`;
  // Initialise from the Zustand cache so diffs survive panel close/reopen.
  const cachedDiff = useDiffStore((s) => s.inlineDiffCache[cacheKey]);
  const [diffState, setDiffState] = useState<DiffState>(
    () => (cachedDiff !== undefined ? { loading: false, data: cachedDiff } : null),
  );
  const renderMode = useDiffStore((s) => s.renderMode);
  // True only on the render where the user toggled unified<->split. The diff
  // body keys its settle-in off this so the motion fires on the mode swap, never
  // on first expand or diff load. The ref is committed after each render below.
  const prevRenderModeRef = useRef(renderMode);
  const isModeSwap = prevRenderModeRef.current !== renderMode;
  // Tracks whether a load has been kicked off in this effect lifecycle.
  // Reset in cleanup so React StrictMode's second invocation can start a
  // fresh, non-cancelled fetch (the first is cancelled by cleanup).
  const loadStartedRef = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);
  // The jump token already scrolled for, so a later diff-load re-render of the
  // same jump doesn't re-trigger the scroll.
  const scrolledJumpRef = useRef<number | undefined>(undefined);
  // Bulk expand/collapse command from the Review-options menu. The ref tracks the
  // last nonce we applied so we react only to new commands, never on mount.
  const appliedBulkRef = useRef(bulkDiffExpand?.nonce);

  // Reset local state when the cache identity changes so a reused component
  // instance doesn't show stale content from a previous identity.
  useEffect(() => {
    const cached = useDiffStore.getState().inlineDiffCache[cacheKey];
    setDiffState(cached !== undefined ? { loading: false, data: cached } : null);
    setShowAllLines(false);
    setPreviewMode(false);
    loadStartedRef.current = false;
  }, [cacheKey, cacheVersion]);

  useEffect(() => {
    if (defaultExpandedProp) setExpanded(true);
  }, [cacheKey, cacheVersion, defaultExpandedProp]);

  // Apply a bulk expand/collapse command once per nonce.
  useEffect(() => {
    if (!bulkDiffExpand || appliedBulkRef.current === bulkDiffExpand.nonce) return;
    appliedBulkRef.current = bulkDiffExpand.nonce;
    setExpanded(bulkDiffExpand.expand);
    if (!bulkDiffExpand.expand) {
      setShowAllLines(false);
      setPreviewMode(false);
    }
  }, [bulkDiffExpand]);

  // Commit the render-mode seen this render so the next swap is detected once.
  useEffect(() => {
    prevRenderModeRef.current = renderMode;
  }, [renderMode]);

  useEffect(() => {
    if (jumpToken === undefined) return;
    // Expand first, but defer the scroll until the diff has loaded and laid out.
    setExpanded(true);
    // Scrolling before the async diff loads measures the file at its pre-load
    // (short) height, which lands a file near the bottom of the list at the
    // wrong offset and reads as "the scroll broke". Wait for the content, and
    // only scroll once per jump token (diff-load re-renders must not re-fire).
    if (diffState === null || diffState.loading) return;
    if (scrolledJumpRef.current === jumpToken) return;
    scrolledJumpRef.current = jumpToken;
    const frame = requestAnimationFrame(() => {
      const target = rowRef.current;
      if (target) {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
        // Scroll only the diff's own viewport, not every scroll ancestor the way
        // scrollIntoView does. The browser clamps scrollTop, so a short file at
        // the very bottom settles gracefully instead of fighting the max scroll.
        const viewport = target.closest<HTMLElement>("[data-slot='scroll-area-viewport']");
        if (viewport) {
          const delta =
            target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
          viewport.scrollTo({ top: viewport.scrollTop + delta - JUMP_STICKY_OFFSET, behavior });
        } else {
          target.scrollIntoView({ block: "nearest", behavior });
        }
      }
      onJumpSettled?.(jumpToken);
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpToken, diffState, onJumpSettled]);

  useEffect(() => {
    if (highlightToken === undefined) return;
    setJumpHighlight(true);
    const timeout = setTimeout(() => setJumpHighlight(false), 1500);
    return () => clearTimeout(timeout);
  }, [highlightToken]);

  const { language, isMarkdown, parentPath, basename } = useMemo(() => {
    const slash = filePath.lastIndexOf("/");
    return {
      language: langFromPath(filePath),
      isMarkdown: isMarkdownFile(filePath),
      parentPath: slash >= 0 ? filePath.slice(0, slash + 1) : "",
      basename: getFileBasename(filePath),
    };
  }, [filePath]);

  // Load diff lazily on first expand. Reads the cache at effect time so a reused
  // row with a new comparison id does not miss its fresh load.
  useEffect(() => {
    if (!expanded || loadStartedRef.current) return;
    const cached = useDiffStore.getState().inlineDiffCache[cacheKey];
    if (cached !== undefined) {
      setDiffState({ loading: false, data: cached });
      return;
    }
    loadStartedRef.current = true;

    let cancelled = false;
    setDiffState({ loading: true });

    const load = async () => {
      try {
        const transport = getTransport();
        const result = await loadFileDiff(transport, source, id, filePath, threadId);
        if (!cancelled) {
          setDiffState({ loading: false, data: result });
          useDiffStore.getState().cacheInlineDiff(threadId, source, id, filePath, result);
        }
      } catch {
        if (!cancelled) setDiffState({ loading: false, data: "" });
      }
    };

    void load();
    return () => {
      cancelled = true;
      loadStartedRef.current = false;
    };
  }, [expanded, source, id, filePath, threadId, cacheKey, cacheVersion]);

  const lines = useMemo(
    () =>
      diffState && !diffState.loading && diffState.data
        ? parseDiffLines(diffState.data)
        : [],
    [diffState],
  );

  // Resolve the file's absolute path on disk so the SideRail can pass it to
  // the editor / file-manager IPC. Worktree threads anchor at their
  // worktree_path; non-worktree threads anchor at the workspace path.
  const basePath = useWorkspaceStore((s) => {
    const thread = s.threads.find((t) => t.id === threadId);
    if (thread?.worktree_path) return thread.worktree_path;
    const ws = s.workspaces.find((w) => w.id === thread?.workspace_id);
    return ws?.path ?? null;
  });

  const absolutePath = useMemo(
    () => (basePath ? joinPaths(basePath, filePath) : undefined),
    [basePath, filePath],
  );

  const absoluteDir = useMemo(() => {
    if (!absolutePath) return undefined;
    const i = absolutePath.lastIndexOf("/");
    const j = absolutePath.lastIndexOf("\\");
    const cut = Math.max(i, j);
    return cut > 0 ? absolutePath.slice(0, cut) : absolutePath;
  }, [absolutePath]);

  const openAtLine = useMemo(
    () =>
      diffState && !diffState.loading && diffState.data
        ? parseFirstHunkLine(diffState.data)
        : undefined,
    [diffState],
  );

  const stats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const l of lines) {
      if (l.type === "add") additions++;
      else if (l.type === "remove") deletions++;
    }
    return { additions, deletions };
  }, [lines]);

  const isLoaded = diffState !== null && !diffState.loading;
  const isLargeDiff = lines.length > LARGE_DIFF_THRESHOLD;
  const { visibleLines, hiddenLineCount, leadingHiddenLines } = useMemo(() => {
    if (isLargeDiff && !showAllLines) {
      const sliced = lines.slice(0, INITIAL_LINES_SHOWN);
      return {
        visibleLines: sliced,
        hiddenLineCount: lines.length - INITIAL_LINES_SHOWN,
        leadingHiddenLines: getLeadingHiddenLineCount(sliced),
      };
    }
    return {
      visibleLines: lines,
      hiddenLineCount: 0,
      leadingHiddenLines: getLeadingHiddenLineCount(lines),
    };
  }, [lines, isLargeDiff, showAllLines]);

  const toggleExpanded = () => {
    setExpanded((prev) => {
      if (prev) {
        setShowAllLines(false);
        setPreviewMode(false);
      }
      return !prev;
    });
  };

  return (
    <div
      ref={rowRef}
      data-review-file={filePath}
      data-testid="diff-file-card"
      data-jump-highlight={jumpHighlight ? "true" : undefined}
      className={cn(
        "flex scroll-mt-10 flex-col",
        jumpHighlight && "animate-flash-highlight",
      )}
    >
      <FileEntryHeader
        contentId={contentId}
        filePath={filePath}
        expanded={expanded}
        jumpHighlight={jumpHighlight}
        parentPath={parentPath}
        basename={basename}
        isLoaded={isLoaded}
        additions={stats.additions}
        deletions={stats.deletions}
        absolutePath={absolutePath}
        absoluteDir={absoluteDir}
        openAtLine={openAtLine}
        isMarkdown={isMarkdown}
        previewMode={previewMode}
        onToggleExpanded={toggleExpanded}
        onTogglePreview={() => setPreviewMode((preview) => !preview)}
      />
      {expanded ? (
        <FileEntryDiffBody
          contentId={contentId}
          isLoaded={isLoaded}
          previewMode={previewMode}
          isMarkdown={isMarkdown}
          lines={lines}
          renderMode={renderMode}
          isModeSwap={isModeSwap}
          visibleLines={visibleLines}
          filePath={filePath}
          language={language}
          leadingHiddenLines={leadingHiddenLines}
          hiddenLineCount={hiddenLineCount}
          onShowAllLines={() => setShowAllLines(true)}
        />
      ) : null}
    </div>
  );
});

/** Props for a file entry's sticky header. */
interface FileEntryHeaderProps {
  contentId: string;
  filePath: string;
  expanded: boolean;
  jumpHighlight: boolean;
  parentPath: string;
  basename: string;
  isLoaded: boolean;
  additions: number;
  deletions: number;
  absolutePath?: string;
  absoluteDir?: string;
  openAtLine?: number;
  isMarkdown: boolean;
  previewMode: boolean;
  onToggleExpanded: () => void;
  onTogglePreview: () => void;
}

/** Renders a file entry's sticky file header and actions. */
function FileEntryHeader({
  contentId,
  filePath,
  expanded,
  jumpHighlight,
  parentPath,
  basename,
  isLoaded,
  additions,
  deletions,
  absolutePath,
  absoluteDir,
  openAtLine,
  isMarkdown,
  previewMode,
  onToggleExpanded,
  onTogglePreview,
}: FileEntryHeaderProps) {
  const hasChanges = additions > 0 || deletions > 0;

  return (
    <div
      data-jump-highlight={jumpHighlight ? "true" : undefined}
      className={cn(
        "sticky top-10 z-10 flex items-center gap-1",
        "border-b border-border/30 bg-muted",
        "data-[jump-highlight=true]:bg-primary/10",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        onClick={onToggleExpanded}
        className={cn(
          "group flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
          "hover:bg-foreground/[0.05]",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring/55",
        )}
        title={filePath}
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground/55 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        <FileTypeIcon filePath={filePath} size={16} />
        <span className="flex min-w-0 flex-1 items-baseline gap-0.5 overflow-hidden font-mono text-xs">
          {parentPath ? (
            <span className="min-w-0 shrink-[100] truncate text-muted-foreground">{parentPath}</span>
          ) : null}
          <span className="min-w-0 truncate font-medium text-foreground/90">{basename}</span>
        </span>
        {isLoaded && hasChanges ? <DiffStat additions={additions} deletions={deletions} /> : null}
      </button>
      {expanded ? (
        <FileActionBar
          filePath={filePath}
          absolutePath={absolutePath}
          absoluteDir={absoluteDir}
          openAtLine={openAtLine}
          isMarkdown={isMarkdown}
          previewMode={previewMode}
          onTogglePreview={onTogglePreview}
        />
      ) : null}
    </div>
  );
}

/** Props for a file entry's expandable diff body. */
interface FileEntryDiffBodyProps {
  contentId: string;
  isLoaded: boolean;
  previewMode: boolean;
  isMarkdown: boolean;
  lines: ReturnType<typeof parseDiffLines>;
  renderMode: "unified" | "side-by-side";
  isModeSwap: boolean;
  visibleLines: ReturnType<typeof parseDiffLines>;
  filePath: string;
  language: string;
  leadingHiddenLines: number;
  hiddenLineCount: number;
  onShowAllLines: () => void;
}

/** Renders the expanded diff, preview, loading state, or empty state. */
function FileEntryDiffBody({
  contentId,
  isLoaded,
  previewMode,
  isMarkdown,
  lines,
  renderMode,
  isModeSwap,
  visibleLines,
  filePath,
  language,
  leadingHiddenLines,
  hiddenLineCount,
  onShowAllLines,
}: FileEntryDiffBodyProps) {
  return (
    <div id={contentId} className="bg-background/40">
      {isLoaded ? (
        <LoadedFileDiff
          previewMode={previewMode}
          isMarkdown={isMarkdown}
          lines={lines}
          renderMode={renderMode}
          isModeSwap={isModeSwap}
          visibleLines={visibleLines}
          filePath={filePath}
          language={language}
          leadingHiddenLines={leadingHiddenLines}
          hiddenLineCount={hiddenLineCount}
          onShowAllLines={onShowAllLines}
        />
      ) : (
        <div className="flex items-center justify-center gap-1.5 py-3">
          {[0, 150, 300].map((delay) => (
            <div
              key={delay}
              className="h-1 w-1 rounded-full bg-muted-foreground/40 animate-pulse"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Props for an already loaded file diff. */
interface LoadedFileDiffProps extends Omit<FileEntryDiffBodyProps, "contentId" | "isLoaded"> {}

/** Renders preview, populated diff, or empty state after a file diff loads. */
function LoadedFileDiff({
  previewMode,
  isMarkdown,
  lines,
  renderMode,
  isModeSwap,
  visibleLines,
  filePath,
  language,
  leadingHiddenLines,
  hiddenLineCount,
  onShowAllLines,
}: LoadedFileDiffProps) {
  if (previewMode && isMarkdown) return <DiffPreview lines={lines} />;
  if (lines.length === 0) return <EmptyDiffState />;

  return (
    <div key={renderMode} className={cn(isModeSwap && "animate-diff-mode-swap")}>
      <FileDiffRenderer
        renderMode={renderMode}
        lines={visibleLines}
        filePath={filePath}
        language={language}
        skipLeadingHunkSeparator={leadingHiddenLines > 0}
      />
      {hiddenLineCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onShowAllLines}
          className="flex w-full items-center justify-center gap-1.5 rounded-none bg-muted/25 py-2 text-[10px] text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground/70"
        >
          <ChevronsDownUp size={11} />
          Show {hiddenLineCount} more lines
        </Button>
      ) : null}
    </div>
  );
}

/** Props for the selected inline diff renderer. */
interface FileDiffRendererProps {
  renderMode: "unified" | "side-by-side";
  lines: ReturnType<typeof parseDiffLines>;
  filePath: string;
  language: string;
  skipLeadingHunkSeparator: boolean;
}

/** Selects the unified or split renderer for a loaded file diff. */
function FileDiffRenderer({
  renderMode,
  lines,
  filePath,
  language,
  skipLeadingHunkSeparator,
}: FileDiffRendererProps) {
  if (renderMode === "unified") {
    return (
      <UnifiedDiff
        lines={lines}
        filePath={filePath}
        language={language}
        skipLeadingHunkSeparator={skipLeadingHunkSeparator}
      />
    );
  }

  return (
    <SideBySideDiff
      lines={lines}
      filePath={filePath}
      language={language}
      skipLeadingHunkSeparator={skipLeadingHunkSeparator}
    />
  );
}

/** Renders the empty loaded-diff state. */
function EmptyDiffState() {
  return (
    <div className="flex items-center justify-center py-4">
      <p className="text-[10px] text-muted-foreground">No changes</p>
    </div>
  );
}

/**
 * Tiny path joiner that picks the right separator without dragging in node:path.
 * Falls back to `/` on the web, but preserves `\` when the base path already
 * uses it (Windows workspace paths).
 */
function joinPaths(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const left = base.endsWith(sep) ? base.slice(0, -1) : base;
  const right = rel.startsWith("/") || rel.startsWith("\\") ? rel.slice(1) : rel;
  // Normalise forward slashes in `rel` to the chosen separator when on Windows.
  const normalised = sep === "\\" ? right.replace(/\//g, "\\") : right;
  return `${left}${sep}${normalised}`;
}
