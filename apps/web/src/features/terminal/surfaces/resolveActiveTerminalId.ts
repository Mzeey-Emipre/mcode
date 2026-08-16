import type { TerminalInstance } from "@/features/terminal/state/terminalStore";

/**
 * Returns the PTY id to display for a thread: stored selection when valid,
 * otherwise the first terminal in the thread.
 */
export function resolveActiveTerminalId(
  threadId: string | null,
  storedActiveId: string | null,
  terminals: Record<string, readonly TerminalInstance[]>,
): string | null {
  if (!threadId) return null;
  const list = terminals[threadId];
  if (!list || list.length === 0) return null;
  if (storedActiveId && list.some((t) => t.id === storedActiveId)) {
    return storedActiveId;
  }
  return list[0]!.id;
}
