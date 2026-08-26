import type { MessageMention } from "@mcode/contracts";
import {
  $createSlashCommandNode,
  $createTypedMentionNode,
} from "@/components/chat/lexical";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from "lexical";

/** Replace Composer editor content while preserving typed mention nodes and line breaks. */
export function writeComposerContent(
  editor: LexicalEditor,
  text: string,
  mentionRanges: readonly MessageMention[] = [],
  italic = false,
): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    let paragraph = $createParagraphNode();
    const sortedMentions = [...mentionRanges].sort((a, b) => a.range.start - b.range.start);
    let cursor = 0;

    const appendText = (value: string) => {
      const parts = value.split("\n");
      for (let index = 0; index < parts.length; index++) {
        if (index > 0) {
          root.append(paragraph);
          paragraph = $createParagraphNode();
        }
        if (parts[index]) {
          const node = $createTextNode(parts[index]);
          if (italic) node.setFormat(2);
          paragraph.append(node);
        }
      }
    };

    for (const mention of sortedMentions) {
      const mentionText = mention.kind === "command" ? `/${mention.label}` : `@${mention.label}`;
      if (
        mention.range.start < cursor ||
        mention.range.end > text.length ||
        text.slice(mention.range.start, mention.range.end) !== mentionText
      ) {
        continue;
      }
      appendText(text.slice(cursor, mention.range.start));
      if (mention.kind === "command") {
        paragraph.append(
          $createSlashCommandNode(
            mention.label,
            mention.namespace,
            mention.capabilityIdentity,
          ),
        );
        cursor = mention.range.end;
        continue;
      }
      const nodeMention =
        mention.kind === "file"
          ? {
              id: mention.id,
              kind: mention.kind,
              label: mention.label,
              path: mention.path,
            }
          : {
              id: mention.id,
              kind: mention.kind,
              label: mention.label,
              name: mention.name,
              path: mention.path,
              ...(mention.kind === "agent" ? { provider: mention.provider } : {}),
            };
      paragraph.append($createTypedMentionNode(nodeMention));
      cursor = mention.range.end;
    }

    appendText(text.slice(cursor));
    root.append(paragraph);
  });
}
