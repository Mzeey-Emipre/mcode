import { useState, useEffect, useRef, useMemo } from "react";
import { ChevronsDownUp, Code2, FileText } from "lucide-react";
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
  /**
   * Indentation depth when rendered inside a folder tree. When > 0, the
   * parent-path suffix is suppressed (the folder header above carries it).
   */
  depth?: number;
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
export function FileEntry({ filePath, source, id, depth = 0 }: FileEntryProps) {
  const nested = depth > 0;
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

        {/* Stats: proportion bar + counts. The bar gives an at-a-glance sense of net impact. */}
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

        {/* Markdown preview toggle — span+role because the parent row is itself a <button>. */}
        {expanded && isMarkdown && (
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
            className={`shrink-0 cursor-pointer rounded p-0.5 outline-none transition-colors focus-visible:ring-[2px] focus-visible:ring-ring/60 ${
              previewMode
                ? "text-foreground/70 hover:text-foreground"
                : "text-muted-foreground/40 hover:text-foreground/60"
            }`}
          >
            {/* Action-as-icon, mirroring MermaidBlock's source/render toggle: in preview, offer Code2 ("see source"); on raw diff, offer FileText ("see rendered"). */}
            {previewMode ? <Code2 size={11} /> : <FileText size={11} />}
          </span>
        )}

        {/* Extension marker — single-color, monospace; lives quietly at the row's edge when collapsed */}
        {!expanded && ext && (
          <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/45">
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
