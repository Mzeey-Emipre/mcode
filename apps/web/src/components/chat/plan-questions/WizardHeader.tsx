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
 * Progress indicator and question display at the top of the plan question wizard.
 * Uses serif display font for the question, minimal badge for counter, warm gray divider.
 * Implements editorial/brutalist aesthetic with asymmetrical composition.
 */
export function WizardHeader({ current, total, category, question }: WizardHeaderProps) {
  return (
    <div className="mb-5 pb-4 border-b border-border">
      {/* Counter and Category in small caps */}
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-xs font-semibold text-foreground uppercase tracking-[0.15em] tabular-nums">
          {current}/{total}
        </span>
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-[0.08em]">
          {category}
        </span>
      </div>

      {/* Question text with serif display font */}
      <h2 className="text-lg leading-snug text-foreground" style={{ fontFamily: "'Crimson Text', 'Playfair Display', serif", fontWeight: 600 }}>
        {question}
      </h2>
    </div>
  );
}
