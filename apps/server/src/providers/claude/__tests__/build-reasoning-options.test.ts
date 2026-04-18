import { describe, it, expect, vi, beforeEach } from "vitest";

// Partial mock: keep the real shared helpers (normalizeReasoningLevelForModel,
// supportsEffortParameter) but replace the logger so we can spy on warn calls
// without triggering real log I/O.
vi.mock("@mcode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcode/shared")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
});

import { logger } from "@mcode/shared";
import { buildReasoningOptions } from "../build-reasoning-options.js";

describe("buildReasoningOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Undefined reasoning
  // ---------------------------------------------------------------------------

  it("returns {} for undefined reasoning", () => {
    expect(buildReasoningOptions(undefined, "claude-sonnet-4-6")).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Haiku 4.5: effort param must be omitted entirely
  // ---------------------------------------------------------------------------

  it("returns {} for haiku-4-5 regardless of level", () => {
    expect(buildReasoningOptions("high", "claude-haiku-4-5")).toEqual({});
  });

  it("returns {} for haiku-4-5 dated variant", () => {
    expect(buildReasoningOptions("high", "claude-haiku-4-5-20251001")).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Opus 4.7: supports all tiers including xhigh and max
  // ---------------------------------------------------------------------------

  it("passes xhigh through for opus-4-7", () => {
    const result = buildReasoningOptions("xhigh", "claude-opus-4-7");
    expect(result).toMatchObject({ effort: "xhigh" });
  });

  it("passes max through for opus-4-7", () => {
    const result = buildReasoningOptions("max", "claude-opus-4-7");
    expect(result).toMatchObject({ effort: "max" });
  });

  it("passes high through for opus-4-7", () => {
    const result = buildReasoningOptions("high", "claude-opus-4-7");
    expect(result).toMatchObject({ effort: "high" });
  });

  // ---------------------------------------------------------------------------
  // Opus 4.6: supports max but not xhigh -- xhigh clamps to high
  // ---------------------------------------------------------------------------

  it("clamps xhigh to high for opus-4-6", () => {
    const result = buildReasoningOptions("xhigh", "claude-opus-4-6");
    // xhigh downgrades to high (not max) because xhigh sits above high in the ladder
    // and max is a separate tier that opus-4-6 does support
    expect(result).toMatchObject({ effort: "high" });
  });

  it("passes max through for opus-4-6", () => {
    const result = buildReasoningOptions("max", "claude-opus-4-6");
    expect(result).toMatchObject({ effort: "max" });
  });

  // ---------------------------------------------------------------------------
  // Sonnet 4.6: supports max -- regression guard against old code that clamped it
  // ---------------------------------------------------------------------------

  it("passes max through for sonnet-4-6", () => {
    // Old code incorrectly clamped max to high for sonnet-4-6 because it was not
    // in the MAX_EFFORT_MODEL_IDS list. Shared helper now handles this correctly.
    const result = buildReasoningOptions("max", "claude-sonnet-4-6");
    expect(result).toMatchObject({ effort: "max" });
  });

  it("clamps xhigh to high for sonnet-4-6", () => {
    const result = buildReasoningOptions("xhigh", "claude-sonnet-4-6");
    expect(result).toMatchObject({ effort: "high" });
  });

  // ---------------------------------------------------------------------------
  // Dated variants
  // ---------------------------------------------------------------------------

  it("passes xhigh through for opus-4-7 dated variant", () => {
    const result = buildReasoningOptions("xhigh", "claude-opus-4-7-20260501");
    expect(result).toMatchObject({ effort: "xhigh" });
  });

  // ---------------------------------------------------------------------------
  // Warning log behavior
  // ---------------------------------------------------------------------------

  it("emits warning when clamping xhigh to high", () => {
    buildReasoningOptions("xhigh", "claude-sonnet-4-6");
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain("clamped");
  });

  it("does not warn when level is unchanged", () => {
    buildReasoningOptions("high", "claude-sonnet-4-6");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Thinking field
  // ---------------------------------------------------------------------------

  it("includes thinking adaptive for non-haiku models when level is set", () => {
    const result = buildReasoningOptions("high", "claude-sonnet-4-6");
    expect(result).toMatchObject({ thinking: { type: "adaptive" } });
  });

  it("does not include thinking field for haiku", () => {
    const result = buildReasoningOptions("high", "claude-haiku-4-5");
    expect(result).not.toHaveProperty("thinking");
  });
});
