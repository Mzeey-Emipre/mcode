import { describe, it, expect } from "vitest";
import { AgentEventSchema, AgentEventType } from "../agent-event.js";

describe("AgentEvent provider_unavailable", () => {
  it("parses a disabled-provider event", () => {
    const parsed = AgentEventSchema().parse({
      type: "providerUnavailable",
      threadId: "t-1",
      providerId: "codex",
      reason: "disabled",
    });
    expect(parsed.type).toBe(AgentEventType.ProviderUnavailable);
  });

  it("parses a cli_missing event with configuredPath", () => {
    const parsed = AgentEventSchema().parse({
      type: "providerUnavailable",
      threadId: "t-1",
      providerId: "claude",
      reason: "cli_missing",
      configuredPath: "/custom/claude",
    });
    if (parsed.type !== "providerUnavailable") throw new Error("unreachable");
    expect(parsed.configuredPath).toBe("/custom/claude");
  });
});

describe("AgentEvent generated attachments", () => {
  const attachment = {
    id: "img-1",
    name: "generated.png",
    mimeType: "image/png",
    sizeBytes: 128,
  };

  it("parses a generatedAttachment event", () => {
    const parsed = AgentEventSchema().parse({
      type: "generatedAttachment",
      threadId: "t-1",
      attachment,
    });
    expect(parsed.type).toBe(AgentEventType.GeneratedAttachment);
  });

  it("parses assistant message attachments", () => {
    const parsed = AgentEventSchema().parse({
      type: "message",
      threadId: "t-1",
      content: "",
      tokens: null,
      attachments: [attachment],
    });
    if (parsed.type !== "message") throw new Error("unreachable");
    expect(parsed.attachments).toEqual([attachment]);
  });
});
