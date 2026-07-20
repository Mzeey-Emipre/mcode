import { describe, it, expect } from "vitest";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import {
  MentionNode,
  $createMentionNode,
  $createTypedMentionNode,
  $isMentionNode,
} from "@/components/chat/lexical/MentionNode";
import { extractComposerMessage } from "@/components/chat/lexical/cursor-utils";

function createTestEditor() {
  return createEditor({
    nodes: [MentionNode],
    onError: (e) => {
      throw e;
    },
  });
}

describe("MentionNode", () => {
  it("stores the file path", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createMentionNode("src/lib/utils.ts");
      expect(node.getFilePath()).toBe("src/lib/utils.ts");
    });
  });

  it("returns @path as text content", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createMentionNode("src/lib/utils.ts");
      expect(node.getTextContent()).toBe("@src/lib/utils.ts");
    });
  });

  it("is inline", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createMentionNode("src/lib/utils.ts");
      expect(node.isInline()).toBe(true);
    });
  });

  it("is not isolated (allows parent editor to handle backspace)", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createMentionNode("src/lib/utils.ts");
      expect(node.isIsolated()).toBe(false);
    });
  });

  it("exports to JSON with correct type and filePath", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createMentionNode("src/lib/utils.ts");
      const json = node.exportJSON();
      expect(json.type).toBe("mention");
      expect(json.filePath).toBe("src/lib/utils.ts");
    });
  });

  it("can be imported from JSON", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = MentionNode.importJSON({
        type: "mention",
        filePath: "src/lib/utils.ts",
        version: 1,
      });
      expect(node.getFilePath()).toBe("src/lib/utils.ts");
    });
  });

  it("$isMentionNode returns true for MentionNode", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createMentionNode("src/lib/utils.ts");
      expect($isMentionNode(node)).toBe(true);
    });
  });

  it("$isMentionNode returns false for non-MentionNode", () => {
    expect($isMentionNode(null)).toBe(false);
    expect($isMentionNode(undefined)).toBe(false);
  });

  it("extracts selected mentions with JavaScript string offsets", () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("😀 see "));
        paragraph.append($createMentionNode("src/app.ts"));
        paragraph.append($createTextNode(" and @plain"));
        root.append(paragraph);
      },
      { discrete: true },
    );

    expect(extractComposerMessage(editor)).toEqual({
      text: "😀 see @src/app.ts and @plain",
      mentions: [{
        id: expect.any(String),
        kind: "file",
        label: "src/app.ts",
        path: "src/app.ts",
        range: { start: 7, end: 18 },
      }],
    });
  });

  it("extracts a selected plugin as a native Codex mention", () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTypedMentionNode({
          id: "plugin-1",
          kind: "plugin",
          label: "Browser",
          name: "Browser",
          path: "plugin://browser@openai-bundled",
        }));
        $getRoot().append(paragraph);
      },
      { discrete: true },
    );

    expect(extractComposerMessage(editor)).toEqual({
      text: "@Browser",
      mentions: [{
        id: "plugin-1",
        kind: "plugin",
        label: "Browser",
        name: "Browser",
        path: "plugin://browser@openai-bundled",
        range: { start: 0, end: 8 },
      }],
    });
  });
});
