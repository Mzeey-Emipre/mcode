interface WizardNavProps {
  /** Called when the user clicks Previous. Undefined when on the first question. */
  onPrevious?: () => void;
  /** Called when the user clicks Next or Submit. */
  onNext: () => void;
  /** Label for the right button ("Next question" or "Submit answers"). */
  nextLabel: string;
  /** Whether the next/submit action is in progress. */
  isSubmitting?: boolean;
  /** 0-based index of the current question. */
  currentIndex?: number;
  /** Total number of questions. */
  totalQuestions?: number;
}

/**
 * Navigation row at the bottom of the plan question wizard.
 * Shows Previous (when applicable), minimal progress indicator, and Next/Submit button.
 * Implements brutalist aesthetic with no background, borders only, minimal hover effects.
 */
export function WizardNav({
  onPrevious,
  onNext,
  nextLabel,
  isSubmitting,
  currentIndex = 0,
  totalQuestions = 1,
}: WizardNavProps) {
  return (
    <div className="flex items-center justify-between pt-4 border-t border-[#e5e1d8]">
      {/* Previous button */}
      <button
        onClick={onPrevious}
        disabled={!onPrevious || isSubmitting}
        className="px-3 py-1.5 text-sm text-[#666] border border-[#e5e1d8] rounded transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed hover:enabled:text-[#0f0f0f] hover:enabled:border-[#0f0f0f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0891b2]/50"
        aria-label="Go to previous question"
      >
        Previous
      </button>

      {/* Progress dots */}
      <div className="flex items-center gap-2">
        {Array.from({ length: totalQuestions }).map((_, i) => (
          <div
            key={i}
            className={`w-1.5 h-1.5 rounded-full transition-colors duration-200 ${
              i === currentIndex ? "bg-[#0891b2]" : "bg-[#e5e1d8]"
            }`}
            aria-hidden="true"
          />
        ))}
      </div>

      {/* Next/Submit button */}
      <button
        onClick={onNext}
        disabled={isSubmitting}
        className="px-3 py-1.5 text-sm font-medium text-[#f8f8f7] bg-[#0891b2] border border-[#0891b2] rounded transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-[#0891b2]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0891b2]/50"
        aria-label={nextLabel}
      >
        {isSubmitting ? "Submitting..." : nextLabel}
      </button>
    </div>
  );
}
