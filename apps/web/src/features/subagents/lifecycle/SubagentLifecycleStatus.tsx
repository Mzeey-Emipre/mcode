import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Semantic visual tones available for a subagent lifecycle label. */
export type SubagentLifecycleTone = "running" | "settled" | "error" | "muted";

/** Props for a compact subagent lifecycle label and status dot. */
export interface SubagentLifecycleStatusProps {
  readonly label: string;
  readonly tone: SubagentLifecycleTone;
  readonly className?: string;
}

const DOT_CLASS: Record<SubagentLifecycleTone, string> = {
  running: "bg-primary status-pulse",
  settled: "bg-[var(--diff-add-strong)]",
  error: "bg-[var(--diff-remove-strong)]",
  muted: "bg-muted-foreground",
};

/** Renders a glanceable text status with Mcode's canonical six-pixel state dot. */
export function SubagentLifecycleStatus({
  label,
  tone,
  className,
}: SubagentLifecycleStatusProps) {
  return (
    <Badge
      variant="ghost"
      size="sm"
      data-testid="subagent-lifecycle-status"
      className={cn(
        "h-4 gap-1.5 px-0 font-mono font-normal text-muted-foreground hover:bg-transparent dark:hover:bg-transparent",
        className,
      )}
    >
      <span
        aria-hidden
        data-testid="subagent-lifecycle-dot"
        className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])}
      />
      {label}
    </Badge>
  );
}
