import type { Thread } from "@/transport/types";

/** Visual shape of a status indicator. "solid" renders as a filled dot; "ring" renders as a hollow circle. */
export type StatusShape = "solid" | "ring";

/** Visual properties for rendering a thread's current status. */
export interface StatusDisplay {
  label: string;
  color: string;
  dotClass: string;
  shape: StatusShape;
}

/** Notification dot overlay for PR threads with an actionable status. */
export interface NotificationDot {
  dotClass: string;
  animate: boolean;
  shape: StatusShape;
}

/**
 * Returns notification dot info for threads with PRs, or null if idle.
 * Used to overlay a small colored dot on the PR icon in the sidebar.
 * @param thread - The thread whose PR notification dot is being computed.
 * @param isActuallyRunning - True when the agent process is currently live.
 * @param hasPendingPermission - True when the thread has at least one unsettled permission request; renders an amber ring.
 */
export function getNotificationDot(
  thread: Thread,
  isActuallyRunning: boolean,
  hasPendingPermission = false,
): NotificationDot | null {
  // Amber takes top priority — show even if the thread has temporarily dropped
  // from runningThreadIds (reconnect race, another tab, etc.). Uses a ring
  // instead of a dot so it reads distinctly from the running-state amber dot.
  if (hasPendingPermission) {
    return {
      dotClass: "ring-2 ring-inset ring-amber-500 bg-transparent",
      animate: true,
      shape: "ring",
    };
  }
  if (isActuallyRunning) {
    return { dotClass: "bg-primary", animate: true, shape: "solid" };
  }
  switch (thread.status) {
    case "completed":
      return { dotClass: "bg-[var(--diff-add-strong)]/85", animate: false, shape: "solid" };
    case "errored":
      return { dotClass: "bg-[var(--diff-remove-strong)]/90", animate: false, shape: "solid" };
    default:
      return null;
  }
}

/**
 * Returns the display label, text color, and dot class for a thread's status.
 * @param thread - The thread whose status display is being computed.
 * @param isActuallyRunning - True when the agent process is currently live.
 * @param hasPendingPermission - True when the thread has at least one unsettled permission request; renders an amber pulsing ring.
 */
export function getStatusDisplay(
  thread: Thread,
  isActuallyRunning: boolean,
  hasPendingPermission = false,
): StatusDisplay {
  // Pending permission is top priority — show amber even if the thread has
  // temporarily dropped from runningThreadIds. Uses a hollow ring so it does
  // NOT visually collide with the running-state amber dot.
  if (hasPendingPermission) {
    return {
      label: "",
      color: "text-amber-500",
      dotClass: "ring-2 ring-inset ring-amber-500 bg-transparent animate-pulse",
      shape: "ring",
    };
  }
  // Live process state takes priority over DB status
  if (isActuallyRunning) {
    return {
      label: "",
      color: "text-primary/90",
      dotClass: "bg-primary animate-pulse",
      shape: "solid",
    };
  }

  // DB-driven states when agent is NOT running
  switch (thread.status) {
    case "errored":
      return {
        label: "Errored",
        color: "text-[var(--diff-remove-strong)]/80",
        dotClass: "bg-[var(--diff-remove-strong)]/85",
        shape: "solid",
      };
    case "completed":
      return {
        label: "",
        color: "text-[var(--diff-add-strong)]/80",
        dotClass: "bg-[var(--diff-add-strong)]/80",
        shape: "solid",
      };
    default:
      // No agent running, not completed, not errored = idle / ready for input
      return {
        label: "",
        color: "text-muted-foreground",
        dotClass: "bg-muted-foreground/35",
        shape: "solid",
      };
  }
}
