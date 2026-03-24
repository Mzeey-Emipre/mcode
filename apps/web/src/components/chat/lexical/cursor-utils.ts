import { $getRoot, $isElementNode, type LexicalEditor } from "lexical";
import { $isMentionNode } from "./MentionNode";
import { $isSlashCommandNode } from "./SlashCommandNode";

/**
 * Extract plain text from the editor state, converting decorator nodes
 * back to their text representations (@path, /command).
 * This is the "collapsed" form used for message sending.
 */
export function getPlainTextFromEditor(editor: LexicalEditor): string {
  let text = "";
  editor.getEditorState().read(() => {
    const root = $getRoot();
    const paragraphs = root.getChildren();
    for (let i = 0; i < paragraphs.length; i++) {
      if (i > 0) text += "\n";
      const paragraph = paragraphs[i];
      if (!$isElementNode(paragraph)) {
        text += paragraph.getTextContent();
        continue;
      }
      const children = paragraph.getChildren();
      for (const child of children) {
        if ($isMentionNode(child)) {
          text += `@${child.getFilePath()}`;
        } else if ($isSlashCommandNode(child)) {
          text += `/${child.getCommandName()}`;
        } else {
          text += child.getTextContent();
        }
      }
    }
  });
  return text;
}

/**
 * Extract all mention file paths from the editor state.
 * Used to build the tagged files set for content injection.
 */
export function extractMentionPaths(editor: LexicalEditor): string[] {
  const pathSet = new Set<string>();
  editor.getEditorState().read(() => {
    const root = $getRoot();
    const paragraphs = root.getChildren();
    for (const paragraph of paragraphs) {
      if (!$isElementNode(paragraph)) continue;
      for (const child of paragraph.getChildren()) {
        if ($isMentionNode(child)) {
          pathSet.add(child.getFilePath());
        }
      }
    }
  });
  return [...pathSet];
}
