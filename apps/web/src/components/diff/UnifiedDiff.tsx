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

interface UnifiedLinePresentation {
  readonly backgroundClass: string;
  readonly changeDescription: string | null;
  readonly changeMarker: string;
  readonly lineNumber: number | null;
  readonly side: "left" | "right";
  readonly textClass: string;
}

interface DiffAnnotationTarget {
  readonly key: string;
  readonly filePath: string;
  readonly side: "left" | "right";
  readonly line: number;
  readonly lineContent: string;
}

function getLinePresentation(line: ParsedDiffLine): UnifiedLinePresentation {
  if (line.type === "add") {
    return {
      backgroundClass: "bg-[var(--diff-add-bg)] hover:bg-[var(--diff-add-bg-hover)]",
      changeDescription: "Added: ",
      changeMarker: "+",
      lineNumber: line.newLineNo,
      side: "right",
      textClass: "text-[var(--diff-add-text)]",
    };
  }
  if (line.type === "remove") {
    return {
      backgroundClass: "bg-[var(--diff-remove-bg)] hover:bg-[var(--diff-remove-bg-hover)]",
      changeDescription: "Removed: ",
      changeMarker: "−",
      lineNumber: line.oldLineNo,
      side: "left",
      textClass: "text-[var(--diff-remove-text)]",
    };
  }
  return {
    backgroundClass: "hover:bg-muted/[0.06]",
    changeDescription: null,
    changeMarker: "",
    lineNumber: line.newLineNo ?? line.oldLineNo,
    side: "right",
    textClass: "text-foreground/65",
  };
}

function getAnnotationTarget(
  activeThreadId: string | null,
  filePath: string | undefined,
  presentation: UnifiedLinePresentation,
  line: ParsedDiffLine,
): DiffAnnotationTarget | null {
  if (!activeThreadId || !filePath || presentation.lineNumber === null) return null;
  return {
    key: `${presentation.side}:${presentation.lineNumber}`,
    filePath,
    side: presentation.side,
    line: presentation.lineNumber,
    lineContent: line.content,
  };
}

function shouldRenderHunk(
  line: ParsedDiffLine,
  index: number,
  firstHunkHeaderIndex: number,
  skipLeadingHunkSeparator: boolean,
): boolean {
  return line.type === "header" &&
    line.content.startsWith("@@") &&
    (line.hiddenLineCount ?? 0) > 0 &&
    (!skipLeadingHunkSeparator || index !== firstHunkHeaderIndex);
}

function UnifiedHunk({
  line,
  index,
  firstHunkHeaderIndex,
  skipLeadingHunkSeparator,
}: {
  readonly line: ParsedDiffLine;
  readonly index: number;
  readonly firstHunkHeaderIndex: number;
  readonly skipLeadingHunkSeparator: boolean;
}) {
  if (!shouldRenderHunk(line, index, firstHunkHeaderIndex, skipLeadingHunkSeparator)) {
    return null;
  }
  return <HunkSeparator hiddenLineCount={line.hiddenLineCount!} />;
}

function UnifiedCommentButton({
  annotation,
  editing,
  target,
  onToggle,
}: {
  readonly annotation: SavedDiffAnnotation | undefined;
  readonly editing: boolean;
  readonly target: DiffAnnotationTarget | null;
  readonly onToggle: () => void;
}) {
  if (!target) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`${annotation ? "Edit" : "Add"} comment on line ${target.line}`}
      className={cn(
        "pointer-events-none absolute left-0.5 top-0.5 z-10 size-6 rounded-md bg-foreground text-background opacity-0 shadow-none transition-opacity duration-100 hover:bg-foreground hover:text-background group-hover/diff-line:pointer-events-auto group-hover/diff-line:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 dark:hover:bg-foreground dark:hover:text-background motion-reduce:transition-none",
        (annotation || editing) && "pointer-events-auto opacity-100",
      )}
      onClick={onToggle}
    >
      {annotation ? (
        <span className="font-mono text-[1rem] font-semibold tabular-nums">
          {annotation.displayNumber}
        </span>
      ) : (
        <Plus size={16} strokeWidth={2.5} aria-hidden />
      )}
    </Button>
  );
}

