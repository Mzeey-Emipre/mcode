import { describe, expect, it } from "vitest";
import { MAX_TURN_RECOVERIES, TurnRecoverySchema, WS_METHODS } from "../index.js";

describe("turn recovery contracts", () => {
  it("bounds recovery progress and exposes explicit actions", () => {
    expect(TurnRecoverySchema().parse({
      threadId: "thread-1",
      executionId: "00000000-0000-4000-8000-000000000015",
      acceptedThrough: 6,
      durableThrough: 6,
      phase: "interrupted",
      error: "Provider execution was not proved active.",
      actions: ["retry"],
    })).toMatchObject({ actions: ["retry"] });
    expect(WS_METHODS()["agent.recoveries"]).toBeDefined();
    expect(WS_METHODS()["agent.retry"]).toBeDefined();
  });

  it("rejects duplicate actions and durable progress beyond accepted progress", () => {
    const input = {
      threadId: "thread-1",
      executionId: "00000000-0000-4000-8000-000000000015",
      acceptedThrough: 5,
      durableThrough: 6,
      phase: "interrupted",
      error: null,
      actions: ["retry", "retry"],
    };
    expect(TurnRecoverySchema().safeParse(input).success).toBe(false);
  });

  it("rejects recovery result overflow", () => {
    const recovery = {
      threadId: "thread-1",
      executionId: "00000000-0000-4000-8000-000000000015",
      acceptedThrough: 6,
      durableThrough: 6,
      phase: "interrupted",
      error: null,
      actions: ["retry"],
    };

    expect(WS_METHODS()["agent.recoveries"].result.safeParse(
      Array.from({ length: MAX_TURN_RECOVERIES + 1 }, () => recovery),
    ).success).toBe(false);
  });
});
