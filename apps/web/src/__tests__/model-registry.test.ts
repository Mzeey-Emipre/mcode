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
  getCodexDefaultReasoningLevel,
  getCodexReasoningLevels,
  isMaxEffortModel,
  isModelAvailable,
  isXhighEffortModel,
  normalizeReasoningLevelForModel,
  resolveThreadModelId,
  supportsEffortParameter,
  pickProviderModelsForSettings,
} from "@/lib/model-registry";

describe("pickProviderModelsForSettings", () => {
  const staticModels = [{ id: "a", label: "A", providerId: "cursor" }];

  it("merges a non-empty dynamic list without hiding static models", () => {
    const dynamic = [{ id: "b", label: "B", providerId: "cursor" }];
    expect(pickProviderModelsForSettings(staticModels, dynamic)).toEqual([
      ...staticModels,
      ...dynamic,
    ]);
  });

  it("preserves the settings context window when dynamic discovery reports provider capacity", () => {
    const staticClaude = [{
      id: "claude-opus-5",
      label: "Claude Opus 5",
      providerId: "claude",
      contextWindow: 200_000,
    }];
    const dynamicClaude = [{
      id: "claude-opus-5",
      label: "Claude Opus 5",
      providerId: "claude",
      contextWindow: 1_000_000,
      supportedReasoningLevels: ["low", "high", "max"] as const,
    }];

    expect(pickProviderModelsForSettings(staticClaude, dynamicClaude)).toEqual([{
      ...dynamicClaude[0],
      contextWindow: 200_000,
    }]);
  });

  it("uses dynamic context updates for non-Claude models", () => {
    const staticCodex = [{
      id: "gpt-test",
      label: "GPT Test",
      providerId: "codex",
      contextWindow: 200_000,
    }];
    const dynamicCodex = [{
      id: "gpt-test",
      label: "GPT Test",
      providerId: "codex",
      contextWindow: 400_000,
    }];

    expect(pickProviderModelsForSettings(staticCodex, dynamicCodex)).toEqual(dynamicCodex);
  });

  it("falls back to static models when dynamic is undefined", () => {
    expect(pickProviderModelsForSettings(staticModels, undefined)).toEqual(staticModels);
  });

  it("falls back to static models when dynamic is empty", () => {
    expect(pickProviderModelsForSettings(staticModels, [])).toEqual(staticModels);
  });
});

