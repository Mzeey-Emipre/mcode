import type { ParsedDiffLine } from "@/lib/diff-parser";
import { getFirstHunkHeaderIndex } from "@/lib/diff-parser";
import { useDiffHighlighter } from "@/hooks/useDiffHighlighter";
import { useShikiTheme } from "@/hooks/useTheme";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { HunkSeparator } from "./HunkSeparator";

/** Props for UnifiedDiff. */
interface UnifiedDiffProps {
  lines: ParsedDiffLine[];
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
export function UnifiedDiff({
  lines,
  language = "text",
  skipLeadingHunkSeparator = false,
}: UnifiedDiffProps) {
  const theme = useShikiTheme();
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const lineWrap = useDiffStore((s) =>
    activeThreadId ? s.getLineWrap(activeThreadId) : true,
  );
  const { getLineTokens } = useDiffHighlighter(lines, language, theme, language !== "text");
  const firstHunkHeaderIndex = skipLeadingHunkSeparator ? getFirstHunkHeaderIndex(lines) : -1;

  return (
    <div className={`select-text text-[12px] font-mono leading-5 ${lineWrap ? "overflow-x-hidden" : "overflow-x-auto"}`}>
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

        // Gutter accent: a 2px tinted strip between line numbers and content.
        // This replaces the +/- character column — same signal, less noise.
        const gutterAccent = isAdd
          ? "bg-[var(--diff-add-gutter)]"
          : isRemove
            ? "bg-[var(--diff-remove-gutter)]"
            : "bg-transparent";

        return (
          <div key={i} className={`flex items-stretch ${rowBg}`}>
            <span className="inline-flex w-10 shrink-0 select-none items-center justify-end pr-2.5 text-[10px] tabular-nums text-muted-foreground">
              {line.oldLineNo ?? ""}
            </span>
            <span className="inline-flex w-10 shrink-0 select-none items-center justify-end pr-2.5 text-[10px] tabular-nums text-muted-foreground">
              {line.newLineNo ?? ""}
            </span>
            <span className={`w-[2px] shrink-0 ${gutterAccent}`} aria-hidden="true" />
            <span className={`flex-1 pl-3 pr-2 ${lineWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
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
        );
      })}
      </div>
    </div>
  );
}
