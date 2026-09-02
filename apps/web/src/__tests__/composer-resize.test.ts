// @vitest-environment node
import { describe, it, expect } from "vitest";
import * as NodeFS from "node:fs";

const EDITOR_SRC = NodeFS.readFileSync(
  new URL("../components/chat/lexical/ComposerEditor.tsx", import.meta.url),
  "utf-8",
);

describe("ComposerEditor resize strategy", () => {
  it("uses named constants for min and max height (no magic strings)", () => {
    expect(EDITOR_SRC).toContain("COMPOSER_MIN_HEIGHT");
    expect(EDITOR_SRC).toContain("COMPOSER_MAX_HEIGHT");
  });

  it("does not perform JS-driven height manipulation (no layout thrashing)", () => {
    // These patterns indicate write-read-write cycles that cause layout thrashing
    expect(EDITOR_SRC).not.toMatch(/\.style\.height\s*=/);
    expect(EDITOR_SRC).not.toMatch(/\.scrollHeight/);
    expect(EDITOR_SRC).not.toMatch(/\.offsetHeight/);
  });

});
