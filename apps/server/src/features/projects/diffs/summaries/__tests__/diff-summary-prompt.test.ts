import { describe, it, expect } from "vitest";
import { buildDiffSummaryPrompt } from "../diff-summary-prompt.js";
import type { DiffPayload } from "../diff-summary-source.js";

describe("buildDiffSummaryPrompt", () => {
  const basePayload: DiffPayload = {
    stats: [
      { filePath: "src/auth.ts", additions: 50, deletions: 10 },
      { filePath: "src/login.ts", additions: 20, deletions: 5 },
    ],
    diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,5 @@\n+import { hash } from 'crypto';",
    commits: "abc12345 feat: add password hashing\ndef67890 fix: handle empty input",
    turnCount: 3,
    lastTurnId: "msg-123",
  };

  it("includes all XML sections", () => {
    const prompt = buildDiffSummaryPrompt(basePayload);
    expect(prompt).toContain("<role>");
    expect(prompt).toContain("</role>");
    expect(prompt).toContain("<rules>");
    expect(prompt).toContain("<mermaid-syntax>");
    expect(prompt).toContain("<workflow>");
    expect(prompt).toContain("<diff-stats>");
    expect(prompt).toContain("<diff>");
    expect(prompt).toContain("<commits>");
  });

  it("includes the diff stats table", () => {
    const prompt = buildDiffSummaryPrompt(basePayload);
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("+50/-10");
  });

  it("includes mermaid syntax rules with <br> guidance", () => {
    const prompt = buildDiffSummaryPrompt(basePayload);
    expect(prompt).toContain("<br>");
    expect(prompt).toContain("NEVER use \\n");
  });

  it("notes partial diff when diff is empty but stats exist", () => {
    const partial: DiffPayload = {
      ...basePayload,
      diff: "",
    };
    const prompt = buildDiffSummaryPrompt(partial);
    expect(prompt).toContain("No detailed diff available");
  });
});
