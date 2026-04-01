import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_SETTINGS, ReasoningLevelSchema, type ReasoningLevel } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  MODEL_PROVIDERS,
  findModelById,
  findProviderForModel,
  getDefaultModel,
  getDefaultModelId,
  getDefaultReasoningLevel,
  isMaxEffortModel,
} from "@/lib/model-registry";

describe("ModelRegistry", () => {
  it("MODEL_PROVIDERS contains Claude with 3 models", () => {
    const claude = MODEL_PROVIDERS.find((p) => p.id === "claude");
    expect(claude).toBeTruthy();
    expect(claude?.models).toHaveLength(3);
    expect(claude?.comingSoon).toBe(false);
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
      settings: DEFAULT_SETTINGS,
      loaded: true,
    });
  });

  it("getDefaultModelId returns settings value", () => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        model: {
          defaults: { provider: "claude", id: "claude-opus-4-6", reasoning: "high" },
        },
      },
    });
    expect(getDefaultModelId()).toBe("claude-opus-4-6");
  });

  it("getDefaultModelId falls back to sonnet when model ID is unknown", () => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        model: {
          defaults: { provider: "claude", id: "nonexistent-model", reasoning: "high" },
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
        ...DEFAULT_SETTINGS,
        model: {
          defaults: { provider: "claude", id: "claude-sonnet-4-6", reasoning: "low" },
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
        ...DEFAULT_SETTINGS,
        model: {
          defaults: { provider: "claude", id: "claude-opus-4-6", reasoning: "max" },
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

describe("isMaxEffortModel", () => {
  it("returns true for claude-opus-4-6", () => {
    expect(isMaxEffortModel("claude-opus-4-6")).toBe(true);
  });

  it("returns false for claude-sonnet-4-6", () => {
    expect(isMaxEffortModel("claude-sonnet-4-6")).toBe(false);
  });

  it("returns false for claude-haiku-4-5", () => {
    expect(isMaxEffortModel("claude-haiku-4-5")).toBe(false);
  });

  it("returns false for unknown model", () => {
    expect(isMaxEffortModel("nonexistent")).toBe(false);
  });
});
