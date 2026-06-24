import type { Thread } from "@/transport";

/**
 * Resolves the user-facing checkout label for a thread row or header control.
 */
export function resolveThreadCheckoutLabel(
  thread: Pick<Thread, "branch" | "checkout_state"> | null | undefined,
): string {
  if (!thread) return "HEAD";
  if (thread.checkout_state === "branchless" || thread.branch === "HEAD") {
    return "HEAD";
  }
  return thread.branch || "HEAD";
}
