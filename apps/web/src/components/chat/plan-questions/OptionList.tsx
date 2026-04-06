import { OptionCard } from "./OptionCard";
import type { PlanQuestionOption } from "@mcode/contracts";

/** Sentinel ID for the user-written "Other" option. */
export const OTHER_OPTION_ID = "__other__";

const OTHER_OPTION: PlanQuestionOption = {
  id: OTHER_OPTION_ID,
  title: "Other...",
  description: "",
  recommended: false,
};

interface OptionListProps {
  options: PlanQuestionOption[];
  selectedId: string | null;
  recommendedId?: string;
  onSelect: (optionId: string) => void;
  /** Current free-text value for the "Other" option. */
  otherText: string;
  /** Called when the user types in the "Other" inline input. */
  onOtherTextChange: (text: string) => void;
}

/** Options list with an appended "Other..." row that expands an inline input on selection. */
export function OptionList({
  options,
  selectedId,
  recommendedId,
  onSelect,
  otherText,
  onOtherTextChange,
}: OptionListProps) {
  return (
    <div role="radiogroup" aria-label="Options" className="flex flex-col mb-3 rounded-md border border-border/30 overflow-hidden">
      {options.map((option) => (
        <OptionCard
          key={option.id}
          option={option}
          selected={selectedId === option.id}
          isRecommended={recommendedId === option.id || option.recommended}
          onSelect={onSelect}
        />
      ))}
      <OptionCard
        option={OTHER_OPTION}
        selected={selectedId === OTHER_OPTION_ID}
        onSelect={onSelect}
        isOtherCard
        otherText={otherText}
        onOtherTextChange={onOtherTextChange}
      />
    </div>
  );
}
