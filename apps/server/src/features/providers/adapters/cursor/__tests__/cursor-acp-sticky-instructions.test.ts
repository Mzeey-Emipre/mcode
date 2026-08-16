import { describe, expect, it } from "vitest";
import {
  CURSOR_INSTRUCTIONS_HEAVY_THRESHOLD_CHARS,
  CURSOR_INSTRUCTIONS_RESUME_HINT_TEXT,
  resolveCursorStickyInstructionBlob,
} from "../cursor-acp-sticky-instructions.js";

describe("resolveCursorStickyInstructionBlob", () => {
  it("substitutes reminder after heavy preamble already committed", () => {
    const heavyPayload = "x".repeat(CURSOR_INSTRUCTIONS_HEAVY_THRESHOLD_CHARS);
    expect(CURSOR_INSTRUCTIONS_RESUME_HINT_TEXT.length).toBeLessThan(
      CURSOR_INSTRUCTIONS_HEAVY_THRESHOLD_CHARS,
    );
    expect(
      resolveCursorStickyInstructionBlob({
        combinedGuidanceAndSkillsMarkdown: heavyPayload,
        readFallbackAgents: () => undefined,
        stickyHeavyCommitted: false,
      }),
    ).toEqual({
      instructionMarkdown: heavyPayload,
      markHeavyCommitted: true,
    });

    expect(
      resolveCursorStickyInstructionBlob({
        combinedGuidanceAndSkillsMarkdown: heavyPayload,
        readFallbackAgents: () => undefined,
        stickyHeavyCommitted: true,
      }),
    ).toEqual({
      instructionMarkdown: CURSOR_INSTRUCTIONS_RESUME_HINT_TEXT,
      markHeavyCommitted: false,
    });
  });

  it("never marks sticky when payload stays below heavy threshold", () => {
    const light = "keep rules concise";
    expect(
      resolveCursorStickyInstructionBlob({
        combinedGuidanceAndSkillsMarkdown: light,
        readFallbackAgents: () => undefined,
        stickyHeavyCommitted: false,
      }),
    ).toEqual({ instructionMarkdown: light, markHeavyCommitted: false });

    expect(
      resolveCursorStickyInstructionBlob({
        combinedGuidanceAndSkillsMarkdown: light,
        readFallbackAgents: () => undefined,
        stickyHeavyCommitted: true,
      }),
    ).toEqual({ instructionMarkdown: light, markHeavyCommitted: false });
  });

  it("falls back to reader when layered markdown missing", () => {
    expect(
      resolveCursorStickyInstructionBlob({
        combinedGuidanceAndSkillsMarkdown: undefined,
        readFallbackAgents: () => "from home ONLY",
        stickyHeavyCommitted: false,
      }).instructionMarkdown,
    ).toBe("from home ONLY");
  });
});
