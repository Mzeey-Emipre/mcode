import { describe, expect, it } from "vitest";
import { TurnOutcomeSchema } from "../turn-outcome.js";

describe("TurnOutcomeSchema", () => {
  it.each(["completed", "cancelled", "interrupted", "errored"] as const)(
    "accepts the durable %s terminal outcome",
    (outcome) => {
      expect(TurnOutcomeSchema.safeParse(outcome).success).toBe(true);
    },
  );

  it("rejects unknown terminal outcomes", () => {
    expect(TurnOutcomeSchema.safeParse("stopped").success).toBe(false);
  });
});
