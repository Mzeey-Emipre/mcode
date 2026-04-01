import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { detectFallbackModel } from "../providers/claude/claude-provider.js";

describe("detectFallbackModel", () => {
  it("returns null when the requested model is the only key in modelUsage", () => {
    const usage = { "claude-opus-4-6": { inputTokens: 100, outputTokens: 50 } };
    expect(detectFallbackModel(usage, "claude-opus-4-6")).toBeNull();
  });

  it("returns the fallback model ID when a different model was used", () => {
    const usage = { "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 50 } };
    expect(detectFallbackModel(usage, "claude-opus-4-6")).toBe("claude-sonnet-4-6");
  });

  it("returns null for empty modelUsage", () => {
    expect(detectFallbackModel({}, "claude-opus-4-6")).toBeNull();
  });

  it("returns a non-requested model when multiple models appear in usage", () => {
    const usage = {
      "claude-opus-4-6": { inputTokens: 10, outputTokens: 0 },
      "claude-sonnet-4-6": { inputTokens: 90, outputTokens: 50 },
    };
    expect(detectFallbackModel(usage, "claude-opus-4-6")).toBe("claude-sonnet-4-6");
  });
});
