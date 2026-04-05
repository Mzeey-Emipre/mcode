import { Button } from "@/components/ui/button";

interface WizardNavProps {
  /** Called when the user clicks Previous. Undefined when on the first question. */
  onPrevious?: () => void;
  /** Called when the user clicks Next or Submit. */
  onNext: () => void;
  /** Called when the user cancels the wizard. */
  onCancel: () => void;
  /** Label for the right button. */
  nextLabel: string;
  /** Whether a submit is in progress. */
  isSubmitting?: boolean;
  /** 0-based index of the current question. */
  currentIndex?: number;
  /** Total number of questions. */
  totalQuestions?: number;
}

/** Navigation row: ghost Previous+Cancel on the left, progress dots center, primary pill on the right. */
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
    <div className="flex items-center justify-between pt-2 border-t border-border/60">
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={onPrevious}
          disabled={!onPrevious || isSubmitting}
          className="h-7 px-2 text-xs"
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

      {totalQuestions > 1 && (
        <div className="flex items-center gap-1">
          {Array.from({ length: totalQuestions }).map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all duration-200 ${
                i === currentIndex
                  ? "w-3 h-1 bg-primary"
                  : "w-1 h-1 bg-muted-foreground/20"
              }`}
            />
          ))}
        </div>
      )}

      <button
        onClick={onNext}
        disabled={isSubmitting}
        className="rounded-full px-3 py-1 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isSubmitting ? "Submitting..." : nextLabel}
      </button>
    </div>
  );
}