function UnifiedLineContent({
  line,
  lineWrap,
  presentation,
  tokens,
}: {
  readonly line: ParsedDiffLine;
  readonly lineWrap: boolean;
  readonly presentation: UnifiedLinePresentation;
  readonly tokens: ReturnType<ReturnType<typeof useDiffHighlighter>["getLineTokens"]>;
}) {
  return (
    <span className={`flex-1 px-2 py-1 leading-5 ${lineWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
      {presentation.changeDescription ? (
        <span className="sr-only">{presentation.changeDescription}</span>
      ) : null}
      {tokens ? (
        tokens.map((token, tokenIndex) => (
          <span key={tokenIndex} style={{ color: token.color }}>
            {token.content}
          </span>
        ))
      ) : (
        <span className={presentation.textClass}>{line.content}</span>
      )}
    </span>
  );
}

function UnifiedLine({
  activeThreadId,
  annotationsByTarget,
  editingTarget,
  filePath,
  getLineTokens,
  index,
  line,
  lineWrap,
  onEditTargetChange,
}: {
  readonly activeThreadId: string | null;
  readonly annotationsByTarget: ReadonlyMap<string, SavedDiffAnnotation>;
  readonly editingTarget: string | null;
  readonly filePath: string | undefined;
  readonly getLineTokens: ReturnType<typeof useDiffHighlighter>["getLineTokens"];
  readonly index: number;
  readonly line: ParsedDiffLine;
  readonly lineWrap: boolean;
  readonly onEditTargetChange: (target: string | null) => void;
}) {
  const presentation = getLinePresentation(line);
  const target = getAnnotationTarget(activeThreadId, filePath, presentation, line);
  const annotation = target ? annotationsByTarget.get(target.key) : undefined;
  const editing = target?.key === editingTarget;
  const tokens = getLineTokens(index);

  return (
    <div>
      <div
        className={cn(
          "group/diff-line relative flex min-h-7 items-stretch outline-none",
          presentation.backgroundClass,
          editing && "ring-1 ring-inset ring-primary/70",
        )}
      >
        <UnifiedCommentButton
          annotation={annotation}
          editing={editing}
          target={target}
          onToggle={() => onEditTargetChange(editing ? null : target!.key)}
        />
        <span
          aria-hidden
          data-testid="dev-diff-gutter"
          className="inline-grid w-10 shrink-0 select-none grid-cols-[0.75rem_1fr] items-center bg-page/35 pr-1.5 text-[1rem] tabular-nums text-muted-foreground/70"
        >
          <span className="text-center text-current">{presentation.changeMarker}</span>
          <span className="text-right">{presentation.lineNumber ?? ""}</span>
        </span>
        <UnifiedLineContent
          line={line}
          lineWrap={lineWrap}
          presentation={presentation}
          tokens={tokens}
        />
      </div>
      {editing && target && activeThreadId ? (
        <DiffAnnotationEditor
          threadId={activeThreadId}
          annotation={annotation}
          target={target}
          onClose={() => onEditTargetChange(null)}
        />
      ) : null}
    </div>
  );
}

function UnifiedRow({
  activeThreadId,
  annotationsByTarget,
  editingTarget,
  filePath,
  firstHunkHeaderIndex,
  getLineTokens,
  index,
  line,
  lineWrap,
  onEditTargetChange,
  skipLeadingHunkSeparator,
}: {
  readonly activeThreadId: string | null;
  readonly annotationsByTarget: ReadonlyMap<string, SavedDiffAnnotation>;
  readonly editingTarget: string | null;
  readonly filePath: string | undefined;
  readonly firstHunkHeaderIndex: number;
  readonly getLineTokens: ReturnType<typeof useDiffHighlighter>["getLineTokens"];
  readonly index: number;
  readonly line: ParsedDiffLine;
  readonly lineWrap: boolean;
  readonly onEditTargetChange: (target: string | null) => void;
  readonly skipLeadingHunkSeparator: boolean;
}) {
  if (line.type === "header") {
    return (
      <UnifiedHunk
        line={line}
        index={index}
        firstHunkHeaderIndex={firstHunkHeaderIndex}
        skipLeadingHunkSeparator={skipLeadingHunkSeparator}
      />
    );
  }
  return (
    <UnifiedLine
      activeThreadId={activeThreadId}
      annotationsByTarget={annotationsByTarget}
      editingTarget={editingTarget}
      filePath={filePath}
      getLineTokens={getLineTokens}
      index={index}
      line={line}
      lineWrap={lineWrap}
      onEditTargetChange={onEditTargetChange}
    />
  );
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
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const annotations = usePreviewAnnotationStore((state) =>
    activeThreadId
      ? (state.diffByThread[activeThreadId] ?? EMPTY_DIFF_ANNOTATIONS)
      : EMPTY_DIFF_ANNOTATIONS,
  );
  const annotationsByTarget = useMemo(
    () => new Map(
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
  const lineWrap = useDiffStore((state) =>
    activeThreadId ? state.getLineWrap(activeThreadId) : true,
  );
  const { getLineTokens } = useDiffHighlighter(lines, language, theme, language !== "text");
  const firstHunkHeaderIndex = skipLeadingHunkSeparator ? getFirstHunkHeaderIndex(lines) : -1;

  return (
    <div className={`select-text text-xs font-mono leading-5 ${lineWrap ? "overflow-x-hidden" : "overflow-x-auto"}`}>
      <div className={lineWrap ? "w-full" : "w-fit min-w-full"}>
        {lines.map((line, index) => (
          <UnifiedRow
            key={index}
            activeThreadId={activeThreadId}
            annotationsByTarget={annotationsByTarget}
            editingTarget={editingTarget}
            filePath={filePath}
            firstHunkHeaderIndex={firstHunkHeaderIndex}
            getLineTokens={getLineTokens}
            index={index}
            line={line}
            lineWrap={lineWrap}
            onEditTargetChange={setEditingTarget}
            skipLeadingHunkSeparator={skipLeadingHunkSeparator}
          />
        ))}
      </div>
    </div>
  );
});
