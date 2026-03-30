import { GitMerge, GitPullRequest } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Icon and Tailwind color class resolved from a PR state string. */
export interface PrStateVisual {
  Icon: LucideIcon;
  color: string;
}

/** Returns the icon and color for a PR state. Shared by PrBadge and ProjectTree. */
export function getPrVisual(state: string | null | undefined): PrStateVisual {
  switch (state?.toLowerCase()) {
    case "merged":
      return { Icon: GitMerge, color: "text-purple-400" };
    case "closed":
      return { Icon: GitPullRequest, color: "text-red-400" };
    default:
      return { Icon: GitPullRequest, color: "text-green-400" };
  }
}
