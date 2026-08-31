import { describe, expect, it } from "vitest";
import { MessageMentionSchema } from "../mention.js";

describe("MessageMentionSchema", () => {
  it("preserves selected slash-command namespace metadata", () => {
    const result = MessageMentionSchema().safeParse({
      id: "command:plugin:figma:use",
      kind: "command",
      label: "figma:use",
      namespace: "plugin",
      capabilityIdentity: {
        providerId: "codex",
        kind: "skill",
        nativeId: "C:/skills/figma-use/SKILL.md",
      },
      range: { start: 4, end: 14 },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      capabilityIdentity: { kind: "skill", nativeId: "C:/skills/figma-use/SKILL.md" },
    });
  });

  it("rejects unknown command namespaces", () => {
    const result = MessageMentionSchema().safeParse({
      id: "command:unknown:deploy",
      kind: "command",
      label: "deploy",
      namespace: "unknown",
      range: { start: 0, end: 7 },
    });

    expect(result.success).toBe(false);
  });

  it("preserves a Codex plugin mention target", () => {
    const result = MessageMentionSchema().safeParse({
      id: "mention-plugin-1",
      kind: "plugin",
      label: "Browser",
      name: "Browser",
      path: "plugin://browser@openai-bundled",
      range: { start: 0, end: 8 },
    });

    expect(result.success).toBe(true);
  });

  it("rejects plugin mentions without Codex's plugin URI", () => {
    const result = MessageMentionSchema().safeParse({
      id: "mention-plugin-1",
      kind: "plugin",
      label: "Browser",
      name: "Browser",
      path: "C:/plugins/browser",
      range: { start: 0, end: 8 },
    });

    expect(result.success).toBe(false);
  });
});
