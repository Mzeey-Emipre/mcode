import { describe, it, expect } from "vitest";
import { createEditor } from "lexical";
import {
  MentionNode,
  $createMentionNode,
  $isMentionNode,
} from "@/components/chat/lexical/MentionNode";

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
});
