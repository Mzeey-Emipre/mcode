import type { TurnFileEffectSummary } from "@mcode/contracts";

/** Compact Codex-style file, addition, and deletion facts for a turn. */
export function FileEffectFacts({ summary }: { summary: TurnFileEffectSummary }) {
  if (summary.fileCount === 0) return null;
  const fileLabel = `${summary.fileCount} ${summary.fileCount === 1 ? "file" : "files"} changed`;
  return (
    <>
      <span className="text-muted-foreground/45" aria-hidden>·</span>
      <span>{fileLabel}</span>
      {summary.additions > 0 && (
        <span className="text-[var(--diff-add-strong)]">+{summary.additions}</span>
      )}
      {summary.deletions > 0 && (
        <span className="text-[var(--diff-delete-strong)]">−{summary.deletions}</span>
      )}
    </>
  );
}
