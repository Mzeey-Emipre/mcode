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
 * control slot on the right. Stacks the control below the label on narrow viewports.
 */
export function SettingRow({ label, hint, children, className }: SettingRowProps) {
  return (
    <div
      className={cn(
        "grid gap-3 border-b border-border/50 px-1 py-4 last:border-b-0 min-[900px]:grid-cols-[minmax(0,1fr)_auto] min-[900px]:items-center min-[900px]:gap-x-8",
        className,
      )}
    >
      <div className="min-w-0">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {hint && (
          <p className="mt-1 max-w-[62ch] text-xs leading-5 text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0 min-[900px]:justify-self-end">{children}</div>
    </div>
  );
}
