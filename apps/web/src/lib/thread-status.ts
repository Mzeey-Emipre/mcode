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
 */
export function getNotificationDot(
  thread: Thread,
  isActuallyRunning: boolean,
): NotificationDot | null {
  if (isActuallyRunning) {
    return { dotClass: "bg-primary", animate: true };
  }
  switch (thread.status) {
    case "completed":
      return { dotClass: "bg-[var(--diff-add-strong)]/85", animate: false };
    case "errored":
      return { dotClass: "bg-[var(--diff-remove-strong)]/90", animate: false };
    default:
      return null;
  }
}

/** Returns the display label, text color, and dot class for a thread's status. */
export function getStatusDisplay(
  thread: Thread,
  isActuallyRunning: boolean,
): StatusDisplay {
  // Live process state takes priority over DB status
  if (isActuallyRunning) {
    return {
      label: "",
      color: "text-primary/90",
      dotClass: "bg-primary animate-pulse",
    };
  }

  // DB-driven states when agent is NOT running
  switch (thread.status) {
    case "errored":
      return {
        label: "Errored",
        color: "text-[var(--diff-remove-strong)]/80",
        dotClass: "bg-[var(--diff-remove-strong)]/85",
      };
    case "completed":
      return {
        label: "",
        color: "text-[var(--diff-add-strong)]/80",
        dotClass: "bg-[var(--diff-add-strong)]/80",
      };
    default:
      // No agent running, not completed, not errored = idle / ready for input
      return { label: "", color: "text-muted-foreground", dotClass: "bg-muted-foreground/35" };
  }
}
