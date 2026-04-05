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
        "w-full text-left py-3 px-4 mb-3 transition-all duration-200",
        "border-l-4 border-r border-b border-t-0 border-[#e5e1d8]",
        "bg-[#f8f8f7] hover:bg-[#f3f2f0]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0891b2]/50",
        "shadow-sm hover:shadow-md",
        selected || isRecommended
          ? "border-l-[#0891b2]"
          : "border-l-[#e5e1d8]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-[#0f0f0f] text-sm">
              {option.title}
            </span>
            {isRecommended && (
              <span className="inline-block bg-[#0891b2] text-[#f8f8f7] text-xs font-medium px-2 py-0.5 rounded">
                Recommended
              </span>
            )}
          </div>
          <p className="text-xs text-[#666] leading-relaxed">
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
