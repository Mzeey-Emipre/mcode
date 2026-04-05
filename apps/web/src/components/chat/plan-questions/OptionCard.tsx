import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanQuestionOption } from "@mcode/contracts";

interface OptionCardProps {
  /** The option data. */
  option: PlanQuestionOption;
  /** 1-based display index. */
  index: number;
  /** Whether this option is currently selected. */
  selected: boolean;
  /** Called when the user clicks this option. */
  onSelect: (optionId: string) => void;
}

/**
 * A single selectable option within a plan question.
 * Displays a numbered circle, bold title with optional "Recommended" badge,
 * and a description. Highlights when selected.
 */
export function OptionCard({ option, index, selected, onSelect }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(option.id)}
      className={cn(
        "w-full text-left rounded-lg border px-3 py-2.5 mt-2 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary bg-primary/10"
          : "border-border hover:border-muted-foreground/40 hover:bg-muted/40",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex-shrink-0 w-5 h-5 rounded-full border text-xs font-medium",
            "flex items-center justify-center mt-0.5",
            selected
              ? "border-primary text-primary"
              : "border-muted-foreground/50 text-muted-foreground",
          )}
        >
          {index}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{option.title}</span>
            {option.recommended && (
              <span className="text-xs text-muted-foreground italic">Recommended</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {option.description}
          </p>
        </div>
        {selected && <Check className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />}
      </div>
    </button>
  );
}
