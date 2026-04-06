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

  it("returns null when requested model is present alongside other models", () => {
    const usage = {
      "claude-opus-4-6": { inputTokens: 10, outputTokens: 0 },
      "claude-sonnet-4-6": { inputTokens: 90, outputTokens: 50 },
    };
    expect(detectFallbackModel(usage, "claude-opus-4-6")).toBeNull();
  });

  it("returns fallback when requested model is absent but multiple others present", () => {
    const usage = {
      "claude-sonnet-4-6": { inputTokens: 90, outputTokens: 50 },
      "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5 },
    };
    expect(detectFallbackModel(usage, "claude-opus-4-6")).toBe("claude-sonnet-4-6");
  });

  it("returns null when SDK resolves alias to dated variant of same model", () => {
    const usage = { "claude-sonnet-4-6-20250514": { inputTokens: 100, outputTokens: 50 } };
    expect(detectFallbackModel(usage, "claude-sonnet-4-6")).toBeNull();
  });

  it("detects real fallback even when both keys are dated variants", () => {
    const usage = { "claude-haiku-4-5-20251001": { inputTokens: 100, outputTokens: 50 } };
    expect(detectFallbackModel(usage, "claude-sonnet-4-6")).toBe("claude-haiku-4-5-20251001");
  });

  it("does not confuse sibling model families (claude-opus-4 vs claude-opus-4-6)", () => {
    expect(
      detectFallbackModel(
        { "claude-opus-4-6-20250514": {} },
        "claude-opus-4",
      ),
    ).toBe("claude-opus-4-6-20250514");
  });
});
