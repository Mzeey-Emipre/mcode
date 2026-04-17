import { useState, useEffect, useRef, useMemo } from "react";
import { Plus, Minus, ChevronsDownUp, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDiffStore, type SelectedFile } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { parseDiffLines, isMarkdownFile } from "@/lib/diff-parser";
import { langFromPath } from "@/lib/lang-from-path";
import { UnifiedDiff } from "./UnifiedDiff";
import { SideBySideDiff } from "./SideBySideDiff";
import { DiffPreview } from "./DiffPreview";

/** Props for FileEntry. */
interface FileEntryProps {
  filePath: string;
  source: SelectedFile["source"];
  id: string;
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

const EXT_COLORS: Record<string, string> = {
  ts: "text-blue-600 dark:text-blue-400",
  tsx: "text-sky-600 dark:text-sky-400",
  js: "text-yellow-700 dark:text-yellow-400",
  jsx: "text-yellow-700 dark:text-yellow-400",
  mjs: "text-yellow-700 dark:text-yellow-400",
  cjs: "text-yellow-700 dark:text-yellow-400",
  json: "text-orange-700 dark:text-orange-400",
  css: "text-pink-600 dark:text-pink-400",
  scss: "text-pink-600 dark:text-pink-400",
  md: "text-slate-600 dark:text-slate-400",
  mdx: "text-slate-600 dark:text-slate-400",
  py: "text-green-600 dark:text-green-400",
  go: "text-cyan-600 dark:text-cyan-400",
  rs: "text-orange-700 dark:text-orange-500",
  sql: "text-purple-600 dark:text-purple-400",
  sh: "text-emerald-600 dark:text-emerald-400",
  yaml: "text-amber-700 dark:text-amber-400",
  yml: "text-amber-700 dark:text-amber-400",
  toml: "text-amber-700 dark:text-amber-400",
};

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
export function FileEntry({ filePath, source, id }: FileEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAllLines, setShowAllLines] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [diffState, setDiffState] = useState<DiffState>(null);
  const renderMode = useDiffStore((s) => s.renderMode);
  // Tracks whether a load has been kicked off so the effect doesn't cancel itself
  // when diffState transitions from null → {loading:true}
  const loadStartedRef = useRef(false);

  const { basename, parent, ext, language, isMarkdown } = useMemo(() => {
    const bn = getFileBasename(filePath);
    const pr = getParentDir(filePath);
    const ex = getExtension(filePath);
    return { basename: bn, parent: pr, ext: ex, language: langFromPath(filePath), isMarkdown: isMarkdownFile(filePath) };
  }, [filePath]);
  const extColor = EXT_COLORS[ext] ?? "text-muted-foreground";

  // Load diff lazily on first expand. Uses a ref guard so that the state
  // transition to {loading:true} doesn't re-trigger cleanup and cancel the fetch.
  useEffect(() => {
    if (!expanded || loadStartedRef.current) return;
    loadStartedRef.current = true;

    let cancelled = false;
    setDiffState({ loading: true });

    const load = async () => {
      try {
        const transport = getTransport();
        let result: string;
        if (source === "snapshot") {
          result = await transport.getSnapshotDiff(id, filePath);
        } else if (source === "cumulative") {
          result = await transport.getCumulativeDiff(id, filePath);
        } else {
          const { useWorkspaceStore } = await import("@/stores/workspaceStore");
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
          result = workspaceId
            ? await transport.getCommitDiff(workspaceId, id, filePath)
            : "";
        }
        if (!cancelled) setDiffState({ loading: false, data: result });
      } catch {
        if (!cancelled) setDiffState({ loading: false, data: "" });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [expanded, source, id, filePath]);

  const lines = useMemo(
    () =>
      diffState && !diffState.loading && diffState.data
        ? parseDiffLines(diffState.data)
        : [],
    [diffState],
  );

  const stats = useMemo(
    () =>
      lines.reduce(
        (acc, l) => {
          if (l.type === "add") acc.additions++;
          else if (l.type === "remove") acc.deletions++;
          return acc;
        },
        { additions: 0, deletions: 0 },
      ),
    [lines],
  );

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
        className={`group flex w-full items-center gap-2 py-[5px] pl-7 pr-3 text-left transition-colors hover:bg-muted/20 ${
          expanded
            ? "sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/20"
            : ""
        }`}
        title={filePath}
      >
        {expanded ? (
          <Minus size={10} className="shrink-0 text-muted-foreground/70" />
        ) : (
          <Plus size={10} className="shrink-0 text-muted-foreground/70" />
        )}

        {/* Status dot */}
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500/60" />

        {/* Filename + path */}
        <span className="flex-1 min-w-0">
          <span className="block truncate font-mono text-[11px] text-foreground/80">
            {basename}
          </span>
          {expanded ? (
            /* Show full path when expanded - no truncation so the full path is always readable */
            <span className="block break-all font-mono text-[9px] text-muted-foreground/60">
              {filePath}
            </span>
          ) : parent ? (
            <span className="block truncate font-mono text-[9px] text-muted-foreground/70">
              {parent}/
            </span>
          ) : null}
        </span>

        {/* +/- stats once loaded */}
        {isLoaded && (stats.additions > 0 || stats.deletions > 0) && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[9px]">
            {stats.additions > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400">+{stats.additions}</span>
            )}
            {stats.deletions > 0 && (
              <span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
            )}
          </span>
        )}

        {/* Markdown preview toggle — only shown when expanded */}
        {expanded && isMarkdown && (
          // span+role avoids invalid nested <button> while still being accessible
          <span
            role="button"
            tabIndex={0}
            aria-label={previewMode ? "Show raw diff" : "Preview rendered markdown"}
            aria-pressed={previewMode}
            onClick={(e) => {
              e.stopPropagation();
              setPreviewMode((prev) => !prev);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault(); // prevent Space from scrolling the page
                e.stopPropagation();
                setPreviewMode((prev) => !prev);
              }
            }}
            className={`shrink-0 rounded p-0.5 transition-colors ${
              previewMode
                ? "text-foreground/70 hover:text-foreground"
                : "text-muted-foreground/40 hover:text-foreground/60"
            }`}
          >
            {previewMode ? <EyeOff size={11} /> : <Eye size={11} />}
          </span>
        )}

        {/* Extension badge (hidden while expanded to save space) */}
        {!expanded && ext && (
          <span className={`shrink-0 font-mono text-[9px] uppercase tracking-wide ${extColor}`}>
            {ext}
          </span>
        )}
      </button>

      {/* Inline diff — no height cap; outer ScrollArea owns vertical scroll */}
      {expanded && (
        <div className="border-t border-border/30">
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
      )}
    </div>
  );
}
