import { useEffect } from "react";
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

/** Regex: matches `/` at start of text or after whitespace. */
const TRIGGER_RE = /(^|\s)(\/\S*)$/;

interface SlashCommandPluginProps {
  readonly onTrigger: (value: string) => void;
  readonly onDismiss: () => void;
  readonly isPopupOpen: boolean;
}

/**
 * Lexical plugin that detects /-triggers for slash commands.
 */
export function SlashCommandPlugin({
  onTrigger,
  onDismiss,
  isPopupOpen,
}: SlashCommandPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          if (isPopupOpen) onDismiss();
          return;
        }

        const anchor = selection.anchor;
        if (anchor.type !== "text") {
          if (isPopupOpen) onDismiss();
          return;
        }

        const node = anchor.getNode();
        if (!(node instanceof TextNode)) {
          if (isPopupOpen) onDismiss();
          return;
        }

        const textContent = node.getTextContent();
        const cursorOffset = anchor.offset;
        const textBeforeCursor = textContent.slice(0, cursorOffset);

        const match = TRIGGER_RE.exec(textBeforeCursor);
        if (!match) {
          if (isPopupOpen) onDismiss();
          return;
        }

        // Pass full text content to the existing hook's input handler
        onTrigger(textContent);
      });
    });
  }, [editor, onTrigger, onDismiss, isPopupOpen]);

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

    const match = TRIGGER_RE.exec(textBeforeCursor);
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
