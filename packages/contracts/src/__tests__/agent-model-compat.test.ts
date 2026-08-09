import { describe, expect, it } from "vitest";
import {
  AgentEventEnvelopeSchema,
  CanonicalAgentEventSchema,
  ProviderSchema,
} from "../compat/agent-model.js";
import { AgentEventSchema } from "../events/agent-event.js";
import { TurnExecutionIdSchema } from "../models/turn-runtime.js";

describe("agent-model compatibility boundary", () => {
  it("keeps the current provider event wire shape", () => {
    const result = AgentEventSchema().safeParse({
      type: "turnStarted",
      threadId: "thread-1",
    });

    expect(result.success).toBe(true);
  });

  it("exposes canonical contracts without changing the current channel", () => {
    const provider = ProviderSchema.parse({
      id: "codex",
      capabilities: [{ name: "build", support: "supported" }],
    });
    const envelopeSchema = AgentEventEnvelopeSchema(CanonicalAgentEventSchema);

    expect(provider.id).toBe("codex");
    expect(envelopeSchema).toBeDefined();
    expect(TurnExecutionIdSchema.safeParse("00000000-0000-4000-8000-000000000001").success).toBe(true);
  });
});
