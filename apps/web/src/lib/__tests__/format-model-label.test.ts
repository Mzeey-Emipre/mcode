import { describe, it, expect } from "vitest";
import { formatModelLabel, resolveModelDisplayLabel } from "../format-model-label";
import type { ModelDefinition } from "../model-registry";

describe("formatModelLabel", () => {
  it("formats Claude opus identifiers", () => {
    expect(formatModelLabel("claude-opus-4-7")).toBe("Claude Opus 4.7");
    expect(formatModelLabel("claude-opus-4-6")).toBe("Claude Opus 4.6");
  });

  it("formats Claude sonnet identifiers", () => {
    expect(formatModelLabel("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(formatModelLabel("claude-sonnet-4-5")).toBe("Claude Sonnet 4.5");
  });

  it("formats Claude haiku identifiers with date suffixes", () => {
    expect(formatModelLabel("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(formatModelLabel("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
  });

  it("formats Cursor Composer module identifiers", () => {
    expect(formatModelLabel("composer-2.5-fast")).toBe("Composer 2.5 Fast");
    expect(formatModelLabel("composer-2-fast")).toBe("Composer 2 Fast");
    expect(formatModelLabel("composer-1.5")).toBe("Composer 1.5");
    expect(formatModelLabel("auto")).toBe("Auto");
  });

  it("title-cases single-word provider names", () => {
    expect(formatModelLabel("codex")).toBe("Codex");
    expect(formatModelLabel("cursor-agent")).toBe("Cursor");
  });

  it("trims whitespace before registry lookup", () => {
    expect(formatModelLabel("  gpt-5.6-sol  ")).toBe("GPT-5.6 Sol");
  });

  it("uses registry labels for known Codex models", () => {
    expect(formatModelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(formatModelLabel("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
  });

  it("formats unknown gpt-* ids without truncating to Gpt", () => {
    expect(formatModelLabel("gpt-5.9-future")).toBe("GPT-5.9-future");
  });

  it("title-cases unknown multi-segment identifiers without Cursor prefixes", () => {
    expect(formatModelLabel("some-custom-model-id")).toBe("Some Custom Model Id");
  });

  it("returns empty string for blank input", () => {
    expect(formatModelLabel("")).toBe("");
    expect(formatModelLabel("   ")).toBe("");
  });
});

describe("resolveModelDisplayLabel", () => {
  const catalog: ModelDefinition[] = [
    { id: "composer-9-beta", label: "Composer 9 Beta (live)", providerId: "cursor" },
  ];

  it("prefers live catalog labels over snapshot and heuristics", () => {
    expect(resolveModelDisplayLabel("composer-9-beta", { catalog })).toBe(
      "Composer 9 Beta",
    );
  });

  it("uses CLI snapshot labels for Cursor GPT and Opus ids", () => {
    expect(resolveModelDisplayLabel("composer-2-fast")).toBe("Composer 2 Fast");
    expect(resolveModelDisplayLabel("claude-opus-4-7-thinking-high")).toBe(
      "Opus 4.7 1M High Thinking",
    );
    expect(resolveModelDisplayLabel("gpt-5.4-high-fast")).toBe("GPT-5.4 High Fast");
  });

  it("strips parenthetical CLI metadata from snapshot names", () => {
    expect(resolveModelDisplayLabel("composer-2.5-fast")).toBe("Composer 2.5 Fast");
  });

  it("falls back to heuristics for unknown ids", () => {
    expect(resolveModelDisplayLabel("composer-9-beta")).toBe("Composer 9 Beta");
  });
});
