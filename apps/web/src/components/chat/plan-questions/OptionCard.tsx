import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import type { PlanQuestionOption } from "@mcode/contracts";

interface OptionCardProps {
  option: PlanQuestionOption;
  selected: boolean;
  isRecommended?: boolean;
  onSelect: (optionId: string) => void;
}

/** Single selectable option row. */
export function OptionCard({ option, selected, isRecommended, onSelect }: OptionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      className={cn(
        "group w-full text-left rounded-md px-3 py-2.5 transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "bg-primary/10"
          : "hover:bg-muted/40",
      )}
    >
      <div className="flex items-start gap-3">
        {/* Radio indicator */}
        <div className={cn(
          "mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors",
          selected
            ? "border-primary bg-primary"
            : "border-muted-foreground/25 group-hover:border-muted-foreground/50",
        )}>
          {selected && <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3} />}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn(
              "text-sm leading-none",
              selected ? "font-medium text-foreground" : "text-foreground/75",
            )}>
              {option.title}
            </span>
            {isRecommended && (
              <span className="inline-flex items-center text-[10px] font-medium text-primary/70 bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 leading-none">
                recommended
              </span>
            )}
          </div>
          {option.description && (
            <p className={cn(
              "text-xs mt-1 leading-relaxed",
              selected ? "text-muted-foreground/80" : "text-muted-foreground/45",
            )}>
              {option.description}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
