import { useState, useEffect, useRef, useMemo } from "react";
import { ChevronsDownUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDiffStore, type SelectedFile } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getTransport } from "@/transport";
import { parseDiffLines, isMarkdownFile } from "@/lib/diff-parser";
import { loadFileDiff } from "@/lib/load-file-diff";
import { parseFirstHunkLine } from "@/lib/parse-first-hunk-line";
import { langFromPath } from "@/lib/lang-from-path";
import { UnifiedDiff } from "./UnifiedDiff";
import { SideBySideDiff } from "./SideBySideDiff";
import { DiffPreview } from "./DiffPreview";
import { SideRail } from "./SideRail";

/** Props for FileEntry. */
interface FileEntryProps {
  filePath: string;
  source: SelectedFile["source"];
  id: string;
  /** Thread that owns this file, used to scope the inline diff cache. */
  threadId: string;
  /**
   * Indentation depth when rendered inside a folder tree. When > 0, the
   * parent-path suffix is suppressed (the folder header above carries it).
   */
  depth?: number;
  /** When true the diff starts expanded on mount (used for the latest turn). */
  defaultExpanded?: boolean;
}

/** Extract the basename from a file path. */
function getFileBasename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

/** Extract the immediate parent directory name from a file path. */
function getParentDir(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

/** Get the file extension (lowercase, no dot). */
function getExtension(filePath: string): string {
  const basename = getFileBasename(filePath);
  const dot = basename.lastIndexOf(".");
  return dot >= 0 ? basename.slice(dot + 1).toLowerCase() : "";
}

/**
 * Number of lines shown initially for large diffs before truncation.
 * Diffs with more than LARGE_DIFF_THRESHOLD lines start truncated.
 */
const LARGE_DIFF_THRESHOLD = 200;
const INITIAL_LINES_SHOWN = 100;

/**
 * Diff loading state.
 * null = not yet started; { loading: true } = in-flight; { loading: false; data } = settled.
 */
type DiffState = null | { loading: true } | { loading: false; data: string };

/**
 * Single file row with an inline expandable diff.
 * Clicking toggles the diff open/closed directly below the filename.
 * Diff is loaded lazily on the first expand.
 * Large diffs (>200 lines) are truncated with a "Show all N lines" button.
 */
export function FileEntry({ filePath, source, id, threadId, depth = 0, defaultExpanded: defaultExpandedProp = false }: FileEntryProps) {
  const nested = depth > 0;
  const [expanded, setExpanded] = useState(defaultExpandedProp);
  const [showAllLines, setShowAllLines] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  // Initialise from the Zustand cache so diffs survive panel close/reopen.
  const cachedDiff = useDiffStore((s) => s.inlineDiffCache[`${threadId}:${source}:${id}:${filePath}`]);
  const [diffState, setDiffState] = useState<DiffState>(
    () => (cachedDiff !== undefined ? { loading: false, data: cachedDiff } : null),
  );
  const renderMode = useDiffStore((s) => s.renderMode);
  // Tracks whether a load has been kicked off in this effect lifecycle.
  // Reset in cleanup so React StrictMode's second invocation can start a
  // fresh, non-cancelled fetch (the first is cancelled by cleanup).
  const loadStartedRef = useRef(false);

  // Reset local state when the cache identity changes so a reused component
  // instance doesn't show stale content from a previous identity.
  const cacheKey = `${threadId}:${source}:${id}:${filePath}`;
  useEffect(() => {
    const cached = useDiffStore.getState().inlineDiffCache[cacheKey];
    setDiffState(cached !== undefined ? { loading: false, data: cached } : null);
    setShowAllLines(false);
    setPreviewMode(false);
    loadStartedRef.current = false;
  }, [cacheKey]);

  const { basename, parent, ext, language, isMarkdown } = useMemo(() => {
    const bn = getFileBasename(filePath);
    const pr = getParentDir(filePath);
    const ex = getExtension(filePath);
    return { basename: bn, parent: pr, ext: ex, language: langFromPath(filePath), isMarkdown: isMarkdownFile(filePath) };
  }, [filePath]);

  // Load diff lazily on first expand. Skips if the diff is already cached.
  useEffect(() => {
    if (!expanded || loadStartedRef.current || (diffState !== null && !diffState.loading)) return;
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
  }, [expanded, source, id, filePath, threadId]);

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
  const { visibleLines, hiddenLineCount } = useMemo(() => {
    if (isLargeDiff && !showAllLines) {
      return {
        visibleLines: lines.slice(0, INITIAL_LINES_SHOWN),
        hiddenLineCount: lines.length - INITIAL_LINES_SHOWN,
      };
    }
    return { visibleLines: lines, hiddenLineCount: 0 };
  }, [lines, isLargeDiff, showAllLines]);

  return (
    <div className={`border-b border-border/30 ${expanded ? "bg-muted/5" : ""}`}>
      {/* File header row — sticky when expanded so filename stays visible while scrolling the diff */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => {
          if (prev) {
            setShowAllLines(false);
            setPreviewMode(false);
          }
          return !prev;
        })}
        className={`group flex w-full items-center gap-2 py-[5px] pr-3 text-left transition-colors hover:bg-muted/20 ${
          expanded
            ? "sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/20"
            : ""
        }`}
        style={{ paddingLeft: nested ? `${12 + depth * 14}px` : "28px" }}
        title={filePath}
      >
        <span
          aria-hidden="true"
          className={`shrink-0 font-mono text-[11px] leading-none transition-transform duration-150 text-muted-foreground/45 ${
            expanded ? "rotate-90" : ""
          }`}
        >
          ›
        </span>

        {/* Filename + path. Inside a tree, the folder header above carries the
            directory context, so we drop the redundant parent-path suffix. */}
        <span className="flex-1 min-w-0">
          <span className="block truncate font-mono text-[11.5px] text-foreground/85">
            {basename}
          </span>
          {expanded && !nested && (
            <span className="block break-all font-mono text-[10px] text-muted-foreground/55">
              {filePath}
            </span>
          )}
          {!expanded && !nested && parent && (
            <span className="block truncate font-mono text-[10px] text-muted-foreground/55">
              {parent}/
            </span>
          )}
        </span>

        {/* Stats: proportion bar + counts. Shown after the diff loads. */}
        {isLoaded && (stats.additions > 0 || stats.deletions > 0) && (
          <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] tabular-nums">
            <span className="flex h-[3px] w-12 items-stretch overflow-hidden rounded-full bg-border/40">
              <span
                className="block bg-[var(--diff-add-strong)]"
                style={{
                  width: `${(stats.additions / (stats.additions + stats.deletions)) * 100}%`,
                }}
              />
              <span
                className="block bg-[var(--diff-remove-strong)]"
                style={{
                  width: `${(stats.deletions / (stats.additions + stats.deletions)) * 100}%`,
                }}
              />
            </span>
            {stats.additions > 0 && (
              <span className="text-[var(--diff-add-strong)]">+{stats.additions}</span>
            )}
            {stats.deletions > 0 && (
              <span className="text-[var(--diff-remove-strong)]">−{stats.deletions}</span>
            )}
          </span>
        )}

        {/* Extension marker — single-color, monospace; lives quietly at the row's edge when collapsed */}
        {!expanded && ext && (
          <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/45">
            {ext}
          </span>
        )}
      </button>

      {/* Inline diff — no height cap; outer ScrollArea owns vertical scroll.
          `relative` anchors the SideRail. min-h ensures the rail (5 buttons
          ~ 171px) is always fully visible even for tiny diffs. pr-8 reserves
          the collapsed rail's gutter so code never sits behind the icons. */}
      {expanded && (
        <div className="relative border-t border-border/30 min-h-[180px]">
          <div className="pr-8">
            {!isLoaded ? (
              <div className="flex items-center justify-center gap-1.5 py-3">
                {[0, 150, 300].map((delay) => (
                  <div
                    key={delay}
                    className="h-1 w-1 rounded-full bg-muted-foreground/40 animate-pulse"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            ) : previewMode && isMarkdown ? (
              <DiffPreview lines={lines} />
            ) : lines.length > 0 ? (
              <>
                {renderMode === "unified" ? (
                  <UnifiedDiff lines={visibleLines} language={language} />
                ) : (
                  <SideBySideDiff lines={visibleLines} language={language} />
                )}

                {/* Large diff expansion button */}
                {hiddenLineCount > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowAllLines(true)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-none border-t border-border/20 py-2 text-[10px] text-muted-foreground/70 hover:text-foreground/70"
                  >
                    <ChevronsDownUp size={11} />
                    Show {hiddenLineCount} more lines
                  </Button>
                )}
              </>
            ) : (
              <div className="flex items-center justify-center py-4">
                <p className="text-[10px] text-muted-foreground">No changes</p>
              </div>
            )}
          </div>

          <SideRail
            filePath={filePath}
            absolutePath={absolutePath}
            absoluteDir={absoluteDir}
            openAtLine={openAtLine}
            isMarkdown={isMarkdown}
            previewMode={previewMode}
            onTogglePreview={() => setPreviewMode((p) => !p)}
          />
        </div>
      )}
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
