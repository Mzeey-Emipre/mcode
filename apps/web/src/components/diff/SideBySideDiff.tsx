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

type DiffSide = "left" | "right";
type SideBySideCell = SideBySideRow[DiffSide];

interface DiffAnnotationTarget {
  readonly key: string;
  readonly filePath: string;
  readonly side: DiffSide;
  readonly line: number;
  readonly lineContent: string;
}

interface IndexedDiffLine {
  readonly index: number;
  readonly line: ParsedDiffLine;
}

/** Convert flat diff lines into paired left/right rows for side-by-side rendering. */
function buildRows(lines: ParsedDiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.type === "header" || line.type === "context") {
      rows.push(createUnchangedRow(line, index));
      index += 1;
      continue;
    }
    index = appendChangedRows(lines, index, rows);
  }

  return rows;
}

function createUnchangedRow(line: ParsedDiffLine, diffIndex: number): SideBySideRow {
  if (line.type === "header") {
    const header = {
      lineNo: null,
      content: line.content,
      type: "header" as const,
      diffIndex,
      hiddenLineCount: line.hiddenLineCount,
    };
    return { left: header, right: header };
  }
  return {
    left: { lineNo: line.oldLineNo, content: line.content, type: "context", diffIndex },
    right: { lineNo: line.newLineNo, content: line.content, type: "context", diffIndex },
  };
}

function appendChangedRows(
  lines: ParsedDiffLine[],
  startIndex: number,
  rows: SideBySideRow[],
): number {
  const removeGroup = collectLineGroup(lines, startIndex, "remove");
  const addGroup = collectLineGroup(lines, removeGroup.nextIndex, "add");
  const rowCount = Math.max(removeGroup.lines.length, addGroup.lines.length);

  for (let index = 0; index < rowCount; index += 1) {
    rows.push(createChangedRow(removeGroup.lines[index], addGroup.lines[index]));
  }
  return addGroup.nextIndex;
}

function collectLineGroup(
  lines: ParsedDiffLine[],
  startIndex: number,
  type: "add" | "remove",
): { readonly lines: IndexedDiffLine[]; readonly nextIndex: number } {
  const group: IndexedDiffLine[] = [];
  let index = startIndex;
  while (index < lines.length && lines[index].type === type) {
    group.push({ line: lines[index], index });
    index += 1;
  }
  return { lines: group, nextIndex: index };
}

function createChangedRow(
  removeLine: IndexedDiffLine | undefined,
  addLine: IndexedDiffLine | undefined,
): SideBySideRow {
  return {
    left: removeLine
      ? {
          lineNo: removeLine.line.oldLineNo,
          content: removeLine.line.content,
          type: "remove",
          diffIndex: removeLine.index,
        }
      : emptyCell(),
    right: addLine
      ? {
          lineNo: addLine.line.newLineNo,
          content: addLine.line.content,
          type: "add",
          diffIndex: addLine.index,
        }
      : emptyCell(),
  };
}

function emptyCell() {
  return { lineNo: null, content: "", type: "empty" as const, diffIndex: null };
}

const LEFT_BG: Record<SideBySideRow["left"]["type"], string> = {
  remove: "bg-[var(--diff-remove-bg)] hover:bg-[var(--diff-remove-bg-hover)]",
  context: "hover:bg-muted/[0.06]",
  header: "bg-muted/15",
  empty: "bg-muted/[0.04]",
};

const RIGHT_BG: Record<SideBySideRow["right"]["type"], string> = {
  add: "bg-[var(--diff-add-bg)] hover:bg-[var(--diff-add-bg-hover)]",
  context: "hover:bg-muted/[0.06]",
  header: "bg-muted/15",
  empty: "bg-muted/[0.04]",
};

function getCellBackground(side: DiffSide, cell: SideBySideCell): string {
  return side === "left"
    ? LEFT_BG[cell.type as SideBySideRow["left"]["type"]]
    : RIGHT_BG[cell.type as SideBySideRow["right"]["type"]];
}

function getCellTextClass(cell: SideBySideCell): string {
  if (cell.type === "add") return "text-[var(--diff-add-text)]";
  if (cell.type === "remove") return "text-[var(--diff-remove-text)]";
  return cell.type === "context" ? "text-foreground/65" : "";
}

function getChangeDescription(cell: SideBySideCell): string | null {
  if (cell.type === "add") return "Added: ";
  return cell.type === "remove" ? "Removed: " : null;
}

function getAnnotationTarget(
  activeThreadId: string | null,
  filePath: string | undefined,
  side: DiffSide,
  cell: SideBySideCell,
): DiffAnnotationTarget | null {
  if (!activeThreadId || !filePath || cell.lineNo === null) return null;
  return {
    key: `${side}:${cell.lineNo}`,
    filePath,
    side,
    line: cell.lineNo,
    lineContent: cell.content,
  };
}

function shouldRenderHunk(
  cell: SideBySideCell,
  diffIndex: number,
  firstHunkHeaderIndex: number,
  skipLeadingHunkSeparator: boolean,
): boolean {
  return cell.type === "header" &&
    cell.content.startsWith("@@") &&
    (cell.hiddenLineCount ?? 0) > 0 &&
    (!skipLeadingHunkSeparator || diffIndex !== firstHunkHeaderIndex);
}

