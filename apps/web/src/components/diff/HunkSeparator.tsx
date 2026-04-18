import { Separator } from "@/components/ui/separator";

/** Props for HunkSeparator. */
interface HunkSeparatorProps {
  hiddenLineCount: number;
}

/**
 * Hunk separator: a thin horizontal rule with an inline label indicating how many
 * unchanged lines are hidden between hunks. Typographic rather than iconographic.
 */
export function HunkSeparator({ hiddenLineCount }: HunkSeparatorProps) {
  return (
    <div className="flex select-none items-center gap-3 px-3 py-1.5 text-[10px] text-muted-foreground/45">
      <Separator className="flex-1 bg-border/40" />
      <span className="font-mono italic tabular-nums tracking-tight">
        {hiddenLineCount} unchanged line{hiddenLineCount !== 1 ? "s" : ""}
      </span>
      <Separator className="flex-1 bg-border/40" />
    </div>
  );
}
