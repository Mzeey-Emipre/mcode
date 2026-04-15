import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ContextMenu } from "@/components/ui/context-menu";
import type { SpellcheckContextMenuData } from "@/transport/desktop-bridge";

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
  const [menuState, setMenuState] = useState<SpellcheckContextMenuData | null>(null);
  // Stores the CSS-pixel viewport coordinates captured from the DOM contextmenu
  // event. Non-null means a right-click on the editor is pending an IPC response.
  // Cleared once the IPC data arrives so stale events don't trigger the menu.
  const pendingPos = useRef<{ x: number; y: number } | null>(null);

  // Capture click position from the DOM event and mark the next IPC event as local.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    const handleContextMenu = (e: MouseEvent) => {
      // Capture viewport-relative CSS pixel coordinates from the DOM event.
      // We use these for menu positioning instead of the Electron IPC coordinates,
      // which can be in physical pixels on high-DPI displays causing offset menus.
      // Do NOT call e.preventDefault() here - that would tell Chromium the event
      // is handled and it would skip the ShowContextMenu IPC to the main process,
      // meaning the Electron context-menu event never fires and we lose spelling data.
      // The main process calls event.preventDefault() in its handler instead.
      pendingPos.current = { x: e.clientX, y: e.clientY };
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
      const pos = pendingPos.current;
      if (!pos) return;
      pendingPos.current = null;

      if (!data.isEditable) return;

      // Override x/y with DOM coordinates so the menu appears exactly at the
      // cursor regardless of how Electron reports coordinates on this display.
      setMenuState({ ...data, x: pos.x, y: pos.y });
    });

    return () => bridge.offContextMenu(listener);
  }, []);

  const handleClose = useCallback(() => setMenuState(null), []);

  // Note: ContextMenu auto-calls onClose() after every item click,
  // so individual onClick handlers must NOT call setMenuState(null) themselves.
  const handleReplace = useCallback((word: string) => {
    window.desktopBridge?.spellcheck.replaceMisspelling(word);
  }, []);

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
      onClick: async () => {
        const sel = window.getSelection();
        const text = sel?.toString();
        if (text) {
          try {
            await navigator.clipboard.writeText(text);
            // Only delete after the clipboard write succeeds - deleting first
            // would lose the text if writeText rejects (e.g. permission denied).
            sel!.deleteFromDocument();
          } catch {
            // Clipboard write failed; leave the selection intact.
          }
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
