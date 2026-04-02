import { cn } from "@/lib/utils";

interface SettingRowProps {
  /** Setting display name. */
  label: string;
  /** Short description shown below the label. */
  hint?: string;
  /** JSON key path shown as a dim monospace badge (e.g. "model.defaults.id"). */
  configKey?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Standard row layout for a single setting: label, optional hint,
 * optional config-key badge, and a control slot.
 */
export function SettingRow({ label, hint, configKey, children, className }: SettingRowProps) {
  return (
    <div className={cn("border-t border-border py-4 first:border-t-0 first:pt-0", className)}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {configKey && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/40">
            {configKey}
          </span>
        )}
      </div>
      {hint && <p className="mb-3 text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}
