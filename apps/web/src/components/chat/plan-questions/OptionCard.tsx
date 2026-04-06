import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PlanQuestionOption } from "@mcode/contracts";

interface OptionCardProps {
  option: PlanQuestionOption;
  selected: boolean;
  isRecommended?: boolean;
  onSelect: (optionId: string) => void;
  /** When true, shows an inline text input instead of description when selected. */
  isOtherCard?: boolean;
  otherText?: string;
  onOtherTextChange?: (text: string) => void;
}

/** Selectable option row. When isOtherCard and selected, renders an inline text input. */
export function OptionCard({
  option,
  selected,
  isRecommended,
  onSelect,
  isOtherCard,
  otherText = "",
  onOtherTextChange,
}: OptionCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the text input when "Other" is selected
  useEffect(() => {
    if (isOtherCard && selected) {
      inputRef.current?.focus();
    }
  }, [isOtherCard, selected]);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      className={cn(
        "group w-full text-left px-3 py-2.5 transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer border-b border-border/20 last:border-b-0",
        selected
          ? "bg-primary/8"
          : "hover:bg-muted/50",
      )}
    >
      <div className="flex items-start gap-3">
        {/* Radio indicator */}
        <div className={cn(
          "mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors",
          selected
            ? "border-primary bg-primary"
            : "border-muted-foreground/50 group-hover:border-primary/60",
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

          {/* Inline text input for "Other" when selected */}
          {isOtherCard && selected ? (
            <input
              ref={inputRef}
              type="text"
              value={otherText}
              onChange={(e) => onOtherTextChange?.(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="Describe your response..."
              className="mt-2 w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 outline-none border-b border-border/50 pb-0.5 focus:border-primary/50 transition-colors"
            />
          ) : (
            option.description && !isOtherCard && (
              <p className={cn(
                "text-xs mt-1 leading-relaxed",
                selected ? "text-muted-foreground/80" : "text-muted-foreground/45",
              )}>
                {option.description}
              </p>
            )
          )}
        </div>
      </div>
    </button>
  );
}
