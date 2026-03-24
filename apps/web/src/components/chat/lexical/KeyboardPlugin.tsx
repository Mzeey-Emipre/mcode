import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_CRITICAL,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_TAB_COMMAND,
  KEY_ESCAPE_COMMAND,
} from "lexical";
import { $isMentionNode } from "./MentionNode";
import { $isSlashCommandNode } from "./SlashCommandNode";

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

  // Backspace/Delete: remove decorator nodes when selected or cursor-adjacent
  useEffect(() => {
    const handleDelete = (event: KeyboardEvent, isBackward: boolean): boolean => {
      const selection = $getSelection();

      // Case 1: NodeSelection (chip is highlighted) - delete all selected nodes
      if ($isNodeSelection(selection)) {
        event.preventDefault();
        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isMentionNode(node) || $isSlashCommandNode(node)) {
            node.remove();
          }
        }
        return true;
      }

      // Case 2: RangeSelection with cursor right after a decorator node
      if ($isRangeSelection(selection) && selection.isCollapsed()) {
        const anchor = selection.anchor;
        if (anchor.type === "text" && anchor.offset === 0 && isBackward) {
          const node = anchor.getNode();
          const prev = node.getPreviousSibling();
          if (prev && ($isMentionNode(prev) || $isSlashCommandNode(prev))) {
            event.preventDefault();
            prev.remove();
            return true;
          }
        }
      }

      return false;
    };

    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event: KeyboardEvent) => handleDelete(event, true),
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterDelete = editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event: KeyboardEvent) => handleDelete(event, false),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterBackspace();
      unregisterDelete();
    };
  }, [editor]);

  return null;
}
