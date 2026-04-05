import { useMemo, useRef, useCallback } from "react";
import type { ParsedDiffLine } from "@/lib/diff-parser";

/** Props for SideBySideDiff. */
interface SideBySideDiffProps {
  lines: ParsedDiffLine[];
}

/** A single paired row in the side-by-side diff layout. */
interface SideBySideRow {
  left: { lineNo: number | null; content: string; type: "remove" | "context" | "header" | "empty" };
  right: { lineNo: number | null; content: string; type: "add" | "context" | "header" | "empty" };
}

/** Convert flat diff lines into paired left/right rows for side-by-side rendering. */
function buildRows(lines: ParsedDiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.type === "header") {
      rows.push({
        left: { lineNo: null, content: line.content, type: "header" },
        right: { lineNo: null, content: line.content, type: "header" },
      });
      i++;
    } else if (line.type === "context") {
      rows.push({
        left: { lineNo: line.oldLineNo, content: line.content, type: "context" },
        right: { lineNo: line.newLineNo, content: line.content, type: "context" },
      });
      i++;
    } else {
      const removes: ParsedDiffLine[] = [];
      const adds: ParsedDiffLine[] = [];

      while (i < lines.length && lines[i].type === "remove") {
        removes.push(lines[i]);
        i++;
      }
      while (i < lines.length && lines[i].type === "add") {
        adds.push(lines[i]);
        i++;
      }

      const maxLen = Math.max(removes.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        const rem = removes[j];
        const add = adds[j];
        rows.push({
          left: rem
            ? { lineNo: rem.oldLineNo, content: rem.content, type: "remove" }
            : { lineNo: null, content: "", type: "empty" },
          right: add
            ? { lineNo: add.newLineNo, content: add.content, type: "add" }
            : { lineNo: null, content: "", type: "empty" },
        });
      }
    }
  }

  return rows;
}

const cellClasses: Record<string, string> = {
  add: "bg-primary/10 text-primary/70",
  remove: "bg-destructive/10 text-destructive/70",
  header: "bg-muted/30 text-muted-foreground/70",
  context: "text-muted-foreground",
  empty: "bg-muted/10",
};

/** Side-by-side diff renderer with synchronized scrolling. */
export function SideBySideDiff({ lines }: SideBySideDiffProps) {
  const rows = useMemo(() => buildRows(lines), [lines]);
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

  return (
    <div className="flex text-[11px] font-mono leading-relaxed select-text h-full">
      <div
        ref={leftRef}
        className="flex-1 overflow-auto border-r border-border/20"
        onScroll={() => syncScroll("left")}
      >
        {rows.map((row, i) => (
          <div key={i} className={cellClasses[row.left.type]}>
            <span className="inline-block w-8 select-none text-right pr-2 opacity-30 text-[10px]">
              {row.left.lineNo ?? ""}
            </span>
            {row.left.content}
          </div>
        ))}
      </div>
      <div
        ref={rightRef}
        className="flex-1 overflow-auto"
        onScroll={() => syncScroll("right")}
      >
        {rows.map((row, i) => (
          <div key={i} className={cellClasses[row.right.type]}>
            <span className="inline-block w-8 select-none text-right pr-2 opacity-30 text-[10px]">
              {row.right.lineNo ?? ""}
            </span>
            {row.right.content}
          </div>
        ))}
      </div>
    </div>
  );
}
