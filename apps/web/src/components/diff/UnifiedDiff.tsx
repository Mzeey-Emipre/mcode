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

/** Props for UnifiedDiff. */
interface UnifiedDiffProps {
  lines: ParsedDiffLine[];
  /** Workspace-relative file path used by Dev diff comments. */
  filePath?: string;
  /** File language for syntax highlighting (e.g. "typescript"). "text" disables highlighting. */
  language?: string;
  /** When true, the first hunk's hidden-line band is omitted (shown on the file header instead). */
  skipLeadingHunkSeparator?: boolean;
}

/**
 * Unified diff renderer.
 * Status is communicated by background tint and a tinted gutter rule on the new-line-number
 * column — no redundant +/- character column. Syntax highlighting layered on top.
 */
export const UnifiedDiff = memo(function UnifiedDiff({
  lines,
  filePath,
  language = "text",
  skipLeadingHunkSeparator = false,
}: UnifiedDiffProps) {
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
          .map((annotation) => [
            `${annotation.side}:${annotation.line}`,
            annotation,
          ]),
      ),
    [annotations, filePath],
  );
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const lineWrap = useDiffStore((s) =>
    activeThreadId ? s.getLineWrap(activeThreadId) : true,
  );
  const { getLineTokens } = useDiffHighlighter(lines, language, theme, language !== "text");
  const firstHunkHeaderIndex = skipLeadingHunkSeparator ? getFirstHunkHeaderIndex(lines) : -1;

  return (
    <div className={`select-text text-xs font-mono leading-5 ${lineWrap ? "overflow-x-hidden" : "overflow-x-auto"}`}>
      <div className={lineWrap ? "w-full" : "w-fit min-w-full"}>
      {lines.map((line, i) => {
        if (line.type === "header") {
          if (!line.content.startsWith("@@")) return null;
          if (!line.hiddenLineCount || line.hiddenLineCount <= 0) return null;
          if (skipLeadingHunkSeparator && i === firstHunkHeaderIndex) return null;
          return <HunkSeparator key={i} hiddenLineCount={line.hiddenLineCount} />;
        }

        const isAdd = line.type === "add";
        const isRemove = line.type === "remove";
        const tokens = getLineTokens(i);

        const rowBg = isAdd
          ? "bg-[var(--diff-add-bg)] hover:bg-[var(--diff-add-bg-hover)]"
          : isRemove
            ? "bg-[var(--diff-remove-bg)] hover:bg-[var(--diff-remove-bg-hover)]"
            : "hover:bg-muted/[0.06]";

        const side = isRemove ? "left" : "right";
        const lineNumber = isRemove ? line.oldLineNo : (line.newLineNo ?? line.oldLineNo);
        const targetKey = lineNumber === null ? null : `${side}:${lineNumber}`;
        const annotation = targetKey ? annotationsByTarget.get(targetKey) : undefined;
        const editing = targetKey !== null && editingTarget === targetKey;
        const changeMarker = isAdd ? "+" : isRemove ? "−" : "";

        return (
          <div key={i}>
            <div
              className={cn(
                "group/diff-line relative flex min-h-7 items-stretch outline-none",
                rowBg,
                editing && "ring-1 ring-inset ring-primary/70",
              )}
            >
              {activeThreadId && filePath && lineNumber !== null ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${annotation ? "Edit" : "Add"} comment on line ${lineNumber}`}
                  className={cn(
                    "pointer-events-none absolute left-0.5 top-0.5 z-10 size-6 rounded-md bg-foreground text-background opacity-0 shadow-none transition-opacity duration-100 hover:bg-foreground hover:text-background group-hover/diff-line:pointer-events-auto group-hover/diff-line:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 dark:hover:bg-foreground dark:hover:text-background motion-reduce:transition-none",
                    (annotation || editing) && "pointer-events-auto opacity-100",
                  )}
                  onClick={() => setEditingTarget(editing ? null : targetKey)}
                >
                  {annotation ? (
                    <span className="font-mono text-[1rem] font-semibold tabular-nums">
                      {annotation.displayNumber}
                    </span>
                  ) : (
                    <Plus size={16} strokeWidth={2.5} aria-hidden />
                  )}
                </Button>
              ) : null}
              <span
                aria-hidden
                data-testid="dev-diff-gutter"
                className="inline-grid w-10 shrink-0 select-none grid-cols-[0.75rem_1fr] items-center bg-page/35 pr-1.5 text-[1rem] tabular-nums text-muted-foreground/70"
              >
                <span className="text-center text-current">{changeMarker}</span>
                <span className="text-right">{lineNumber ?? ""}</span>
              </span>
              <span className={`flex-1 px-2 py-1 leading-5 ${lineWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
                {(isAdd || isRemove) && (
                  <span className="sr-only">{isAdd ? "Added: " : "Removed: "}</span>
                )}
                {tokens ? (
                  tokens.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))
                ) : (
                  <span
                    className={
                      isAdd
                        ? "text-[var(--diff-add-text)]"
                        : isRemove
                          ? "text-[var(--diff-remove-text)]"
                          : "text-foreground/65"
                    }
                  >
                    {line.content}
                  </span>
                )}
              </span>
            </div>
            {editing && activeThreadId && filePath && lineNumber !== null ? (
              <DiffAnnotationEditor
                threadId={activeThreadId}
                annotation={annotation}
                target={{
                  filePath,
                  side,
                  line: lineNumber,
                  lineContent: line.content,
                }}
                onClose={() => setEditingTarget(null)}
              />
            ) : null}
          </div>
        );
      })}
      </div>
    </div>
  );
});
