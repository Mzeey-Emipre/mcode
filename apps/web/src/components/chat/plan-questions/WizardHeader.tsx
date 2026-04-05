interface WizardHeaderProps {
  /** 1-based index of the current question. */
  current: number;
  /** Total number of questions in the batch. */
  total: number;
  /** Category label from the question (e.g. "SCOPE"). */
  category: string;
  /** The question text. */
  question: string;
}

/** Counter, category tag, and question text at the top of the plan question wizard. */
export function WizardHeader({ current, total, category, question }: WizardHeaderProps) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-mono text-muted-foreground/50 tabular-nums">
          {current}/{total}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
          {category}
        </span>
      </div>
      <p className="text-sm font-semibold text-foreground leading-snug">{question}</p>
    </div>
  );
}
