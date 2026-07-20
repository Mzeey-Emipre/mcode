import { type ReactNode } from "react";

import { cn } from "@/lib/utils";

interface AnimatedCollapsibleProps {
  /** Whether the content is expanded. */
  open: boolean;
  /** Content to show/hide. */
  children: ReactNode;
  /** Additional class names on the outer grid container. */
  className?: string;
}

/**
 * Smooth height animation using CSS grid-template-rows.
 * Transitions between 0fr (collapsed) and 1fr (expanded) using an
 * ease-out cubic-bezier for a snappy, natural feel.
 */
export function AnimatedCollapsible({
  open,
  children,
  className,
}: AnimatedCollapsibleProps) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-250 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div
        className="min-h-0 overflow-hidden"
        aria-hidden={!open}
        inert={!open}
      >
        {children}
      </div>
    </div>
  );
}
