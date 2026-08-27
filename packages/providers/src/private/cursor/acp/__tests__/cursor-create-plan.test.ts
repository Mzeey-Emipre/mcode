import { describe, it, expect } from "vitest";
import { extractCursorCreatePlanMarkdown } from "../cursor-create-plan.js";

describe("extractCursorCreatePlanMarkdown", () => {
  it("reads a top-level markdown field", () => {
    expect(
      extractCursorCreatePlanMarkdown({ markdown: "# Plan\n\nBody" }),
    ).toBe("# Plan\n\nBody");
  });

  it("reads nested plan.markdown", () => {
    expect(
      extractCursorCreatePlanMarkdown({
        plan: { markdown: "## Nested plan" },
      }),
    ).toBe("## Nested plan");
  });

  it("returns null when no markdown is present", () => {
    expect(extractCursorCreatePlanMarkdown({ title: "Only title" })).toBeNull();
  });
});
