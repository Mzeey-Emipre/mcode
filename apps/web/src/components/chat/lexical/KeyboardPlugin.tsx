import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isElementNode,
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

/** Keyboard handling callbacks for the Lexical chat composer. */
interface KeyboardPluginProps {
  /** Callback to submit the current message. */
  readonly onSubmit: () => void;
  /** When true, Enter-to-submit is suppressed. */
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
 *
 * Uses refs for popup callbacks to avoid constant re-registration of
 * CRITICAL-priority handlers, which can cause timing gaps where
 * Enter/Tab events slip through to the submit handler.
 */
export function KeyboardPlugin({
  onSubmit,
  disabled,
  isPopupOpen,
  onPopupKeyDown,
}: KeyboardPluginProps): null {
  const [editor] = useLexicalComposerContext();

  // Refs to always access latest values without re-registering handlers
  const isPopupOpenRef = useRef(isPopupOpen);
  isPopupOpenRef.current = isPopupOpen;

  const onPopupKeyDownRef = useRef(onPopupKeyDown);
  onPopupKeyDownRef.current = onPopupKeyDown;

  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // Register all keyboard handlers once, using refs for latest values
  useEffect(() => {
    // Popup interception at CRITICAL priority (above submit handler)
    const popupHandler = (key: string) => (event: KeyboardEvent | null): boolean => {
      if (!event) return false;
      if (!isPopupOpenRef.current || !onPopupKeyDownRef.current) return false;
      if (onPopupKeyDownRef.current(key)) {
        event.preventDefault();
        return true;
      }
      return false;
    };

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      popupHandler("ArrowDown") as (event: KeyboardEvent) => boolean,
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      popupHandler("ArrowUp") as (event: KeyboardEvent) => boolean,
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      popupHandler("Tab") as (event: KeyboardEvent) => boolean,
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEsc = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      popupHandler("Escape") as (event: KeyboardEvent) => boolean,
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterPopupEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;
        if (event.shiftKey) return false;
        if (!isPopupOpenRef.current || !onPopupKeyDownRef.current) return false;
        if (onPopupKeyDownRef.current("Enter")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    // Normal Enter-to-submit at HIGH priority
    const unregisterSubmitEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;
        if (event.shiftKey) return false;
        event.preventDefault();
        if (!disabledRef.current) {
          onSubmitRef.current();
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    // Backspace/Delete: remove decorator nodes when selected or cursor-adjacent
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

        if (anchor.type === "text") {
          const node = anchor.getNode();
          // Backspace at offset 0: remove the previous sibling chip
          if (anchor.offset === 0 && isBackward) {
            const prev = node.getPreviousSibling();
            if (prev && ($isMentionNode(prev) || $isSlashCommandNode(prev))) {
              event.preventDefault();
              prev.remove();
              return true;
            }
          }
          // Forward Delete at end of text: remove the next sibling chip
          if (!isBackward && anchor.offset === node.getTextContentSize()) {
            const next = node.getNextSibling();
            if (next && ($isMentionNode(next) || $isSlashCommandNode(next))) {
              event.preventDefault();
              next.remove();
              return true;
            }
          }
        }

        // Element anchor: cursor is between block children (e.g. after a chip with no text node)
        if (anchor.type === "element" && $isElementNode(anchor.getNode())) {
          const parent = anchor.getNode();
          if (isBackward && anchor.offset > 0) {
            const target = parent.getChildAtIndex(anchor.offset - 1);
            if (target && ($isMentionNode(target) || $isSlashCommandNode(target))) {
              event.preventDefault();
              target.remove();
              return true;
            }
          }
          if (!isBackward) {
            const target = parent.getChildAtIndex(anchor.offset);
            if (target && ($isMentionNode(target) || $isSlashCommandNode(target))) {
              event.preventDefault();
              target.remove();
              return true;
            }
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
      unregisterDown();
      unregisterUp();
      unregisterTab();
      unregisterEsc();
      unregisterPopupEnter();
      unregisterSubmitEnter();
      unregisterBackspace();
      unregisterDelete();
    };
  }, [editor]);

  return null;
}
