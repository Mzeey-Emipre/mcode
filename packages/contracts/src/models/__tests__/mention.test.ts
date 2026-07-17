import { describe, expect, it } from "vitest";
import { MessageMentionSchema } from "../mention.js";

describe("MessageMentionSchema", () => {
  it("preserves selected slash-command namespace metadata", () => {
    const result = MessageMentionSchema.safeParse({
      id: "command:plugin:figma:use",
      kind: "command",
      label: "figma:use",
      namespace: "plugin",
      range: { start: 4, end: 14 },
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown command namespaces", () => {
    const result = MessageMentionSchema.safeParse({
      id: "command:unknown:deploy",
      kind: "command",
      label: "deploy",
      namespace: "unknown",
      range: { start: 0, end: 7 },
    });

    expect(result.success).toBe(false);
  });
});
