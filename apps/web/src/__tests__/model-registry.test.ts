import { describe, it, expect, beforeEach } from "vitest";
import { getDefaultSettings, ReasoningLevelSchema } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  MODEL_PROVIDERS,
  findModelById,
  findProviderForModel,
  getDefaultModel,
  getDefaultModelId,
  getDefaultReasoningLevel,
  isMaxEffortModel,
  isXhighEffortModel,
  normalizeReasoningLevelForModel,
  resolveThreadModelId,
} from "@/lib/model-registry";

describe("ModelRegistry", () => {
  it("MODEL_PROVIDERS contains Claude with 4 models", () => {
    const claude = MODEL_PROVIDERS.find((p) => p.id === "claude");
    expect(claude).toBeTruthy();
    expect(claude?.models).toHaveLength(4);
    expect(claude?.comingSoon).toBe(false);
  });

  it("findModelById returns Opus 4.7", () => {
    const model = findModelById("claude-opus-4-7");
    expect(model?.label).toBe("Claude Opus 4.7");
    expect(model?.providerId).toBe("claude");
  });

  it("findModelById returns correct model", () => {
    const model = findModelById("claude-sonnet-4-6");
    expect(model?.label).toBe("Claude Sonnet 4.6");
    expect(model?.providerId).toBe("claude");
  });

  it("findModelById returns undefined for unknown ID", () => {
    expect(findModelById("nonexistent")).toBeUndefined();
  });

  it("findProviderForModel returns provider", () => {
    const provider = findProviderForModel("claude-opus-4-6");
    expect(provider?.id).toBe("claude");
  });

  it("findProviderForModel returns undefined for unknown model", () => {
    expect(findProviderForModel("nonexistent")).toBeUndefined();
  });

  it("getDefaultModel returns Claude Sonnet 4.6", () => {
    const model = getDefaultModel();
    expect(model.id).toBe("claude-sonnet-4-6");
  });
});

describe("Settings-aware defaults", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      loaded: true,
    });
  });

  it("getDefaultModelId returns settings value", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        model: {
          defaults: { provider: "claude", id: "claude-opus-4-6", reasoning: "high", fallbackId: "" },
        },
      },
    });
    expect(getDefaultModelId()).toBe("claude-opus-4-6");
  });

  it("getDefaultModelId falls back to sonnet when model ID is unknown", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        model: {
          defaults: { provider: "claude", id: "nonexistent-model", reasoning: "high", fallbackId: "" },
        },
      },
    });
    expect(getDefaultModelId()).toBe("claude-sonnet-4-6");
  });

  it("getDefaultModelId returns sonnet from default settings", () => {
    expect(getDefaultModelId()).toBe("claude-sonnet-4-6");
  });

  it("getDefaultReasoningLevel returns settings value", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        model: {
          defaults: { provider: "claude", id: "claude-sonnet-4-6", reasoning: "low", fallbackId: "" },
        },
      },
    });
    expect(getDefaultReasoningLevel()).toBe("low");
  });

  it("getDefaultReasoningLevel returns high from default settings", () => {
    expect(getDefaultReasoningLevel()).toBe("high");
  });

  it("getDefaultReasoningLevel accepts max as a valid level", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        model: {
          defaults: { provider: "claude", id: "claude-opus-4-6", reasoning: "max", fallbackId: "" },
        },
      },
    });
    expect(getDefaultReasoningLevel()).toBe("max");
  });
});

describe("ReasoningLevelSchema", () => {
  it("accepts low, medium, high", () => {
    expect(() => ReasoningLevelSchema.parse("low")).not.toThrow();
    expect(() => ReasoningLevelSchema.parse("medium")).not.toThrow();
    expect(() => ReasoningLevelSchema.parse("high")).not.toThrow();
  });

  it("accepts max", () => {
    expect(() => ReasoningLevelSchema.parse("max")).not.toThrow();
    expect(ReasoningLevelSchema.parse("max")).toBe("max");
  });

  it("rejects unknown values", () => {
    expect(() => ReasoningLevelSchema.parse("extreme")).toThrow();
  });
});

describe("findModelById dated variants", () => {
  it("resolves claude-haiku-4-5-20251001 to claude-haiku-4-5", () => {
    const model = findModelById("claude-haiku-4-5-20251001");
    expect(model?.id).toBe("claude-haiku-4-5");
    expect(model?.label).toBe("Claude Haiku 4.5");
  });

  it("resolves claude-sonnet-4-6-20251001 to claude-sonnet-4-6", () => {
    const model = findModelById("claude-sonnet-4-6-20251001");
    expect(model?.id).toBe("claude-sonnet-4-6");
  });

  it("resolves claude-opus-4-6-20251001 to claude-opus-4-6", () => {
    const model = findModelById("claude-opus-4-6-20251001");
    expect(model?.id).toBe("claude-opus-4-6");
  });

  it("resolves claude-opus-4-7-20260401 to claude-opus-4-7", () => {
    const model = findModelById("claude-opus-4-7-20260401");
    expect(model?.id).toBe("claude-opus-4-7");
  });

  it("returns undefined for a totally unknown dated-style string", () => {
    expect(findModelById("claude-unknown-99-9-20251001")).toBeUndefined();
  });

  it("prefers longest match when model IDs share a prefix", () => {
    // Ensures a future model like "claude-sonnet-4" doesn't shadow "claude-sonnet-4-6"
    // The dated variant of the longer ID must resolve to the longer ID.
    const model = findModelById("claude-sonnet-4-6-20251001");
    expect(model?.id).toBe("claude-sonnet-4-6");
  });
});

