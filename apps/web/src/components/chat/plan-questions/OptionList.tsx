import { OptionCard } from "./OptionCard";
import type { PlanQuestionOption } from "@mcode/contracts";

interface OptionListProps {
  /** Options to display. */
  options: PlanQuestionOption[];
  /** Currently selected option ID, or null. */
  selectedId: string | null;
  /** ID of the recommended option (if any). */
  recommendedId?: string;
  /** Called with the option ID when the user selects an option. */
  onSelect: (optionId: string) => void;
}

/**
 * Renders a vertical list of selectable options with a single divider between each row.
 */
export function OptionList({ options, selectedId, recommendedId, onSelect }: OptionListProps) {
  return (
    <div role="radiogroup" aria-label="Options" className="mb-5 divide-y divide-border/50">
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
