import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ContextMenu } from "@/components/ui/context-menu";

/** Data pushed from the Electron main process on right-click. */
interface ContextMenuEvent {
  readonly x: number;
  readonly y: number;
  readonly misspelledWord: string;
  readonly suggestions: readonly string[];
  readonly selectionText: string;
  readonly isEditable: boolean;
  readonly editFlags: {
    readonly canCut: boolean;
    readonly canCopy: boolean;
    readonly canPaste: boolean;
    readonly canSelectAll: boolean;
  };
}

interface SpellcheckContextMenuProps {
  /** Ref to the editor container element, used to scope context-menu events to the Composer. */
  readonly editorRef: RefObject<HTMLDivElement | null>;
}

/**
 * Custom context menu for the Composer editor showing spelling suggestions
 * from Electron's built-in spellchecker. Gracefully does nothing when
 * running in a browser without the Electron desktop bridge.
 */
export function SpellcheckContextMenu({ editorRef }: SpellcheckContextMenuProps) {
  const [menuState, setMenuState] = useState<ContextMenuEvent | null>(null);
  // Set to true when the most recent contextmenu event came from the editor element.
  // Cleared after the IPC data arrives so stale events don't trigger the menu.
  const pendingRef = useRef(false);

  // Prevent the native context menu on the editor and mark the next IPC event as local.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    const handleContextMenu = (e: MouseEvent) => {
      pendingRef.current = true;
      e.preventDefault();
    };

    el.addEventListener("contextmenu", handleContextMenu);
    return () => el.removeEventListener("contextmenu", handleContextMenu);
  }, [editorRef]);

  // Listen for spellcheck context-menu IPC events from the Electron main process.
  useEffect(() => {
    const bridge = window.desktopBridge?.spellcheck;
    if (!bridge) return;

    // onContextMenu returns the listener reference for targeted cleanup.
    const listener = bridge.onContextMenu((data) => {
      if (!pendingRef.current) return;
      pendingRef.current = false;

      const event = data as ContextMenuEvent;
      if (!event.isEditable) return;

      setMenuState(event);
    });

    return () => bridge.offContextMenu(listener);
  }, []);

  const handleClose = useCallback(() => setMenuState(null), []);

  // Note: ContextMenu auto-calls onClose() after every item click,
  // so individual onClick handlers must NOT call setMenuState(null) themselves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleReplace = useCallback((word: string) => {
    window.desktopBridge?.spellcheck.replaceMisspelling(word);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleAddToDictionary = useCallback((word: string) => {
    window.desktopBridge?.spellcheck.addToDictionary(word);
  }, []);

  if (!menuState) return null;

  const { x, y, misspelledWord, suggestions, editFlags } = menuState;

  // Build menu items: spelling suggestions first, then standard edit operations.
  const items: Array<{
    label: string;
    onClick: () => void;
    destructive?: boolean;
    divider?: boolean;
  }> = [];

  // Spelling section (only when a misspelled word is under the cursor).
  if (misspelledWord) {
    for (const suggestion of suggestions) {
      items.push({ label: suggestion, onClick: () => handleReplace(suggestion) });
    }
    // Omit "No suggestions" placeholder - avoids a dead clickable item.
    items.push({ label: "", onClick: () => {}, divider: true });
    items.push({
      label: `Add "${misspelledWord}" to dictionary`,
      onClick: () => handleAddToDictionary(misspelledWord),
    });
    items.push({ label: "", onClick: () => {}, divider: true });
  }

  // Edit section - use Clipboard API for copy/cut; Electron IPC for paste.
  // ContextMenu auto-closes after each click, so no manual handleClose() needed.
  if (editFlags.canCut) {
    items.push({
      label: "Cut",
      onClick: () => {
        const sel = window.getSelection();
        if (sel?.toString()) {
          navigator.clipboard.writeText(sel.toString());
          sel.deleteFromDocument();
        }
      },
    });
  }
  if (editFlags.canCopy) {
    items.push({
      label: "Copy",
      onClick: () => {
        const sel = window.getSelection();
        if (sel) navigator.clipboard.writeText(sel.toString());
      },
    });
  }
  if (editFlags.canPaste) {
    items.push({
      label: "Paste",
      onClick: () => {
        // Use Electron's native paste via IPC (execCommand('paste') is unreliable).
        window.desktopBridge?.spellcheck.paste();
      },
    });
  }
  if (editFlags.canSelectAll) {
    items.push({
      label: "Select All",
      // execCommand('selectAll') works reliably for contenteditable elements.
      onClick: () => document.execCommand("selectAll"),
    });
  }

  return <ContextMenu x={x} y={y} items={items} onClose={handleClose} />;
}
