import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

interface WizardNavProps {
  onPrevious?: () => void;
  onNext: () => void;
  onCancel: () => void;
  isSubmitting?: boolean;
  currentIndex?: number;
  totalQuestions?: number;
}

/** Bottom nav: ghost secondary actions on the left, step pills center, primary action right. */
export function WizardNav({
  onPrevious,
  onNext,
  onCancel,
  isSubmitting,
  currentIndex = 0,
  totalQuestions = 1,
}: WizardNavProps) {
  const isLast = currentIndex === totalQuestions - 1;

  return (
    <div className="flex items-center justify-between pt-2.5">
      {/* Secondary actions */}
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={onPrevious}
          disabled={!onPrevious || isSubmitting}
          className="h-7 px-2 text-xs text-muted-foreground/50 hover:text-muted-foreground"
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isSubmitting}
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </Button>
      </div>

      {/* Step progress */}
      {totalQuestions > 1 && (
        <div className="flex items-center gap-1">
          {Array.from({ length: totalQuestions }).map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all duration-200 ${
                i === currentIndex
                  ? "w-3 h-1 bg-primary/60"
                  : i < currentIndex
                    ? "w-1 h-1 bg-primary/30"
                    : "w-1 h-1 bg-muted-foreground/15"
              }`}
            />
          ))}
        </div>
      )}

      {/* Primary action */}
      <Button
        size="sm"
        onClick={onNext}
        disabled={isSubmitting}
        className="h-7 gap-1.5 px-3 text-xs"
      >
        {isSubmitting ? "Submitting..." : isLast ? "Submit answers" : "Next"}
        {!isSubmitting && !isLast && <ArrowRight className="w-3 h-3" />}
      </Button>
    </div>
  );
}
