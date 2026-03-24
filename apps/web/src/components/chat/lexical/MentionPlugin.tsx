import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  TextNode,
  type LexicalEditor,
} from "lexical";
import { $createMentionNode } from "./MentionNode";

interface MentionPluginProps {
  readonly onTrigger: (text: string, cursorPos: number) => void;
  readonly onDismiss: () => void;
  readonly isPopupOpen: boolean;
}

/**
 * Lexical plugin that detects @-triggers for file mentions.
 * Scans the current text node backward from cursor for @ preceded
 * by whitespace or start-of-text.
 *
 * Uses refs for callbacks to register the update listener once,
 * avoiding re-registration on every prop change.
 */
export function MentionPlugin({
  onTrigger,
  onDismiss,
  isPopupOpen,
}: MentionPluginProps): null {
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

        // Only invoke trigger callback when @ is present
        if (!textBeforeCursor.includes("@")) {
          if (isPopupOpenRef.current) onDismissRef.current();
          return;
        }

        onTriggerRef.current(textContent, cursorOffset);
      });
    });
  }, [editor]);

  return null;
}

/**
 * Insert a mention node at the trigger position.
 * Replaces @query text in the current text node with a MentionNode.
 */
export function insertMentionNode(
  editor: LexicalEditor,
  filePath: string,
  triggerStart: number,
  queryLength: number,
): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    const anchor = selection.anchor;
    if (anchor.type !== "text") return;

    const node = anchor.getNode();
    if (!(node instanceof TextNode)) return;

    const textContent = node.getTextContent();
    const beforeAt = textContent.slice(0, triggerStart);
    const afterQuery = textContent.slice(triggerStart + 1 + queryLength);

    const mentionNode = $createMentionNode(filePath);
    const trailingText = afterQuery.length > 0 ? afterQuery : " ";
    const afterNode = $createTextNode(trailingText);

    if (beforeAt) {
      const beforeNode = $createTextNode(beforeAt);
      node.replace(beforeNode);
      beforeNode.insertAfter(mentionNode);
      mentionNode.insertAfter(afterNode);
    } else {
      node.replace(mentionNode);
      mentionNode.insertAfter(afterNode);
    }

    // Place cursor after the trailing space
    const offset = trailingText.startsWith(" ") ? 1 : 0;
    afterNode.select(offset, offset);
  });
}
