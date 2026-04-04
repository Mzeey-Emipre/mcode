// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const EDITOR_SRC = readFileSync(
  resolve(__dirname, "../components/chat/lexical/ComposerEditor.tsx"),
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

  it("applies CSS-only sizing via style prop on ContentEditable", () => {
    expect(EDITOR_SRC).toMatch(/minHeight:\s*COMPOSER_MIN_HEIGHT/);
    expect(EDITOR_SRC).toMatch(/maxHeight:\s*COMPOSER_MAX_HEIGHT/);
    expect(EDITOR_SRC).toMatch(/overflowY:\s*["']auto["']/);
  });
});
