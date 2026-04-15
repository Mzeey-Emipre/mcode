import { CircleCheck, CircleX, Clock, type LucideIcon } from "lucide-react";
import type { ChecksStatus } from "@mcode/contracts";

/** Visual properties for a CI aggregate state. */
export interface CiVisual {
  icon: LucideIcon;
  color: string;
  borderColor: string;
  label: string;
}

/** Maps an aggregate CI status to icon, color, and label. */
export function getCiVisual(aggregate: ChecksStatus["aggregate"]): CiVisual {
  switch (aggregate) {
    case "passing":
      return { icon: CircleCheck, color: "text-green-500", borderColor: "border-green-500/50", label: "Checks passing" };
    case "failing":
      return { icon: CircleX, color: "text-red-500", borderColor: "border-red-500/50", label: "Checks failing" };
    case "pending":
      return { icon: Clock, color: "text-orange-500", borderColor: "border-orange-500/50", label: "Checks running" };
    case "no_checks":
      return { icon: CircleCheck, color: "text-muted-foreground", borderColor: "border-border", label: "No checks" };
  }
}

/** Returns a Tailwind dot colour class for sidebar CI indicators. Returns null for no_checks. */
export function getCiDotClass(aggregate: ChecksStatus["aggregate"]): string | null {
  switch (aggregate) {
    case "passing":
      return "bg-green-500";
    case "failing":
      return "bg-red-500";
    case "pending":
      return "bg-orange-500";
    case "no_checks":
      return null;
  }
}
