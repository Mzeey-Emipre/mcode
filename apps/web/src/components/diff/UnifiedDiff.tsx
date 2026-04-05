import type { ParsedDiffLine } from "@/lib/diff-parser";

/** Props for UnifiedDiff. */
interface UnifiedDiffProps {
  lines: ParsedDiffLine[];
}

const lineClasses: Record<ParsedDiffLine["type"], string> = {
  add: "bg-primary/10 text-primary/70",
  remove: "bg-destructive/10 text-destructive/70",
  header: "bg-muted/30 text-muted-foreground/70",
  context: "text-muted-foreground",
};

/** Unified diff renderer: line numbers, +/- prefix, green/red backgrounds. */
export function UnifiedDiff({ lines }: UnifiedDiffProps) {
  return (
    <div className="text-[11px] font-mono leading-relaxed select-text">
      {lines.map((line, i) => (
        <div key={i} className={lineClasses[line.type]}>
          <span className="inline-block w-8 select-none text-right pr-1 opacity-30 text-[10px]">
            {line.oldLineNo ?? ""}
          </span>
          <span className="inline-block w-8 select-none text-right pr-2 opacity-30 text-[10px]">
            {line.newLineNo ?? ""}
          </span>
          <span className="inline-block w-3 select-none text-center opacity-40">
            {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
          </span>
          {line.content}
        </div>
      ))}
    </div>
  );
}
