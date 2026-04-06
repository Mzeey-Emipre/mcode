import { OptionCard } from "./OptionCard";
import type { PlanQuestionOption } from "@mcode/contracts";

interface OptionListProps {
  options: PlanQuestionOption[];
  selectedId: string | null;
  recommendedId?: string;
  onSelect: (optionId: string) => void;
}

/** Vertical list of option rows with no dividers — spacing does the separation. */
export function OptionList({ options, selectedId, recommendedId, onSelect }: OptionListProps) {
  return (
    <div role="radiogroup" aria-label="Options" className="flex flex-col gap-0.5 mb-3">
      {options.map((option) => (
        <OptionCard
          key={option.id}
          option={option}
          selected={selectedId === option.id}
          isRecommended={recommendedId === option.id || option.recommended}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
