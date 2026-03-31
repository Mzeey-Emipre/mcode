import { describe, it, expect } from "vitest";
import {
  sanitizeBranchName,
  sanitizeCustomBranchInput,
  trimTrailingBranchChars,
  finalizeCustomBranchName,
  generateBranchNameFromMessage,
  generateFallbackBranchName,
} from "../lib/branch-name";

describe("sanitizeBranchName", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(sanitizeBranchName("Fix Login Bug")).toBe("fix-login-bug");
  });

  it("strips invalid characters", () => {
    expect(sanitizeBranchName("feat: add auth!@#$")).toBe("feat-add-auth");
  });

  it("truncates to 50 chars", () => {
    const long = "a".repeat(60);
    expect(sanitizeBranchName(long).length).toBeLessThanOrEqual(50);
  });

  it("removes leading and trailing hyphens", () => {
    expect(sanitizeBranchName("-hello-world-")).toBe("hello-world");
  });
});

describe("generateBranchNameFromMessage", () => {
  it("extracts meaningful words from short message", () => {
    const name = generateBranchNameFromMessage("fix the login timeout error");
    expect(name).toBe("fix-login-timeout-error");
  });

  it("filters stop words", () => {
    const name = generateBranchNameFromMessage(
      "I need you to add a new feature for the users",
    );
    expect(name).not.toContain("need");
    expect(name).not.toContain("the");
  });

  it("limits to 5 words", () => {
    const name = generateBranchNameFromMessage(
      "refactor authentication system database queries caching layer validation middleware",
    );
    const parts = name.split("-");
    expect(parts.length).toBeLessThanOrEqual(5);
  });

  it("returns fallback for empty/stop-word-only messages", () => {
    const name = generateBranchNameFromMessage("hey hi hello");
    expect(name).toMatch(/^thread-/);
  });
});

describe("sanitizeCustomBranchInput", () => {
  it("preserves valid branch names", () => {
    expect(sanitizeCustomBranchInput("feat/my-branch")).toBe("feat/my-branch");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitizeCustomBranchInput("fix my bug")).toBe("fix-my-bug");
  });

  it("replaces git-invalid characters with hyphens", () => {
    expect(sanitizeCustomBranchInput("feat?add*stuff")).toBe("feat-add-stuff");
  });

  it("collapses consecutive dots", () => {
    expect(sanitizeCustomBranchInput("feat..bar")).toBe("feat.bar");
  });

  it("collapses consecutive slashes", () => {
    expect(sanitizeCustomBranchInput("feat//bar")).toBe("feat/bar");
  });

  it("collapses consecutive hyphens from replacements", () => {
    expect(sanitizeCustomBranchInput("feat?!bar")).toBe("feat-bar");
  });

  it("preserves dots, slashes, and underscores", () => {
    expect(sanitizeCustomBranchInput("v1.0/my_branch")).toBe("v1.0/my_branch");
  });

  it("preserves uppercase letters", () => {
    expect(sanitizeCustomBranchInput("Fix/OAuth")).toBe("Fix/OAuth");
  });

  it("truncates to 100 characters", () => {
    const long = "a".repeat(120);
    expect(sanitizeCustomBranchInput(long).length).toBe(100);
  });

  it("strips tilde, caret, colon, question, asterisk, brackets, backslash", () => {
    expect(sanitizeCustomBranchInput("a~b^c:d?e*f[g]h\\i")).toBe("a-b-c-d-e-f-g-h-i");
  });

  it("strips leading hyphens", () => {
    expect(sanitizeCustomBranchInput("-my-branch")).toBe("my-branch");
  });

  it("strips .lock suffix", () => {
    expect(sanitizeCustomBranchInput("refs.lock")).toBe("refs");
  });

  it("strips dot-prefixed path components", () => {
    expect(sanitizeCustomBranchInput("feat/.hidden")).toBe("feat/hidden");
  });

  it("strips leading dot at start of name", () => {
    expect(sanitizeCustomBranchInput(".dotfile")).toBe("dotfile");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeCustomBranchInput("")).toBe("");
  });

  it("strips reflog @{...} syntax", () => {
    expect(sanitizeCustomBranchInput("branch@{0}")).toBe("branch-0");
  });

  it("replaces control characters with hyphens", () => {
    expect(sanitizeCustomBranchInput("foo\tbar")).toBe("foo-bar");
  });

  it("collapses multiple dot-prefixed path components", () => {
    expect(sanitizeCustomBranchInput("feat/..hidden")).toBe("feat/hidden");
  });

  it("strips leading slash from dot-prefixed input", () => {
    expect(sanitizeCustomBranchInput("./foo")).toBe("foo");
  });
});

describe("trimTrailingBranchChars", () => {
  it("strips trailing dot", () => {
    expect(trimTrailingBranchChars("branch.")).toBe("branch");
  });

  it("strips trailing slash", () => {
    expect(trimTrailingBranchChars("feat/")).toBe("feat");
  });

  it("strips trailing hyphen", () => {
    expect(trimTrailingBranchChars("feat-")).toBe("feat");
  });

  it("strips mixed trailing chars", () => {
    expect(trimTrailingBranchChars("feat/bar./..")).toBe("feat/bar");
  });

  it("passes through valid names unchanged", () => {
    expect(trimTrailingBranchChars("feat/my-branch")).toBe("feat/my-branch");
  });
});

describe("finalizeCustomBranchName", () => {
  it("sanitizes and trims in one pass", () => {
    expect(finalizeCustomBranchName("feat?bar.")).toBe("feat-bar");
  });

  it("passes through valid names unchanged", () => {
    expect(finalizeCustomBranchName("feat/my-branch")).toBe("feat/my-branch");
  });
});

describe("generateFallbackBranchName", () => {
  it("returns a thread-prefixed name", () => {
    expect(generateFallbackBranchName()).toMatch(/^thread-[a-z0-9]+$/);
  });
});
