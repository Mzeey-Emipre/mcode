import { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { PlanQuestion, PlanAnswer } from "@mcode/contracts";

interface AcceptRecommendedProps {
  /** The full batch of questions. */
  questions: PlanQuestion[];
  /** Called with answers for every question, each set to its recommended option. */
  onAccept: (answers: PlanAnswer[]) => void;
  /** Disables the button during submission. */
  disabled?: boolean;
  /** Adds a `data-` hook so tests and the wizard can target this action. */
  testId?: string;
}

/**
 * Subtle text-link action that appears below the option list when every
 * question has exactly one recommended option. Surfaces the one-gesture
 * shortcut for the common case without competing visually with the
 * primary Next/Submit button. The wizard triggers a per-tile flash
 * animation when this fires — the visual ack lives in the tiles, not in
 * a confirmation dialog.
 */
export function AcceptRecommended({
  questions,
  onAccept,
  disabled,
  testId,
}: AcceptRecommendedProps) {
  // Every question must have exactly one recommended option. Memoize the
  // predicate and the answer-builder so they don't recompute on every
  // unrelated re-render — `questions` is stable from the store, so both
  // memos invalidate only when a new batch arrives.
  const allHaveRecommended = useMemo(
    () =>
      questions.every(
        (q) => q.options.filter((o) => o.recommended).length === 1,
      ),
    [questions],
  );

  const handleClick = useCallback((): void => {
    const answers: PlanAnswer[] = questions.map((q) => ({
      questionId: q.id,
      selectedOptionId: q.options.find((o) => o.recommended)!.id,
      freeText: null,
    }));
    onAccept(answers);
  }, [questions, onAccept]);

  if (!allHaveRecommended) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-mono",
        "text-primary/65 hover:text-primary",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-primary/65",
        "transition-colors duration-150 ease-out",
        "focus-visible:outline-none focus-visible:underline underline-offset-4",
      )}
    >
      <span aria-hidden="true">↵</span>
      <span className="lowercase tracking-wide">accept all recommended</span>
    </button>
  );
}
