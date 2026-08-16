/** Keyboard platform used by the terminal clipboard contract. */
export type TerminalShortcutPlatform = "mac" | "windows" | "linux" | "other";

/** Resolves the host platform without treating a modifier as platform evidence. */
export function detectTerminalShortcutPlatform(): TerminalShortcutPlatform {
  const platform = typeof navigator === "undefined"
    ? ""
    : `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (platform.includes("mac")) return "mac";
  if (platform.includes("linux")) return "linux";
  if (platform.includes("win")) return "windows";
  return "other";
}

function usesPlatformModifier(
  event: KeyboardEvent,
  platform: TerminalShortcutPlatform,
): boolean {
  return platform === "mac"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * Returns whether the keyboard event is the platform-valid terminal copy shortcut.
 *
 * @param event - The keyboard event from xterm's `attachCustomKeyEventHandler` callback.
 * @param hasSelection - Whether the terminal currently has selected text.
 * @param platform - Optional platform override for deterministic tests.
 */
export function shouldInterceptKeyEvent(
  event: KeyboardEvent,
  hasSelection: boolean,
  platform?: TerminalShortcutPlatform,
): boolean {
  if (event.isComposing) return false;
  // Modifier inference keeps this pure helper useful in existing callers and
  // tests. The renderer passes its detected platform explicitly.
  const resolvedPlatform = platform ?? (event.metaKey ? "mac" : "other");
  if (!usesPlatformModifier(event, resolvedPlatform)) return false;
  const key = event.key.toLowerCase();

  if (key !== "c") return false;

  // Windows and Linux use Ctrl+Shift+C. macOS uses Cmd+C.
  if (resolvedPlatform !== "mac" && event.shiftKey) return true;
  if (resolvedPlatform === "mac" && !event.shiftKey) return hasSelection;

  // Ctrl+C always reaches the PTY on Windows/Linux, even when xterm has a selection.
  return false;
}

/** Returns whether the keyboard event is the platform-valid terminal paste shortcut. */
export function isTerminalPasteShortcut(
  event: KeyboardEvent,
  platform: TerminalShortcutPlatform = detectTerminalShortcutPlatform(),
): boolean {
  if (event.isComposing) return false;
  return event.key.toLowerCase() === "v" &&
    usesPlatformModifier(event, platform) &&
    (platform === "mac" || event.shiftKey);
}

/** Returns whether a middle-click should paste on this host platform. */
export function isTerminalMiddleClickPaste(
  event: Pick<MouseEvent, "button">,
  platform: TerminalShortcutPlatform = detectTerminalShortcutPlatform(),
): boolean {
  return platform === "linux" && event.button === 1;
}

/** Returns true for the platform-neutral Ctrl/Cmd+F terminal search shortcut. */
export function isTerminalSearchShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f"
  );
}
