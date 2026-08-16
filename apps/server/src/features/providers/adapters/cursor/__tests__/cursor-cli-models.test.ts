import { describe, it, expect } from "vitest";
import { inferCursorModelGroup, parseCursorCliModelsOutput } from "../cursor-cli-models.js";

describe("inferCursorModelGroup", () => {
  it("groups Composer and auto under Cursor", () => {
    expect(inferCursorModelGroup("auto")).toBe("Cursor");
    expect(inferCursorModelGroup("composer-2-fast")).toBe("Cursor");
  });

  it("groups vendor families by id prefix", () => {
    expect(inferCursorModelGroup("claude-4.6-sonnet-medium")).toBe("Anthropic");
    expect(inferCursorModelGroup("gpt-5.4-medium")).toBe("OpenAI");
    expect(inferCursorModelGroup("gemini-3-flash")).toBe("Google");
    expect(inferCursorModelGroup("grok-4-20")).toBe("xAI");
    expect(inferCursorModelGroup("kimi-k2.5")).toBe("Kimi");
    expect(inferCursorModelGroup("unknown-model")).toBe("Other");
  });
});

describe("parseCursorCliModelsOutput", () => {
  it("parses real Cursor CLI sample lines", () => {
    const stdout = `Available models

auto - Auto
composer-2-fast - Composer 2 Fast (current, default)
gpt-5.4-medium - GPT-5.4 1M
claude-4.6-sonnet-medium - Sonnet 4.6 1M

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`;
    const rows = parseCursorCliModelsOutput(stdout);
    expect(rows).toEqual([
      { id: "auto", name: "Auto", group: "Cursor" },
      {
        id: "composer-2-fast",
        name: "Composer 2 Fast (current, default)",
        group: "Cursor",
      },
      {
        id: "gpt-5.4-medium",
        name: "GPT-5.4 1M (Max)",
        group: "OpenAI",
        contextWindow: 1_000_000,
      },
      {
        id: "claude-4.6-sonnet-medium",
        name: "Sonnet 4.6 1M (Max)",
        group: "Anthropic",
        contextWindow: 1_000_000,
      },
    ]);
  });
});
