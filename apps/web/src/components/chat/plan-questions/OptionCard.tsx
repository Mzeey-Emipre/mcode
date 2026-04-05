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
 * Uses left border accent (teal when recommended/selected), minimal shadow,
 * and brutalist aesthetic. Implements editorial design with asymmetrical styling.
 */
export function OptionCard({ option, selected, isRecommended, onSelect }: OptionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      className={cn(
        "w-full text-left py-3 px-4 mb-2 transition-all duration-200",
        "border-l-4 border border-border",
        "bg-card hover:bg-muted/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0891b2]/50",
        selected
          ? "border-l-[#0891b2] bg-muted/40"
          : "border-l-transparent",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-foreground text-sm">
              {option.title}
            </span>
            {isRecommended && (
              <span className="inline-block bg-[#0891b2]/15 text-[#0891b2] text-xs font-medium px-1.5 py-0.5 rounded border border-[#0891b2]/30">
                Recommended
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {option.description}
          </p>
        </div>
        {selected && (
          <div className="flex-shrink-0 w-4 h-4 rounded-full bg-[#0891b2] mt-1" />
        )}
      </div>
    </button>
  );
}
