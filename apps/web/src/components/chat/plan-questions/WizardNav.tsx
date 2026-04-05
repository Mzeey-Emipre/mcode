interface WizardNavProps {
  /** Called when the user clicks Previous. Undefined when on the first question. */
  onPrevious?: () => void;
  /** Called when the user clicks Next or Submit. */
  onNext: () => void;
  /** Called when the user cancels the wizard entirely. */
  onCancel: () => void;
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
 */
export function WizardNav({
  onPrevious,
  onNext,
  onCancel,
  nextLabel,
  isSubmitting,
  currentIndex = 0,
  totalQuestions = 1,
}: WizardNavProps) {
  return (
    <div className="flex items-center justify-between pt-3 border-t border-border">
      <div className="flex items-center gap-3">
        <button
          onClick={onPrevious}
          disabled={!onPrevious || isSubmitting}
          className="text-xs text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none"
        >
          Previous
        </button>
        <button
          onClick={onCancel}
          disabled={isSubmitting}
          className="text-xs text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none"
        >
          Cancel
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {Array.from({ length: totalQuestions }).map((_, i) => (
          <div
            key={i}
            className={`w-1 h-1 rounded-full transition-colors ${
              i === currentIndex ? "bg-primary" : "bg-muted-foreground/20"
            }`}
          />
        ))}
      </div>

      <button
        onClick={onNext}
        disabled={isSubmitting}
        className="text-xs font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none"
      >
        {isSubmitting ? "Submitting..." : nextLabel}
      </button>
    </div>
  );
}
