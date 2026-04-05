interface WizardHeaderProps {
  /** 1-based index of the current question. */
  current: number;
  /** Total number of questions in the batch. */
  total: number;
  /** Category label from the question (e.g. "AUTH"). */
  category: string;
}

/**
 * Progress indicator displayed at the top of the plan question wizard.
 * Shows "2/3 CATEGORY" matching the reference design.
 */
export function WizardHeader({ current, total, category }: WizardHeaderProps) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-xs font-semibold text-muted-foreground tabular-nums">
        {current}/{total}
      </span>
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {category}
      </span>
    </div>
  );
}
