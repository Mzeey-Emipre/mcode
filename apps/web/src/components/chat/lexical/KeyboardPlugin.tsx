import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
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
  type LexicalNode,
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

interface KeyboardRefs {
  isPopupOpen: MutableRefObject<boolean | undefined>;
  onPopupKeyDown: MutableRefObject<((key: string) => boolean) | undefined>;
  onSubmit: MutableRefObject<() => void>;
  disabled: MutableRefObject<boolean | undefined>;
}

/** Handles a popup navigation key when a Composer popup has claimed it. */
function handlePopupKey(event: KeyboardEvent | null, key: string, refs: KeyboardRefs): boolean {
  const popupHandler = refs.onPopupKeyDown.current;
  if (!event || !refs.isPopupOpen.current || !popupHandler) return false;
  if (!popupHandler(key)) return false;
  event.preventDefault();
  return true;
}

/** Handles Enter for an open Composer popup. */
function handlePopupEnter(event: KeyboardEvent | null, refs: KeyboardRefs): boolean {
  if (!event || event.shiftKey) return false;
  return handlePopupKey(event, "Enter", refs);
}

/** Submits the Composer for an unhandled Enter key. */
function handleSubmitEnter(event: KeyboardEvent | null, refs: KeyboardRefs): boolean {
  if (!event || event.shiftKey) return false;
  event.preventDefault();
  if (!refs.disabled.current) refs.onSubmit.current();
  return true;
}

/** Returns whether a Lexical node is a mention or slash-command chip. */
function isDecoratorShortcutNode(node: LexicalNode): boolean {
  return $isMentionNode(node) || $isSlashCommandNode(node);
}

/** Removes selected chips and preserves Lexical's node-selection delete behavior. */
function removeSelectedShortcutNodes(event: KeyboardEvent, selection: ReturnType<typeof $getSelection>): boolean {
  if (!$isNodeSelection(selection)) return false;
  event.preventDefault();
  for (const node of selection.getNodes()) {
    if (isDecoratorShortcutNode(node)) node.remove();
  }
  return true;
}

/** Finds the chip adjacent to a collapsed range selection in a delete direction. */
function getAdjacentShortcutNode(
  selection: ReturnType<typeof $getSelection>,
  isBackward: boolean,
): LexicalNode | null {
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

  const anchor = selection.anchor;
  if (anchor.type === "text") {
    return getTextAdjacentShortcutNode(anchor.getNode(), anchor.offset, isBackward);
  }
  if (anchor.type === "element") {
    return getElementAdjacentShortcutNode(anchor.getNode(), anchor.offset, isBackward);
  }
  return null;
}

/** Finds the chip adjacent to a text selection anchor. */
function getTextAdjacentShortcutNode(
  node: LexicalNode,
  offset: number,
  isBackward: boolean,
): LexicalNode | null {
  if (isBackward && offset === 0) return node.getPreviousSibling();
  if (!isBackward && offset === node.getTextContentSize()) return node.getNextSibling();
  return null;
}

/** Finds the chip adjacent to an element selection anchor. */
function getElementAdjacentShortcutNode(
  node: LexicalNode,
  offset: number,
  isBackward: boolean,
): LexicalNode | null {
  if (!$isElementNode(node)) return null;
  if (isBackward && offset === 0) return null;
  return node.getChildAtIndex(isBackward ? offset - 1 : offset);
}

/** Deletes a selected or cursor-adjacent Composer chip. */
function handleShortcutDelete(event: KeyboardEvent, isBackward: boolean): boolean {
  const selection = $getSelection();
  if (removeSelectedShortcutNodes(event, selection)) return true;

  const node = getAdjacentShortcutNode(selection, isBackward);
  if (!node || !isDecoratorShortcutNode(node)) return false;
  event.preventDefault();
  node.remove();
  return true;
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

  const refs = useMemo<KeyboardRefs>(() => ({
    isPopupOpen: isPopupOpenRef,
    onPopupKeyDown: onPopupKeyDownRef,
    onSubmit: onSubmitRef,
    disabled: disabledRef,
  }), []);

  // Register all keyboard handlers once, using refs for latest values
  useEffect(() => {
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handlePopupKey(event, "ArrowDown", refs),
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handlePopupKey(event, "ArrowUp", refs),
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => handlePopupKey(event, "Tab", refs),
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEsc = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => handlePopupKey(event, "Escape", refs),
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterPopupEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => handlePopupEnter(event, refs),
      COMMAND_PRIORITY_CRITICAL,
    );

    // Normal Enter-to-submit at HIGH priority
    const unregisterSubmitEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => handleSubmitEnter(event, refs),
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => handleShortcutDelete(event, true),
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterDelete = editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => handleShortcutDelete(event, false),
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
  }, [editor, refs]);

  return null;
}
