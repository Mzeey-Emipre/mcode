import { describe, it, expect } from "vitest";
import { AgentEventSchema } from "../events/agent-event.js";

describe("AgentEventSchema", () => {
  it("parses a valid modelFallback event", () => {
    const result = AgentEventSchema().safeParse({
      type: "modelFallback",
      threadId: "thread-1",
      requestedModel: "claude-opus-4-6",
      actualModel: "claude-sonnet-4-6",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("modelFallback");
      expect(result.data.requestedModel).toBe("claude-opus-4-6");
      expect(result.data.actualModel).toBe("claude-sonnet-4-6");
    }
  });

  it("rejects modelFallback missing actualModel", () => {
    const result = AgentEventSchema().safeParse({
      type: "modelFallback",
      threadId: "thread-1",
      requestedModel: "claude-opus-4-6",
    });
    expect(result.success).toBe(false);
  });

  it("still parses existing turnComplete events", () => {
    const result = AgentEventSchema().safeParse({
      type: "turnComplete",
      threadId: "thread-1",
      reason: "end_turn",
      costUsd: null,
      tokensIn: 100,
      tokensOut: 50,
    });
    expect(result.success).toBe(true);
  });
});

describe("compactSummary event", () => {
  it("validates a well-formed compactSummary event", () => {
    const event = {
      type: "compactSummary",
      threadId: "t-1",
      summary: "The assistant fixed the auth middleware and added tests.",
    };
    const result = AgentEventSchema().safeParse(event);
    expect(result.success).toBe(true);
  });

  it("rejects compactSummary missing summary", () => {
    const result = AgentEventSchema().safeParse({ type: "compactSummary", threadId: "t-1" });
    expect(result.success).toBe(false);
  });
});
