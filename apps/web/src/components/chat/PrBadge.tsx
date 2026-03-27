import { ExternalLink } from "lucide-react";
import type { PrInfo } from "@/transport";

interface PrBadgeProps {
  pr: PrInfo;
}

/** Small clickable badge showing PR number. Opens in default browser via the desktop bridge. */
export function PrBadge({ pr }: PrBadgeProps) {
  const handleClick = () => {
    // Validate URL scheme before opening
    try {
      const parsed = new URL(pr.url);
      if (parsed.protocol === "https:") {
        window.desktopBridge?.openExternalUrl(pr.url);
      }
    } catch {
      // Invalid URL, ignore
    }
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      title={`View PR #${pr.number}`}
      aria-label={`View pull request number ${pr.number}`}
    >
      <span>PR #{pr.number}</span>
      <ExternalLink size={10} />
    </button>
  );
}
