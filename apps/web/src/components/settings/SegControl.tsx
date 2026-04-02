import { cn } from "@/lib/utils";
import { Fragment, type ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface SegOption {
  /** Value passed to onChange when selected. */
  value: string;
  /** Display label. */
  label: string;
  /** When true the option renders dimmed and is not clickable. */
  disabled?: boolean;
  /** Optional icon rendered before the label. */
  icon?: ReactNode;
  /** Tooltip text shown on hover (uses the app's styled tooltip). */
  title?: string;
}

interface SegControlProps {
  options: SegOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/**
 * Segmented button control for selecting one value from a short list.
 * Renders as a recessed tray with a raised active button.
 */
export function SegControl({ options, value, onChange, className }: SegControlProps) {
  return (
    <TooltipProvider>
      <div
        role="radiogroup"
        className={cn(
          "inline-flex gap-0.5 rounded-md border border-border bg-muted/40 p-0.5",
          className,
        )}
      >
        {options.map((opt) => {
          const isActive = value === opt.value;
          const button = (
            <button
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-disabled={opt.disabled || undefined}
              disabled={opt.disabled}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange(opt.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-all duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
                opt.disabled && "cursor-not-allowed opacity-30",
              )}
            >
              {opt.icon}
              {opt.label}
            </button>
          );

          if (!opt.title) return <Fragment key={opt.value}>{button}</Fragment>;

          return (
            <Tooltip key={opt.value}>
              <TooltipTrigger render={<span />}>
                {button}
              </TooltipTrigger>
              <TooltipContent>{opt.title}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
