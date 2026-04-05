import type { ParsedDiffLine } from "@/lib/diff-parser";

/** Props for UnifiedDiff. */
interface UnifiedDiffProps {
  lines: ParsedDiffLine[];
}

/** Unified diff renderer: line numbers, +/- prefix, green/red backgrounds. */
export function UnifiedDiff({ lines }: UnifiedDiffProps) {
  return (
    <div className="select-text overflow-x-auto text-[11px] font-mono leading-relaxed">
      {lines.map((line, i) => {
        if (line.type === "header") {
          return (
            <div
              key={i}
              className="my-0.5 flex items-center border-y border-border/10 bg-muted/20 px-2 py-0.5"
            >
              <span className="truncate text-[10px] text-muted-foreground/40">{line.content}</span>
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
                ? "bg-emerald-950/30 hover:bg-emerald-950/50"
                : isRemove
                  ? "bg-red-950/30 hover:bg-red-950/50"
                  : "hover:bg-muted/10"
            }`}
          >
            {/* Old line number */}
            <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/10 pr-2 text-[10px] text-muted-foreground/20">
              {line.oldLineNo ?? ""}
            </span>
            {/* New line number */}
            <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/10 pr-2 text-[10px] text-muted-foreground/20">
              {line.newLineNo ?? ""}
            </span>
            {/* Sign */}
            <span
              className={`inline-flex w-5 shrink-0 select-none items-center justify-center text-[11px] ${
                isAdd
                  ? "text-emerald-400/60"
                  : isRemove
                    ? "text-red-400/60"
                    : "text-transparent"
              }`}
            >
              {isAdd ? "+" : isRemove ? "-" : " "}
            </span>
            {/* Content */}
            <span
              className={`flex-1 whitespace-pre px-1 ${
                isAdd
                  ? "text-emerald-100/80"
                  : isRemove
                    ? "text-red-100/70"
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
