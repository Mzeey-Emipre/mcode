import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildReasoningOptions } from "../providers/claude/build-reasoning-options.js";

vi.mock("@mcode/shared", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from "@mcode/shared";

const OPUS = "claude-opus-4-6";
const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-4-6";

describe("buildReasoningOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns effort and thinking when reasoning level is low", () => {
    expect(buildReasoningOptions("low", OPUS)).toEqual({
      effort: "low",
      thinking: { type: "adaptive" },
    });
  });

  it("returns effort and thinking when reasoning level is medium", () => {
    expect(buildReasoningOptions("medium", OPUS)).toEqual({
      effort: "medium",
      thinking: { type: "adaptive" },
    });
  });

  it("returns effort and thinking when reasoning level is high", () => {
    expect(buildReasoningOptions("high", OPUS)).toEqual({
      effort: "high",
      thinking: { type: "adaptive" },
    });
  });

  it("returns max effort for Opus 4.6", () => {
    expect(buildReasoningOptions("max", OPUS)).toEqual({
      effort: "max",
      thinking: { type: "adaptive" },
    });
  });

  it("clamps max to high for Haiku and warns", () => {
    expect(buildReasoningOptions("max", HAIKU)).toEqual({
      effort: "high",
      thinking: { type: "adaptive" },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Max reasoning effort not supported for model, clamping to high",
      { modelId: HAIKU },
    );
  });

  it("clamps max to high for Sonnet and warns", () => {
    expect(buildReasoningOptions("max", SONNET)).toEqual({
      effort: "high",
      thinking: { type: "adaptive" },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Max reasoning effort not supported for model, clamping to high",
      { modelId: SONNET },
    );
  });

  it("returns empty object when reasoning level is undefined", () => {
    expect(buildReasoningOptions(undefined, OPUS)).toEqual({});
  });
});
