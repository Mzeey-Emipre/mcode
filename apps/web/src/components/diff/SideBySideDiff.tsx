import { useMemo, useRef, useCallback } from "react";
import type { ParsedDiffLine } from "@/lib/diff-parser";
import { useDiffHighlighter } from "@/hooks/useDiffHighlighter";
import { useShikiTheme } from "@/hooks/useTheme";
import { HunkSeparator } from "./HunkSeparator";

/** Props for SideBySideDiff. */
interface SideBySideDiffProps {
  lines: ParsedDiffLine[];
  /** File language for syntax highlighting (e.g. "typescript"). "text" disables highlighting. */
  language?: string;
}

/** A single paired row in the side-by-side diff layout. */
interface SideBySideRow {
  left: {
    lineNo: number | null;
    content: string;
    type: "remove" | "context" | "header" | "empty";
    /** Index into the original ParsedDiffLine[] for token lookup. */
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
  remove: "bg-red-50 hover:bg-red-100 dark:bg-red-950/30 dark:hover:bg-red-950/50",
  context: "hover:bg-muted/10",
  header: "bg-muted/20",
  empty: "bg-muted/5",
};

const RIGHT_BG: Record<string, string> = {
  add: "bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50",
  context: "hover:bg-muted/10",
  header: "bg-muted/20",
  empty: "bg-muted/5",
};

/** Side-by-side diff renderer with synchronized scrolling, syntax highlighting, and hunk separator bars. */
export function SideBySideDiff({ lines, language = "text" }: SideBySideDiffProps) {
  const rows = useMemo(() => buildRows(lines), [lines]);
  const theme = useShikiTheme();
  const { getLineTokens } = useDiffHighlighter(lines, language, theme, language !== "text");

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  const syncScroll = useCallback((source: "left" | "right") => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    const from = source === "left" ? leftRef.current : rightRef.current;
    const to = source === "left" ? rightRef.current : leftRef.current;
    if (from && to) to.scrollTop = from.scrollTop;
    syncingRef.current = false;
  }, []);

  const onScrollLeft = useCallback(() => syncScroll("left"), [syncScroll]);
  const onScrollRight = useCallback(() => syncScroll("right"), [syncScroll]);

  return (
    <div className="flex select-text text-[11px] font-mono leading-relaxed">
      {/* Left (removed) */}
      <div
        ref={leftRef}
        className="flex-1 border-r border-border/20"
        onScroll={onScrollLeft}
      >
        {rows.map((row, i) => {
          // Hunk separator bar
          if (row.left.type === "header") {
            if (!row.left.content.startsWith("@@")) return null;
            if (!row.left.hiddenLineCount || row.left.hiddenLineCount <= 0) return null;
            return <HunkSeparator key={i} hiddenLineCount={row.left.hiddenLineCount} />;
          }

          const tokens = row.left.diffIndex !== null ? getLineTokens(row.left.diffIndex) : null;

          return (
            <div key={i} className={`flex items-stretch ${LEFT_BG[row.left.type]}`}>
              <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/10 pr-2 text-[10px] text-muted-foreground/20">
                {row.left.lineNo ?? ""}
              </span>
              <span className="flex-1 whitespace-pre px-1">
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
                        ? "text-red-900 dark:text-red-100/70"
                        : row.left.type === "context"
                          ? "text-foreground/60"
                          : ""
                    }
                  >
                    {row.left.content}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {/* Right (added) */}
      <div
        ref={rightRef}
        className="flex-1"
        onScroll={onScrollRight}
      >
        {rows.map((row, i) => {
          // Hunk separator bar
          if (row.right.type === "header") {
            if (!row.right.content.startsWith("@@")) return null;
            if (!row.right.hiddenLineCount || row.right.hiddenLineCount <= 0) return null;
            return <HunkSeparator key={i} hiddenLineCount={row.right.hiddenLineCount} />;
          }

          const tokens = row.right.diffIndex !== null ? getLineTokens(row.right.diffIndex) : null;

          return (
            <div key={i} className={`flex items-stretch ${RIGHT_BG[row.right.type]}`}>
              <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/10 pr-2 text-[10px] text-muted-foreground/20">
                {row.right.lineNo ?? ""}
              </span>
              <span className="flex-1 whitespace-pre px-1">
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
                        ? "text-emerald-900 dark:text-emerald-100/80"
                        : row.right.type === "context"
                          ? "text-foreground/60"
                          : ""
                    }
                  >
                    {row.right.content}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