describe("ModelRegistry", () => {
  it("MODEL_PROVIDERS contains Claude with 8 models", () => {
    const claude = MODEL_PROVIDERS.find((p) => p.id === "claude");
    expect(claude).toBeTruthy();
    expect(claude?.models).toHaveLength(8);
    expect(claude?.comingSoon).toBe(false);
  });

  it("findModelById returns Opus 5 with the standard-mode context clamp", () => {
    const model = findModelById("claude-opus-5");
    expect(model).toEqual({
      id: "claude-opus-5",
      label: "Claude Opus 5",
      providerId: "claude",
      contextWindow: 200_000,
    });
  });

  it("findModelById returns Fable 5 with no availability end date", () => {
    const model = findModelById("claude-fable-5");
    expect(model?.label).toBe("Claude Fable 5");
    expect(model?.providerId).toBe("claude");
    expect(model?.availableUntil).toBeUndefined();
    expect(isModelAvailable(model!)).toBe(true);
  });

  it("findModelById returns Sonnet 5", () => {
    const model = findModelById("claude-sonnet-5");
    expect(model?.label).toBe("Claude Sonnet 5");
    expect(model?.providerId).toBe("claude");
  });

  it("isModelAvailable honors availableUntil inclusively in local time", () => {
    const m = { id: "x", label: "X", providerId: "claude", availableUntil: "2026-06-22" };
    // Local-time Date constructions keep this timezone-independent and match the
    // local-formatted "Until <date>" badge users see in the picker.
    expect(isModelAvailable(m, new Date(2026, 5, 22, 12, 0, 0))).toBe(true);
    expect(isModelAvailable(m, new Date(2026, 5, 22, 23, 59, 59))).toBe(true);
    expect(isModelAvailable(m, new Date(2026, 5, 23, 0, 0, 0))).toBe(false);
    expect(isModelAvailable({ id: "y", label: "Y", providerId: "claude" })).toBe(true);
  });

  it("findModelById returns Opus 4.8", () => {
    const model = findModelById("claude-opus-4-8");
    expect(model?.label).toBe("Claude Opus 4.8");
    expect(model?.providerId).toBe("claude");
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

  it("getDefaultModel returns the first available Claude model", () => {
    const model = getDefaultModel();
    expect(model.providerId).toBe("claude");
    expect(isModelAvailable(model)).toBe(true);
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
          defaults: { provider: "claude", id: "claude-opus-4-6", reasoning: "high", fallbackId: "", contextWindow: "200k", thinking: false },
          utility: { provider: "", id: "" },
        },
      },
    });
    expect(getDefaultModelId()).toBe("claude-opus-4-6");
  });

  it("getDefaultModelId passes through unknown IDs as valid persisted provider model IDs", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        model: {
          defaults: { provider: "codex", id: "nonexistent-model", reasoning: "high", fallbackId: "", contextWindow: "200k", thinking: false },
          utility: { provider: "", id: "" },
        },
      },
    });
    expect(getDefaultModelId()).toBe("nonexistent-model");
  });

  it("getDefaultModelId preserves Cursor settings ID when absent from the static registry", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        model: {
          defaults: { provider: "cursor", id: "cursor-dynamic-model-xyz", reasoning: "high", fallbackId: "", contextWindow: "200k", thinking: false },
          utility: { provider: "", id: "" },
        },
      },
    });
    expect(getDefaultModelId()).toBe("cursor-dynamic-model-xyz");
  });

  it("getDefaultModelId returns opus-4-8 from default settings", () => {
    expect(getDefaultModelId()).toBe("claude-opus-4-8");
  });

  it("getDefaultReasoningLevel returns settings value", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        model: {
          defaults: { provider: "claude", id: "claude-sonnet-4-6", reasoning: "low", fallbackId: "", contextWindow: "200k", thinking: false },
          utility: { provider: "", id: "" },
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
          defaults: { provider: "claude", id: "claude-opus-4-6", reasoning: "max", fallbackId: "", contextWindow: "200k", thinking: false },
          utility: { provider: "", id: "" },
        },
      },
    });
    expect(getDefaultReasoningLevel()).toBe("max");
  });
});

describe("ReasoningLevelSchema", () => {
  it("accepts none, minimal, medium, high", () => {
    expect(() => ReasoningLevelSchema.parse("none")).not.toThrow();
    expect(() => ReasoningLevelSchema.parse("minimal")).not.toThrow();
    expect(() => ReasoningLevelSchema.parse("medium")).not.toThrow();
    expect(() => ReasoningLevelSchema.parse("high")).not.toThrow();
  });

  it("accepts max", () => {
    expect(() => ReasoningLevelSchema.parse("max")).not.toThrow();
    expect(ReasoningLevelSchema.parse("max")).toBe("max");
  });

  it("accepts xhigh", () => {
    expect(() => ReasoningLevelSchema.parse("xhigh")).not.toThrow();
    expect(ReasoningLevelSchema.parse("xhigh")).toBe("xhigh");
  });

  it("normalizes legacy orchestration-shaped values to max", () => {
    expect(ReasoningLevelSchema.parse("ultra")).toBe("max");
    expect(ReasoningLevelSchema.parse("ultrathink")).toBe("max");
  });

  it("rejects unknown values", () => {
    expect(() => ReasoningLevelSchema.parse("extreme")).toThrow();
  });
});

