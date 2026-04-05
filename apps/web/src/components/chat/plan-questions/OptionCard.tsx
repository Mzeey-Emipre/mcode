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
 * Matches the app's existing card style (border-l-2, muted hover, primary accent).
 */
export function OptionCard({ option, selected, isRecommended, onSelect }: OptionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      className={cn(
        "w-full text-left pl-3 pr-2 py-2 transition-colors",
        "border-l-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "border-l-primary bg-primary/5 text-foreground"
          : "border-l-transparent hover:bg-muted/20 text-foreground/80 hover:text-foreground",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium truncate">{option.title}</span>
          {isRecommended && (
            <span className="shrink-0 text-[10px] font-medium text-primary/70 border border-primary/30 px-1.5 py-px rounded-sm">
              recommended
            </span>
          )}
        </div>
        {selected && <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-primary" />}
      </div>
      {option.description && (
        <p className="text-xs text-muted-foreground/60 mt-0.5 leading-relaxed">{option.description}</p>
      )}
    </button>
  );
}
