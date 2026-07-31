import { describe, it, expect } from "vitest";
import { WS_METHODS } from "@mcode/contracts";

describe("agent.listRunning contract", () => {
  it("is registered in WS_METHODS with runtime snapshot result", () => {
    const methods = WS_METHODS();
    expect(methods).toHaveProperty("agent.listRunning");
    const result = methods["agent.listRunning"].result.safeParse([
      { threadId: "t-1", turnExecutionId: "00000000-0000-4000-8000-000000000001", phase: "running" },
      { threadId: "t-2", turnExecutionId: null, phase: "idle" },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts empty params", () => {
    const methods = WS_METHODS();
    const parsed = methods["agent.listRunning"].params.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it("validates authoritative agent.stop results", () => {
    const result = WS_METHODS()["agent.stop"].result.safeParse({
      threadId: "t-1",
      turnExecutionId: "00000000-0000-4000-8000-000000000001",
      snapshot: {
        threadId: "t-1",
        turnExecutionId: "00000000-0000-4000-8000-000000000001",
        phase: "cancelled",
      },
      status: "cancelled",
      dispatchState: "dispatched",
    });
    expect(result.success).toBe(true);
  });
});
