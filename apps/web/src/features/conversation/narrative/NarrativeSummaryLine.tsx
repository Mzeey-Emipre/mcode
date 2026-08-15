import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { NARRATIVE_TOOL_ROW } from "./narrative-layout";

interface NarrativeSummaryLineProps {
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  children: ReactNode;
  badge?: ReactNode;
  expandable?: boolean;
  disabled?: boolean;
}

/** Shared compact narrative summary row used by tool, hook, and Browser groups. */
export function NarrativeSummaryLine({
  open,
  onToggle,
  icon,
  children,
  badge,
  expandable = true,
  disabled = false,
}: NarrativeSummaryLineProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`${NARRATIVE_TOOL_ROW} w-full rounded-md px-2 py-1 text-left text-sm transition-colors duration-100 ${
        disabled ? "cursor-default" : "hover:bg-muted/30"
      }`}
      aria-expanded={expandable ? open : undefined}
    >
      {icon}
      {children}
      {badge}
      {expandable ? (
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground/30 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}
