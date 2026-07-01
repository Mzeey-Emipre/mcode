import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

/** Renders the Synara-style split-arrow worktree indicator. */
export function WorktreeModeIcon({
  size = 14,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M14.75 20.25H20.25V14.75" />
      <path d="M20.25 9.25V3.75H14.75" />
      <path d="M12 12H3.75M12 12L19.5 19.5M12 12L19.5 4.5" />
    </svg>
  );
}
