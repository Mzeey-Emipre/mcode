import { useState, useEffect, useRef, useMemo } from "react";
import { Plus, Minus } from "lucide-react";
import { useDiffStore, type SelectedFile } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { parseDiffLines } from "@/lib/diff-parser";
import { UnifiedDiff } from "./UnifiedDiff";
import { SideBySideDiff } from "./SideBySideDiff";

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
  ts: "text-blue-400/60",
  tsx: "text-sky-400/60",
  js: "text-yellow-400/60",
  jsx: "text-yellow-400/60",
  mjs: "text-yellow-400/60",
  cjs: "text-yellow-400/60",
  json: "text-orange-400/60",
  css: "text-pink-400/60",
  scss: "text-pink-400/60",
  md: "text-slate-400/60",
  mdx: "text-slate-400/60",
  py: "text-green-400/60",
  go: "text-cyan-400/60",
  rs: "text-orange-500/60",
  sql: "text-purple-400/60",
  sh: "text-emerald-400/60",
  yaml: "text-amber-400/60",
  yml: "text-amber-400/60",
  toml: "text-amber-400/60",
};

/** Height in pixels for inline side-by-side diff rendering. */
const INLINE_SIDE_BY_SIDE_HEIGHT = 240;

/**
 * Diff loading state.
 * null = not yet started; { loading: true } = in-flight; { loading: false; data } = settled.
 */
type DiffState = null | { loading: true } | { loading: false; data: string };

/**
 * Single file row with an inline expandable diff.
 * Clicking toggles the diff open/closed directly below the filename.
 * Diff is loaded lazily on the first expand.
 */
export function FileEntry({ filePath, source, id }: FileEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const [diffState, setDiffState] = useState<DiffState>(null);
  const renderMode = useDiffStore((s) => s.renderMode);
  // Tracks whether a load has been kicked off so the effect doesn't cancel itself
  // when diffState transitions from null → {loading:true}
  const loadStartedRef = useRef(false);

  const basename = getFileBasename(filePath);
  const parent = getParentDir(filePath);
  const ext = getExtension(filePath);
  const extColor = EXT_COLORS[ext] ?? "text-muted-foreground/30";

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
    () => ({
      additions: lines.filter((l) => l.type === "add").length,
      deletions: lines.filter((l) => l.type === "remove").length,
    }),
    [lines],
  );

  const isLoaded = diffState !== null && !diffState.loading;

  return (
    <div className={`border-b border-border/10 ${expanded ? "bg-muted/5" : ""}`}>
      {/* File header row */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="group flex w-full items-center gap-2 py-[5px] pl-7 pr-3 text-left transition-colors hover:bg-muted/15"
        title={filePath}
      >
        {expanded ? (
          <Minus size={10} className="shrink-0 text-muted-foreground/25" />
        ) : (
          <Plus size={10} className="shrink-0 text-muted-foreground/25" />
        )}

        {/* Status dot */}
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/50" />

        {/* Filename + parent dir */}
        <span className="flex-1 min-w-0">
          <span className="block truncate font-mono text-[11px] text-foreground/70">
            {basename}
          </span>
          {parent && (
            <span className="block truncate font-mono text-[9px] text-muted-foreground/30">
              {parent}/
            </span>
          )}
        </span>

        {/* +/- stats once loaded */}
        {isLoaded && (stats.additions > 0 || stats.deletions > 0) && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[9px]">
            {stats.additions > 0 && (
              <span className="text-emerald-400/60">+{stats.additions}</span>
            )}
            {stats.deletions > 0 && (
              <span className="text-red-400/50">-{stats.deletions}</span>
            )}
          </span>
        )}

        {/* Extension badge (hidden while expanded to save space) */}
        {!expanded && ext && (
          <span className={`shrink-0 font-mono text-[9px] uppercase tracking-wide ${extColor}`}>
            {ext}
          </span>
        )}
      </button>

      {/* Inline diff */}
      {expanded && (
        <div className="border-t border-border/10">
          {!isLoaded ? (
            <div className="flex items-center justify-center gap-1.5 py-3">
              {[0, 150, 300].map((delay) => (
                <div
                  key={delay}
                  className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          ) : lines.length > 0 ? (
            <div className="overflow-x-auto">
              {renderMode === "unified" ? (
                <UnifiedDiff lines={lines} />
              ) : (
                <div style={{ height: `${INLINE_SIDE_BY_SIDE_HEIGHT}px` }}>
                  <SideBySideDiff lines={lines} />
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center py-4">
              <p className="text-[10px] text-muted-foreground/25">No changes</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
