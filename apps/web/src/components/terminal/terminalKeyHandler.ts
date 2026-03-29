/**
 * Returns `true` if the keyboard event should be intercepted for clipboard copy
 * (i.e. xterm should NOT forward it to the PTY), `false` otherwise.
 *
 * Rules:
 * - Ctrl+Shift+C / Cmd+Shift+C: always intercept (explicit copy shortcut, like gnome-terminal)
 * - Ctrl+C / Cmd+C with a selection: intercept and copy selected text
 * - Ctrl+C / Cmd+C without a selection: do NOT intercept (let SIGINT through to PTY)
 * - Everything else: do NOT intercept
 */
export function shouldInterceptKeyEvent(
  event: KeyboardEvent,
  hasSelection: boolean,
): boolean {
  const isMod = event.ctrlKey || event.metaKey;
  if (!isMod) return false;

  const key = event.key.toLowerCase();

  // Ctrl+Shift+C or Cmd+Shift+C: always intercept as explicit copy
  if (key === "c" && event.shiftKey) return true;

  // Ctrl+C or Cmd+C: only intercept when the terminal has selected text
  if (key === "c" && !event.shiftKey) return hasSelection;

  return false;
}
