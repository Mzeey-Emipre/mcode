/** Window event fired when the terminal pool slot gains size or the active thread changes. */
export const TERMINAL_POOL_REFIT = "mcode:terminal-pool-refit";

/**
 * Notifies pooled {@link TerminalView} instances to refit and re-apply scroll anchors
 * after layout changes (thread switch, panel unhide, tab layer resize).
 */
export function dispatchTerminalPoolRefit(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TERMINAL_POOL_REFIT));
}
