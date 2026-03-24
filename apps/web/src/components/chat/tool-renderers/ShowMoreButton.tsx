interface ShowMoreButtonProps {
  totalCount: number;
  visibleCount: number;
  expanded: boolean;
  onToggle: () => void;
}

export function ShowMoreButton({ totalCount, visibleCount, expanded, onToggle }: ShowMoreButtonProps) {
  if (totalCount <= visibleCount) return null;

  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
    >
      {expanded ? "Show less" : `Show ${totalCount - visibleCount} more`}
    </button>
  );
}
