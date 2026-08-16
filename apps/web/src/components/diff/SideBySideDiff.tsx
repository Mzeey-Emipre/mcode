import { memo, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { ParsedDiffLine } from "@/lib/diff-parser";
import { getFirstHunkHeaderIndex } from "@/lib/diff-parser";
import { useDiffHighlighter } from "@/hooks/useDiffHighlighter";
import { useShikiTheme } from "@/hooks/useTheme";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  usePreviewAnnotationStore,
  type SavedDiffAnnotation,
} from "@/features/preview/state/previewAnnotationStore";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HunkSeparator } from "./HunkSeparator";
import { DiffAnnotationEditor } from "./DiffAnnotationEditor";

const EMPTY_DIFF_ANNOTATIONS: readonly SavedDiffAnnotation[] = [];

/** Props for SideBySideDiff. */
interface SideBySideDiffProps {
  lines: ParsedDiffLine[];
  /** Workspace-relative file path used by Dev diff comments. */
  filePath?: string;
  /** File language for syntax highlighting (e.g. "typescript"). "text" disables highlighting. */
  language?: string;
  /** When true, the first hunk's hidden-line band is omitted (shown on the file header instead). */
  skipLeadingHunkSeparator?: boolean;
}

/** A single paired row in the side-by-side diff layout. */
interface SideBySideRow {
  left: {
    lineNo: number | null;
    content: string;
    type: "remove" | "context" | "header" | "empty";
    diffIndex: number | null;
    hiddenLineCount?: number;
  };
  right: {
    lineNo: number | null;
    content: string;
    type: "add" | "context" | "header" | "empty";
    diffIndex: number | null;
    hiddenLineCount?: number;
  };
}

/** Convert flat diff lines into paired left/right rows for side-by-side rendering. */
function buildRows(lines: ParsedDiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.type === "header") {
      rows.push({
        left: { lineNo: null, content: line.content, type: "header", diffIndex: i, hiddenLineCount: line.hiddenLineCount },
        right: { lineNo: null, content: line.content, type: "header", diffIndex: i, hiddenLineCount: line.hiddenLineCount },
      });
      i++;
    } else if (line.type === "context") {
      rows.push({
        left: { lineNo: line.oldLineNo, content: line.content, type: "context", diffIndex: i },
        right: { lineNo: line.newLineNo, content: line.content, type: "context", diffIndex: i },
      });
      i++;
    } else {
      const removes: { line: ParsedDiffLine; idx: number }[] = [];
      const adds: { line: ParsedDiffLine; idx: number }[] = [];

      while (i < lines.length && lines[i].type === "remove") {
        removes.push({ line: lines[i], idx: i });
        i++;
      }
      while (i < lines.length && lines[i].type === "add") {
        adds.push({ line: lines[i], idx: i });
        i++;
      }

      const maxLen = Math.max(removes.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        const rem = removes[j];
        const add = adds[j];
        rows.push({
          left: rem
            ? { lineNo: rem.line.oldLineNo, content: rem.line.content, type: "remove", diffIndex: rem.idx }
            : { lineNo: null, content: "", type: "empty", diffIndex: null },
          right: add
            ? { lineNo: add.line.newLineNo, content: add.line.content, type: "add", diffIndex: add.idx }
            : { lineNo: null, content: "", type: "empty", diffIndex: null },
        });
      }
    }
  }

  return rows;
}

const LEFT_BG: Record<string, string> = {
  remove: "bg-[var(--diff-remove-bg)] hover:bg-[var(--diff-remove-bg-hover)]",
  context: "hover:bg-muted/[0.06]",
  header: "bg-muted/15",
  empty: "bg-muted/[0.04]",
};

const RIGHT_BG: Record<string, string> = {
  add: "bg-[var(--diff-add-bg)] hover:bg-[var(--diff-add-bg-hover)]",
  context: "hover:bg-muted/[0.06]",
  header: "bg-muted/15",
  empty: "bg-muted/[0.04]",
};

