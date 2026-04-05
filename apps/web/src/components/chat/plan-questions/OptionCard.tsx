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

/** A single selectable option row. Selected state uses the app's primary accent. */
export function OptionCard({ option, selected, isRecommended, onSelect }: OptionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      className={cn(
        "w-full text-left px-3 py-2.5 transition-colors duration-100",
        "border-l-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0",
        selected
          ? "border-l-primary bg-primary/10 text-foreground"
          : "border-l-transparent hover:bg-muted/40 text-foreground/70 hover:text-foreground",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium leading-none truncate">{option.title}</span>
          {isRecommended && (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-primary/70 border border-primary/25 px-1.5 py-px rounded-sm leading-none">
              recommended
            </span>
          )}
        </div>
        {selected && (
          <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-primary" />
        )}
      </div>
      {option.description && (
        <p className="text-[11px] text-muted-foreground/50 mt-1 leading-relaxed">{option.description}</p>
      )}
    </button>
  );
}
