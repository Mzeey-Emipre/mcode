import { describe, it, expect } from "vitest";
import {
  isXhighEffortModel,
  isMaxEffortModel,
  supportsEffortParameter,
  normalizeReasoningLevelForModel,
} from "../index.js";

describe("isXhighEffortModel", () => {
  it("returns true for claude-opus-4-7", () => {
    expect(isXhighEffortModel("claude-opus-4-7")).toBe(true);
  });

  it("returns true for dated variant of claude-opus-4-7", () => {
    expect(isXhighEffortModel("claude-opus-4-7-20260501")).toBe(true);
  });

  it("returns false for claude-opus-4-6", () => {
    expect(isXhighEffortModel("claude-opus-4-6")).toBe(false);
  });

  it("returns false for claude-sonnet-4-6", () => {
    expect(isXhighEffortModel("claude-sonnet-4-6")).toBe(false);
  });

  it("returns false for claude-haiku-4-5", () => {
    expect(isXhighEffortModel("claude-haiku-4-5")).toBe(false);
  });

  it("returns false for unknown model", () => {
    expect(isXhighEffortModel("claude-unknown-model")).toBe(false);
  });
});

describe("isMaxEffortModel", () => {
  it("returns true for claude-opus-4-7", () => {
    expect(isMaxEffortModel("claude-opus-4-7")).toBe(true);
  });

  it("returns true for claude-opus-4-6", () => {
    expect(isMaxEffortModel("claude-opus-4-6")).toBe(true);
  });

  it("returns true for claude-sonnet-4-6", () => {
    expect(isMaxEffortModel("claude-sonnet-4-6")).toBe(true);
  });

  it("returns false for claude-haiku-4-5", () => {
    expect(isMaxEffortModel("claude-haiku-4-5")).toBe(false);
  });

  it("returns false for unknown model", () => {
    expect(isMaxEffortModel("claude-unknown-model")).toBe(false);
  });

  it("returns true for dated variant of claude-opus-4-6", () => {
    expect(isMaxEffortModel("claude-opus-4-6-20251001")).toBe(true);
  });
});

describe("supportsEffortParameter", () => {
  it("returns true for claude-opus-4-7", () => {
    expect(supportsEffortParameter("claude-opus-4-7")).toBe(true);
  });

  it("returns false for claude-haiku-4-5", () => {
    expect(supportsEffortParameter("claude-haiku-4-5")).toBe(false);
  });

  it("returns false for dated variant of claude-haiku-4-5", () => {
    expect(supportsEffortParameter("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("returns true for claude-opus-4-6", () => {
    expect(supportsEffortParameter("claude-opus-4-6")).toBe(true);
  });

  it("returns true for claude-sonnet-4-6", () => {
    expect(supportsEffortParameter("claude-sonnet-4-6")).toBe(true);
  });

  it("returns true for an unknown Claude model (default to supported)", () => {
    expect(supportsEffortParameter("claude-unknown-model")).toBe(true);
  });
});

describe("normalizeReasoningLevelForModel", () => {
  describe("claude-opus-4-7 (supports all tiers)", () => {
    it("passes low through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-7", "low")).toBe("low");
    });

    it("passes medium through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-7", "medium")).toBe("medium");
    });

    it("passes high through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-7", "high")).toBe("high");
    });

    it("passes xhigh through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-7", "xhigh")).toBe("xhigh");
    });

    it("passes max through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-7", "max")).toBe("max");
    });
  });

  describe("claude-opus-4-6 (supports low, medium, high, max but not xhigh)", () => {
    it("passes low through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-6", "low")).toBe("low");
    });

    it("passes high through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-6", "high")).toBe("high");
    });

    it("downgrades xhigh to high (walks down, skips xhigh, lands on high)", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-6", "xhigh")).toBe("high");
    });

    it("passes max through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-6", "max")).toBe("max");
    });
  });

  describe("claude-sonnet-4-6 (supports low, medium, high, max but not xhigh)", () => {
    it("downgrades xhigh to high", () => {
      expect(normalizeReasoningLevelForModel("claude-sonnet-4-6", "xhigh")).toBe("high");
    });

    it("passes max through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-sonnet-4-6", "max")).toBe("max");
    });
  });

  describe("claude-haiku-4-5 (no effort support - short-circuit)", () => {
    it("returns high for low (short-circuit)", () => {
      expect(normalizeReasoningLevelForModel("claude-haiku-4-5", "low")).toBe("high");
    });

    it("returns high for max (short-circuit)", () => {
      expect(normalizeReasoningLevelForModel("claude-haiku-4-5", "max")).toBe("high");
    });

    it("returns high for xhigh (short-circuit)", () => {
      expect(normalizeReasoningLevelForModel("claude-haiku-4-5", "xhigh")).toBe("high");
    });
  });

  describe("unknown Claude model (only supports low, medium, high)", () => {
    it("downgrades xhigh to high", () => {
      expect(normalizeReasoningLevelForModel("claude-unknown-model", "xhigh")).toBe("high");
    });

    it("downgrades max to high (walks down from max, skips xhigh and max, lands on high)", () => {
      expect(normalizeReasoningLevelForModel("claude-unknown-model", "max")).toBe("high");
    });

    it("passes low through unchanged", () => {
      expect(normalizeReasoningLevelForModel("claude-unknown-model", "low")).toBe("low");
    });
  });

  describe("dated variant normalization", () => {
    it("claude-opus-4-7-20260501 passes xhigh through (recognized as opus-4-7)", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-7-20260501", "xhigh")).toBe("xhigh");
    });

    it("claude-opus-4-6-20251001 passes max through (recognized as opus-4-6)", () => {
      expect(normalizeReasoningLevelForModel("claude-opus-4-6-20251001", "max")).toBe("max");
    });

    it("claude-haiku-4-5-20251001 short-circuits to high (recognized as haiku)", () => {
      expect(normalizeReasoningLevelForModel("claude-haiku-4-5-20251001", "low")).toBe("high");
    });
  });
});