describe("findProviderForModel dated variants", () => {
  it("resolves claude-haiku-4-5-20251001 to claude provider", () => {
    expect(findProviderForModel("claude-haiku-4-5-20251001")?.id).toBe("claude");
  });

  it("resolves claude-opus-4-7-20260401 to claude provider", () => {
    expect(findProviderForModel("claude-opus-4-7-20260401")?.id).toBe("claude");
  });

  it("returns undefined for a totally unknown dated-style string", () => {
    expect(findProviderForModel("claude-unknown-99-9-20251001")).toBeUndefined();
  });

  it("prefers longest match when model IDs share a prefix", () => {
    const provider = findProviderForModel("claude-sonnet-4-6-20251001");
    expect(provider?.id).toBe("claude");
    const model = findModelById("claude-sonnet-4-6-20251001");
    expect(model?.id).toBe("claude-sonnet-4-6");
  });
});

describe("isMaxEffortModel", () => {
  it("returns true for claude-opus-4-6", () => {
    expect(isMaxEffortModel("claude-opus-4-6")).toBe(true);
  });

  it("returns true for dated Opus variant claude-opus-4-6-20251001", () => {
    expect(isMaxEffortModel("claude-opus-4-6-20251001")).toBe(true);
  });

  it("returns false for claude-sonnet-4-6", () => {
    expect(isMaxEffortModel("claude-sonnet-4-6")).toBe(false);
  });

  it("returns false for dated Sonnet variant", () => {
    expect(isMaxEffortModel("claude-sonnet-4-6-20251001")).toBe(false);
  });

  it("returns false for claude-haiku-4-5", () => {
    expect(isMaxEffortModel("claude-haiku-4-5")).toBe(false);
  });

  it("returns true for claude-opus-4-7", () => {
    expect(isMaxEffortModel("claude-opus-4-7")).toBe(true);
  });

  it("returns true for dated Opus 4.7 variant", () => {
    expect(isMaxEffortModel("claude-opus-4-7-20260401")).toBe(true);
  });

  it("returns false for unknown model", () => {
    expect(isMaxEffortModel("nonexistent")).toBe(false);
  });
});

describe("isXhighEffortModel", () => {
  it("returns true for claude-opus-4-7", () => {
    expect(isXhighEffortModel("claude-opus-4-7")).toBe(true);
  });

  it("returns true for dated Opus 4.7 variant", () => {
    expect(isXhighEffortModel("claude-opus-4-7-20260401")).toBe(true);
  });

  it("returns false for claude-opus-4-6", () => {
    expect(isXhighEffortModel("claude-opus-4-6")).toBe(false);
  });

  it("returns false for claude-sonnet-4-6", () => {
    expect(isXhighEffortModel("claude-sonnet-4-6")).toBe(false);
  });

  it("returns false for unknown model", () => {
    expect(isXhighEffortModel("nonexistent")).toBe(false);
  });
});

describe("normalizeReasoningLevelForModel", () => {
  it("returns max unchanged for Opus 4.6", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-6", "max")).toBe("max");
  });

  it("returns max unchanged for dated Opus variant", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-6-20251001", "max")).toBe("max");
  });

  it("returns max unchanged for Opus 4.7", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-7", "max")).toBe("max");
  });

  it("clamps max to high for Sonnet", () => {
    expect(normalizeReasoningLevelForModel("claude-sonnet-4-6", "max")).toBe("high");
  });

  it("clamps max to high for dated Sonnet variant", () => {
    expect(normalizeReasoningLevelForModel("claude-sonnet-4-6-20251001", "max")).toBe("high");
  });

  it("clamps max to high for Haiku", () => {
    expect(normalizeReasoningLevelForModel("claude-haiku-4-5", "max")).toBe("high");
  });

  it("passes through non-max levels unchanged for any model", () => {
    expect(normalizeReasoningLevelForModel("claude-sonnet-4-6", "high")).toBe("high");
    expect(normalizeReasoningLevelForModel("claude-sonnet-4-6", "medium")).toBe("medium");
    expect(normalizeReasoningLevelForModel("claude-sonnet-4-6", "low")).toBe("low");
  });

  it("returns xhigh unchanged for Opus 4.7", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-7", "xhigh")).toBe("xhigh");
  });

  it("returns xhigh unchanged for dated Opus 4.7 variant", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-7-20260401", "xhigh")).toBe("xhigh");
  });

  it("clamps xhigh to high for Opus 4.6", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-6", "xhigh")).toBe("high");
  });

  it("clamps xhigh to high for Sonnet", () => {
    expect(normalizeReasoningLevelForModel("claude-sonnet-4-6", "xhigh")).toBe("high");
  });
});

describe("resolveThreadModelId", () => {
  it("returns locked model when it is a known model ID", () => {
    expect(resolveThreadModelId("claude-opus-4-6", "claude-sonnet-4-6")).toBe("claude-opus-4-6");
  });

  it("normalizes dated variant to base model ID", () => {
    expect(resolveThreadModelId("claude-haiku-4-5-20251001", "claude-sonnet-4-6")).toBe("claude-haiku-4-5");
  });

  it("returns default when locked model is null", () => {
    expect(resolveThreadModelId(null, "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("returns default when locked model is undefined", () => {
    expect(resolveThreadModelId(undefined, "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("returns default when locked model is an unknown ID", () => {
    expect(resolveThreadModelId("some-unknown-model", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});
