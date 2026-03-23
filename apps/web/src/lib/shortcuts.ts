type ShortcutHandler = () => void;

interface Shortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  description: string;
  handler: ShortcutHandler;
}

let shortcuts: readonly Shortcut[] = [];

export function registerShortcut(shortcut: Shortcut): () => void {
  shortcuts = [...shortcuts, shortcut];
  return () => {
    shortcuts = shortcuts.filter((s) => s !== shortcut);
  };
}

export function handleKeyDown(e: KeyboardEvent): void {
  // Don't intercept keystrokes when a terminal (xterm) has focus
  const target = e.target as HTMLElement | null;
  if (target?.closest(".xterm") || target?.classList.contains("xterm-helper-textarea")) {
    return;
  }

  for (const shortcut of shortcuts) {
    const ctrlOrMeta = shortcut.ctrl || shortcut.meta;
    const keyMatches = e.key.toLowerCase() === shortcut.key.toLowerCase();
    const modifierMatches = ctrlOrMeta ? e.ctrlKey || e.metaKey : true;
    const shiftMatches = shortcut.shift ? e.shiftKey : !e.shiftKey;

    if (keyMatches && modifierMatches && shiftMatches) {
      e.preventDefault();
      shortcut.handler();
      return;
    }
  }
}

export function getShortcuts(): readonly Shortcut[] {
  return shortcuts;
}

export function initShortcuts(): () => void {
  document.addEventListener("keydown", handleKeyDown);
  return () => document.removeEventListener("keydown", handleKeyDown);
}
