import { describe, it, expect } from "vitest";
import {
  parseCursorCliModelsOutput,
  inferCursorModelGroup,
} from "../cursor-cli-models.js";

describe("inferCursorModelGroup", () => {
  it('maps "auto" to Cursor', () => {
    expect(inferCursorModelGroup("auto")).toBe("Cursor");
  });

  it("maps claude- prefix to Anthropic", () => {
    expect(inferCursorModelGroup("claude-4.6-sonnet")).toBe("Anthropic");
  });

  it("maps gpt- prefix to OpenAI", () => {
    expect(inferCursorModelGroup("gpt-5.4")).toBe("OpenAI");
  });

  it("maps unknown prefix to Other", () => {
    expect(inferCursorModelGroup("llama-3")).toBe("Other");
  });
});

describe("parseCursorCliModelsOutput", () => {
  const sampleOutput = [
    "Available models",
    "  claude-4.6-sonnet - Claude 4.6 Sonnet",
    "  claude-4.6-sonnet-medium - Claude 4.6 Sonnet (Max)",
    "  gpt-5.4 - GPT-5.4",
    "  gpt-5.4-medium - GPT-5.4 (Max)",
    "  auto - Cursor Auto",
    "Tip: use --model to select",
  ].join("\n");

  it("parses all model lines", () => {
    const models = parseCursorCliModelsOutput(sampleOutput);
    expect(models).toHaveLength(5);
    expect(models[0].id).toBe("claude-4.6-sonnet");
    expect(models[1].id).toBe("claude-4.6-sonnet-medium");
  });

  it("annotates -medium suffix models with contextWindow", () => {
    const models = parseCursorCliModelsOutput(sampleOutput);
    const maxModel = models.find((m) => m.id === "claude-4.6-sonnet-medium");
    expect(maxModel).toBeDefined();
    expect(maxModel!.contextWindow).toBe(1_000_000);
  });

  it("does not set contextWindow on non-medium models", () => {
    const models = parseCursorCliModelsOutput(sampleOutput);
    const baseModel = models.find((m) => m.id === "claude-4.6-sonnet");
    expect(baseModel).toBeDefined();
    expect(baseModel!.contextWindow).toBeUndefined();
  });

  it("appends (Max) to display name when -medium suffix but name lacks it", () => {
    const output = [
      "Available models",
      "  claude-4.6-sonnet-medium - Claude 4.6 Sonnet",
      "Tip: done",
    ].join("\n");
    const models = parseCursorCliModelsOutput(output);
    expect(models[0].name).toBe("Claude 4.6 Sonnet (Max)");
  });

  it("keeps existing (Max) suffix without doubling", () => {
    const output = [
      "Available models",
      "  gpt-5.4-medium - GPT-5.4 (Max)",
      "Tip: done",
    ].join("\n");
    const models = parseCursorCliModelsOutput(output);
    expect(models[0].name).toBe("GPT-5.4 (Max)");
  });
});
