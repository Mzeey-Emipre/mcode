import { describe, it, expect } from "vitest";
import {
  sanitizeBranchName,
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

describe("generateFallbackBranchName", () => {
  it("returns a thread-prefixed name", () => {
    expect(generateFallbackBranchName()).toMatch(/^thread-[a-z0-9]+$/);
  });
});
