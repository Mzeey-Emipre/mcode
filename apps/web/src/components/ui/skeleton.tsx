import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/** Renders a shared muted placeholder surface for loading layouts. */
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
