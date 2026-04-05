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

/** Selectable option row with a clear selected state using the app's primary accent. */
export function OptionCard({ option, selected, isRecommended, onSelect }: OptionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      className={cn(
        "w-full text-left px-3 py-3 transition-colors duration-100",
        "border-l-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "border-l-primary bg-primary/10"
          : "border-l-transparent hover:bg-muted/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={cn(
              "text-xs font-medium leading-none",
              selected ? "text-foreground" : "text-foreground/70",
            )}>
              {option.title}
            </span>
            {isRecommended && (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-primary/60 border border-primary/20 px-1.5 py-px rounded-sm leading-none">
                recommended
              </span>
            )}
          </div>
          {option.description && (
            <p className={cn(
              "text-[11px] leading-relaxed mt-1",
              selected ? "text-muted-foreground/70" : "text-muted-foreground/40",
            )}>
              {option.description}
            </p>
          )}
        </div>
        <div className={cn(
          "shrink-0 mt-0.5 w-3.5 h-3.5 rounded-full border-2 transition-colors",
          selected
            ? "border-primary bg-primary"
            : "border-muted-foreground/20 bg-transparent",
        )} />
      </div>
    </button>
  );
}
