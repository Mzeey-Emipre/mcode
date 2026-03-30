import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPrVisual } from "@/lib/pr-status";
import type { PrInfo } from "@/transport";

interface PrBadgeProps {
  pr: PrInfo;
}

/** Small clickable badge showing PR number with state icon. Opens in default browser via the desktop bridge. */
export function PrBadge({ pr }: PrBadgeProps) {
  const { Icon, color } = getPrVisual(pr.state);

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
      title={`View PR #${pr.number} \u2013 ${pr.state}`}
      aria-label={`View pull request number ${pr.number}, ${pr.state}`}
    >
      <Icon size={12} className={cn("shrink-0", color)} />
      <span>PR #{pr.number}</span>
      <ExternalLink size={10} />
    </button>
  );
}
