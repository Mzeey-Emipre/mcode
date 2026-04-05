interface WizardHeaderProps {
  /** 1-based index of the current question. */
  current: number;
  /** Total number of questions in the batch. */
  total: number;
  /** Category label from the question (e.g. "AUTH"). */
  category: string;
  /** The question text for display. */
  question: string;
}

/**
 * Progress counter and question text at the top of the plan question wizard.
 */
export function WizardHeader({ current, total, category, question }: WizardHeaderProps) {
  return (
    <div className="mb-4 pb-3 border-b border-border">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-medium text-muted-foreground/50 tabular-nums">
          {current}/{total}
        </span>
        <span className="text-[11px] text-muted-foreground/40 uppercase tracking-wide">
          {category}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground">{question}</p>
    </div>
  );
}
