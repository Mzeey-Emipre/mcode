import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ENTER_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_TAB_COMMAND,
  KEY_ESCAPE_COMMAND,
} from "lexical";

interface KeyboardPluginProps {
  readonly onSubmit: () => void;
  readonly disabled?: boolean;
  /** When true, intercept navigation keys for popup handling. */
  readonly isPopupOpen?: boolean;
  /** Called when a navigation key is pressed while popup is open. Returns true if handled. */
  readonly onPopupKeyDown?: (key: string) => boolean;
}

/**
 * Lexical plugin for keyboard shortcuts.
 * - Enter (without Shift): submit message (or select popup item)
 * - Shift+Enter: insert newline (default Lexical behavior)
 * - Arrow keys, Tab, Escape: delegated to popup handler when open
 */
export function KeyboardPlugin({
  onSubmit,
  disabled,
  isPopupOpen,
  onPopupKeyDown,
}: KeyboardPluginProps): null {
  const [editor] = useLexicalComposerContext();

  // Popup keyboard interception at CRITICAL priority (above normal handlers)
  useEffect(() => {
    if (!isPopupOpen || !onPopupKeyDown) return;

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (onPopupKeyDown("ArrowDown")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event: KeyboardEvent) => {
        if (onPopupKeyDown("ArrowUp")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event: KeyboardEvent) => {
        if (onPopupKeyDown("Tab")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEsc = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event: KeyboardEvent) => {
        if (onPopupKeyDown("Escape")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;
        if (event.shiftKey) return false;
        if (onPopupKeyDown("Enter")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterTab();
      unregisterEsc();
      unregisterEnter();
    };
  }, [editor, isPopupOpen, onPopupKeyDown]);

  // Normal Enter-to-submit at HIGH priority
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;
        if (event.shiftKey) return false;
        event.preventDefault();
        if (!disabled) {
          onSubmit();
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSubmit, disabled]);

  return null;
}
