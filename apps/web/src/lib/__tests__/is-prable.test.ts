import { describe, it, expect } from "vitest";
import { isPrable } from "../is-prable";

describe("isPrable", () => {
  it("returns true for a worktree-mode thread on a publishable branch", () => {
    expect(isPrable({ mode: "worktree", branch: "feat/my-feature" })).toBe(true);
  });

  it("returns false for an internal worktree branch", () => {
    expect(isPrable({ mode: "worktree", branch: "mcode-abc12345" })).toBe(false);
  });

  it("allows user-created mcode-prefixed branches", () => {
    expect(isPrable({ mode: "worktree", branch: "mcode-settings-fix" })).toBe(true);
  });

  it("returns false for a direct-mode thread", () => {
    expect(isPrable({ mode: "direct", branch: "feat/my-feature" })).toBe(false);
  });
});
