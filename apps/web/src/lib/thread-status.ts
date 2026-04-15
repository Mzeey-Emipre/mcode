import type { Thread } from "@/transport/types";

/** Visual properties for rendering a thread's current status. */
export interface StatusDisplay {
  label: string;
  color: string;
  dotClass: string;
}

/** Notification dot overlay for PR threads with an actionable status. */
export interface NotificationDot {
  dotClass: string;
  animate: boolean;
}

/**
 * Returns notification dot info for threads with PRs, or null if idle.
 * Used to overlay a small colored dot on the PR icon in the sidebar.
 * @param thread - The thread whose PR notification dot is being computed.
 * @param isActuallyRunning - True when the agent process is currently live.
 * @param hasPendingPermission - True when the thread has at least one unsettled permission request; renders an amber dot.
 */
export function getNotificationDot(
  thread: Thread,
  isActuallyRunning: boolean,
  hasPendingPermission = false,
): NotificationDot | null {
  // Amber takes top priority — show even if the thread has temporarily dropped
  // from runningThreadIds (reconnect race, another tab, etc.).
  if (hasPendingPermission) {
    return { dotClass: "bg-amber-500", animate: true };
  }
  if (isActuallyRunning) {
    return { dotClass: "bg-yellow-500", animate: true };
  }
  switch (thread.status) {
    case "completed":
      return { dotClass: "bg-green-500", animate: false };
    case "errored":
      return { dotClass: "bg-destructive", animate: false };
    default:
      return null;
  }
}

/**
 * Returns the display label, text color, and dot class for a thread's status.
 * @param thread - The thread whose status display is being computed.
 * @param isActuallyRunning - True when the agent process is currently live.
 * @param hasPendingPermission - True when the thread has at least one unsettled permission request; renders an amber pulsing dot.
 */
export function getStatusDisplay(
  thread: Thread,
  isActuallyRunning: boolean,
  hasPendingPermission = false,
): StatusDisplay {
  // Pending permission is top priority — show amber even if the thread has
  // temporarily dropped from runningThreadIds (reconnect race, another tab).
  if (hasPendingPermission) {
    return {
      label: "",
      color: "text-amber-500",
      dotClass: "bg-amber-500 animate-pulse",
    };
  }
  // Live process state takes priority over DB status
  if (isActuallyRunning) {
    return {
      label: "",
      color: "text-yellow-500",
      dotClass: "bg-yellow-500 animate-pulse",
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
        label: "",
        color: "text-green-500",
        dotClass: "bg-green-500",
      };
    default:
      // No agent running, not completed, not errored = idle / ready for input
      return { label: "", color: "text-muted-foreground", dotClass: "bg-muted-foreground/50" };
  }
}
