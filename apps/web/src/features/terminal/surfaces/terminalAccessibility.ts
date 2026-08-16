/** User preference for xterm screen-reader support. */
export type TerminalScreenReaderMode = "off" | "auto" | "on";

/** Resolves the screen-reader setting without probing assistive technology in browser mode. */
export async function resolveTerminalScreenReaderMode(
  mode: TerminalScreenReaderMode,
): Promise<boolean> {
  if (mode === "off") return false;
  if (mode === "on") return true;

  const getAccessibilitySupport = window.desktopBridge?.getAccessibilitySupport;
  if (!getAccessibilitySupport) return false;

  try {
    return (await getAccessibilitySupport()) === true;
  } catch {
    return false;
  }
}
