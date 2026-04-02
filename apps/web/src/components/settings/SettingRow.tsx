import { cn } from "@/lib/utils";

interface SettingRowProps {
  /** Setting display name. */
  label: string;
  /** Short description shown below the label. */
  hint?: string;
  /** JSON key path (reserved for future tooltip use). */
  configKey?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Responsive row layout for a single setting: label + hint on the left,
 * control slot on the right. Wraps to a stacked layout on narrow viewports.
 */
export function SettingRow({ label, hint, children, className }: SettingRowProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border/50 px-1 py-4 last:border-b-0",
        className,
      )}
    >
      <div className="min-w-[10rem]">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
