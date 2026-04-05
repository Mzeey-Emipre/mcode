import { Button } from "@/components/ui/button";

interface WizardNavProps {
  /** Called when the user clicks Previous. Undefined when on the first question. */
  onPrevious?: () => void;
  /** Called when the user clicks Next or Submit. */
  onNext: () => void;
  /** Label for the right button ("Next question" or "Submit answers"). */
  nextLabel: string;
  /** Whether the next/submit action is in progress. */
  isSubmitting?: boolean;
}

/**
 * Navigation row at the bottom of the plan question wizard.
 * Shows Previous (when applicable) and a Next/Submit button.
 */
export function WizardNav({ onPrevious, onNext, nextLabel, isSubmitting }: WizardNavProps) {
  return (
    <div className="flex items-center justify-between mt-4">
      <div>
        {onPrevious && (
          <Button variant="ghost" size="sm" onClick={onPrevious}>
            Previous
          </Button>
        )}
      </div>
      <Button size="sm" onClick={onNext} disabled={isSubmitting}>
        {nextLabel}
      </Button>
    </div>
  );
}
