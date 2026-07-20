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

/** Responsive grid shared by standard and provider-specific setting rows. */
export const SETTING_ROW_GRID_CLASS =
  "grid gap-3 min-[90rem]:grid-cols-[minmax(0,1fr)_auto] min-[90rem]:items-center min-[90rem]:gap-x-8";

/**
 * Responsive row layout for a single setting: label + hint on the left,
 * control slot on the right. Stacks the control below the label on narrow viewports.
 */
export function SettingRow({ label, hint, children, className }: SettingRowProps) {
  return (
    <div
      className={cn(
        SETTING_ROW_GRID_CLASS,
        "border-b border-border/50 px-1 py-4 last:border-b-0",
        className,
      )}
    >
      <div className="min-w-0">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {hint && (
          <p className="mt-1 max-w-[62ch] text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0 min-[90rem]:justify-self-end">{children}</div>
    </div>
  );
}
