import { describe, it, expect } from "vitest";
import { buildReasoningOptions } from "../providers/claude/build-reasoning-options.js";

describe("buildReasoningOptions", () => {
  it("returns effort and thinking when reasoning level is low", () => {
    expect(buildReasoningOptions("low")).toEqual({
      effort: "low",
      thinking: { type: "adaptive" },
    });
  });

  it("returns effort and thinking when reasoning level is medium", () => {
    expect(buildReasoningOptions("medium")).toEqual({
      effort: "medium",
      thinking: { type: "adaptive" },
    });
  });

  it("returns effort and thinking when reasoning level is high", () => {
    expect(buildReasoningOptions("high")).toEqual({
      effort: "high",
      thinking: { type: "adaptive" },
    });
  });

  it("returns effort and thinking when reasoning level is max", () => {
    expect(buildReasoningOptions("max")).toEqual({
      effort: "max",
      thinking: { type: "adaptive" },
    });
  });

  it("returns empty object when reasoning level is undefined", () => {
    expect(buildReasoningOptions(undefined)).toEqual({});
  });
});