describe("Codex model catalog", () => {
  it("lists Astra after Sol and before the other GPT-5.6 Codex models", () => {
    const codex = MODEL_PROVIDERS.find((provider) => provider.id === "codex");
    expect(codex?.models.slice(0, 4).map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-6-astra",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("uses the Codex model catalog reasoning levels and defaults", () => {
    expect(getCodexReasoningLevels("gpt-6-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getCodexDefaultReasoningLevel("gpt-6-astra")).toBeNull();
    expect(getCodexReasoningLevels("gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getCodexDefaultReasoningLevel("gpt-5.6-sol")).toBe("low");
    expect(getCodexReasoningLevels("gpt-5.6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("omits inaccessible GPT-5.2 and GPT-5.1 Codex models", () => {
    const codex = MODEL_PROVIDERS.find((provider) => provider.id === "codex");
    expect(codex?.models.map((model) => model.id)).not.toContain("gpt-5.2-codex");
    expect(codex?.models.map((model) => model.id)).not.toContain("gpt-5.1-codex-mini");
  });

  it("replaces a retired Codex default with the first supported model", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        model: {
          defaults: {
            provider: "codex",
            id: "gpt-5.2-codex",
            reasoning: "medium",
            fallbackId: "",
            contextWindow: "200k",
            thinking: false,
          },
          utility: { provider: "", id: "" },
        },
      },
    });

    expect(getDefaultModelId()).toBe("gpt-5.6-sol");
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
  it("returns true for claude-opus-4-8", () => {
    expect(isMaxEffortModel("claude-opus-4-8")).toBe(true);
  });

  it("returns true for claude-opus-4-7", () => {
    expect(isMaxEffortModel("claude-opus-4-7")).toBe(true);
  });

  it("returns true for claude-opus-4-6", () => {
    expect(isMaxEffortModel("claude-opus-4-6")).toBe(true);
  });

  it("returns true for dated Opus 4.6 variant claude-opus-4-6-20251001", () => {
    expect(isMaxEffortModel("claude-opus-4-6-20251001")).toBe(true);
  });

  it("returns true for claude-sonnet-4-6", () => {
    expect(isMaxEffortModel("claude-sonnet-4-6")).toBe(true);
  });

  it("returns true for dated Sonnet variant", () => {
    expect(isMaxEffortModel("claude-sonnet-4-6-20251001")).toBe(true);
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
  it("returns true for claude-opus-4-8", () => {
    expect(isXhighEffortModel("claude-opus-4-8")).toBe(true);
  });

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

  it("returns false for dated Opus 4.6 variant", () => {
    expect(isXhighEffortModel("claude-opus-4-6-20251001")).toBe(false);
  });
});

describe("normalizeReasoningLevelForModel", () => {
  it("returns xhigh unchanged for Opus 4.7", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-7", "xhigh")).toBe("xhigh");
  });

  it("returns max unchanged for Opus 4.7", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-7", "max")).toBe("max");
  });

  it("returns max unchanged for Opus 4.6", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-6", "max")).toBe("max");
  });

  it("clamps xhigh to high for Opus 4.6 (xhigh not supported)", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-6", "xhigh")).toBe("high");
  });

  it("returns max unchanged for dated Opus 4.6 variant", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-6-20251001", "max")).toBe("max");
  });

  it("returns max unchanged for Opus 4.7", () => {
    expect(normalizeReasoningLevelForModel("claude-opus-4-7", "max")).toBe("max");
  });

  it("returns max unchanged for Sonnet 4.6 (now in MAX_EFFORT_MODEL_IDS)", () => {
    expect(normalizeReasoningLevelForModel("claude-sonnet-4-6", "max")).toBe("max");
  });

  it("returns max unchanged for dated Sonnet variant", () => {
    expect(normalizeReasoningLevelForModel("claude-sonnet-4-6-20251001", "max")).toBe("max");
  });

  it("short-circuits to high for Haiku regardless of requested level", () => {
    expect(normalizeReasoningLevelForModel("claude-haiku-4-5", "max")).toBe("high");
    expect(normalizeReasoningLevelForModel("claude-haiku-4-5", "low")).toBe("high");
    expect(normalizeReasoningLevelForModel("claude-haiku-4-5", "xhigh")).toBe("high");
  });

  it("passes through non-max levels unchanged for Sonnet", () => {
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

  it("clamps xhigh to high for Haiku", () => {
    expect(normalizeReasoningLevelForModel("claude-haiku-4-5", "xhigh")).toBe("high");
  });
});

describe("supportsEffortParameter", () => {
  it("returns true for claude-opus-4-7", () => {
    expect(supportsEffortParameter("claude-opus-4-7")).toBe(true);
  });

  it("returns true for claude-opus-4-6", () => {
    expect(supportsEffortParameter("claude-opus-4-6")).toBe(true);
  });

  it("returns true for claude-sonnet-4-6", () => {
    expect(supportsEffortParameter("claude-sonnet-4-6")).toBe(true);
  });

  it("returns false for claude-haiku-4-5", () => {
    expect(supportsEffortParameter("claude-haiku-4-5")).toBe(false);
  });

  it("returns false for dated Haiku variant", () => {
    expect(supportsEffortParameter("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("returns true for unknown model (defaults to supported)", () => {
    expect(supportsEffortParameter("nonexistent")).toBe(true);
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

  it("passes through unknown locked model ID (dynamic listing providers)", () => {
    expect(resolveThreadModelId("cursor-dynamic-123", "claude-sonnet-4-6")).toBe("cursor-dynamic-123");
  });
});
