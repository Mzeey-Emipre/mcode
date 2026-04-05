import type { ParsedDiffLine } from "@/lib/diff-parser";

/** Props for UnifiedDiff. */
interface UnifiedDiffProps {
  lines: ParsedDiffLine[];
}

/** Unified diff renderer: line numbers, +/- prefix, light/dark-mode aware colors. */
export function UnifiedDiff({ lines }: UnifiedDiffProps) {
  return (
    <div className="select-text overflow-x-auto text-[11px] font-mono leading-relaxed">
      {lines.map((line, i) => {
        if (line.type === "header") {
          // Only render @@ hunk headers as visual dividers; skip git metadata lines
          if (!line.content.startsWith("@@")) return null;
          return (
            <div
              key={i}
              className="my-0.5 flex items-center border-y border-border/10 bg-muted/20 px-2 py-0.5"
            >
              <span className="truncate text-[10px] text-muted-foreground/50">{line.content}</span>
            </div>
          );
        }

        const isAdd = line.type === "add";
        const isRemove = line.type === "remove";

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
            <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/10 pr-2 text-[10px] text-muted-foreground/30">
              {line.oldLineNo ?? ""}
            </span>
            {/* New line number */}
            <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/10 pr-2 text-[10px] text-muted-foreground/30">
              {line.newLineNo ?? ""}
            </span>
            {/* Sign */}
            <span
              className={`inline-flex w-5 shrink-0 select-none items-center justify-center text-[11px] ${
                isAdd
                  ? "text-emerald-600 dark:text-emerald-400/70"
                  : isRemove
                    ? "text-red-600 dark:text-red-400/70"
                    : "text-transparent"
              }`}
            >
              {isAdd ? "+" : isRemove ? "-" : " "}
            </span>
            {/* Content */}
            <span
              className={`flex-1 whitespace-pre px-1 ${
                isAdd
                  ? "text-emerald-900 dark:text-emerald-100/80"
                  : isRemove
                    ? "text-red-900 dark:text-red-100/70"
                    : "text-foreground/60"
              }`}
            >
              {line.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}
