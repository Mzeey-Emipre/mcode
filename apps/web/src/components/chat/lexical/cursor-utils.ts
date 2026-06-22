import { $getRoot, $isElementNode, type LexicalEditor } from "lexical";
import type { MessageMention } from "@mcode/contracts";
import { $isMentionNode } from "./MentionNode";
import { $isSlashCommandNode } from "./SlashCommandNode";

/** Composer text and selected typed mentions with JS string offsets. */
export interface ExtractedComposerMessage {
  readonly text: string;
  readonly mentions: MessageMention[];
}

/**
 * Extract collapsed composer text and metadata from selected mention nodes.
 * Plain typed @foo text remains text because it is not represented by a node.
 */
export function extractComposerMessage(editor: LexicalEditor): ExtractedComposerMessage {
  let text = "";
  const mentions: MessageMention[] = [];
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
          const mentionText = child.getTextContent();
          const start = text.length;
          text += mentionText;
          mentions.push({ ...child.getMentionData(), range: { start, end: text.length } });
        } else if ($isSlashCommandNode(child)) {
          text += `/${child.getCommandName()}`;
        } else {
          text += child.getTextContent();
        }
      }
    }
  });
  return { text, mentions };
}

/**
 * Extract plain text from the editor state, converting decorator nodes
 * back to their text representations (@path, /command).
 * This is the "collapsed" form used for message sending.
 */
export function getPlainTextFromEditor(editor: LexicalEditor): string {
  return extractComposerMessage(editor).text;
}

/**
 * Extract all mention file paths from the editor state.
 * Used to build the tagged files set for content injection.
 */
export function extractMentionPaths(editor: LexicalEditor): string[] {
  return [
    ...new Set(
      extractComposerMessage(editor).mentions
        .filter((mention) => mention.kind === "file")
        .map((mention) => mention.path),
    ),
  ];
}
