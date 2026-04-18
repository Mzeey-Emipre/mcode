import { useMemo } from "react";
import type { ParsedDiffLine } from "@/lib/diff-parser";
import { useDiffHighlighter } from "@/hooks/useDiffHighlighter";
import { useShikiTheme } from "@/hooks/useTheme";
import { useDiffStore } from "@/stores/diffStore";
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

const LEFT_GUTTER: Record<string, string> = {
  remove: "bg-[var(--diff-remove-gutter)]",
  context: "bg-transparent",
  header: "bg-transparent",
  empty: "bg-transparent",
};

const RIGHT_GUTTER: Record<string, string> = {
  add: "bg-[var(--diff-add-gutter)]",
  context: "bg-transparent",
  header: "bg-transparent",
  empty: "bg-transparent",
};

/** Side-by-side diff renderer with syntax highlighting and hunk separator bars. */
export function SideBySideDiff({ lines, language = "text" }: SideBySideDiffProps) {
  const rows = useMemo(() => buildRows(lines), [lines]);
  const theme = useShikiTheme();
  const lineWrap = useDiffStore((s) => s.lineWrap);
  const { getLineTokens } = useDiffHighlighter(lines, language, theme, language !== "text");

  return (
    <div className="flex select-text text-[12px] font-mono leading-5">
      {/* Left (removed) */}
      <div className={`flex-1 border-r border-border/15 ${lineWrap ? "overflow-x-hidden" : "overflow-x-auto"}`}>
        <div className={lineWrap ? "w-full" : "w-fit min-w-full"}>
        {rows.map((row, i) => {
          if (row.left.type === "header") {
            if (!row.left.content.startsWith("@@")) return null;
            if (!row.left.hiddenLineCount || row.left.hiddenLineCount <= 0) return null;
            return <HunkSeparator key={i} hiddenLineCount={row.left.hiddenLineCount} />;
          }

          const tokens = row.left.diffIndex !== null ? getLineTokens(row.left.diffIndex) : null;

          return (
            <div key={i} className={`flex items-stretch ${LEFT_BG[row.left.type]}`}>
              <span className="inline-flex w-10 shrink-0 select-none items-center justify-end pr-2.5 text-[10px] tabular-nums text-muted-foreground/45">
                {row.left.lineNo ?? ""}
              </span>
              <span className={`w-[2px] shrink-0 ${LEFT_GUTTER[row.left.type]}`} aria-hidden="true" />
              <span className={`flex-1 pl-3 pr-2 ${lineWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
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
            if (!row.right.hiddenLineCount || row.right.hiddenLineCount <= 0) return null;
            return <HunkSeparator key={i} hiddenLineCount={row.right.hiddenLineCount} />;
          }

          const tokens = row.right.diffIndex !== null ? getLineTokens(row.right.diffIndex) : null;

          return (
            <div key={i} className={`flex items-stretch ${RIGHT_BG[row.right.type]}`}>
              <span className="inline-flex w-10 shrink-0 select-none items-center justify-end pr-2.5 text-[10px] tabular-nums text-muted-foreground/45">
                {row.right.lineNo ?? ""}
              </span>
              <span className={`w-[2px] shrink-0 ${RIGHT_GUTTER[row.right.type]}`} aria-hidden="true" />
              <span className={`flex-1 pl-3 pr-2 ${lineWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
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
          );
        })}
        </div>
      </div>
    </div>
  );
}
