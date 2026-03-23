import { ExternalLink } from "lucide-react";
import type { PrInfo } from "@/transport";

interface PrBadgeProps {
  pr: PrInfo;
}

/** Small clickable badge showing PR number. Opens in default browser. */
export function PrBadge({ pr }: PrBadgeProps) {
  const handleClick = () => {
    window.open(pr.url, "_blank", "noopener,noreferrer");
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      title={`View PR #${pr.number}`}
    >
      <span>PR #{pr.number}</span>
      <ExternalLink size={10} />
    </button>
  );
}
