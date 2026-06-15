import { cn } from "@/lib/utils";

/** Props for {@link DiffStat}. */
export interface DiffStatProps {
  /** Number of added lines. */
  additions: number;
  /** Number of removed lines. */
  deletions: number;
  /** When true, render a proportion bar before the counts. */
  bar?: boolean;
  className?: string;
}

/**
 * Added/removed line counts rendered in the shared diff color tokens, with an
 * optional proportion bar. Single source of truth so the Changes panel and the
 * chat turn summary can never drift on stat color or sign glyph.
 */
export function DiffStat({ additions, deletions, bar = false, className }: DiffStatProps) {
  const total = additions + deletions;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums",
        className,
      )}
    >
      {bar && total > 0 && (
        <span className="flex h-[3px] w-12 items-stretch overflow-hidden rounded-full bg-border/40">
          <span
            className="block bg-[var(--diff-add-strong)]"
            style={{ width: `${(additions / total) * 100}%` }}
          />
          <span
            className="block bg-[var(--diff-remove-strong)]"
            style={{ width: `${(deletions / total) * 100}%` }}
          />
        </span>
      )}
      {additions > 0 && <span className="text-[var(--diff-add-strong)]">+{additions}</span>}
      {deletions > 0 && <span className="text-[var(--diff-remove-strong)]">−{deletions}</span>}
    </span>
  );
}
