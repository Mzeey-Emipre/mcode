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

const LEFT_CELL: Record<string, string> = {
  remove: "bg-red-950/30 text-red-100/70 hover:bg-red-950/50",
  context: "text-foreground/60 hover:bg-muted/10",
  header: "bg-muted/20 text-muted-foreground/40",
  empty: "bg-muted/5",
};

const RIGHT_CELL: Record<string, string> = {
  add: "bg-emerald-950/30 text-emerald-100/80 hover:bg-emerald-950/50",
  context: "text-foreground/60 hover:bg-muted/10",
  header: "bg-muted/20 text-muted-foreground/40",
  empty: "bg-muted/5",
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
    <div className="flex h-full select-text text-[11px] font-mono leading-relaxed">
      {/* Left (removed) */}
      <div
        ref={leftRef}
        className="flex-1 overflow-auto border-r border-border/20"
        onScroll={() => syncScroll("left")}
      >
        {rows.map((row, i) => (
          <div key={i} className={`flex items-stretch ${LEFT_CELL[row.left.type]}`}>
            <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/10 pr-2 text-[10px] text-muted-foreground/20">
              {row.left.lineNo ?? ""}
            </span>
            <span className="flex-1 whitespace-pre px-1">{row.left.content}</span>
          </div>
        ))}
      </div>

      {/* Right (added) */}
      <div
        ref={rightRef}
        className="flex-1 overflow-auto"
        onScroll={() => syncScroll("right")}
      >
        {rows.map((row, i) => (
          <div key={i} className={`flex items-stretch ${RIGHT_CELL[row.right.type]}`}>
            <span className="inline-flex w-9 shrink-0 select-none items-center justify-end border-r border-border/10 pr-2 text-[10px] text-muted-foreground/20">
              {row.right.lineNo ?? ""}
            </span>
            <span className="flex-1 whitespace-pre px-1">{row.right.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
