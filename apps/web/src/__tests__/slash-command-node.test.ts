import { describe, it, expect } from "vitest";
import { createEditor, $createTextNode } from "lexical";
import {
  SlashCommandNode,
  $createSlashCommandNode,
  $isSlashCommandNode,
} from "@/components/chat/lexical/SlashCommandNode";

function createTestEditor() {
  return createEditor({
    nodes: [SlashCommandNode],
    onError: (e) => {
      throw e;
    },
  });
}

describe("SlashCommandNode", () => {
  it("stores the command name and namespace", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createSlashCommandNode("commit", "skill");
      expect(node.getCommandName()).toBe("commit");
      expect(node.getNamespace()).toBe("skill");
    });
  });

  it("returns /name as text content", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createSlashCommandNode("commit", "skill");
      expect(node.getTextContent()).toBe("/commit");
    });
  });

  it("is inline and not isolated (allows parent editor to handle backspace)", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createSlashCommandNode("m:plan", "mcode");
      expect(node.isInline()).toBe(true);
      expect(node.isIsolated()).toBe(false);
    });
  });

  it("exports to JSON with type, name, and namespace", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createSlashCommandNode("commit", "skill");
      const json = node.exportJSON();
      expect(json.type).toBe("slash-command");
      expect(json.commandName).toBe("commit");
      expect(json.namespace).toBe("skill");
    });
  });

  it("can be imported from JSON", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = SlashCommandNode.importJSON({
        type: "slash-command",
        commandName: "commit",
        namespace: "skill",
        version: 1,
      });
      expect(node.getCommandName()).toBe("commit");
      expect(node.getNamespace()).toBe("skill");
    });
  });

  it("$isSlashCommandNode returns true for SlashCommandNode", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const node = $createSlashCommandNode("commit", "skill");
      expect($isSlashCommandNode(node)).toBe(true);
    });
  });

  it("$isSlashCommandNode returns false for non-SlashCommandNode", () => {
    expect($isSlashCommandNode(null)).toBe(false);
    expect($isSlashCommandNode(undefined)).toBe(false);
  });

  it("$isSlashCommandNode returns false for other Lexical node types", () => {
    const editor = createTestEditor();
    editor.update(() => {
      const textNode = $createTextNode("hello");
      expect($isSlashCommandNode(textNode)).toBe(false);
    });
  });
});
