interface WizardHeaderProps {
  current: number;
  total: number;
  category: string;
  question: string;
}

/** Step counter, category label, and question text. */
export function WizardHeader({ current, total, category, question }: WizardHeaderProps) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[11px] text-muted-foreground/40 tabular-nums font-mono">
          {current}/{total}
        </span>
        <span className="text-muted-foreground/25">·</span>
        <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/35">
          {category}
        </span>
      </div>
      <p className="text-sm font-semibold text-foreground leading-snug">{question}</p>
    </div>
  );
}
