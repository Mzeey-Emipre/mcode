import { Button } from "@/components/ui/button";

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
 * Uses ghost buttons for Previous/Cancel and the primary action style for Next/Submit.
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
    <div className="flex items-center justify-between pt-2 border-t border-border">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onPrevious}
          disabled={!onPrevious || isSubmitting}
          className="h-7 px-2 text-xs text-muted-foreground"
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isSubmitting}
          className="h-7 px-2 text-xs text-muted-foreground"
        >
          Cancel
        </Button>
      </div>

      <div className="flex items-center gap-1">
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
        className="rounded-full px-3 py-1 text-xs font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isSubmitting ? "Submitting..." : nextLabel}
      </button>
    </div>
  );
}
