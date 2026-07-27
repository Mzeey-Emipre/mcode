import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createEditor, $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import {
  SlashCommandNode,
  $createSlashCommandNode,
  $isSlashCommandNode,
} from "@/components/chat/lexical/SlashCommandNode";
import { extractComposerMessage } from "@/components/chat/lexical/cursor-utils";

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
      const node = $createSlashCommandNode("plan", "mcode");
      expect(node.isInline()).toBe(true);
      expect(node.isIsolated()).toBe(false);
    });
  });

  it("decorates a slash invocation as a slash-free inline token with its source icon", () => {
    const editor = createTestEditor();
    let decoration: ReturnType<SlashCommandNode["decorate"]>;
    editor.update(() => {
      const node = $createSlashCommandNode("impeccable", "skill");
      decoration = node.decorate(editor, {} as never);
    });
    render(decoration!);

    const label = screen.getByText("impeccable");
    const token = label.closest("[data-entity-token]");
    expect(screen.queryByText("/impeccable")).not.toBeInTheDocument();
    expect(token).toHaveAttribute("data-entity-token", "skill");
    expect(token?.querySelector(".lucide-badge-check")).not.toBeNull();
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

  it("extracts namespace metadata for persisted transcript rendering", () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("Use "));
        paragraph.append($createSlashCommandNode("impeccable", "skill", {
          providerId: "codex",
          kind: "skill",
          nativeId: "C:/skills/impeccable/SKILL.md",
        }));
        $getRoot().append(paragraph);
      },
      { discrete: true },
    );

    expect(extractComposerMessage(editor)).toEqual({
      text: "Use /impeccable",
      mentions: [{
        id: "command:skill:impeccable",
        kind: "command",
        label: "impeccable",
        namespace: "skill",
        capabilityIdentity: {
          providerId: "codex",
          kind: "skill",
          nativeId: "C:/skills/impeccable/SKILL.md",
        },
        range: { start: 4, end: 15 },
      }],
    });
  });
});