function SideBySideHunk({
  cell,
  diffIndex,
  firstHunkHeaderIndex,
  skipLeadingHunkSeparator,
}: {
  readonly cell: SideBySideCell;
  readonly diffIndex: number;
  readonly firstHunkHeaderIndex: number;
  readonly skipLeadingHunkSeparator: boolean;
}) {
  if (!shouldRenderHunk(cell, diffIndex, firstHunkHeaderIndex, skipLeadingHunkSeparator)) {
    return null;
  }
  return <HunkSeparator hiddenLineCount={cell.hiddenLineCount!} />;
}

function DiffLineCommentButton({
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

function DiffLineContent({
  cell,
  lineWrap,
  tokens,
}: {
  readonly cell: SideBySideCell;
  readonly lineWrap: boolean;
  readonly tokens: ReturnType<ReturnType<typeof useDiffHighlighter>["getLineTokens"]>;
}) {
  const changeDescription = getChangeDescription(cell);
  return (
    <span className={`flex-1 px-2 py-1 leading-5 ${lineWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
      {changeDescription ? <span className="sr-only">{changeDescription}</span> : null}
      {tokens ? (
        tokens.map((token, index) => (
          <span key={index} style={{ color: token.color }}>
            {token.content}
          </span>
        ))
      ) : (
        <span className={getCellTextClass(cell)}>{cell.content}</span>
      )}
    </span>
  );
}

function getNextEditingTarget(editing: boolean, target: DiffAnnotationTarget | null): string | null {
  return editing ? null : (target?.key ?? null);
}

function SideBySideAnnotationEditor({
  activeThreadId,
  annotation,
  editing,
  onEditTargetChange,
  target,
}: {
  readonly activeThreadId: string | null;
  readonly annotation: SavedDiffAnnotation | undefined;
  readonly editing: boolean;
  readonly onEditTargetChange: (target: string | null) => void;
  readonly target: DiffAnnotationTarget | null;
}) {
  if (!editing || !target || !activeThreadId) return null;
  return (
    <DiffAnnotationEditor
      threadId={activeThreadId}
      annotation={annotation}
      target={target}
      onClose={() => onEditTargetChange(null)}
    />
  );
}

function getSideBySideLineState(
  activeThreadId: string | null,
  annotationsByTarget: ReadonlyMap<string, SavedDiffAnnotation>,
  cell: SideBySideCell,
  editingTarget: string | null,
  filePath: string | undefined,
  getLineTokens: ReturnType<typeof useDiffHighlighter>["getLineTokens"],
  side: DiffSide,
) {
  const target = getAnnotationTarget(activeThreadId, filePath, side, cell);
  return {
    annotation: target ? annotationsByTarget.get(target.key) : undefined,
    editing: target?.key === editingTarget,
    marker: getSideBySideMarker(side, cell),
    target,
    tokens: cell.diffIndex === null ? null : getLineTokens(cell.diffIndex),
  };
}

function getSideBySideMarker(side: DiffSide, cell: SideBySideCell): string {
  if (side === "left" && cell.type === "remove") return "−";
  return side === "right" && cell.type === "add" ? "+" : "";
}

function SideBySideLine({
  activeThreadId,
  annotationsByTarget,
  cell,
  editingTarget,
  filePath,
  getLineTokens,
  lineWrap,
  onEditTargetChange,
  side,
}: {
  readonly activeThreadId: string | null;
  readonly annotationsByTarget: ReadonlyMap<string, SavedDiffAnnotation>;
  readonly cell: SideBySideCell;
  readonly editingTarget: string | null;
  readonly filePath: string | undefined;
  readonly getLineTokens: ReturnType<typeof useDiffHighlighter>["getLineTokens"];
  readonly lineWrap: boolean;
  readonly onEditTargetChange: (target: string | null) => void;
  readonly side: DiffSide;
}) {
  const { annotation, editing, marker, target, tokens } = getSideBySideLineState(
    activeThreadId,
    annotationsByTarget,
    cell,
    editingTarget,
    filePath,
    getLineTokens,
    side,
  );

  return (
    <div>
      <div
        className={cn(
          "group/diff-line relative flex min-h-7 items-stretch",
          getCellBackground(side, cell),
          editing && "ring-1 ring-inset ring-primary/70",
        )}
      >
        <DiffLineCommentButton
          annotation={annotation}
          editing={editing}
          target={target}
          onToggle={() => onEditTargetChange(getNextEditingTarget(editing, target))}
        />
        <span
          aria-hidden
          className="inline-grid w-10 shrink-0 select-none grid-cols-[0.75rem_1fr] items-center bg-page/35 pr-1.5 text-[1rem] tabular-nums text-muted-foreground/70"
        >
          <span className="text-center">{marker}</span>
          <span className="text-right">{cell.lineNo ?? ""}</span>
        </span>
        <DiffLineContent cell={cell} lineWrap={lineWrap} tokens={tokens} />
      </div>
      <SideBySideAnnotationEditor
        activeThreadId={activeThreadId}
        annotation={annotation}
        editing={editing}
        onEditTargetChange={onEditTargetChange}
        target={target}
      />
    </div>
  );
}

function SideBySideRowView({
  activeThreadId,
  annotationsByTarget,
  editingTarget,
  filePath,
  firstHunkHeaderIndex,
  getLineTokens,
  lineWrap,
  onEditTargetChange,
  row,
  side,
  skipLeadingHunkSeparator,
}: {
  readonly activeThreadId: string | null;
  readonly annotationsByTarget: ReadonlyMap<string, SavedDiffAnnotation>;
  readonly editingTarget: string | null;
  readonly filePath: string | undefined;
  readonly firstHunkHeaderIndex: number;
  readonly getLineTokens: ReturnType<typeof useDiffHighlighter>["getLineTokens"];
  readonly lineWrap: boolean;
  readonly onEditTargetChange: (target: string | null) => void;
  readonly row: SideBySideRow;
  readonly side: DiffSide;
  readonly skipLeadingHunkSeparator: boolean;
}) {
  const cell = row[side];
  if (cell.type === "header") {
    return (
      <SideBySideHunk
        cell={cell}
        diffIndex={cell.diffIndex ?? -1}
        firstHunkHeaderIndex={firstHunkHeaderIndex}
        skipLeadingHunkSeparator={skipLeadingHunkSeparator}
      />
    );
  }
  return (
    <SideBySideLine
      activeThreadId={activeThreadId}
      annotationsByTarget={annotationsByTarget}
      cell={cell}
      editingTarget={editingTarget}
      filePath={filePath}
      getLineTokens={getLineTokens}
      lineWrap={lineWrap}
      onEditTargetChange={onEditTargetChange}
      side={side}
    />
  );
}

function SideBySidePane({
  activeThreadId,
  annotationsByTarget,
  editingTarget,
  filePath,
  firstHunkHeaderIndex,
  getLineTokens,
  lineWrap,
  onEditTargetChange,
  rows,
  side,
  skipLeadingHunkSeparator,
}: {
  readonly activeThreadId: string | null;
  readonly annotationsByTarget: ReadonlyMap<string, SavedDiffAnnotation>;
  readonly editingTarget: string | null;
  readonly filePath: string | undefined;
  readonly firstHunkHeaderIndex: number;
  readonly getLineTokens: ReturnType<typeof useDiffHighlighter>["getLineTokens"];
  readonly lineWrap: boolean;
  readonly onEditTargetChange: (target: string | null) => void;
  readonly rows: readonly SideBySideRow[];
  readonly side: DiffSide;
  readonly skipLeadingHunkSeparator: boolean;
}) {
  const paneClassName = side === "left" ? "flex-1 border-r border-border/15" : "flex-1";
  return (
    <div className={`${paneClassName} ${lineWrap ? "overflow-x-hidden" : "overflow-x-auto"}`}>
      <div className={lineWrap ? "w-full" : "w-fit min-w-full"}>
        {rows.map((row, rowIndex) => (
          <SideBySideRowView
            key={rowIndex}
            activeThreadId={activeThreadId}
            annotationsByTarget={annotationsByTarget}
            editingTarget={editingTarget}
            filePath={filePath}
            firstHunkHeaderIndex={firstHunkHeaderIndex}
            getLineTokens={getLineTokens}
            lineWrap={lineWrap}
            onEditTargetChange={onEditTargetChange}
            row={row}
            side={side}
            skipLeadingHunkSeparator={skipLeadingHunkSeparator}
          />
        ))}
      </div>
    </div>
  );
}

/** Side-by-side diff renderer with syntax highlighting and hunk separator bars. */
export const SideBySideDiff = memo(function SideBySideDiff({
  lines,
  filePath,
  language = "text",
  skipLeadingHunkSeparator = false,
}: SideBySideDiffProps) {
  const rows = useMemo(() => buildRows(lines), [lines]);
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
        .map((annotation) => [`${annotation.side}:${annotation.line}`, annotation]),
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
    <div className="flex select-text text-xs font-mono leading-5">
      <SideBySidePane
        activeThreadId={activeThreadId}
        annotationsByTarget={annotationsByTarget}
        editingTarget={editingTarget}
        filePath={filePath}
        firstHunkHeaderIndex={firstHunkHeaderIndex}
        getLineTokens={getLineTokens}
        lineWrap={lineWrap}
        onEditTargetChange={setEditingTarget}
        rows={rows}
        side="left"
        skipLeadingHunkSeparator={skipLeadingHunkSeparator}
      />
      <SideBySidePane
        activeThreadId={activeThreadId}
        annotationsByTarget={annotationsByTarget}
        editingTarget={editingTarget}
        filePath={filePath}
        firstHunkHeaderIndex={firstHunkHeaderIndex}
        getLineTokens={getLineTokens}
        lineWrap={lineWrap}
        onEditTargetChange={setEditingTarget}
        rows={rows}
        side="right"
        skipLeadingHunkSeparator={skipLeadingHunkSeparator}
      />
    </div>
  );
});
