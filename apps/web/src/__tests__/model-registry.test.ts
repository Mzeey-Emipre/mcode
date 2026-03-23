import { describe, it, expect } from "vitest";
import {
  MODEL_PROVIDERS,
  findModelById,
  findProviderForModel,
  getDefaultModel,
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
