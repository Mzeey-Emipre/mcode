import type { ParsedDiffLine } from "@/lib/diff-parser";
import { useDiffHighlighter } from "@/hooks/useDiffHighlighter";
import { useShikiTheme } from "@/hooks/useTheme";
import { HunkSeparator } from "./HunkSeparator";

/** Props for UnifiedDiff. */
interface UnifiedDiffProps {
  lines: ParsedDiffLine[];
  /** File language for syntax highlighting (e.g. "typescript"). "text" disables highlighting. */
  language?: string;
}

/** Unified diff renderer: line numbers, +/- prefix, syntax highlighting, hunk separator bars. */
export function UnifiedDiff({ lines, language = "text" }: UnifiedDiffProps) {
  const theme = useShikiTheme();
  const { getLineTokens } = useDiffHighlighter(lines, language, theme, language !== "text");

  return (
    <div className="select-text overflow-x-auto text-[11px] font-mono leading-relaxed">
      {lines.map((line, i) => {
        if (line.type === "header") {
          // Only render @@ hunk headers; skip git metadata lines
          if (!line.content.startsWith("@@")) return null;
          // Skip bars with no hidden lines (hunk starts at line 1)
          if (!line.hiddenLineCount || line.hiddenLineCount <= 0) return null;
          return <HunkSeparator key={i} hiddenLineCount={line.hiddenLineCount} />;
        }

        const isAdd = line.type === "add";
        const isRemove = line.type === "remove";
        const tokens = getLineTokens(i);

        return (
          <div
            key={i}
            className={`flex items-stretch ${
              isAdd
                ? "bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50"
                : isRemove
                  ? "bg-red-50 hover:bg-red-100 dark:bg-red-950/30 dark:hover:bg-red-950/50"
                  : "hover:bg-muted/10"
            }`}
          >
            {/* Old line number */}
            <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/20 pr-2 text-[10px] text-muted-foreground/70">
              {line.oldLineNo ?? ""}
            </span>
            {/* New line number */}
            <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/20 pr-2 text-[10px] text-muted-foreground/70">
              {line.newLineNo ?? ""}
            </span>
            {/* Sign */}
            <span
              className={`inline-flex w-5 shrink-0 select-none items-center justify-center text-[11px] ${
                isAdd
                  ? "text-emerald-600 dark:text-emerald-400"
                  : isRemove
                    ? "text-red-600 dark:text-red-400"
                    : "text-transparent"
              }`}
            >
              {isAdd ? "+" : isRemove ? "-" : " "}
            </span>
            {/* Content: syntax-highlighted tokens when available, plain text fallback */}
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
                    isAdd
                      ? "text-emerald-900 dark:text-emerald-100/80"
                      : isRemove
                        ? "text-red-900 dark:text-red-100/70"
                        : "text-foreground/60"
                  }
                >
                  {line.content}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
