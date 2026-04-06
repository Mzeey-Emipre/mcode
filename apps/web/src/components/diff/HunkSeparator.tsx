import { ChevronsUpDown } from "lucide-react";

/** Props for HunkSeparator. */
interface HunkSeparatorProps {
  hiddenLineCount: number;
}

/** Separator bar shown between diff hunks indicating how many unchanged lines are hidden. */
export function HunkSeparator({ hiddenLineCount }: HunkSeparatorProps) {
  return (
    <div className="my-0.5 flex items-center justify-center gap-1.5 border-y border-border/10 bg-muted/10 px-2 py-1">
      <ChevronsUpDown size={12} className="shrink-0 text-muted-foreground/25" />
      <span className="text-[10px] text-muted-foreground/40">
        {hiddenLineCount} unchanged line{hiddenLineCount !== 1 ? "s" : ""}
      </span>
    </div>
  );
}
