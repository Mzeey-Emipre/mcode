import type { Thread } from "@/transport/types";

export interface StatusDisplay {
  label: string;
  color: string;
  dotClass: string;
}

export function getStatusDisplay(
  thread: Thread,
  isActuallyRunning: boolean,
): StatusDisplay {
  // Live process state takes priority over DB status
  if (isActuallyRunning) {
    return {
      label: "Working",
      color: "text-yellow-500",
      dotClass: "bg-yellow-500",
    };
  }

  // DB-driven states when agent is NOT running
  switch (thread.status) {
    case "errored":
      return {
        label: "Errored",
        color: "text-red-500",
        dotClass: "bg-red-500",
      };
    case "completed":
      return {
        label: "Completed",
        color: "text-green-500",
        dotClass: "bg-green-500",
      };
    default:
      // No agent running, not completed, not errored = idle / ready for input
      return { label: "", color: "text-muted-foreground", dotClass: "bg-muted-foreground/50" };
  }
}
