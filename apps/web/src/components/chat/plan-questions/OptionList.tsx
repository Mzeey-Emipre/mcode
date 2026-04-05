import { OptionCard } from "./OptionCard";
import type { PlanQuestionOption } from "@mcode/contracts";

interface OptionListProps {
  /** Options to display. */
  options: PlanQuestionOption[];
  /** Currently selected option ID, or null. */
  selectedId: string | null;
  /** Called with the option ID when the user selects an option. */
  onSelect: (optionId: string) => void;
}

/**
 * Renders a vertical list of selectable OptionCard items for a plan question.
 */
export function OptionList({ options, selectedId, onSelect }: OptionListProps) {
  return (
    <div role="radiogroup" aria-label="Options">
      {options.map((option, i) => (
        <OptionCard
          key={option.id}
          option={option}
          index={i + 1}
          selected={selectedId === option.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
