import type { Thread } from "@/transport/types";

export interface StatusDisplay {
  label: string;
  color: string;
  dotClass: string;
}

export function getStatusDisplay(thread: Thread): StatusDisplay {
  // Internal states map to user-facing labels
  switch (thread.status) {
    case "active":
      return { label: "Working", color: "text-yellow-500", dotClass: "bg-yellow-500" };
    case "paused":
    case "interrupted":
      return { label: "Awaiting Input", color: "text-blue-400", dotClass: "bg-blue-400" };
    case "errored":
      return { label: "Errored", color: "text-red-500", dotClass: "bg-red-500" };
    case "completed":
      return { label: "Completed", color: "text-green-500", dotClass: "bg-green-500" };
    case "archived":
    case "deleted":
    default:
      return { label: "Awaiting Input", color: "text-blue-400", dotClass: "bg-blue-400" };
  }
}
