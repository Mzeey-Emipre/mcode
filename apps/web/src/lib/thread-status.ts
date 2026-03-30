import type { Thread } from "@/transport/types";

/** Visual properties for rendering a thread's current status. */
export interface StatusDisplay {
  label: string;
  color: string;
  dotClass: string;
}

/** Returns the display label, text color, and dot class for a thread's status. */
export function getStatusDisplay(
  thread: Thread,
  isActuallyRunning: boolean,
): StatusDisplay {
  // Live process state takes priority over DB status
  if (isActuallyRunning) {
    return {
      label: "Working",
      color: "text-yellow-500/60",
      dotClass: "bg-yellow-500/60",
    };
  }

  // DB-driven states when agent is NOT running
  switch (thread.status) {
    case "errored":
      return {
        label: "Errored",
        color: "text-destructive/70",
        dotClass: "bg-destructive/70",
      };
    case "completed":
      return {
        label: "Completed",
        color: "text-green-500/60",
        dotClass: "bg-green-500/60",
      };
    default:
      // No agent running, not completed, not errored = idle / ready for input
      return { label: "", color: "text-muted-foreground", dotClass: "bg-muted-foreground/50" };
  }
}
