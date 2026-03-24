import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  TextNode,
  type LexicalEditor,
} from "lexical";
import {
  $createSlashCommandNode,
  type SlashCommandNamespace,
} from "./SlashCommandNode";
import { SLASH_TRIGGER_RE } from "../useSlashCommand";

/** Props for the SlashCommandPlugin that detects /-triggers in the editor. */
interface SlashCommandPluginProps {
  /** Called when a /command trigger is detected, with the full text content. */
  readonly onTrigger: (value: string) => void;
  /** Called to close the slash popup when the trigger is no longer valid. */
  readonly onDismiss: () => void;
  /** Whether the slash command popup is currently visible. */
  readonly isPopupOpen: boolean;
}

/**
 * Lexical plugin that detects /-triggers for slash commands.
 *
 * Uses refs for callbacks to register the update listener once,
 * avoiding re-registration on every prop change.
 */
export function SlashCommandPlugin({
  onTrigger,
  onDismiss,
  isPopupOpen,
}: SlashCommandPluginProps): null {
  const [editor] = useLexicalComposerContext();

  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const isPopupOpenRef = useRef(isPopupOpen);
  isPopupOpenRef.current = isPopupOpen;

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          if (isPopupOpenRef.current) onDismissRef.current();
          return;
        }

        const anchor = selection.anchor;
        if (anchor.type !== "text") {
          if (isPopupOpenRef.current) onDismissRef.current();
          return;
        }

        const node = anchor.getNode();
        if (!(node instanceof TextNode)) {
          if (isPopupOpenRef.current) onDismissRef.current();
          return;
        }

        const textContent = node.getTextContent();
        const cursorOffset = anchor.offset;
        const textBeforeCursor = textContent.slice(0, cursorOffset);

        const match = SLASH_TRIGGER_RE.exec(textBeforeCursor);
        if (!match) {
          if (isPopupOpenRef.current) onDismissRef.current();
          return;
        }

        // Pass full text content to the existing hook's input handler
        onTriggerRef.current(textContent);
      });
    });
  }, [editor]);

  return null;
}

/**
 * Insert a slash command node at the current / trigger position.
 */
export function insertSlashCommandNode(
  editor: LexicalEditor,
  commandName: string,
  namespace: SlashCommandNamespace,
): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    const anchor = selection.anchor;
    if (anchor.type !== "text") return;

    const node = anchor.getNode();
    if (!(node instanceof TextNode)) return;

    const textContent = node.getTextContent();
    const cursorOffset = anchor.offset;
    const textBeforeCursor = textContent.slice(0, cursorOffset);

    const match = SLASH_TRIGGER_RE.exec(textBeforeCursor);
    if (!match) return;

    const triggerStart = match.index + match[1].length;
    const afterCursor = textContent.slice(cursorOffset);

    const commandNode = $createSlashCommandNode(commandName, namespace);
    const trailingText = afterCursor.length > 0 ? afterCursor : " ";
    const afterNode = $createTextNode(trailingText);

    const beforeText = textContent.slice(0, triggerStart);
    if (beforeText) {
      const beforeNode = $createTextNode(beforeText);
      node.replace(beforeNode);
      beforeNode.insertAfter(commandNode);
      commandNode.insertAfter(afterNode);
    } else {
      node.replace(commandNode);
      commandNode.insertAfter(afterNode);
    }

    const offset = trailingText.startsWith(" ") ? 1 : 0;
    afterNode.select(offset, offset);
  });
}
