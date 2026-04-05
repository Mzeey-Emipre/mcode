import { cn } from "@/lib/utils";
import type { PlanQuestionOption } from "@mcode/contracts";

interface OptionCardProps {
  /** The option data. */
  option: PlanQuestionOption;
  /** Whether this option is currently selected. */
  selected: boolean;
  /** Whether this option is recommended by the model. */
  isRecommended?: boolean;
  /** Called when the user clicks this option. */
  onSelect: (optionId: string) => void;
}

/**
 * A single selectable option within a plan question.
 * Renders as a clean list row with a left accent line on selection.
 */
export function OptionCard({ option, selected, isRecommended, onSelect }: OptionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      className={cn(
        "w-full text-left px-3 py-2.5 transition-all duration-150",
        "border-l-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#0891b2]/40",
        selected
          ? "border-l-[#0891b2] bg-[#0891b2]/8"
          : "border-l-transparent hover:border-l-border hover:bg-muted/30",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("text-sm font-medium", selected ? "text-foreground" : "text-foreground/80")}>
            {option.title}
          </span>
          {isRecommended && (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#0891b2] border border-[#0891b2]/40 px-1.5 py-px rounded-sm">
              Recommended
            </span>
          )}
        </div>
        {selected && (
          <div className="shrink-0 w-3.5 h-3.5 rounded-full bg-[#0891b2] ring-2 ring-[#0891b2]/20" />
        )}
      </div>
      {option.description && (
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{option.description}</p>
      )}
    </button>
  );
}