/** Side-by-side diff renderer with syntax highlighting and hunk separator bars. */
export const SideBySideDiff = memo(function SideBySideDiff({
  lines,
  filePath,
  language = "text",
  skipLeadingHunkSeparator = false,
}: SideBySideDiffProps) {
  const rows = useMemo(() => buildRows(lines), [lines]);
  const theme = useShikiTheme();
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const annotations = usePreviewAnnotationStore((s) =>
    activeThreadId
      ? (s.diffByThread[activeThreadId] ?? EMPTY_DIFF_ANNOTATIONS)
      : EMPTY_DIFF_ANNOTATIONS,
  );
  const annotationsByTarget = useMemo(
    () =>
      new Map(
        annotations
          .filter((annotation) => annotation.filePath === filePath)
          .map((annotation) => [`${annotation.side}:${annotation.line}`, annotation]),
      ),
    [annotations, filePath],
  );
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const lineWrap = useDiffStore((s) =>
    activeThreadId ? s.getLineWrap(activeThreadId) : true,
  );
  const { getLineTokens } = useDiffHighlighter(lines, language, theme, language !== "text");
  const firstHunkHeaderIndex = skipLeadingHunkSeparator ? getFirstHunkHeaderIndex(lines) : -1;

  const shouldSkipHunkSeparator = (diffIndex: number | null, hiddenLineCount?: number) => {
    if (!hiddenLineCount || hiddenLineCount <= 0) return true;
    if (skipLeadingHunkSeparator && diffIndex === firstHunkHeaderIndex) return true;
    return false;
  };

  return (
    <div className="flex select-text text-xs font-mono leading-5">
      {/* Left (removed) */}
      <div className={`flex-1 border-r border-border/15 ${lineWrap ? "overflow-x-hidden" : "overflow-x-auto"}`}>
        <div className={lineWrap ? "w-full" : "w-fit min-w-full"}>
        {rows.map((row, i) => {
          if (row.left.type === "header") {
            if (!row.left.content.startsWith("@@")) return null;
            if (shouldSkipHunkSeparator(row.left.diffIndex, row.left.hiddenLineCount)) return null;
            return <HunkSeparator key={i} hiddenLineCount={row.left.hiddenLineCount!} />;
          }

          const tokens = row.left.diffIndex !== null ? getLineTokens(row.left.diffIndex) : null;
          const targetKey = row.left.lineNo === null ? null : `left:${row.left.lineNo}`;
          const annotation = targetKey ? annotationsByTarget.get(targetKey) : undefined;
          const editing = targetKey !== null && editingTarget === targetKey;

          return (
            <div key={i}>
            <div className={cn("group/diff-line relative flex min-h-7 items-stretch", LEFT_BG[row.left.type], editing && "ring-1 ring-inset ring-primary/70")}>
              {activeThreadId && filePath && row.left.lineNo !== null && row.left.type !== "empty" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${annotation ? "Edit" : "Add"} comment on line ${row.left.lineNo}`}
                  className={cn(
                    "pointer-events-none absolute left-0.5 top-0.5 z-10 size-6 rounded-md bg-foreground text-background opacity-0 shadow-none transition-opacity duration-100 hover:bg-foreground hover:text-background group-hover/diff-line:pointer-events-auto group-hover/diff-line:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 dark:hover:bg-foreground dark:hover:text-background motion-reduce:transition-none",
                    (annotation || editing) && "pointer-events-auto opacity-100",
                  )}
                  onClick={() => setEditingTarget(editing ? null : targetKey)}
                >
                  {annotation ? <span className="font-mono text-[1rem] font-semibold tabular-nums">{annotation.displayNumber}</span> : <Plus size={16} strokeWidth={2.5} aria-hidden />}
                </Button>
              ) : null}
              <span aria-hidden className="inline-grid w-10 shrink-0 select-none grid-cols-[0.75rem_1fr] items-center bg-page/35 pr-1.5 text-[1rem] tabular-nums text-muted-foreground/70">
                <span className="text-center">{row.left.type === "remove" ? "−" : ""}</span>
                <span className="text-right">{row.left.lineNo ?? ""}</span>
              </span>
              <span className={`flex-1 px-2 py-1 leading-5 ${lineWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
                {row.left.type === "remove" && <span className="sr-only">Removed: </span>}
                {tokens ? (
                  tokens.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))
                ) : (
                  <span
                    className={
                      row.left.type === "remove"
                        ? "text-[var(--diff-remove-text)]"
                        : row.left.type === "context"
                          ? "text-foreground/65"
                          : ""
                    }
                  >
                    {row.left.content}
                  </span>
                )}
              </span>
            </div>
            {editing && activeThreadId && filePath && row.left.lineNo !== null ? (
              <DiffAnnotationEditor
                threadId={activeThreadId}
                annotation={annotation}
                target={{ filePath, side: "left", line: row.left.lineNo, lineContent: row.left.content }}
                onClose={() => setEditingTarget(null)}
              />
            ) : null}
            </div>
          );
        })}
        </div>
      </div>

      {/* Right (added) */}
      <div className={`flex-1 ${lineWrap ? "overflow-x-hidden" : "overflow-x-auto"}`}>
        <div className={lineWrap ? "w-full" : "w-fit min-w-full"}>
        {rows.map((row, i) => {
          if (row.right.type === "header") {
            if (!row.right.content.startsWith("@@")) return null;
            if (shouldSkipHunkSeparator(row.right.diffIndex, row.right.hiddenLineCount)) return null;
            return <HunkSeparator key={i} hiddenLineCount={row.right.hiddenLineCount!} />;
          }

          const tokens = row.right.diffIndex !== null ? getLineTokens(row.right.diffIndex) : null;
          const targetKey = row.right.lineNo === null ? null : `right:${row.right.lineNo}`;
          const annotation = targetKey ? annotationsByTarget.get(targetKey) : undefined;
          const editing = targetKey !== null && editingTarget === targetKey;

          return (
            <div key={i}>
            <div className={cn("group/diff-line relative flex min-h-7 items-stretch", RIGHT_BG[row.right.type], editing && "ring-1 ring-inset ring-primary/70")}>
              {activeThreadId && filePath && row.right.lineNo !== null && row.right.type !== "empty" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${annotation ? "Edit" : "Add"} comment on line ${row.right.lineNo}`}
                  className={cn(
                    "pointer-events-none absolute left-0.5 top-0.5 z-10 size-6 rounded-md bg-foreground text-background opacity-0 shadow-none transition-opacity duration-100 hover:bg-foreground hover:text-background group-hover/diff-line:pointer-events-auto group-hover/diff-line:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 dark:hover:bg-foreground dark:hover:text-background motion-reduce:transition-none",
                    (annotation || editing) && "pointer-events-auto opacity-100",
                  )}
                  onClick={() => setEditingTarget(editing ? null : targetKey)}
                >
                  {annotation ? <span className="font-mono text-[1rem] font-semibold tabular-nums">{annotation.displayNumber}</span> : <Plus size={16} strokeWidth={2.5} aria-hidden />}
                </Button>
              ) : null}
              <span aria-hidden className="inline-grid w-10 shrink-0 select-none grid-cols-[0.75rem_1fr] items-center bg-page/35 pr-1.5 text-[1rem] tabular-nums text-muted-foreground/70">
                <span className="text-center">{row.right.type === "add" ? "+" : ""}</span>
                <span className="text-right">{row.right.lineNo ?? ""}</span>
              </span>
              <span className={`flex-1 px-2 py-1 leading-5 ${lineWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
                {row.right.type === "add" && <span className="sr-only">Added: </span>}
                {tokens ? (
                  tokens.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))
                ) : (
                  <span
                    className={
                      row.right.type === "add"
                        ? "text-[var(--diff-add-text)]"
                        : row.right.type === "context"
                          ? "text-foreground/65"
                          : ""
                    }
                  >
                    {row.right.content}
                  </span>
                )}
              </span>
            </div>
            {editing && activeThreadId && filePath && row.right.lineNo !== null ? (
              <DiffAnnotationEditor
                threadId={activeThreadId}
                annotation={annotation}
                target={{ filePath, side: "right", line: row.right.lineNo, lineContent: row.right.content }}
                onClose={() => setEditingTarget(null)}
              />
            ) : null}
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
});
